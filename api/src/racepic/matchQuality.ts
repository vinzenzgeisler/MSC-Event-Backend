import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicAssignment, racepicDetection, racepicImage, racepicMatchCandidate } from '../db/schema';

/**
 * Qualitätsreport (Paket 10), siehe docs/memory-bank/racepic-architecture.md Abschnitt H
 * "Qualitätsreport" und Abschnitt N Paket 10 "Kalibrierung der Schwellen an Review-Daten". In
 * Paket 6/7 bewusst zurückgestellt, weil es ohne echte, von Menschen getroffene Review-
 * Entscheidungen nicht sinnvoll auswertbar ist (siehe racepic-progress.md).
 *
 * Ansatz: nur Detections, für die mindestens eine *von einem Menschen* getroffene Entscheidung
 * vorliegt (`source = 'MANUAL'`, also confirm/reject/correct/add aus der Review-Queue), zählen
 * als Ground Truth. Ein reines `AUTO_MATCHED` ohne jede menschliche Prüfung wird nicht als
 * Ground Truth verwendet, sonst würde der Report die Entscheidung des Matchers gegen sich selbst
 * bewerten. Positives Label = die von einem Menschen bestätigte/korrigierte Entry-ID für diese
 * Detection; fehlt ein positives Label (alle MANUAL-Assignments dieser Detection sind REJECTED),
 * gilt die Detection als "kein korrekter Kandidat vorhanden".
 *
 * Vereinfachung ggü. dem echten Matcher (`matchWorker.ts`): die Marge zum Zweitplatzierten
 * (`minMargin`) fließt hier nicht ein, nur der Score des Rang-1-Kandidaten gegen die
 * Schwelle. Für die Kalibrierung von `autoThreshold`/`reviewThreshold` reicht das aus; wer die
 * Marge mitkalibrieren will, muss die Rohdaten (`racepic_match_candidate`) separat auswerten.
 */

const POSITIVE_STATUSES = ['MANUALLY_CONFIRMED', 'MANUALLY_CORRECTED'] as const;
const THRESHOLD_STEP = 0.05;

export type QualityThresholdRow = {
  threshold: number;
  candidateCount: number;
  correctCount: number;
  incorrectCount: number;
  precision: number | null;
  recall: number | null;
};

export type MatchQualityReport = {
  eventId: string;
  reviewedDetectionCount: number;
  detectionsWithConfirmedMatchCount: number;
  thresholds: QualityThresholdRow[];
};

export const computeMatchQualityReport = async (eventId: string): Promise<MatchQualityReport> => {
  const db = await getDb();

  const detections = await db
    .select({ id: racepicDetection.id, imageId: racepicDetection.imageId })
    .from(racepicDetection)
    .innerJoin(racepicImage, eq(racepicImage.id, racepicDetection.imageId))
    .where(eq(racepicImage.eventId, eventId));
  if (detections.length === 0) {
    return { eventId, reviewedDetectionCount: 0, detectionsWithConfirmedMatchCount: 0, thresholds: [] };
  }
  const detectionIds = detections.map((row) => row.id);

  const manualAssignments = await db
    .select({ detectionId: racepicAssignment.detectionId, entryId: racepicAssignment.entryId, status: racepicAssignment.status })
    .from(racepicAssignment)
    .where(and(inArray(racepicAssignment.detectionId, detectionIds), eq(racepicAssignment.source, 'MANUAL')));

  const positiveEntryByDetection = new Map<string, string>();
  const reviewedDetectionIds = new Set<string>();
  for (const row of manualAssignments) {
    if (!row.detectionId) continue;
    reviewedDetectionIds.add(row.detectionId);
    if ((POSITIVE_STATUSES as readonly string[]).includes(row.status)) {
      positiveEntryByDetection.set(row.detectionId, row.entryId);
    }
  }
  if (reviewedDetectionIds.size === 0) {
    return { eventId, reviewedDetectionCount: 0, detectionsWithConfirmedMatchCount: 0, thresholds: [] };
  }

  const rank1Candidates = await db
    .select({ detectionId: racepicMatchCandidate.detectionId, entryId: racepicMatchCandidate.entryId, score: racepicMatchCandidate.score })
    .from(racepicMatchCandidate)
    .where(and(inArray(racepicMatchCandidate.detectionId, Array.from(reviewedDetectionIds)), eq(racepicMatchCandidate.rank, 1)));

  const rank1ByDetection = new Map<string, { entryId: string; score: number }>();
  for (const row of rank1Candidates) {
    if (!row.detectionId) continue;
    rank1ByDetection.set(row.detectionId, { entryId: row.entryId, score: Number(row.score) });
  }

  const totalWithKnownPositive = positiveEntryByDetection.size;
  const thresholds: QualityThresholdRow[] = [];
  for (let t = THRESHOLD_STEP; t <= 1; t += THRESHOLD_STEP) {
    const threshold = Math.round(t * 100) / 100;
    let candidateCount = 0;
    let correctCount = 0;
    for (const detectionId of reviewedDetectionIds) {
      const rank1 = rank1ByDetection.get(detectionId);
      if (!rank1 || rank1.score < threshold) continue;
      candidateCount += 1;
      if (positiveEntryByDetection.get(detectionId) === rank1.entryId) correctCount += 1;
    }
    thresholds.push({
      threshold,
      candidateCount,
      correctCount,
      incorrectCount: candidateCount - correctCount,
      precision: candidateCount > 0 ? correctCount / candidateCount : null,
      recall: totalWithKnownPositive > 0 ? correctCount / totalWithKnownPositive : null
    });
  }

  return {
    eventId,
    reviewedDetectionCount: reviewedDetectionIds.size,
    detectionsWithConfirmedMatchCount: totalWithKnownPositive,
    thresholds
  };
};
