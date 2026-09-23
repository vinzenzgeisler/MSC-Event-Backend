import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicVehicleReference, vehicle } from '../db/schema';
import { embedImage } from './bedrock';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { detectVehicles, type RgbColor } from './rekognition';

/**
 * Referenzdaten aus dem bei der Nennung hochgeladenen Fahrzeugfoto (Paket 6: KI-Pipeline), siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F "Referenzdaten". Liest **nur lesend** aus
 * dem Assets-Bucket des Nennungstools (separate IAM-Policy, kein Schreibzugriff).
 *
 * Bewusst kein separater, vorgelagerter Batch-Job: die Referenz wird beim ersten Matching-Bedarf
 * berechnet und in `racepic_vehicle_reference` zwischengespeichert (Cache-on-demand), verknuepft
 * ueber einen Hash des Quellschluessels - aendert sich `vehicle.image_s3_key`, wird neu berechnet.
 */

const getAssetsBucket = (): string => {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) throw new Error('ASSETS_BUCKET is not set');
  return bucket;
};

const getS3Client = () => new S3Client({});

const VEHICLE_IMAGE_EXTENSIONS = ['', '.jpg', '.jpeg', '.png', '.webp'];

const findVehicleImageObject = async (s3Key: string): Promise<Buffer | null> => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  for (const extension of VEHICLE_IMAGE_EXTENSIONS) {
    const candidate = `${s3Key}${extension}`;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: candidate }));
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: candidate }));
      if (!result.Body) continue;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch {
      continue;
    }
  }
  return null;
};

/** Grober Fallback, falls Rekognition im Referenzfoto gar kein Fahrzeug findet: 1x1-Resize mit sharp mittelt alle Pixel. */
const approximateDominantColor = async (jpegOrPngBuffer: Buffer): Promise<RgbColor> => {
  const { data } = await sharp(jpegOrPngBuffer).resize(1, 1, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return { red: data[0], green: data[1], blue: data[2] };
};

/**
 * Bug gefunden 2026-09-23 (Nutzer-Feedback: ein komplett gelbes Referenzfahrzeug wurde als 40%
 * "aehnlich" zu einem weiss/rot/schwarzen Auto vorgeschlagen): `approximateDominantColor` mittelt
 * *das gesamte Referenzfoto* (Hintergrund inklusive) auf einen einzigen Pixel - bei viel Gras/
 * Asphalt/Himmel im Bild dominiert der Hintergrund die "Fahrzeugfarbe" komplett, unabhaengig von
 * der tatsaechlichen Lackierung. Das analysierte Foto bekommt seine Farbe dagegen schon laenger
 * praezise aus Rekognitions Instanz-BBox (`detectVehicles` -> `instance.DominantColors`,
 * rekognition.ts) - hier jetzt derselbe Weg fuers Referenzfoto, mit dem alten 1x1-Mittel nur noch
 * als Fallback, falls Rekognition kein Fahrzeug im Referenzfoto erkennt.
 */
const detectReferenceDominantColor = async (imageBuffer: Buffer): Promise<RgbColor> => {
  try {
    const detections = await detectVehicles(imageBuffer);
    const best = [...detections].sort((a, b) => b.confidence - a.confidence).find((d) => d.dominantColors.length > 0);
    if (best) return best.dominantColors[0];
  } catch (error) {
    logOperationalEvent('error', 'racepic_vehicle_reference.color_detect_failed', { errorCode: errorCodeOf(error) });
  }
  return approximateDominantColor(imageBuffer);
};

const hashKey = (value: string): string => {
  // Nicht kryptografisch relevant - dient nur als billiger "hat sich der Schluessel geaendert"-Check.
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
};

// `embedding`/`dominantColor`: null heisst "Signal nicht verfuegbar" (Bedrock-Kontoverifizierung
// noch nicht abgeschlossen bzw. sharp konnte das Referenzfoto nicht dekodieren, z. B. ein
// beschaedigtes/nicht standardkonformes JPEG - "VipsJpeg: Invalid SOS parameters for sequential
// JPEG" bei einem echten Nennungsfoto in Prod, 2026-09-22) - Matching faellt dann auf die
// verbleibenden Signale zurueck, statt den ganzen Match-Lauf abzubrechen.
export type VehicleReference = { embedding: number[] | null; dominantColor: RgbColor | null; vehicleType: string | null };

/**
 * Liefert die Referenzdaten fuer ein Fahrzeug, berechnet sie bei Bedarf. Gibt `null` zurueck, wenn
 * das Fahrzeug kein Foto hat (kein Embedding moeglich - Matching faellt fuer diese Nennung dann auf
 * OCR/Typ/Farbe-Signale ohne `embedding_sim` zurueck).
 */
export const ensureVehicleReference = async (vehicleId: string): Promise<VehicleReference | null> => {
  const db = await getDb();
  const [vehicleRow] = await db.select().from(vehicle).where(eq(vehicle.id, vehicleId)).limit(1);
  if (!vehicleRow?.imageS3Key) return null;

  const sourceKeyHash = hashKey(vehicleRow.imageS3Key);
  const [existing] = await db.select().from(racepicVehicleReference).where(eq(racepicVehicleReference.vehicleId, vehicleId)).limit(1);
  if (existing && existing.sourceKeyHash === sourceKeyHash && existing.embedding) {
    return {
      embedding: existing.embedding as unknown as number[],
      dominantColor: (existing.dominantColors as unknown as { color: RgbColor | null } | null)?.color ?? null,
      vehicleType: existing.vehicleType
    };
  }

  const rawImageBuffer = await findVehicleImageObject(vehicleRow.imageS3Key);
  if (!rawImageBuffer) return null;

  // Bug gefunden 2026-09-23 (17-19 Rekognition ValidationException/InvalidImageFormatException in
  // 15 Minuten): Nennungsfotos kommen unbearbeitet aus dem Assets-Bucket des Nennungstools - anders
  // als RacePics eigene Bilder (immer JPEG/PNG, sharp-normalisiert) koennen das beliebige Formate,
  // Groessen oder Farbraeume sein. Rekognitions synchrone API verlangt JPEG/PNG unter 5 MB;
  // ueberschreitet ein Foto das, schlaegt detectVehicles fehl (Fallback greift dann auf das grobe
  // Ganzbild-Mittel zurueck statt die eigentlich bessere Instanz-Farbe zu liefern). Einmal auf JPEG
  // unter einer sicheren Groesse normalisieren, fuer beide KI-Aufrufe (Rekognition + Bedrock)
  // gemeinsam - schlaegt auch das fehl, bleibt der Rohbuffer als letzter Fallback.
  const imageBuffer = await sharp(rawImageBuffer, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
    .catch(() => rawImageBuffer);

  // Beide Aufrufe einzeln abgefangen (Bug gefunden 2026-09-22: ein einzelner Fehler in einem von
  // beiden liess vorher den kompletten Match-Lauf fuer das Bild abstuerzen, statt nur dieses eine
  // Signal auszulassen - dasselbe Prinzip wie schon in analyzeWorker.ts). Zuerst nur
  // `embedImage` abgesichert (Bedrock-Kontoverifizierung), dann live in Prod festgestellt: auch
  // `approximateDominantColor` (sharp-Dekodierung) kann an einem defekten Referenzfoto scheitern.
  const [embedding, dominantColor] = await Promise.all([
    embedImage(imageBuffer).catch((error) => {
      logOperationalEvent('error', 'racepic_vehicle_reference.embedding_failed', { errorCode: errorCodeOf(error) });
      return null;
    }),
    detectReferenceDominantColor(imageBuffer).catch((error) => {
      logOperationalEvent('error', 'racepic_vehicle_reference.color_failed', { errorCode: errorCodeOf(error) });
      return null;
    })
  ]);

  const reference: VehicleReference = { embedding, dominantColor, vehicleType: vehicleRow.vehicleType };
  await db
    .insert(racepicVehicleReference)
    .values({
      vehicleId,
      sourceKeyHash,
      embedding,
      dominantColors: { color: dominantColor },
      vehicleType: vehicleRow.vehicleType
    })
    .onConflictDoUpdate({
      target: racepicVehicleReference.vehicleId,
      set: { sourceKeyHash, embedding, dominantColors: { color: dominantColor }, vehicleType: vehicleRow.vehicleType, computedAt: new Date() }
    });

  return reference;
};
