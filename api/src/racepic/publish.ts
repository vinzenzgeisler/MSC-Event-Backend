import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { getDb } from '../db/client';
import {
  commerceOfferVersion,
  commerceProduct,
  eventClass,
  entry,
  person,
  racepicAssignment,
  racepicEvent,
  racepicImage,
  racepicImageVariant,
  racepicLicense,
  racepicOfferConversionItem,
  racepicPhotographer,
  vehicle
} from '../db/schema';
import { RacePicError } from './repository';
import { copyObject, deleteObject, deleteObjectsByPrefix, listObjectKeys, putObject } from './s3';
import { slugify } from './slug';
import { isImagePubliclyEligible, listPubliclyEligibleImageIds } from './eligibility';
import { getCommerceFlags } from '../commerce/flags';
import { conversionArtifactKeys, paidPublicKey, publicVariantUrl } from '../commerce/objectKeys';
import { loadActiveOffersByImage, type ActiveOfferInfo } from '../commerce/publicOffers';

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
 *
 * URL-Konvention (Abweichung von den Kurzformen `/m/*`/`/p/*` aus dem Architekturplan Abschnitt H):
 * `infra/lib/stacks/racepic-stack.ts` hat CloudFront-Behaviors direkt auf die S3-Praefixe
 * `manifests/*` und `public/*` gelegt, keine zusaetzlichen Pfad-Aliase (haette eine CloudFront
 * Function oder weitere Behaviors gebraucht, ohne funktionalen Mehrwert). Oeffentliche URLs sehen
 * deshalb so aus: `https://{RACEPIC_CDN_DOMAIN}/manifests/{slug}/index.json` und
 * `.../public/{imageId}/thumb.webp`.
 */

const publicVariantKey = (imageId: string, kind: 'thumb' | 'preview'): string => `public/${imageId}/${kind}.webp`;
const derivedVariantKey = (imageId: string, kind: 'thumb' | 'preview'): string => `derived/${imageId}/${kind}.webp`;

export const invalidateCloudFront = async (paths: string[]): Promise<void> => {
  const distributionId = process.env.RACEPIC_CDN_DISTRIBUTION_ID;
  if (!distributionId || paths.length === 0) {
    return;
  }
  const client = new CloudFrontClient({});
  await client.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `racepic-${Date.now()}`,
        Paths: { Quantity: paths.length, Items: paths }
      }
    })
  );
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

export const getImagePhotographerId = async (imageId: string): Promise<string | null> => {
  const db = await getDb();
  const [image] = await db.select({ photographerId: racepicImage.photographerId }).from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  return image?.photographerId ?? null;
};

export const publishImage = async (imageId: string): Promise<void> => {
  const image = await loadImageOrThrow(imageId);
  if (image.offerMode !== 'FREE' && !(await hasPublicPaidOffer(imageId))) throw new RacePicError('RACEPIC_PAID_OFFER_NOT_PUBLIC');
  if (!['DERIVED', 'ANALYZED', 'MATCHED'].includes(image.processingStatus)) {
    throw new RacePicError('RACEPIC_IMAGE_NOT_READY_TO_PUBLISH');
  }
  if (!(await isImagePubliclyEligible(imageId, false))) {
    throw new RacePicError('RACEPIC_IMAGE_NOT_PUBLICLY_ELIGIBLE');
  }
  const db = await getDb();
  const [event] = await db.select({ enabled: racepicEvent.enabled, published: racepicEvent.published })
    .from(racepicEvent).where(eq(racepicEvent.eventId, image.eventId)).limit(1);
  if (event?.enabled && event.published) {
    await publishPublicObjectsForImage(imageId);
  }
  await db.update(racepicImage).set({ visibility: 'PUBLISHED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
  await invalidateCloudFront([`/public/${imageId}/*`]);
};

const unpublishObjects = async (imageId: string): Promise<void> => {
  // Praefix statt fester Keys: umfasst auch offer-versionierte PAID-Vorschauen (public/{id}/o{version}/...).
  await deleteObjectsByPrefix(`public/${imageId}/`);
  await invalidateCloudFront([`/public/${imageId}/*`]);
};

/** Wahr, wenn das Bild eine aktive PAID-Version hat und PAID-Angebote oeffentlich gelistet werden duerfen. */
const hasPublicPaidOffer = async (imageId: string): Promise<boolean> => {
  if (!getCommerceFlags().commercePaidOffers) return false;
  return (await loadActiveOffersByImage([imageId])).get(imageId)?.mode === 'PAID';
};

/**
 * Kopiert die oeffentlichen Vorschauobjekte eines Bildes: FREE wie bisher unversioniert, PAID ausschliesslich
 * als wasserzeichenbehaftete, offer-versionierte Kopie. Ohne aktive PAID-Version (oder bei ausgeschaltetem
 * Flag `commercePaidOffers`) wird nie etwas veroeffentlicht.
 */
export const publishPublicObjectsForImage = async (imageId: string): Promise<void> => {
  const image = await loadImageOrThrow(imageId);
  if (image.offerMode === 'PAID') {
    if (!getCommerceFlags().commercePaidOffers) return;
    const offer = (await loadActiveOffersByImage([imageId])).get(imageId);
    if (!offer || offer.mode !== 'PAID') return;
    const keys = conversionArtifactKeys(imageId, offer.offerVersionId);
    await copyObject(keys.watermarkedThumb, paidPublicKey(imageId, offer.version, 'thumb'));
    await copyObject(keys.watermarkedPreview, paidPublicKey(imageId, offer.version, 'preview'));
    return;
  }
  await Promise.all((['thumb', 'preview'] as const).map((kind) => copyObject(derivedVariantKey(imageId, kind), publicVariantKey(imageId, kind))));
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

/**
 * Loescht ein bereits entferntes Bild endgueltig aus der Datenbank (Feedback 2026-09-22: "ich
 * will es komplett entfernen können mit der Prämisse dass natürlich kein Kauf dahinter hängt" -
 * im MVP gab es noch keinen echten Checkout, die Praemisse war also fuer jedes RacePic-Bild
 * erfuellt). Setzt `visibility='REMOVED'` voraus (kein Direkt-Hard-Delete aus PUBLISHED/HIDDEN,
 * damit `removeImage` immer zuerst die S3-Objekte aufraeumt). Kaskadiert per FK auch
 * `racepic_assignment`/`racepic_assignment_event` fuer dieses Bild weg - bewusster Bruch mit der
 * sonst geltenden Architekturregel "Das Audit bleibt ohne Bilddaten erhalten" (Abschnitt G), aber
 * hier vom Nutzer explizit so gewollt ("komplett entfernen"); die allgemeine Admin-Audit-Log-Zeile
 * fuer die Loeschaktion selbst (writeAuditLog, siehe handler.ts) bleibt unabhaengig davon erhalten.
 *
 * Bug gefunden 2026-09-29 (Postgres 23503 foreign_key_violation, 500 statt sauberer Fehlermeldung):
 * die obige "kein Kauf dahinter"-Praemisse stimmt seit der Commerce-Grundlage (AP02/AP03) nicht
 * mehr unbedingt - jedes Bild bekommt beim Backfill eine `commerce_product`-Zeile (ON DELETE
 * RESTRICT auf racepic_image), aktive/vergangene Preisstufen dazu `commerce_offer_version`-Zeilen
 * (RESTRICT auf commerce_product), eine abgeschlossene FREE->PAID-Umstellung zusaetzlich eine
 * `racepic_offer_conversion_item`-Zeile (RESTRICT auf racepic_image). Bestellungen/Zahlungen
 * referenzieren diese Zeilen nicht per FK (sie halten stattdessen einen unveraenderlichen
 * Preis-Snapshot), koennen ein Loeschen hier also nicht verhindern - genau deshalb ist es sicher,
 * dieses reine Produkt-/Preisstufen-Bucheintrag-Beiwerk in derselben Transaktion mitzuloeschen,
 * statt die urspruengliche Praemisse als generelle RESTRICT-Sperre stehen zu lassen.
 */
export const hardDeleteImage = async (imageId: string): Promise<void> => {
  const image = await loadImageOrThrow(imageId);
  if (image.visibility !== 'REMOVED') throw new RacePicError('RACEPIC_IMAGE_NOT_REMOVED');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [product] = await tx.select({ id: commerceProduct.id }).from(commerceProduct).where(eq(commerceProduct.racepicImageId, imageId)).limit(1);
    if (product) {
      await tx.delete(commerceOfferVersion).where(eq(commerceOfferVersion.productId, product.id));
      await tx.delete(commerceProduct).where(eq(commerceProduct.id, product.id));
    }
    await tx.delete(racepicOfferConversionItem).where(eq(racepicOfferConversionItem.imageId, imageId));
    await tx.delete(racepicImage).where(eq(racepicImage.id, imageId));
  });
};

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

export type ManifestImage = {
  imageId: string;
  thumbUrl: string;
  previewUrl: string;
  width: number | null;
  height: number | null;
  title: string | null;
  description: string | null;
  tags: string[];
  camera: unknown;
  capturedAt: string | null;
  createdAt: string;
  photographer: { displayName: string; website: string | null; slug: string | null };
  license: { code: string; title: unknown; attributionRequired: boolean; attributionTemplate: string | null };
  /** Angebot laut aktiver Angebotsversion; Preis nur zur Anzeige, autoritativ bleibt die serverseitige Quote. */
  offer: { mode: 'FREE' | 'PAID'; priceCents: number | null; currency: 'EUR' };
};

const manifestOffer = (offer: ActiveOfferInfo | undefined): ManifestImage['offer'] =>
  offer?.mode === 'PAID' ? { mode: 'PAID', priceCents: offer.priceCents, currency: 'EUR' } : { mode: 'FREE', priceCents: null, currency: 'EUR' };

type ManifestData = { participants: ManifestParticipant[]; imagesByParticipantKey: Map<string, ManifestImage[]> };

/**
 * Baut Teilnehmerliste UND Bilder je Teilnehmer in einem Durchlauf (Abschnitt H:
 * `/manifests/{eventSlug}/index.json` und `/manifests/{eventSlug}/p/{participantKey}.json`, siehe
 * URL-Konvention oben). Ohne Paket 6-Zuordnungen bzw. vor der ersten Veroeffentlichung ist das
 * Ergebnis bewusst leer, kein Fehler - der Mechanismus (Query, S3-Schreiben, Invalidation) ist
 * trotzdem vollstaendig.
 */
const buildManifestData = async (eventId: string): Promise<ManifestData> => {
  const db = await getDb();
  const eligibleImageIds = await listPubliclyEligibleImageIds(eventId);
  if (eligibleImageIds.size === 0) return { participants: [], imagesByParticipantKey: new Map() };
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
      imageId: racepicImage.id,
      imageWidth: racepicImage.width,
      imageHeight: racepicImage.height,
      imageTitle: racepicImage.title,
      imageDescription: racepicImage.description,
      imageTags: racepicImage.tags,
      imageCamera: racepicImage.camera,
      imageCapturedAt: racepicImage.capturedAt,
      imageCreatedAt: racepicImage.createdAt,
      photographerDisplayName: racepicPhotographer.displayName,
      photographerWebsite: racepicPhotographer.website,
      photographerSlug: racepicPhotographer.slug,
      licenseCode: racepicLicense.code,
      licenseTitle: racepicLicense.title,
      licenseAttributionRequired: racepicLicense.attributionRequired,
      licenseAttributionTemplate: racepicLicense.attributionTemplate
    })
    .from(racepicAssignment)
    .innerJoin(entry, eq(entry.id, racepicAssignment.entryId))
    .innerJoin(eventClass, eq(eventClass.id, entry.classId))
    .innerJoin(person, eq(person.id, entry.driverPersonId))
    .innerJoin(vehicle, eq(vehicle.id, entry.vehicleId))
    .innerJoin(racepicImage, eq(racepicImage.id, racepicAssignment.imageId))
    .innerJoin(racepicPhotographer, eq(racepicPhotographer.id, racepicImage.photographerId))
    .innerJoin(racepicLicense, eq(racepicLicense.id, racepicImage.licenseId))
    .where(
      and(
        eq(entry.eventId, eventId),
        isNull(entry.deletedAt),
        eq(entry.registrationStatus, 'submitted_verified'),
        eq(entry.acceptanceStatus, 'accepted'),
        eq(entry.consentMediaAccepted, true),
        inArray(racepicImage.id, Array.from(eligibleImageIds)),
        eq(racepicImage.visibility, 'PUBLISHED'),
        inArray(racepicAssignment.status, ['AUTO_MATCHED', 'MANUALLY_CONFIRMED', 'MANUALLY_CORRECTED'])
      )
    );

  const byEntry = new Map<string, ManifestParticipant & { _imageIds: Set<string> }>();
  const imagesByParticipantKey = new Map<string, ManifestImage[]>();
  const activeOffers = await loadActiveOffersByImage(Array.from(new Set(rows.map((row) => row.imageId))));

  for (const row of rows) {
    // Datenschutz: Teilnehmer mit Widerspruch/Verarbeitungseinschraenkung erscheinen nicht in der
    // Namenssuche (siehe racepic-architecture.md Abschnitt "Datenschutz"); ein hinterlegter
    // Veroeffentlichungsname wird als Pseudonym angezeigt statt den echten Namen zu unterdruecken.
    if (row.processingRestricted || row.objectionFlag) continue;
    if (!row.startNumberNorm) continue;
    const displayName = row.publicationName?.trim() || `${row.firstName} ${row.lastName}`.trim();
    const participantKey = `${row.startNumberNorm}-${slugify(row.className, 'klasse')}`;

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
        coverThumbUrl: publicVariantUrl(row.imageId, 'thumb', activeOffers.get(row.imageId)),
        _imageIds: new Set([row.imageId])
      });
    }

    const images = imagesByParticipantKey.get(participantKey) ?? [];
    if (!images.some((image) => image.imageId === row.imageId)) {
      images.push({
        imageId: row.imageId,
        thumbUrl: publicVariantUrl(row.imageId, 'thumb', activeOffers.get(row.imageId)),
        previewUrl: publicVariantUrl(row.imageId, 'preview', activeOffers.get(row.imageId)),
        offer: manifestOffer(activeOffers.get(row.imageId)),
        width: row.imageWidth,
        height: row.imageHeight,
        title: row.imageTitle,
        description: row.imageDescription,
        tags: Array.isArray(row.imageTags) ? row.imageTags as string[] : [],
        camera: row.imageCamera,
        capturedAt: row.imageCapturedAt ? row.imageCapturedAt.toISOString() : null,
        createdAt: row.imageCreatedAt.toISOString(),
        photographer: { displayName: row.photographerDisplayName, website: row.photographerWebsite, slug: row.photographerSlug },
        license: {
          code: row.licenseCode,
          title: row.licenseTitle,
          attributionRequired: row.licenseAttributionRequired,
          attributionTemplate: row.licenseAttributionTemplate
        }
      });
      imagesByParticipantKey.set(participantKey, images);
    }
  }

  const participants = Array.from(byEntry.values())
    .map(({ _imageIds, ...rest }) => rest)
    .sort((a, b) => a.startNumber.localeCompare(b.startNumber, undefined, { numeric: true }));

  return { participants, imagesByParticipantKey };
};

/**
 * Veroeffentlichte Bilder ohne (aktive) Fahrer-Zuordnung (Nutzerwunsch 2026-09-23: "es gibt auch
 * Fahrzeuge, die ich wirklich nicht erkenne, nicht mal manuell - diese sollen auch einfach ohne
 * Fahrer-Zuordnung im RacePic herunterladbar sein"). `requestImageDownload` (download.ts) prueft
 * ohnehin keine Zuordnung, das Bild war also technisch schon laenger herunterladbar - nur *finden*
 * konnte man es nirgendwo, weil `buildManifestData` oben ausschliesslich ueber Zuordnungen
 * (racepic_assignment -> entry) geht. Diese Bilder tauchen deshalb NICHT auf einer
 * Teilnehmer-Seite auf (es gibt ja keinen Fahrer dazu), aber im globalen Discover-Feed und mit
 * eigener Bild-Detailseite (`i/{imageId}.json`), siehe regenerateManifestsForEvent/
 * regenerateGlobalDiscoveryManifests unten.
 */
const listUnassignedPublishedImages = async (eventId: string): Promise<ManifestImage[]> => {
  const db = await getDb();
  const eligibleImageIds = await listPubliclyEligibleImageIds(eventId);
  if (eligibleImageIds.size === 0) return [];
  const activeAssignments = await db
    .selectDistinct({ imageId: racepicAssignment.imageId })
    .from(racepicAssignment)
    .innerJoin(racepicImage, eq(racepicImage.id, racepicAssignment.imageId))
    .where(and(eq(racepicImage.eventId, eventId), inArray(racepicAssignment.status, ['AUTO_MATCHED', 'MANUALLY_CONFIRMED', 'MANUALLY_CORRECTED'])));
  const assignedImageIds = activeAssignments.map((row) => row.imageId);

  const rows = await db
    .select({
      imageId: racepicImage.id,
      imageWidth: racepicImage.width,
      imageHeight: racepicImage.height,
      imageTitle: racepicImage.title,
      imageDescription: racepicImage.description,
      imageTags: racepicImage.tags,
      imageCamera: racepicImage.camera,
      imageCapturedAt: racepicImage.capturedAt,
      imageCreatedAt: racepicImage.createdAt,
      photographerDisplayName: racepicPhotographer.displayName,
      photographerWebsite: racepicPhotographer.website,
      photographerSlug: racepicPhotographer.slug,
      licenseCode: racepicLicense.code,
      licenseTitle: racepicLicense.title,
      licenseAttributionRequired: racepicLicense.attributionRequired,
      licenseAttributionTemplate: racepicLicense.attributionTemplate
    })
    .from(racepicImage)
    .innerJoin(racepicPhotographer, eq(racepicPhotographer.id, racepicImage.photographerId))
    .innerJoin(racepicLicense, eq(racepicLicense.id, racepicImage.licenseId))
    .where(and(
      eq(racepicImage.eventId, eventId),
      eq(racepicImage.visibility, 'PUBLISHED'),
      inArray(racepicImage.id, Array.from(eligibleImageIds)),
      assignedImageIds.length > 0 ? notInArray(racepicImage.id, assignedImageIds) : undefined
    ));

  const activeOffers = await loadActiveOffersByImage(rows.map((row) => row.imageId));
  return rows.map((row) => ({
    imageId: row.imageId,
    thumbUrl: publicVariantUrl(row.imageId, 'thumb', activeOffers.get(row.imageId)),
    previewUrl: publicVariantUrl(row.imageId, 'preview', activeOffers.get(row.imageId)),
    offer: manifestOffer(activeOffers.get(row.imageId)),
    width: row.imageWidth,
    height: row.imageHeight,
    title: row.imageTitle,
    description: row.imageDescription,
    tags: Array.isArray(row.imageTags) ? row.imageTags as string[] : [],
    camera: row.imageCamera,
    capturedAt: row.imageCapturedAt ? row.imageCapturedAt.toISOString() : null,
    createdAt: row.imageCreatedAt.toISOString(),
    photographer: { displayName: row.photographerDisplayName, website: row.photographerWebsite, slug: row.photographerSlug },
    license: {
      code: row.licenseCode,
      title: row.licenseTitle,
      attributionRequired: row.licenseAttributionRequired,
      attributionTemplate: row.licenseAttributionTemplate
    }
  }));
};

export const regenerateManifestsForEvent = async (eventId: string): Promise<void> => {
  const db = await getDb();
  const [racepicEventRow] = await db.select().from(racepicEvent).where(eq(racepicEvent.eventId, eventId)).limit(1);
  if (!racepicEventRow || !racepicEventRow.published || !racepicEventRow.enabled) {
    return;
  }

  const { participants, imagesByParticipantKey } = await buildManifestData(eventId);
  const unassignedImages = await listUnassignedPublishedImages(eventId);
  const slug = racepicEventRow.slug;
  const oldDetailKeys = await Promise.all([
    listObjectKeys(`manifests/${slug}/p/`),
    listObjectKeys(`manifests/${slug}/i/`)
  ]).then((parts) => parts.flat());
  const desiredDetailKeys = new Set<string>();

  await putObject(
    `manifests/${slug}/index.json`,
    Buffer.from(JSON.stringify({ eventId, slug, title: racepicEventRow.title, participants })),
    'application/json'
  );

  for (const participant of participants) {
    desiredDetailKeys.add(`manifests/${slug}/p/${participant.participantKey}.json`);
    await putObject(
      `manifests/${slug}/p/${participant.participantKey}.json`,
      Buffer.from(JSON.stringify({ participant, images: imagesByParticipantKey.get(participant.participantKey) ?? [] })),
      'application/json'
    );
  }

  const imageDetails = new Map<string, { image: ManifestImage; participants: ManifestParticipant[] }>();
  for (const participant of participants) {
    for (const image of imagesByParticipantKey.get(participant.participantKey) ?? []) {
      const detail = imageDetails.get(image.imageId) ?? { image, participants: [] };
      detail.participants.push(participant);
      imageDetails.set(image.imageId, detail);
    }
  }
  // Bilder ohne Fahrer-Zuordnung bekommen ebenfalls eine Detailseite (leere `participants`), damit
  // die Discover-Lightbox sie oeffnen kann (siehe listUnassignedPublishedImages oben).
  for (const image of unassignedImages) {
    if (!imageDetails.has(image.imageId)) imageDetails.set(image.imageId, { image, participants: [] });
  }
  const allImages = Array.from(imageDetails.values()).map((detail) => detail.image);
  for (const [imageId, detail] of imageDetails) {
    desiredDetailKeys.add(`manifests/${slug}/i/${imageId}.json`);
    const sameVehicle = detail.participants.flatMap((participant) => imagesByParticipantKey.get(participant.participantKey) ?? []);
    const related = Array.from(new Map([...sameVehicle, ...allImages].filter((image) => image.imageId !== imageId).map((image) => [image.imageId, image])).values()).slice(0, 12);
    await putObject(
      `manifests/${slug}/i/${imageId}.json`,
      Buffer.from(JSON.stringify({ image: detail.image, eventSlug: slug, eventTitle: racepicEventRow.title, participants: detail.participants, relatedImages: related })),
      'application/json'
    );
  }
  await Promise.all(oldDetailKeys.filter((key) => !desiredDetailKeys.has(key)).map((key) => deleteObject(key)));

  const publishedEvents = await db.select().from(racepicEvent).where(and(eq(racepicEvent.enabled, true), eq(racepicEvent.published, true)));
  await putObject(
    'manifests/events.json',
    Buffer.from(JSON.stringify(publishedEvents.map((row) => ({ eventId: row.eventId, slug: row.slug, title: row.title })))),
    'application/json'
  );

  await regenerateGlobalDiscoveryManifests(publishedEvents);
  await invalidateCloudFront([`/manifests/${slug}/*`, '/manifests/events.json', '/manifests/discover*', '/manifests/search-index.json']);
};

const DISCOVER_PAGE_SIZE = 60;

/**
 * Event-uebergreifende Manifeste fuer die Landingpage im Unsplash/Airbnb-Stil (Paket 17), siehe
 * racepic-ux-redesign-plan.md. Bleibt konsistent mit dem Architekturprinzip "oeffentlicher
 * Traffic trifft nie Lambda/DB" (weiterhin nur CDN-Fetch von der Website aus) - der Preis dafuer
 * ist, dass hier bei **jeder** Publish-/Unpublish-Aktion **alle** veroeffentlichten Events neu
 * abgefragt werden (kein periodischer Job, kein inkrementelles Update). Bei der in Abschnitt M
 * angenommenen Groessenordnung (einzelne Events pro Jahr, jeweils einige hundert Teilnehmer)
 * bleibt das unproblematisch; sollte RacePic auf sehr viele Events wachsen, muesste das
 * inkrementell werden.
 */
const regenerateGlobalDiscoveryManifests = async (publishedEvents: (typeof racepicEvent.$inferSelect)[]): Promise<void> => {
  const discoverById = new Map<string, { imageId: string; thumbUrl: string; previewUrl: string; eventSlug: string; eventTitle: string; capturedAt: string | null; createdAt: string }>();
  const searchEntries: { participantKey: string; eventSlug: string; eventTitle: string; startNumber: string; displayName: string; make: string | null; model: string | null; className: string }[] = [];
  for (const eventRow of publishedEvents) {
    const { participants, imagesByParticipantKey } = await buildManifestData(eventRow.eventId);
    const unassignedImages = await listUnassignedPublishedImages(eventRow.eventId);
    // Auch ohne Fahrer-Zuordnung im globalen Discover-Feed sichtbar (siehe
    // listUnassignedPublishedImages) - kein Suchindex-Eintrag dafuer, da es keinen Teilnehmer gibt,
    // nach dem gesucht werden koennte.
    for (const image of unassignedImages) {
      discoverById.set(image.imageId, {
        imageId: image.imageId,
        thumbUrl: image.thumbUrl,
        previewUrl: image.previewUrl,
        eventSlug: eventRow.slug,
        eventTitle: eventRow.title,
        capturedAt: image.capturedAt,
        createdAt: image.createdAt
      });
    }
    for (const participant of participants) {
      for (const image of imagesByParticipantKey.get(participant.participantKey) ?? []) {
        discoverById.set(image.imageId, {
          imageId: image.imageId,
          thumbUrl: image.thumbUrl,
          previewUrl: image.previewUrl,
          eventSlug: eventRow.slug,
          eventTitle: eventRow.title,
          capturedAt: image.capturedAt,
          createdAt: image.createdAt
        });
      }
      searchEntries.push({
        participantKey: participant.participantKey,
        eventSlug: eventRow.slug,
        eventTitle: eventRow.title,
        startNumber: participant.startNumber,
        displayName: participant.displayName,
        make: participant.make,
        model: participant.model,
        className: participant.className
      });
    }
  }
  const discover = Array.from(discoverById.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pageCount = Math.ceil(discover.length / DISCOVER_PAGE_SIZE);
  const previousPageKeys = await listObjectKeys('manifests/discover-pages/');
  const desiredPageKeys = new Set<string>();
  for (let page = 0; page < pageCount; page += 1) {
    desiredPageKeys.add(`manifests/discover-pages/${page + 1}.json`);
    await putObject(
      `manifests/discover-pages/${page + 1}.json`,
      Buffer.from(JSON.stringify(discover.slice(page * DISCOVER_PAGE_SIZE, (page + 1) * DISCOVER_PAGE_SIZE))),
      'application/json'
    );
  }
  await putObject('manifests/discover.json', Buffer.from(JSON.stringify(discover.slice(0, DISCOVER_PAGE_SIZE))), 'application/json');
  await putObject('manifests/discover-index.json', Buffer.from(JSON.stringify({ total: discover.length, pageCount, pageSize: DISCOVER_PAGE_SIZE })), 'application/json');
  await putObject('manifests/search-index.json', Buffer.from(JSON.stringify(searchEntries)), 'application/json');
  await Promise.all(previousPageKeys.filter((key) => !desiredPageKeys.has(key)).map((key) => deleteObject(key)));
};

export const setEventPublicObjectAvailability = async (eventId: string, available: boolean): Promise<void> => {
  const db = await getDb();
  const images = await db.select({ id: racepicImage.id }).from(racepicImage)
    .where(and(eq(racepicImage.eventId, eventId), eq(racepicImage.visibility, 'PUBLISHED'), inArray(racepicImage.offerMode, ['FREE', 'PAID'])));
  for (const image of images) {
    if (available) {
      // PAID-Bilder ohne aktive Angebotsversion (oder bei ausgeschaltetem Flag) veroeffentlicht die Funktion nicht.
      await publishPublicObjectsForImage(image.id);
    } else {
      await unpublishObjects(image.id);
    }
  }
  if (available && images.length > 0) await invalidateCloudFront(['/public/*']);
};

/**
 * Zieht die Manifeste eines Events vollstaendig zurueck (Luecke, gefunden bei einer Bestandsaufnahme
 * am 2026-09-22: `regenerateManifestsForEvent` bricht fuer ein nicht (mehr) veroeffentlichtes Event
 * fruehzeitig ab, ohne die zuvor geschriebenen Manifeste zu loeschen - ein Admin, der ein Event
 * wieder auf "nicht veroeffentlicht" stellt, hat die Galerie also faelschlich weiterhin oeffentlich
 * erreichbar). Wird gebraucht bei (a) Unpublish (`published: true -> false`) und (b) einer
 * Slug-Aenderung eines veroeffentlichten Events (die alten Manifest-Pfade unter dem frueheren Slug
 * werden sonst zu verwaisten, weiterhin oeffentlich erreichbaren Dateien).
 */
export const unpublishEventManifests = async (previousSlug: string, eventId: string): Promise<void> => {
  await deleteObjectsByPrefix(`manifests/${previousSlug}/`);

  const db = await getDb();
  const publishedEvents = await db.select().from(racepicEvent).where(and(eq(racepicEvent.enabled, true), eq(racepicEvent.published, true)));
  await putObject(
    'manifests/events.json',
    Buffer.from(JSON.stringify(publishedEvents.map((row) => ({ eventId: row.eventId, slug: row.slug, title: row.title })))),
    'application/json'
  );

  await regenerateGlobalDiscoveryManifests(publishedEvents);
  // Profile enthalten ebenfalls Event-Bilder. Nach einem Unpublish oder Slug-Wechsel
  // muessen ihre alten CDN-Manifeste zurueckgezogen beziehungsweise neu aufgebaut werden.
  const affectedPhotographers = await db.selectDistinct({ photographerId: racepicImage.photographerId })
    .from(racepicImage).where(eq(racepicImage.eventId, eventId));
  await Promise.all(affectedPhotographers.map(({ photographerId }) => regeneratePhotographerManifest(photographerId)));
  await invalidateCloudFront([
    `/manifests/${previousSlug}/*`,
    '/manifests/events.json',
    '/manifests/discover*',
    '/manifests/search-index.json'
  ]);
};

/**
 * Oeffentliches Fotografenprofil (Paket 12), siehe docs/memory-bank/racepic-architecture.md
 * Abschnitt H ("GET /m/photographers/{slug}.json") und J (MVP-Scope). Nur Bilder aus
 * veroeffentlichten Events (`racepic_event.published = true`), unabhaengig davon, ob/welchem
 * Teilnehmer sie zugeordnet sind - ein Bild kann mehreren Fahrern zugeordnet sein (Abschnitt C),
 * eine eindeutige Verlinkung zu "der" Teilnehmerseite gibt es deshalb nicht; die Kachel verlinkt
 * stattdessen auf die Event-Galerie. Ohne Slug (noch nicht vergeben, siehe repository.ts) gibt es
 * kein oeffentliches Profil, die Funktion ist dann ein No-Op.
 */
export const regeneratePhotographerManifest = async (photographerId: string): Promise<void> => {
  const db = await getDb();
  const [photographer] = await db.select().from(racepicPhotographer).where(eq(racepicPhotographer.id, photographerId)).limit(1);
  if (!photographer || !photographer.slug) return;

  const publishedEvents = await db.select().from(racepicEvent).where(and(eq(racepicEvent.enabled, true), eq(racepicEvent.published, true)));
  const imagesById = new Map<string, { imageId: string; thumbUrl: string; previewUrl: string; eventSlug: string; eventTitle: string; capturedAt: string | null; createdAt: string }>();
  for (const eventRow of publishedEvents) {
    const { imagesByParticipantKey } = await buildManifestData(eventRow.eventId);
    const unassignedImages = await listUnassignedPublishedImages(eventRow.eventId);
    for (const images of imagesByParticipantKey.values()) {
      for (const image of images) {
        if (image.photographer.slug !== photographer.slug) continue;
        imagesById.set(image.imageId, {
          imageId: image.imageId,
          thumbUrl: image.thumbUrl,
          previewUrl: image.previewUrl,
          eventSlug: eventRow.slug,
          eventTitle: eventRow.title,
          capturedAt: image.capturedAt,
          createdAt: image.createdAt
        });
      }
    }
    for (const image of unassignedImages) {
      if (image.photographer.slug !== photographer.slug) continue;
      imagesById.set(image.imageId, {
        imageId: image.imageId,
        thumbUrl: image.thumbUrl,
        previewUrl: image.previewUrl,
        eventSlug: eventRow.slug,
        eventTitle: eventRow.title,
        capturedAt: image.capturedAt,
        createdAt: image.createdAt
      });
    }
  }
  const images = Array.from(imagesById.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  await putObject(
    `manifests/photographers/${photographer.slug}.json`,
    Buffer.from(
      JSON.stringify({
        photographerId,
        slug: photographer.slug,
        displayName: photographer.displayName,
        copyrightLine: photographer.copyrightLine,
        website: photographer.website,
        social: photographer.social,
        imageCount: images.length,
        images
      })
    ),
    'application/json'
  );

  await invalidateCloudFront([`/manifests/photographers/${photographer.slug}.json`]);
};
