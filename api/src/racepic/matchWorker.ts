import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  entry,
  eventClass,
  racepicAssignment,
  racepicAssignmentEvent,
  racepicDetection,
  racepicImage,
  racepicMatchCandidate,
  racepicProcessingStep,
  racepicTextDetection,
  vehicle
} from '../db/schema';
import { logOperationalEvent, errorCodeOf } from '../observability/logger';
import { colorSimilarity, embeddingSimilarity, scoreCandidate, vehicleTypeMatches, type CandidateFeatures } from './matching';
import { getActiveMatchingConfig } from './matchingConfig';
import { ensureVehicleReference } from './vehicleReference';
import type { RgbColor } from './rekognition';

/**
 * RacePicMatchWorker (Paket 6: KI-Pipeline), konsumiert die Match-Queue. Siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F "Matching-Strategie". Idempotent ueber
 * `racepic_processing_step` (step='match'), aber die Pipeline-Version schliesst die verwendete
 * Matching-Config-Version ein - ein Rematch mit neuer Config ist damit **kein** No-Op.
 */
export const PIPELINE_VERSION = '2026-09-21.1';
const MAX_STORED_CANDIDATES = 5;
// Bug gefunden 2026-09-22: `eligible.map(...)` in `Promise.all` feuerte pro Detection so viele
// gleichzeitige `ensureVehicleReference`-Aufrufe wie es zulaessige Nennungen im Event gibt - jeder
// davon laedt bei einem Cache-Miss ein volles Fahrzeugfoto herunter und dekodiert es mit sharp.
// Bei einem groesseren Event (mehrere Dutzend/hundert Nennungen) fuehrte das zu
// `Runtime.OutOfMemory`. Begrenzt die Parallelitaet stattdessen auf einen festen Wert.
// Gesenkt 2026-09-23 (Bug gefunden: 154 Bedrock-ThrottlingExceptions in 2h, weiterhin dutzende
// selbst mit Retry/Backoff in bedrock.ts) - das frisch freigeschaltete Inference-Profile hat
// offenbar ein niedriges TPS-Kontingent; 5 gleichzeitige embedImage-Aufrufe ueberfordern das
// zuverlaessig. Auf Kosten etwas laengerer Match-Laufzeit.
const CANDIDATE_SCORING_CONCURRENCY = 2;

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type EligibleEntry = {
  entryId: string;
  startNumberNorm: string | null;
  vehicleId: string;
  vehicleType: string;
};

const processOneImage = async (imageId: string): Promise<void> => {
  const db = await getDb();

  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image) return;
  if (image.processingStatus !== 'ANALYZED' && image.processingStatus !== 'MATCHED') return;

  const config = await getActiveMatchingConfig(image.eventId);
  const pipelineVersion = `${PIPELINE_VERSION}:${config.version}`;

  const [existingStep] = await db
    .select()
    .from(racepicProcessingStep)
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'match'), eq(racepicProcessingStep.pipelineVersion, pipelineVersion)))
    .limit(1);
  if (existingStep?.status === 'DONE') return;
  if (!existingStep) {
    await db.insert(racepicProcessingStep).values({ imageId, step: 'match', pipelineVersion, status: 'IN_PROGRESS' }).onConflictDoNothing();
  }

  const detections = await db.select().from(racepicDetection).where(eq(racepicDetection.imageId, imageId));
  const textDetections = await db.select().from(racepicTextDetection).where(eq(racepicTextDetection.imageId, imageId));

  const eligibleRows = await db
    .select({
      entryId: entry.id,
      startNumberNorm: entry.startNumberNorm,
      vehicleId: entry.vehicleId,
      vehicleType: eventClass.vehicleType
    })
    .from(entry)
    .innerJoin(eventClass, eq(eventClass.id, entry.classId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .where(
      and(
        eq(entry.eventId, image.eventId),
        eq(entry.acceptanceStatus, 'accepted'),
        eq(entry.registrationStatus, 'submitted_verified'),
        isNull(entry.deletedAt)
      )
    );
  const eligible: EligibleEntry[] = eligibleRows;

  const ambiguityCounts = new Map<string, number>();
  for (const row of eligible) {
    if (!row.startNumberNorm) continue;
    ambiguityCounts.set(row.startNumberNorm, (ambiguityCounts.get(row.startNumberNorm) ?? 0) + 1);
  }

  // Mehrere Fahrzeuge auf demselben Foto vergleichen dieselben Nennungsfahrzeuge. Ein
  // Promise-Cache verhindert doppelte S3-/Bedrock-/DB-Arbeit innerhalb dieses Jobs.
  const referenceCache = new Map<string, ReturnType<typeof ensureVehicleReference>>();
  const getReference = (vehicleId: string) => {
    let reference = referenceCache.get(vehicleId);
    if (!reference) { reference = ensureVehicleReference(vehicleId); referenceCache.set(vehicleId, reference); }
    return reference;
  };

  for (const detection of detections) {
    const linkedTexts = textDetections.filter((text) => text.detectionId === detection.id);
    const detectionColor: RgbColor | null = Array.isArray(detection.dominantColors) && detection.dominantColors[0] ? (detection.dominantColors[0] as RgbColor) : null;
    const detectionEmbedding = detection.embedding as unknown as number[] | null;

    const scored = await mapWithConcurrencyLimit(eligible, CANDIDATE_SCORING_CONCURRENCY, async (candidateEntry) => {
      const textMatches = candidateEntry.startNumberNorm
        ? linkedTexts.filter((text) => text.normalized === candidateEntry.startNumberNorm)
        : [];
      const reference = await getReference(candidateEntry.vehicleId);

      const features: CandidateFeatures = {
        ocrExact: textMatches.length > 0,
        ocrConfidence: textMatches.length > 0 ? Math.max(...textMatches.map((t) => Number(t.confidence ?? 0))) / 100 : 0,
        vehicleTypeMatch: vehicleTypeMatches(detection.label as 'Car' | 'Motorcycle', candidateEntry.vehicleType),
        embeddingSimilarity:
          detectionEmbedding && reference?.embedding ? embeddingSimilarity(detectionEmbedding, reference.embedding) : null,
        colorSimilarity: detectionColor && reference?.dominantColor ? colorSimilarity(detectionColor, reference.dominantColor) : null,
        ambiguityCount: candidateEntry.startNumberNorm ? (ambiguityCounts.get(candidateEntry.startNumberNorm) ?? 1) : 1
      };

      return { entryId: candidateEntry.entryId, score: scoreCandidate(features, config.weights), features };
    });

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) continue;

    const top = scored[0];
    const margin = scored.length > 1 ? top.score - scored[1].score : top.score;

    // Bug gefunden 2026-09-23 (Nutzer-Feedback: die Review-Queue zeigte einen "Top-Kandidaten" mit
    // 88%/76% Konfidenz an, obwohl fuer dieses Bild gar keine Zuordnung existierte - deutlich ueber
    // reviewThreshold haette das eine echte racepic_assignment-Zeile erzeugen muessen): alte
    // racepic_match_candidate-Zeilen fuer diese Detection wurden nie geloescht, nur neue rangiert
    // eingefuegt. Bei mehreren Laeufen fuer dieselbe Detection (Re-Match, oder ein zweiter
    // Match-Versuch nach einem teilweise fehlgeschlagenen vorherigen) sammelten sich so Kandidaten
    // aus verschiedenen Config-/Pipeline-Versionen an, und `loadCandidateDisplays`
    // (reviewQueue.ts) zeigte einfach irgendeine der mehreren "rank=1"-Zeilen - moeglicherweise aus
    // einem alten Lauf mit anderen Gewichten/Schwellen. Vor dem Einfuegen der frischen Kandidaten
    // erst die alten fuer diese Detection entfernen, damit die Tabelle immer nur den aktuellen Lauf
    // widerspiegelt (die eigentliche Historie ist racepic_assignment_event, nicht diese Tabelle).
    await db.delete(racepicMatchCandidate).where(eq(racepicMatchCandidate.detectionId, detection.id));

    const storedCandidateIds: string[] = [];
    for (const [index, candidate] of scored.slice(0, MAX_STORED_CANDIDATES).entries()) {
      const [row] = await db
        .insert(racepicMatchCandidate)
        .values({
          imageId,
          detectionId: detection.id,
          entryId: candidate.entryId,
          features: candidate.features,
          score: candidate.score.toFixed(5),
          rank: index + 1,
          matcherVersion: PIPELINE_VERSION,
          configVersion: config.version
        })
        .returning();
      if (row) storedCandidateIds.push(row.id);
    }
    const topCandidateId = storedCandidateIds[0] ?? null;

    let desiredStatus: 'AUTO_MATCHED' | 'REVIEW_REQUIRED' | null = null;
    if (top.score >= config.autoThreshold && margin >= config.minMargin) desiredStatus = 'AUTO_MATCHED';
    else if (top.score >= config.reviewThreshold) desiredStatus = 'REVIEW_REQUIRED';
    if (!desiredStatus) continue;

    const [existingAssignment] = await db
      .select()
      .from(racepicAssignment)
      .where(and(eq(racepicAssignment.imageId, imageId), eq(racepicAssignment.entryId, top.entryId)))
      .limit(1);

    if (existingAssignment?.source === 'MANUAL') {
      // Architekturprinzip (Abschnitt F): "Manuelle Entscheidungen werden durch Re-Runs nie ueberschrieben."
      continue;
    }

    if (existingAssignment) {
      await db
        .update(racepicAssignment)
        .set({
          status: desiredStatus,
          detectionId: detection.id,
          candidateId: topCandidateId,
          confidence: top.score.toFixed(5),
          source: 'AI',
          decidedByType: 'system',
          decidedById: null,
          decidedAt: new Date()
        })
        .where(eq(racepicAssignment.id, existingAssignment.id));
      await db.insert(racepicAssignmentEvent).values({
        assignmentId: existingAssignment.id,
        fromStatus: existingAssignment.status,
        toStatus: desiredStatus,
        actorType: 'system',
        reason: `rematch:${pipelineVersion}`
      });
    } else {
      const [created] = await db
        .insert(racepicAssignment)
        .values({
          imageId,
          entryId: top.entryId,
          detectionId: detection.id,
          candidateId: topCandidateId,
          status: desiredStatus,
          source: 'AI',
          confidence: top.score.toFixed(5),
          decidedByType: 'system'
        })
        .returning();
      if (created) {
        await db.insert(racepicAssignmentEvent).values({
          assignmentId: created.id,
          fromStatus: null,
          toStatus: desiredStatus,
          actorType: 'system',
          reason: `match:${pipelineVersion}`
        });
      }
    }
  }

  await db.update(racepicImage).set({ processingStatus: 'MATCHED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
  await db
    .update(racepicProcessingStep)
    .set({ status: 'DONE', finishedAt: new Date() })
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'match'), eq(racepicProcessingStep.pipelineVersion, pipelineVersion)));
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { imageId?: string };
      if (!body.imageId) throw new Error('RACEPIC_MATCH_MISSING_IMAGE_ID');
      await processOneImage(body.imageId);
    } catch (error) {
      logOperationalEvent('error', 'racepic_match.failed', { errorCode: errorCodeOf(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
