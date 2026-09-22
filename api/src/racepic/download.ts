import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicEvent, racepicImage, racepicLicense, racepicPhotographer } from '../db/schema';
import { RacePicError } from './repository';
import { presignGetObject } from './s3';

/**
 * Oeffentlicher Download (Paket 8), siehe docs/memory-bank/racepic-architecture.md Abschnitt H
 * (`POST /public/racepic/images/{imageId}/download`) und I ("Downloads immer ueber kurzlebige
 * Signed-URLs, auch fuer kostenlose Bilder"). Nutzt `presignGetObject` (S3) statt CloudFront Signed
 * URLs, siehe Kommentar dort - Interimsloesung bis das CloudFront-Signing-Keypair existiert.
 */

export type DownloadVariant = 'small' | 'medium' | 'large' | 'original';

const VARIANT_KEY_BUILDERS: Record<DownloadVariant, (imageId: string, originalKey: string | null) => string | null> = {
  small: (imageId) => `derived/${imageId}/preview.webp`,
  medium: (imageId) => `derived/${imageId}/medium.jpg`,
  large: (imageId) => `derived/${imageId}/large.jpg`,
  original: (_imageId, originalKey) => originalKey
};

const DOWNLOAD_URL_TTL_SECONDS = 300;

export type DownloadResult = {
  url: string;
  expiresAt: string;
  attribution: { photographerName: string; copyrightLine: string | null; licenseCode: string; licenseTitle: unknown; attributionRequired: boolean; attributionTemplate: string | null };
};

export const requestImageDownload = async (imageId: string, variant: DownloadVariant): Promise<DownloadResult> => {
  const db = await getDb();
  const [row] = await db
    .select({
      visibility: racepicImage.visibility,
      eventPublished: racepicEvent.published,
      eventEnabled: racepicEvent.enabled,
      offerMode: racepicImage.offerMode,
      originalKey: racepicImage.originalKey,
      photographerDisplayName: racepicPhotographer.displayName,
      photographerCopyrightLine: racepicPhotographer.copyrightLine,
      licenseCode: racepicLicense.code,
      licenseTitle: racepicLicense.title,
      licenseAttributionRequired: racepicLicense.attributionRequired,
      licenseAttributionTemplate: racepicLicense.attributionTemplate
    })
    .from(racepicImage)
    .innerJoin(racepicEvent, eq(racepicEvent.eventId, racepicImage.eventId))
    .innerJoin(racepicPhotographer, eq(racepicPhotographer.id, racepicImage.photographerId))
    .innerJoin(racepicLicense, eq(racepicLicense.id, racepicImage.licenseId))
    .where(eq(racepicImage.id, imageId))
    .limit(1);

  if (!row) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  if (row.visibility !== 'PUBLISHED' || !row.eventPublished || !row.eventEnabled) throw new RacePicError('RACEPIC_IMAGE_NOT_PUBLISHED');
  if (row.offerMode !== 'FREE') {
    // Der Marketplace (kostenpflichtige Bilder, Entitlement-Pruefung) ist nicht Teil des MVP -
    // siehe Architekturplan Abschnitt K/J. Dieser Codepfad existiert, damit spaeter nur die
    // Bedingung erweitert werden muss, nicht der ganze Endpunkt.
    throw new RacePicError('RACEPIC_IMAGE_NOT_FREE');
  }

  const key = VARIANT_KEY_BUILDERS[variant](imageId, row.originalKey);
  if (!key) throw new RacePicError('RACEPIC_DOWNLOAD_VARIANT_UNAVAILABLE');

  const url = await presignGetObject(key, DOWNLOAD_URL_TTL_SECONDS);
  return {
    url,
    expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    attribution: {
      photographerName: row.photographerDisplayName,
      copyrightLine: row.photographerCopyrightLine,
      licenseCode: row.licenseCode,
      licenseTitle: row.licenseTitle,
      attributionRequired: row.licenseAttributionRequired,
      attributionTemplate: row.licenseAttributionTemplate
    }
  };
};
