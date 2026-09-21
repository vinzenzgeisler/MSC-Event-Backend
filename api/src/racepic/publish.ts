import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { getDb } from '../db/client';
import { eventClass, entry, person, racepicAssignment, racepicEvent, racepicImage, racepicImageVariant, vehicle } from '../db/schema';
import { RacePicError } from './repository';
import { copyObject, deleteObject, putObject } from './s3';

/**
 * Publish-Worker (Paket 4), siehe docs/memory-bank/racepic-architecture.md Abschnitt B/G/H.
 *
 * Trennung von der Ingest-Pipeline: der Ingest-Worker erzeugt alle Varianten immer privat unter
 * `derived/{imageId}/{kind}`. Erst wenn ein Bild veroeffentlicht wird (spaeter durch die
 * Review-Bestaetigung aus Paket 6/7 ausgeloest, hier zunaechst nur ueber die Admin-Route
 * `PATCH /admin/racepic/images/{id}` erreichbar), kopiert dieses Modul thumb/preview zusaetzlich
 * nach `public/{imageId}/{kind}.webp` (CDN-oeffentlich). Es gibt dafuer bewusst keine eigene
 * DB-Zeile: die `racepic_image_variant`-Zeile bleibt der kanonische private Pfad, `visibility` auf
 * `racepic_image` entscheidet, ob die oeffentliche Kopie existieren soll.
 */

const publicVariantKey = (imageId: string, kind: 'thumb' | 'preview'): string => `public/${imageId}/${kind}.webp`;
const derivedVariantKey = (imageId: string, kind: 'thumb' | 'preview'): string => `derived/${imageId}/${kind}.webp`;

const invalidateCloudFront = async (paths: string[]): Promise<void> => {
  const distributionId = process.env.RACEPIC_CDN_DISTRIBUTION_ID;
  if (!distributionId || paths.length === 0) {
    return;
  }
  const client = new CloudFrontClient({});
  await client
    .send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `racepic-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths }
        }
      })
    )
    .catch(() => undefined); // Best-effort: eine fehlgeschlagene Invalidation blockiert nie die Publish-Aktion selbst.
};

const loadImageOrThrow = async (imageId: string) => {
  const db = await getDb();
  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  return image;
};

export const getImageEventId = async (imageId: string): Promise<string | null> => {
  const db = await getDb();
  const [image] = await db.select({ eventId: racepicImage.eventId }).from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  return image?.eventId ?? null;
};

export const publishImage = async (imageId: string): Promise<void> => {
  const image = await loadImageOrThrow(imageId);
  if (!['DERIVED', 'ANALYZED', 'MATCHED'].includes(image.processingStatus)) {
    throw new RacePicError('RACEPIC_IMAGE_NOT_READY_TO_PUBLISH');
  }
  await Promise.all(
    (['thumb', 'preview'] as const).map((kind) => copyObject(derivedVariantKey(imageId, kind), publicVariantKey(imageId, kind)))
  );
  const db = await getDb();
  await db.update(racepicImage).set({ visibility: 'PUBLISHED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
  await invalidateCloudFront([`/public/${imageId}/*`]);
};

const unpublishObjects = async (imageId: string): Promise<void> => {
  await Promise.all((['thumb', 'preview'] as const).map((kind) => deleteObject(publicVariantKey(imageId, kind))));
  await invalidateCloudFront([`/public/${imageId}/*`]);
};

export const hideImage = async (imageId: string): Promise<void> => {
  await loadImageOrThrow(imageId);
  await unpublishObjects(imageId);
  const db = await getDb();
  await db.update(racepicImage).set({ visibility: 'HIDDEN', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
};

/**
 * Entfernt Bilddaten dauerhaft (S3 + `racepic_image`/`racepic_image_variant`), behaelt aber das
 * Audit (`racepic_assignment_event`) - siehe Architekturplan Abschnitt G "Loeschung": "Das Audit
 * bleibt ohne Bilddaten erhalten."
 */
export const removeImage = async (imageId: string): Promise<void> => {
  const image = await loadImageOrThrow(imageId);
  await unpublishObjects(imageId);
  if (image.originalKey) await deleteObject(image.originalKey);

  const db = await getDb();
  // Ueber die tatsaechlich gespeicherten Variant-Keys loeschen statt sie erneut zu konstruieren -
  // robuster gegenueber zukuenftigen Formataenderungen (z. B. andere Variantenkinds/-endungen).
  const variants = await db.select({ s3Key: racepicImageVariant.s3Key }).from(racepicImageVariant).where(eq(racepicImageVariant.imageId, imageId));
  await Promise.all(variants.map((variant) => deleteObject(variant.s3Key)));

  await db.delete(racepicImageVariant).where(eq(racepicImageVariant.imageId, imageId));
  await db.update(racepicImage).set({ visibility: 'REMOVED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'klasse';

export type ManifestParticipant = {
  participantKey: string;
  startNumber: string;
  className: string;
  vehicleType: string;
  displayName: string;
  make: string | null;
  model: string | null;
  imageCount: number;
  coverThumbUrl: string;
};

/**
 * Baut das Teilnehmer-Manifest fuer ein Event (Abschnitt H: `/m/{eventSlug}/index.json`).
 * Ohne Paket 6 (KI-Matching) gibt es noch keine `racepic_assignment`-Zeilen - das Ergebnis ist
 * dann bewusst eine leere Teilnehmerliste, kein Fehler. Der Mechanismus (Query, S3-Schreiben,
 * Invalidation) ist damit trotzdem vollstaendig und getestet.
 */
export const buildParticipantManifest = async (eventId: string): Promise<ManifestParticipant[]> => {
  const db = await getDb();
  const rows = await db
    .select({
      entryId: entry.id,
      startNumberNorm: entry.startNumberNorm,
      className: eventClass.name,
      vehicleType: eventClass.vehicleType,
      firstName: person.firstName,
      lastName: person.lastName,
      publicationName: person.publicationName,
      processingRestricted: person.processingRestricted,
      objectionFlag: person.objectionFlag,
      make: vehicle.make,
      model: vehicle.model,
      imageId: racepicAssignment.imageId
    })
    .from(racepicAssignment)
    .innerJoin(entry, eq(entry.id, racepicAssignment.entryId))
    .innerJoin(eventClass, eq(eventClass.id, entry.classId))
    .innerJoin(person, eq(person.id, entry.driverPersonId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .innerJoin(racepicImage, eq(racepicImage.id, racepicAssignment.imageId))
    .where(
      and(
        eq(entry.eventId, eventId),
        isNull(entry.deletedAt),
        eq(entry.consentMediaAccepted, true),
        eq(racepicImage.visibility, 'PUBLISHED'),
        inArray(racepicAssignment.status, ['AUTO_MATCHED', 'MANUALLY_CONFIRMED', 'MANUALLY_CORRECTED'])
      )
    );

  const byEntry = new Map<string, ManifestParticipant & { _imageIds: Set<string> }>();
  for (const row of rows) {
    // Datenschutz: Teilnehmer mit Widerspruch/Verarbeitungseinschraenkung erscheinen nicht in der
    // Namenssuche (siehe racepic-architecture.md Abschnitt "Datenschutz"); ein hinterlegter
    // Veroeffentlichungsname wird als Pseudonym angezeigt statt den echten Namen zu unterdruecken.
    if (row.processingRestricted || row.objectionFlag) continue;
    if (!row.startNumberNorm) continue;
    const displayName = row.publicationName?.trim() || `${row.firstName} ${row.lastName}`.trim();
    const participantKey = `${row.startNumberNorm}-${slugify(row.className)}`;
    const existing = byEntry.get(row.entryId);
    if (existing) {
      existing._imageIds.add(row.imageId);
      existing.imageCount = existing._imageIds.size;
    } else {
      byEntry.set(row.entryId, {
        participantKey,
        startNumber: row.startNumberNorm,
        className: row.className,
        vehicleType: row.vehicleType,
        displayName,
        make: row.make,
        model: row.model,
        imageCount: 1,
        coverThumbUrl: `/p/${row.imageId}/thumb.webp`,
        _imageIds: new Set([row.imageId])
      });
    }
  }

  return Array.from(byEntry.values())
    .map(({ _imageIds, ...rest }) => rest)
    .sort((a, b) => a.startNumber.localeCompare(b.startNumber, undefined, { numeric: true }));
};

export const regenerateManifestsForEvent = async (eventId: string): Promise<void> => {
  const db = await getDb();
  const [racepicEventRow] = await db.select().from(racepicEvent).where(eq(racepicEvent.eventId, eventId)).limit(1);
  if (!racepicEventRow || !racepicEventRow.published) {
    return;
  }
  const participants = await buildParticipantManifest(eventId);
  const manifestKey = `manifests/${racepicEventRow.slug}/index.json`;
  await putObject(manifestKey, Buffer.from(JSON.stringify({ eventId, slug: racepicEventRow.slug, title: racepicEventRow.title, participants })), 'application/json');

  const publishedEvents = await db.select().from(racepicEvent).where(and(eq(racepicEvent.enabled, true), eq(racepicEvent.published, true)));
  await putObject(
    'manifests/events.json',
    Buffer.from(JSON.stringify(publishedEvents.map((row) => ({ eventId: row.eventId, slug: row.slug, title: row.title })))),
    'application/json'
  );

  await invalidateCloudFront([`/m/${racepicEventRow.slug}/*`, '/m/events.json']);
};
