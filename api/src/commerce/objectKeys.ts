/**
 * S3-Schluessel der Commerce-Artefakte (AP04/AP10).
 *
 * Privat (nie ueber CloudFront erreichbar, siehe DenyUnsignedPrivatePaths in racepic-stack.ts):
 *  - `licensed/{imageId}/{offerVersionId}/licensed_full.jpg` (an Kaeufer auszuliefern)
 *  - `derived/{imageId}/offers/{offerVersionId}/watermarked_{thumb,preview}.webp`
 * Oeffentlich (nur wasserzeichenbehaftet, offer-versioniert, damit Manifeste und CDN-Caches nie alte und neue
 * Ausgabe mischen): `public/{imageId}/o{version}/{thumb,preview}.webp`.
 */
export const conversionArtifactKeys = (imageId: string, offerVersionId: string) => ({
  licensedFull: `licensed/${imageId}/${offerVersionId}/licensed_full.jpg`,
  watermarkedThumb: `derived/${imageId}/offers/${offerVersionId}/watermarked_thumb.webp`,
  watermarkedPreview: `derived/${imageId}/offers/${offerVersionId}/watermarked_preview.webp`
});

export type PublicVariantKind = 'thumb' | 'preview';

export const paidPublicKey = (imageId: string, offerVersion: number, kind: PublicVariantKind): string =>
  `public/${imageId}/o${offerVersion}/${kind}.webp`;

export const freePublicKey = (imageId: string, kind: PublicVariantKind): string => `public/${imageId}/${kind}.webp`;

/** Relative CDN-URL (wie in den Manifesten) fuer ein oeffentliches Bild. */
export const publicVariantUrl = (
  imageId: string,
  kind: PublicVariantKind,
  offer: { mode: 'FREE' | 'PAID'; version: number } | null | undefined
): string => `/${offer?.mode === 'PAID' ? paidPublicKey(imageId, offer.version, kind) : freePublicKey(imageId, kind)}`;
