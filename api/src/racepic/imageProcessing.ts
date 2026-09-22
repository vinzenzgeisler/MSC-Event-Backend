import { createHash } from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';

/**
 * Reine Bildverarbeitungslogik fuer den Ingest-Worker (Paket 4), keine AWS-/DB-Aufrufe hier -
 * siehe docs/memory-bank/racepic-architecture.md Abschnitt F ("Ingest") und G ("Storage").
 *
 * Sicherheitsnetz gegen Dekompressions-Bomben: `sharp.limit` unten begrenzt die maximale
 * Pixelzahl, die sharp ueberhaupt dekodiert (Standardlimit ist bereits recht hoch, wir setzen es
 * explizit und dokumentiert).
 */

// ~50 Megapixel - deckt auch hochaufloesende Kamera-JPEGs ab, verhindert aber absurd grosse
// (potenziell boesartige) Bilddimensionen.
const MAX_INPUT_PIXELS = 50_000_000;

const JPEG_MAGIC_BYTES = Buffer.from([0xff, 0xd8, 0xff]);

export const looksLikeJpeg = (buffer: Buffer): boolean => buffer.length > 3 && buffer.subarray(0, 3).equals(JPEG_MAGIC_BYTES);

export const computeSha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export type ExtractedExif = {
  capturedAt: Date | null;
  camera: { make: string | null; model: string | null } | null;
};

/**
 * Nur die fuer RacePic relevanten Felder - kein GPS, keine Seriennummern (Abschnitt G: "Aus allen
 * abgeleiteten Varianten werden GPS und Seriennummern aus dem EXIF entfernt"; das gilt fuer die
 * *abgeleiteten* Varianten, hier lesen wir nur aus dem Original, ohne GPS/Seriennummer zu
 * uebernehmen).
 */
export const extractExif = async (buffer: Buffer): Promise<ExtractedExif> => {
  try {
    const tags = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model'] });
    if (!tags) return { capturedAt: null, camera: null };
    const capturedAtRaw = tags.DateTimeOriginal ?? tags.CreateDate;
    const capturedAt = capturedAtRaw instanceof Date && !Number.isNaN(capturedAtRaw.getTime()) ? capturedAtRaw : null;
    const make = typeof tags.Make === 'string' ? tags.Make.trim() || null : null;
    const model = typeof tags.Model === 'string' ? tags.Model.trim() || null : null;
    return { capturedAt, camera: make || model ? { make, model } : null };
  } catch {
    // Kaputte/fehlende EXIF-Daten sind kein Ingest-Fehler, nur ein leeres Ergebnis.
    return { capturedAt: null, camera: null };
  }
};

export type DecodedImage = { width: number; height: number };

/** Wirft, wenn das Bild kein valides, dekodierbares JPEG innerhalb der Groessenlimits ist. */
export const decodeImage = async (buffer: Buffer): Promise<DecodedImage> => {
  const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('RACEPIC_INGEST_DECODE_FAILED');
  }
  return { width: metadata.width, height: metadata.height };
};

export type VariantKind = 'thumb' | 'preview' | 'medium' | 'large';

export type VariantSpec = { kind: VariantKind; maxDimension: number; format: 'webp' | 'jpeg'; withCopyright: boolean };

// Siehe Architekturplan Abschnitt G: thumb 480px, preview 1600px ("Small"-Download), medium
// 2560px, large 3840px. thumb/preview als WebP fuer die oeffentliche Galerie (klein, schnell),
// medium/large als JPEG fuer Downloads (universelle Kompatibilitaet).
export const VARIANT_SPECS: VariantSpec[] = [
  { kind: 'thumb', maxDimension: 480, format: 'webp', withCopyright: false },
  { kind: 'preview', maxDimension: 1600, format: 'webp', withCopyright: false },
  { kind: 'medium', maxDimension: 2560, format: 'jpeg', withCopyright: true },
  { kind: 'large', maxDimension: 3840, format: 'jpeg', withCopyright: true }
];

export type RenderedVariant = { kind: VariantKind; contentType: string; buffer: Buffer; width: number; height: number };

/**
 * Erzeugt alle vier Downloadvarianten aus dem Originalbuffer. Ohne `withMetadata()` entfernt
 * sharp standardmaessig **alle** Metadaten (inkl. GPS, Seriennummern) - das ist der Default-Pfad
 * fuer thumb/preview. Fuer medium/large wird stattdessen gezielt nur der Copyright-Hinweis
 * zurueckgeschrieben (Ersatz fuer volles IPTC/XMP - siehe Progress-Notiz zu dieser vereinfachten
 * Umsetzung).
 */
export const renderVariants = async (buffer: Buffer, copyrightLine: string): Promise<RenderedVariant[]> => {
  const results: RenderedVariant[] = [];
  for (const spec of VARIANT_SPECS) {
    let pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).resize({
      width: spec.maxDimension,
      height: spec.maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    });
    if (spec.withCopyright && copyrightLine) {
      pipeline = pipeline.withMetadata({ exif: { IFD0: { Copyright: copyrightLine, Artist: copyrightLine } } });
    }
    pipeline = spec.format === 'webp' ? pipeline.webp({ quality: 82 }) : pipeline.jpeg({ quality: 87, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    results.push({
      kind: spec.kind,
      contentType: spec.format === 'webp' ? 'image/webp' : 'image/jpeg',
      buffer: data,
      width: info.width,
      height: info.height
    });
  }
  return results;
};

/** Private preview for paid drafts. The source remains private and this variant is never copied to public/. */
export const renderWatermarkedPreview = async (previewBuffer: Buffer): Promise<Buffer> => {
  const metadata = await sharp(previewBuffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const width = metadata.width ?? 1600;
  const height = metadata.height ?? 1000;
  const fontSize = Math.max(28, Math.round(width / 14));
  const rows = Array.from({ length: 5 }, (_, row) => `<text x="-25%" y="${Math.round((row + 0.6) * height / 5)}">RacePic · VORSCHAU · RacePic · VORSCHAU</text>`).join('');
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-18 ${width / 2} ${height / 2})" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" fill-opacity="0.56" stroke="black" stroke-opacity="0.42" stroke-width="2" paint-order="stroke">${rows}</g></svg>`);
  return sharp(previewBuffer, { limitInputPixels: MAX_INPUT_PIXELS }).composite([{ input: overlay }]).webp({ quality: 82 }).toBuffer();
};
