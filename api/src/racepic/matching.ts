import { cosineSimilarity } from './bedrock';
import type { RgbColor } from './rekognition';
import type { MatchingWeights } from './matchingConfig';

/**
 * Reine Scoring-Logik (Paket 6: KI-Pipeline), keine AWS-/DB-Aufrufe - siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F "Matching-Features je (Detection, Entry)".
 * Bewusst als gewichtete lineare Kombination statt einer trainierten Logistic Regression: es gibt
 * noch keine gelabelten Trainingsdaten (die entstehen erst durch die Review-Entscheidungen aus dem
 * Piloten, Paket 10). Gewichte/Schwellen sind ueber `racepic_matching_config` austauschbar, ohne
 * Codeaenderung - das erfuellt das Architekturprinzip "Grenzwerte nicht hart einbauen", auch wenn
 * die Kombinationsform selbst (noch) simpel ist.
 */

// Bug gefunden 2026-09-23 (per Live-Test gegen Rekognition bestaetigt): eine gut lesbare "5" auf
// einem Rennstartnummern-Schild wurde mit 93.2% Konfidenz als Buchstabe "S" erkannt - in der dort
// verwendeten Blockschrift sehen sich beide Zeichen fast identisch (flache Oberkante, aehnliche
// Kurve). `normalizeStartNumberCandidate` (rekognition.ts) behaelt Buchstaben unveraendert, ein
// exakter String-Vergleich gegen die numerische Startnummer scheitert dadurch komplett - das
// Signal ging nicht etwa schwaecher, sondern ganz verloren. Bekannte OCR-Verwechslungen zwischen
// Ziffern und aehnlich aussehenden Buchstaben werden vor dem Vergleich auf eine gemeinsame Form
// abgebildet; echte Startnummern sind praktisch immer rein numerisch, das Risiko einer dadurch neu
// entstehenden Fehlzuordnung ist gering und wird ohnehin durch reviewThreshold/minMargin und
// menschliche Pruefung abgefangen.
const OCR_DIGIT_CONFUSION: Record<string, string> = { S: '5', O: '0', B: '8', Z: '2', I: '1', G: '6', D: '0' };
export const canonicalizeOcrNumber = (value: string): string =>
  value.split('').map((char) => OCR_DIGIT_CONFUSION[char] ?? char).join('');

export type CandidateFeatures = {
  ocrExact: boolean;
  ocrConfidence: number; // 0..1
  vehicleTypeMatch: boolean;
  embeddingSimilarity: number | null; // 0..1, null wenn keine Referenz/kein Embedding vorhanden
  colorSimilarity: number | null; // 0..1
  ambiguityCount: number; // Anzahl Entries im Event mit derselben Startnummer (>=1)
};

const RGB_MAX_DISTANCE = Math.sqrt(3 * 255 * 255);

export const colorSimilarity = (a: RgbColor, b: RgbColor): number => {
  const distance = Math.sqrt((a.red - b.red) ** 2 + (a.green - b.green) ** 2 + (a.blue - b.blue) ** 2);
  return 1 - distance / RGB_MAX_DISTANCE;
};

export const embeddingSimilarity = (a: number[], b: number[]): number => {
  // Kosinus-Aehnlichkeit liegt in [-1, 1], fuer die Gewichtung auf [0, 1] normiert.
  return (cosineSimilarity(a, b) + 1) / 2;
};

export const scoreCandidate = (features: CandidateFeatures, weights: MatchingWeights): number => {
  let score = 0;
  if (features.ocrExact) score += weights.ocrExact;
  score += weights.ocrConfidence * features.ocrConfidence;
  if (features.vehicleTypeMatch) score += weights.vehicleTypeMatch;
  // A registration photo may show an older livery or color. Once the race photo contains an exact
  // official start-number match, weak reference-image signals must not reduce that strong event-
  // specific evidence. Above-neutral visual matches still help distinguish duplicate numbers.
  const referenceSignal = (value: number | null) => {
    const normalized = value ?? 0.5;
    return features.ocrExact ? Math.max(0.5, normalized) : normalized;
  };
  score += weights.embeddingSimilarity * referenceSignal(features.embeddingSimilarity);
  score += weights.colorSimilarity * referenceSignal(features.colorSimilarity);

  const ambiguityFactor = Math.min(1, Math.max(0, features.ambiguityCount - 1) / 3);
  score -= weights.ambiguityPenalty * ambiguityFactor;

  return Math.min(1, Math.max(0, score));
};

/** 'Car'/'Motorcycle' (Rekognition) <-> 'auto'/'moto' (Nennungstool-Klassen). */
export const vehicleTypeMatches = (detectionLabel: 'Car' | 'Motorcycle', classVehicleType: string): boolean =>
  (detectionLabel === 'Car' && classVehicleType === 'auto') || (detectionLabel === 'Motorcycle' && classVehicleType === 'moto');
