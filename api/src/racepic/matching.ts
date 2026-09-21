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
  // Fehlende Signale (kein Referenzfoto, kein Embedding) werden neutral behandelt (0.5), nicht als
  // Ablehnung gewertet - ein Fahrzeug ohne Referenzfoto darf trotzdem ueber OCR gematcht werden.
  score += weights.embeddingSimilarity * (features.embeddingSimilarity ?? 0.5);
  score += weights.colorSimilarity * (features.colorSimilarity ?? 0.5);

  const ambiguityFactor = Math.min(1, Math.max(0, features.ambiguityCount - 1) / 3);
  score -= weights.ambiguityPenalty * ambiguityFactor;

  return Math.min(1, Math.max(0, score));
};

/** 'Car'/'Motorcycle' (Rekognition) <-> 'auto'/'moto' (Nennungstool-Klassen). */
export const vehicleTypeMatches = (detectionLabel: 'Car' | 'Motorcycle', classVehicleType: string): boolean =>
  (detectionLabel === 'Car' && classVehicleType === 'auto') || (detectionLabel === 'Motorcycle' && classVehicleType === 'moto');
