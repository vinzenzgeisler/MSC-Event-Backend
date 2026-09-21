import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicVehicleReference, vehicle } from '../db/schema';
import { embedImage } from './bedrock';
import type { RgbColor } from './rekognition';

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

/** Schneller Naeherungswert fuer die dominante Farbe: 1x1-Resize mit sharp mittelt alle Pixel. */
const approximateDominantColor = async (jpegOrPngBuffer: Buffer): Promise<RgbColor> => {
  const { data } = await sharp(jpegOrPngBuffer).resize(1, 1, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return { red: data[0], green: data[1], blue: data[2] };
};

const hashKey = (value: string): string => {
  // Nicht kryptografisch relevant - dient nur als billiger "hat sich der Schluessel geaendert"-Check.
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
};

export type VehicleReference = { embedding: number[]; dominantColor: RgbColor; vehicleType: string | null };

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
      dominantColor: (existing.dominantColors as unknown as { color: RgbColor })?.color ?? { red: 0, green: 0, blue: 0 },
      vehicleType: existing.vehicleType
    };
  }

  const imageBuffer = await findVehicleImageObject(vehicleRow.imageS3Key);
  if (!imageBuffer) return null;

  const [embedding, dominantColor] = await Promise.all([embedImage(imageBuffer), approximateDominantColor(imageBuffer)]);

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
