import { count, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { event, racepicEvent, racepicImage, racepicPhotographer, racepicPhotographerEvent } from '../db/schema';
import { RacePicError } from './repository';

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
