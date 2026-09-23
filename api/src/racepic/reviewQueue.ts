import { and, asc, eq, isNull, ne } from 'drizzle-orm';
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
  assignmentId: string | null;
  imageId: string;
  imagePreviewUrl: string;
  detection: { id: string; label: string; bbox: unknown } | null;
  confidence: number;
  suggestedEntryId: string | null;
  candidates: CandidateDisplay[];
};

export const listReviewQueue = async (eventId: string, offset: number, limit: number): Promise<{ items: ReviewQueueItem[]; total: number }> => {
  const db = await getDb();

  // Bug gefunden 2026-09-23 (Nutzer-Feedback: "komische Duplikate mit und ohne Bild"): removeImage()
  // loescht die S3-Objekte und setzt visibility='REMOVED', laesst processingStatus aber auf
  // 'MATCHED' und die Assignment-/Detection-Zeilen unangetastet - beide Queries unten filterten
  // bislang nicht auf visibility. Ein entferntes Bild blieb dadurch als (dann permanent kaputter,
  // bildloser) Eintrag in der Queue stehen, parallel zum frisch hochgeladenen Ersatzbild.

  // 1) Von der KI vorgeschlagene, aber noch nicht entschiedene Zuordnungen.
  const reviewRows = await db
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
    .where(and(eq(racepicImage.eventId, eventId), eq(racepicAssignment.status, 'REVIEW_REQUIRED'), ne(racepicImage.visibility, 'REMOVED')));

  // 2) Erkannte Fahrzeuge ganz ohne Zuordnung (Bug gefunden 2026-09-22, Nutzer-Feedback: "wenn gar
  // kein Match gibt, dass es dann zur Queue-Ansicht geht" und "wenn zwei oder mehr Fahrzeuge im
  // Bild dann soll das in der Queue-Ansicht auch direkt klickbar sein") - matchWorker legt fuer ein
  // Fahrzeug ohne Kandidat ueber der reviewThreshold ueberhaupt keine racepic_assignment-Zeile an
  // (siehe `if (!desiredStatus) continue;`); ein solches Bild - oder ein zweites Fahrzeug auf einem
  // bereits teilweise zugeordneten Bild - verschwand dadurch bisher spurlos aus jeder Uebersicht.
  // Ein Detection zaehlt nur dann als offen, wenn es ueberhaupt noch keine (auch abgelehnte)
  // Zuordnung dafuer gibt - eine explizit abgelehnte Entscheidung soll nicht endlos wiederkehren.
  const orphanDetectionRows = await db
    .select({
      imageId: racepicDetection.imageId,
      detectionId: racepicDetection.id,
      detectionLabel: racepicDetection.label,
      detectionBbox: racepicDetection.bbox
    })
    .from(racepicDetection)
    .innerJoin(racepicImage, eq(racepicImage.id, racepicDetection.imageId))
    .leftJoin(racepicAssignment, eq(racepicAssignment.detectionId, racepicDetection.id))
    .where(and(eq(racepicImage.eventId, eventId), eq(racepicImage.processingStatus, 'MATCHED'), isNull(racepicAssignment.id), ne(racepicImage.visibility, 'REMOVED')));

  const merged = [
    ...reviewRows.map((row) => ({
      assignmentId: row.assignmentId as string | null,
      imageId: row.imageId,
      entryId: row.entryId as string | null,
      confidence: Number(row.confidence ?? 0),
      detectionId: row.detectionId,
      detectionLabel: row.detectionLabel,
      detectionBbox: row.detectionBbox
    })),
    ...orphanDetectionRows.map((row) => ({
      assignmentId: null as string | null,
      imageId: row.imageId,
      entryId: null as string | null,
      confidence: 0,
      detectionId: row.detectionId as string | null,
      detectionLabel: row.detectionLabel as string | null,
      detectionBbox: row.detectionBbox
    }))
  ];

  const total = merged.length;
  const page = merged.slice(offset, offset + limit);

  const items = await Promise.all(
    page.map(async (row) => {
      const candidates = row.detectionId ? await loadCandidateDisplays(row.imageId, row.detectionId) : [];
      // Bug gefunden 2026-09-23 (Nutzer-Feedback: eine orphane Detection zeigte "#147 Hagen
      // Tzschoppe - BMW 318ti, 0% Konfidenz" an - ein irrefuehrend konkreter, aber komplett
      // erfundener "Treffer"): fuer orphane Detections (assignmentId=null) stand suggestedEntryId
      // fest auf null und confidence fest auf 0, das Frontend fiel beim Anzeigen aber still auf
      // candidates[0] zurueck - den bestbewerteten *gespeicherten* Kandidaten (der die
      // reviewThreshold eben NICHT erreicht hat), gepaart mit der erfundenen 0%. Jetzt wird fuer
      // orphane Zeilen, falls vorhanden, explizit der echte Top-Kandidat samt seinem tatsaechlichen
      // Score verwendet - immer noch klar als "unterhalb der Schwelle" markiert (assignmentId
      // bleibt null, kein Bestaetigen/Ablehnen moeglich), aber mit ehrlicher Zahl.
      const topCandidate = row.assignmentId === null ? candidates[0] : undefined;
      return {
        assignmentId: row.assignmentId,
        imageId: row.imageId,
        imagePreviewUrl: await presignGetObject(previewKey(row.imageId), PREVIEW_URL_TTL_SECONDS),
        detection: row.detectionId ? { id: row.detectionId, label: row.detectionLabel!, bbox: row.detectionBbox } : null,
        confidence: topCandidate ? topCandidate.score : row.confidence,
        suggestedEntryId: topCandidate ? topCandidate.entryId : row.entryId,
        candidates
      };
    })
  );

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

/**
 * Zuordnungs-Detail zu einem Bild (Paket 16: Admin-Redesign, siehe racepic-ux-redesign-plan.md) -
 * das Gegenstueck zu `listImagesForEntry` (dort nach `entryId`, hier nach `imageId`). Schliesst
 * die vom Verein genannte Lücke "wie ich die Zuordnung zum Fahrer sehen/ändern kann" direkt aus
 * der neuen Bilder-Grid-Ansicht heraus, ohne erst über die Fahrersuche gehen zu muessen.
 */
export type ImageAssignmentDisplay = {
  assignmentId: string;
  entryId: string;
  status: string;
  source: string;
  confidence: number | null;
  driverName: string;
  startNumber: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
};

export const listAssignmentsForImage = async (imageId: string): Promise<ImageAssignmentDisplay[]> => {
  const db = await getDb();
  const rows = await db
    .select({
      assignmentId: racepicAssignment.id,
      entryId: racepicAssignment.entryId,
      status: racepicAssignment.status,
      source: racepicAssignment.source,
      confidence: racepicAssignment.confidence,
      startNumber: entry.startNumberNorm,
      firstName: person.firstName,
      lastName: person.lastName,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model
    })
    .from(racepicAssignment)
    .innerJoin(entry, eq(entry.id, racepicAssignment.entryId))
    .innerJoin(person, eq(person.id, entry.driverPersonId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .where(eq(racepicAssignment.imageId, imageId))
    .orderBy(asc(racepicAssignment.decidedAt));

  return rows.map((row) => ({
    assignmentId: row.assignmentId,
    entryId: row.entryId,
    status: row.status,
    source: row.source,
    confidence: row.confidence ? Number(row.confidence) : null,
    driverName: `${row.firstName} ${row.lastName}`.trim(),
    startNumber: row.startNumber,
    vehicleMake: row.vehicleMake,
    vehicleModel: row.vehicleModel
  }));
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

/**
 * "Teilnehmer ausblenden" (Paket 9), siehe docs/memory-bank/racepic-architecture.md Abschnitt
 * "Datenschutz": "Bei Widerspruch gegen Bilder: Assignments auf REJECTED setzen und die Bilder
 * verbergen." Lehnt alle aktiven Zuordnungen dieser Nennung ab (Bilder mit *nur* dieser Nennung
 * verschwinden dadurch automatisch aus dem naechsten Manifest-Rebuild - andere, weiterhin gueltige
 * Zuordnungen desselben Bildes zu anderen Fahrern bleiben unberuehrt).
 */
export const hideParticipant = async (entryId: string, actorId: string): Promise<{ eventIds: string[]; rejectedCount: number }> => {
  const db = await getDb();
  const [entryRow] = await db.select({ eventId: entry.eventId }).from(entry).where(eq(entry.id, entryId)).limit(1);
  if (!entryRow) throw new RacePicError('RACEPIC_ENTRY_NOT_FOUND');

  const activeAssignments = await db
    .select()
    .from(racepicAssignment)
    .where(and(eq(racepicAssignment.entryId, entryId), ne(racepicAssignment.status, 'REJECTED')));

  for (const assignment of activeAssignments) {
    await db
      .update(racepicAssignment)
      .set({ status: 'REJECTED', source: 'MANUAL', decidedByType: 'admin', decidedById: actorId, decidedAt: new Date() })
      .where(eq(racepicAssignment.id, assignment.id));
    await writeAssignmentEvent(db, assignment.id, assignment.status, 'REJECTED', actorId, 'participant_hidden');
  }

  return { eventIds: [entryRow.eventId], rejectedCount: activeAssignments.length };
};
