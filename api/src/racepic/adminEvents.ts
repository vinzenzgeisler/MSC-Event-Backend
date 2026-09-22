import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { event, racepicEvent, racepicImage, racepicPhotographer, racepicPhotographerEvent } from '../db/schema';
import { RacePicError } from './repository';
import { presignGetObject } from './s3';

/**
 * Admin-Verwaltung von RacePic pro Event (Paket 5: Admin-Basis), siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt H. Eigenes Modul statt Erweiterung von
 * repository.ts (dort geht es um Fotografen-Identitaet, hier um Event-Konfiguration).
 */

export type EventWithRacepicConfig = {
  eventId: string;
  eventName: string;
  startsAt: string;
  endsAt: string;
  racepic: {
    slug: string;
    title: string;
    enabled: boolean;
    uploadOpensAt: Date | null;
    uploadClosesAt: Date | null;
    published: boolean;
    defaultLicenseId: string | null;
  } | null;
};

export const listEventsWithRacepicConfig = async (): Promise<EventWithRacepicConfig[]> => {
  const db = await getDb();
  const rows = await db
    .select({
      eventId: event.id,
      eventName: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      racepicSlug: racepicEvent.slug,
      racepicTitle: racepicEvent.title,
      racepicEnabled: racepicEvent.enabled,
      racepicUploadOpensAt: racepicEvent.uploadOpensAt,
      racepicUploadClosesAt: racepicEvent.uploadClosesAt,
      racepicPublished: racepicEvent.published,
      racepicDefaultLicenseId: racepicEvent.defaultLicenseId
    })
    .from(event)
    .leftJoin(racepicEvent, eq(racepicEvent.eventId, event.id))
    .orderBy(event.startsAt);

  return rows.map((row) => ({
    eventId: row.eventId,
    eventName: row.eventName,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    racepic: row.racepicSlug
      ? {
          slug: row.racepicSlug,
          title: row.racepicTitle ?? row.eventName,
          enabled: row.racepicEnabled ?? false,
          uploadOpensAt: row.racepicUploadOpensAt,
          uploadClosesAt: row.racepicUploadClosesAt,
          published: row.racepicPublished ?? false,
          defaultLicenseId: row.racepicDefaultLicenseId
        }
      : null
  }));
};

export type RacepicEventPatch = {
  slug: string;
  title: string;
  enabled: boolean;
  uploadOpensAt: Date | null;
  uploadClosesAt: Date | null;
  published: boolean;
  defaultLicenseId: string | null;
};

/** Legt die racepic_event-Zeile an oder aktualisiert sie (1:1 zu `event`, siehe Migration 0095). */
export const upsertRacepicEventConfig = async (eventId: string, patch: RacepicEventPatch) => {
  const db = await getDb();
  const [eventRow] = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (!eventRow) throw new RacePicError('RACEPIC_EVENT_NOT_FOUND');

  const [existing] = await db.select().from(racepicEvent).where(eq(racepicEvent.eventId, eventId)).limit(1);
  if (existing) {
    const [updated] = await db
      .update(racepicEvent)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(racepicEvent.eventId, eventId))
      .returning();
    return updated;
  }
  const [created] = await db.insert(racepicEvent).values({ eventId, ...patch }).returning();
  return created;
};

export type RacepicEventStats = {
  photographerCount: number;
  imagesByStatus: Record<string, number>;
  imagesByVisibility: Record<string, number>;
};

export const getEventStats = async (eventId: string): Promise<RacepicEventStats> => {
  const db = await getDb();

  const [{ value: photographerCount }] = await db
    .select({ value: count() })
    .from(racepicPhotographerEvent)
    .where(eq(racepicPhotographerEvent.eventId, eventId));

  const statusRows = await db
    .select({ status: racepicImage.processingStatus, value: count() })
    .from(racepicImage)
    .where(eq(racepicImage.eventId, eventId))
    .groupBy(racepicImage.processingStatus);

  const visibilityRows = await db
    .select({ visibility: racepicImage.visibility, value: count() })
    .from(racepicImage)
    .where(eq(racepicImage.eventId, eventId))
    .groupBy(racepicImage.visibility);

  return {
    photographerCount,
    imagesByStatus: Object.fromEntries(statusRows.map((row) => [row.status, row.value])),
    imagesByVisibility: Object.fromEntries(visibilityRows.map((row) => [row.visibility, row.value]))
  };
};

export type RacepicAdminImageListItem = {
  id: string;
  previewUrl: string | null;
  visibility: string;
  processingStatus: string;
  photographerDisplayName: string;
  capturedAt: string | null;
  createdAt: string;
};

/**
 * Allgemeine Bildliste fuer ein Event (Paket 11), siehe Bestandsaufnahme 2026-09-22 in
 * racepic-progress.md: bislang gab es keinen Weg, Bilder eines Events unabhaengig von einer
 * bereits bestehenden Zuordnung zu sehen (Review-Queue zeigt nur REVIEW_REQUIRED, die
 * Fahrer-Ansicht nur bereits zugeordnete Bilder) - ohne diese Liste konnte ein frisch
 * hochgeladenes (`visibility=DRAFT`) Bild admin-seitig nie erreicht/veroeffentlicht werden, wenn
 * es (noch) keine Zuordnung hatte. Offset-Pagination wie im Rest des RacePic-Admin-Bereichs.
 */
export const listImagesForEvent = async (
  eventId: string,
  filter: { visibility?: string; processingStatus?: string },
  offset: number,
  limit: number
): Promise<{ items: RacepicAdminImageListItem[]; total: number }> => {
  const db = await getDb();
  const conditions = [eq(racepicImage.eventId, eventId)];
  if (filter.visibility) conditions.push(eq(racepicImage.visibility, filter.visibility));
  if (filter.processingStatus) conditions.push(eq(racepicImage.processingStatus, filter.processingStatus));
  const where = and(...conditions);

  const [{ value: total }] = await db.select({ value: count() }).from(racepicImage).where(where);

  const rows = await db
    .select({
      id: racepicImage.id,
      visibility: racepicImage.visibility,
      processingStatus: racepicImage.processingStatus,
      photographerDisplayName: racepicPhotographer.displayName,
      capturedAt: racepicImage.capturedAt,
      createdAt: racepicImage.createdAt
    })
    .from(racepicImage)
    .innerJoin(racepicPhotographer, eq(racepicPhotographer.id, racepicImage.photographerId))
    .where(where)
    .orderBy(desc(racepicImage.createdAt))
    .limit(limit)
    .offset(offset);

  const items = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      // Nur die private derived/-Vorschau (kein Abhaengigkeit davon, ob das Bild schon
      // oeffentlich ist) - dieselbe Quelle wie die Review-Queue (Paket 7).
      previewUrl: ['UPLOADED', 'VALIDATED'].includes(row.processingStatus)
        ? null
        : await presignGetObject(`derived/${row.id}/preview.webp`, 300).catch(() => null),
      visibility: row.visibility,
      processingStatus: row.processingStatus,
      photographerDisplayName: row.photographerDisplayName,
      capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString()
    }))
  );

  return { items, total };
};

/** Fuer die Fotografen-Liste im Admin (Paket 5), inkl. je Fotograf zugeteilter Events. */
export const listPhotographersWithEventAccess = async () => {
  const db = await getDb();
  const photographers = await db.select().from(racepicPhotographer);
  if (photographers.length === 0) return [];
  const accessRows = await db
    .select({ photographerId: racepicPhotographerEvent.photographerId, eventId: event.id, eventName: event.name })
    .from(racepicPhotographerEvent)
    .innerJoin(event, eq(event.id, racepicPhotographerEvent.eventId))
    .where(inArray(racepicPhotographerEvent.photographerId, photographers.map((p) => p.id)));

  const accessByPhotographer = new Map<string, { eventId: string; eventName: string }[]>();
  for (const row of accessRows) {
    const list = accessByPhotographer.get(row.photographerId) ?? [];
    list.push({ eventId: row.eventId, eventName: row.eventName });
    accessByPhotographer.set(row.photographerId, list);
  }

  return photographers.map((photographer) => ({
    ...photographer,
    events: accessByPhotographer.get(photographer.id) ?? []
  }));
};
