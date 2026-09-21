import { and, asc, count, eq, ne } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  entry,
  eventClass,
  person,
  racepicAssignment,
  racepicAssignmentEvent,
  racepicDetection,
  racepicImage,
  racepicMatchCandidate,
  vehicle
} from '../db/schema';
import { RacePicError } from './repository';
import { presignGetObject } from './s3';

/**
 * Review-Queue (Paket 7), siehe docs/memory-bank/racepic-architecture.md Abschnitt H/18. Die
 * UI dazu liegt in MSC-Event-Frontend; dieses Modul stellt die dafuer noetigen, im Architekturplan
 * bereits vorgesehenen, aber bislang nicht gebauten Endpunkte bereit.
 *
 * Bewusste Vereinfachungen ggue. Abschnitt H:
 * - Offset-Pagination statt Keyset-Cursor (bei den hier erwarteten Datenmengen pro Verein/Event
 *   ausreichend, deutlich einfacher).
 * - Kein Soft-Lock pro Item (mehrere Reviewer koennten theoretisch dasselbe Bild gleichzeitig
 *   bearbeiten) - bei einem kleinen Orga-Team ein akzeptables Risiko fuer den MVP, siehe
 *   Progress-Datei fuer den offenen Punkt.
 */

const PREVIEW_URL_TTL_SECONDS = 300;

const previewKey = (imageId: string) => `derived/${imageId}/preview.webp`;

type CandidateDisplay = {
  candidateId: string;
  entryId: string;
  score: number;
  rank: number;
  driverName: string;
  startNumber: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
};

const loadCandidateDisplays = async (imageId: string, detectionId: string): Promise<CandidateDisplay[]> => {
  const db = await getDb();
  const rows = await db
    .select({
      candidateId: racepicMatchCandidate.id,
      entryId: racepicMatchCandidate.entryId,
      score: racepicMatchCandidate.score,
      rank: racepicMatchCandidate.rank,
      startNumber: entry.startNumberNorm,
      firstName: person.firstName,
      lastName: person.lastName,
      publicationName: person.publicationName,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model
    })
    .from(racepicMatchCandidate)
    .innerJoin(entry, eq(entry.id, racepicMatchCandidate.entryId))
    .innerJoin(person, eq(person.id, entry.driverPersonId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .where(and(eq(racepicMatchCandidate.imageId, imageId), eq(racepicMatchCandidate.detectionId, detectionId)))
    .orderBy(asc(racepicMatchCandidate.rank));

  return rows.map((row) => ({
    candidateId: row.candidateId,
    entryId: row.entryId,
    score: Number(row.score),
    rank: row.rank,
    // Admins sehen den echten Namen auch bei hinterlegtem Veroeffentlichungsnamen - das
    // Pseudonym betrifft nur die oeffentliche Anzeige (Paket 4/8), nicht die interne Zuordnung.
    driverName: `${row.firstName} ${row.lastName}`.trim(),
    startNumber: row.startNumber,
    vehicleMake: row.vehicleMake,
    vehicleModel: row.vehicleModel
  }));
};

export type ReviewQueueItem = {
  assignmentId: string;
  imageId: string;
  imagePreviewUrl: string;
  detection: { id: string; label: string; bbox: unknown } | null;
  confidence: number;
  suggestedEntryId: string;
  candidates: CandidateDisplay[];
};

export const listReviewQueue = async (eventId: string, offset: number, limit: number): Promise<{ items: ReviewQueueItem[]; total: number }> => {
  const db = await getDb();

  const rows = await db
    .select({
      assignmentId: racepicAssignment.id,
      imageId: racepicAssignment.imageId,
      entryId: racepicAssignment.entryId,
      confidence: racepicAssignment.confidence,
      detectionId: racepicDetection.id,
      detectionLabel: racepicDetection.label,
      detectionBbox: racepicDetection.bbox
    })
    .from(racepicAssignment)
    .innerJoin(racepicImage, eq(racepicImage.id, racepicAssignment.imageId))
    .leftJoin(racepicDetection, eq(racepicDetection.id, racepicAssignment.detectionId))
    .where(and(eq(racepicImage.eventId, eventId), eq(racepicAssignment.status, 'REVIEW_REQUIRED')))
    .orderBy(asc(racepicAssignment.decidedAt))
    .limit(limit)
    .offset(offset);

  const items = await Promise.all(
    rows.map(async (row) => ({
      assignmentId: row.assignmentId,
      imageId: row.imageId,
      imagePreviewUrl: await presignGetObject(previewKey(row.imageId), PREVIEW_URL_TTL_SECONDS),
      detection: row.detectionId ? { id: row.detectionId, label: row.detectionLabel!, bbox: row.detectionBbox } : null,
      confidence: Number(row.confidence ?? 0),
      suggestedEntryId: row.entryId,
      candidates: row.detectionId ? await loadCandidateDisplays(row.imageId, row.detectionId) : []
    }))
  );

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(racepicAssignment)
    .innerJoin(racepicImage, eq(racepicImage.id, racepicAssignment.imageId))
    .where(and(eq(racepicImage.eventId, eventId), eq(racepicAssignment.status, 'REVIEW_REQUIRED')));

  return { items, total };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writeAssignmentEvent = async (
  db: any,
  assignmentId: string,
  fromStatus: string | null,
  toStatus: string,
  actorId: string,
  reason: string
) => {
  await db.insert(racepicAssignmentEvent).values({ assignmentId, fromStatus, toStatus, actorType: 'admin', actorId, reason });
};

/** "Bestaetigen": die KI-Vorschlagszuordnung wird zur endgueltigen, manuellen Entscheidung. */
export const confirmAssignment = async (assignmentId: string, actorId: string) => {
  const db = await getDb();
  const [assignment] = await db.select().from(racepicAssignment).where(eq(racepicAssignment.id, assignmentId)).limit(1);
  if (!assignment) throw new RacePicError('RACEPIC_ASSIGNMENT_NOT_FOUND');
  await db
    .update(racepicAssignment)
    .set({ status: 'MANUALLY_CONFIRMED', source: 'MANUAL', decidedByType: 'admin', decidedById: actorId, decidedAt: new Date() })
    .where(eq(racepicAssignment.id, assignmentId));
  await writeAssignmentEvent(db, assignmentId, assignment.status, 'MANUALLY_CONFIRMED', actorId, 'review_confirm');
  return assignment;
};

/** "keine Zuordnung": die KI-Vorschlagszuordnung wird verworfen. */
export const rejectAssignment = async (assignmentId: string, actorId: string) => {
  const db = await getDb();
  const [assignment] = await db.select().from(racepicAssignment).where(eq(racepicAssignment.id, assignmentId)).limit(1);
  if (!assignment) throw new RacePicError('RACEPIC_ASSIGNMENT_NOT_FOUND');
  await db
    .update(racepicAssignment)
    .set({ status: 'REJECTED', source: 'MANUAL', decidedByType: 'admin', decidedById: actorId, decidedAt: new Date() })
    .where(eq(racepicAssignment.id, assignmentId));
  await writeAssignmentEvent(db, assignmentId, assignment.status, 'REJECTED', actorId, 'review_reject');
  return assignment;
};

/**
 * "anderen Fahrer waehlen": verwirft den bisherigen Vorschlag und legt eine neue, manuell
 * korrigierte Zuordnung fuer den gewaehlten Fahrer an (oder aktualisiert eine vorhandene, sofern
 * fuer diesen Fahrer bei diesem Bild schon eine existiert).
 */
export const correctAssignment = async (assignmentId: string, newEntryId: string, actorId: string) => {
  const db = await getDb();
  const [assignment] = await db.select().from(racepicAssignment).where(eq(racepicAssignment.id, assignmentId)).limit(1);
  if (!assignment) throw new RacePicError('RACEPIC_ASSIGNMENT_NOT_FOUND');

  return db.transaction(async (tx) => {
    await tx
      .update(racepicAssignment)
      .set({ status: 'REJECTED', source: 'MANUAL', decidedByType: 'admin', decidedById: actorId, decidedAt: new Date() })
      .where(eq(racepicAssignment.id, assignmentId));
    await writeAssignmentEvent(tx, assignmentId, assignment.status, 'REJECTED', actorId, 'review_correct:superseded');

    const [existingForNewEntry] = await tx
      .select()
      .from(racepicAssignment)
      .where(and(eq(racepicAssignment.imageId, assignment.imageId), eq(racepicAssignment.entryId, newEntryId)))
      .limit(1);

    if (existingForNewEntry) {
      await tx
        .update(racepicAssignment)
        .set({
          status: 'MANUALLY_CORRECTED',
          detectionId: assignment.detectionId,
          source: 'MANUAL',
          decidedByType: 'admin',
          decidedById: actorId,
          decidedAt: new Date()
        })
        .where(eq(racepicAssignment.id, existingForNewEntry.id));
      await writeAssignmentEvent(tx, existingForNewEntry.id, existingForNewEntry.status, 'MANUALLY_CORRECTED', actorId, 'review_correct');
      return existingForNewEntry.id;
    }

    const [created] = await tx
      .insert(racepicAssignment)
      .values({
        imageId: assignment.imageId,
        entryId: newEntryId,
        detectionId: assignment.detectionId,
        status: 'MANUALLY_CORRECTED',
        source: 'MANUAL',
        decidedByType: 'admin',
        decidedById: actorId
      })
      .returning();
    if (!created) throw new RacePicError('RACEPIC_ASSIGNMENT_CREATE_FAILED');
    await writeAssignmentEvent(tx, created.id, null, 'MANUALLY_CORRECTED', actorId, 'review_correct');
    return created.id;
  });
};

/** "weitere Zuordnung": ein zusaetzlicher Fahrer wird demselben Bild zugeordnet (mehrere Fahrzeuge pro Bild, Abschnitt C). */
export const addAssignment = async (imageId: string, entryId: string, detectionId: string | null, actorId: string) => {
  const db = await getDb();
  const [image] = await db.select({ id: racepicImage.id }).from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');

  const [existing] = await db
    .select()
    .from(racepicAssignment)
    .where(and(eq(racepicAssignment.imageId, imageId), eq(racepicAssignment.entryId, entryId)))
    .limit(1);
  if (existing) throw new RacePicError('RACEPIC_ASSIGNMENT_ALREADY_EXISTS');

  const [created] = await db
    .insert(racepicAssignment)
    .values({ imageId, entryId, detectionId, status: 'MANUALLY_CONFIRMED', source: 'MANUAL', decidedByType: 'admin', decidedById: actorId })
    .returning();
  if (!created) throw new RacePicError('RACEPIC_ASSIGNMENT_CREATE_FAILED');
  await writeAssignmentEvent(db, created.id, null, 'MANUALLY_CONFIRMED', actorId, 'review_add');
  return created;
};

/** Fahreransicht zur Korrektur (Abschnitt H: `GET /admin/racepic/participants/{entryId}/images`). */
export const listImagesForEntry = async (entryId: string) => {
  const db = await getDb();
  const rows = await db
    .select({ assignmentId: racepicAssignment.id, imageId: racepicAssignment.imageId, status: racepicAssignment.status, confidence: racepicAssignment.confidence })
    .from(racepicAssignment)
    .where(and(eq(racepicAssignment.entryId, entryId), ne(racepicAssignment.status, 'REJECTED')));

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      confidence: row.confidence ? Number(row.confidence) : null,
      imagePreviewUrl: await presignGetObject(previewKey(row.imageId), PREVIEW_URL_TTL_SECONDS)
    }))
  );
};

/** Fuer die Fahrer-Suche im "anderen Fahrer waehlen"-Dialog. */
export const searchEntriesByEvent = async (eventId: string, query: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      entryId: entry.id,
      startNumber: entry.startNumberNorm,
      firstName: person.firstName,
      lastName: person.lastName,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model
    })
    .from(entry)
    .innerJoin(person, eq(person.id, entry.driverPersonId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .where(eq(entry.eventId, eventId));

  const normalizedQuery = query.trim().toLowerCase();
  return rows
    .filter((row) => {
      if (!normalizedQuery) return true;
      const haystack = `${row.startNumber ?? ''} ${row.firstName} ${row.lastName} ${row.vehicleMake ?? ''} ${row.vehicleModel ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, 25)
    .map((row) => ({
      entryId: row.entryId,
      startNumber: row.startNumber,
      driverName: `${row.firstName} ${row.lastName}`.trim(),
      vehicleMake: row.vehicleMake,
      vehicleModel: row.vehicleModel
    }));
};
