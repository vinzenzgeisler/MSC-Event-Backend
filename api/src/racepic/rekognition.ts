import { DetectLabelsCommand, DetectTextCommand, RekognitionClient } from '@aws-sdk/client-rekognition';

/**
 * Rekognition-Zugriff (Paket 6: KI-Pipeline), siehe docs/memory-bank/racepic-architecture.md
 * Abschnitt F. Bewusst **keine** Gesichtserkennung (Abschnitt "Datenschutz": "Gesichtserkennung
 * ist nicht Bestandteil der Kernfunktion") - `DetectFaces`/`IndexFaces` werden hier nie aufgerufen,
 * und die IAM-Policy des Analyze-Workers erlaubt nur `DetectText`/`DetectLabels`.
 */

const VEHICLE_LABELS = new Set(['Car', 'Motorcycle']);
const MIN_LABEL_CONFIDENCE = 60;
const MIN_TEXT_CONFIDENCE = 50;

const getClient = () => new RekognitionClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1' });

export type BoundingBoxRatio = { width: number; height: number; left: number; top: number };
export type RgbColor = { red: number; green: number; blue: number };

export type VehicleDetection = {
  label: 'Car' | 'Motorcycle';
  confidence: number;
  bbox: BoundingBoxRatio;
  dominantColors: RgbColor[];
};

/** Fahrzeuginstanzen mit Bounding Box und Instanz-Farben (Grundlage fuer mehrere Fahrzeuge pro Bild, Abschnitt C). */
export const detectVehicles = async (jpegBuffer: Buffer): Promise<VehicleDetection[]> => {
  const client = getClient();
  const result = await client.send(
    new DetectLabelsCommand({
      Image: { Bytes: jpegBuffer },
      Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
      MinConfidence: MIN_LABEL_CONFIDENCE
    })
  );

  const detections: VehicleDetection[] = [];
  for (const label of result.Labels ?? []) {
    if (!label.Name || !VEHICLE_LABELS.has(label.Name)) continue;
    for (const instance of label.Instances ?? []) {
      const box = instance.BoundingBox;
      if (!box || box.Width === undefined || box.Height === undefined || box.Left === undefined || box.Top === undefined) continue;
      detections.push({
        label: label.Name as 'Car' | 'Motorcycle',
        confidence: instance.Confidence ?? label.Confidence ?? 0,
        bbox: { width: box.Width, height: box.Height, left: box.Left, top: box.Top },
        dominantColors: (instance.DominantColors ?? [])
          .filter((color) => color.Red !== undefined && color.Green !== undefined && color.Blue !== undefined)
          .map((color) => ({ red: color.Red!, green: color.Green!, blue: color.Blue! }))
      });
    }
  }
  return detections;
};

export type TextDetectionResult = { text: string; normalized: string; confidence: number; bbox: BoundingBoxRatio };

/** Normalisierung analog zur Startnummer im Nennungstool (`^[A-Z0-9]{1,6}$`, siehe entry-Schema). */
export const normalizeStartNumberCandidate = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Worterkennung (nicht Zeilen) fuer praezise Bounding-Boxes einzelner Startnummern-Token. */
export const detectText = async (jpegBuffer: Buffer): Promise<TextDetectionResult[]> => {
  const client = getClient();
  const result = await client.send(new DetectTextCommand({ Image: { Bytes: jpegBuffer } }));

  const detections: TextDetectionResult[] = [];
  for (const item of result.TextDetections ?? []) {
    if (item.Type !== 'WORD' || !item.DetectedText || item.Confidence === undefined) continue;
    const box = item.Geometry?.BoundingBox;
    if (!box || box.Width === undefined || box.Height === undefined || box.Left === undefined || box.Top === undefined) continue;
    if (item.Confidence < MIN_TEXT_CONFIDENCE) continue;
    const normalized = normalizeStartNumberCandidate(item.DetectedText);
    if (!normalized || normalized.length > 6) continue;
    detections.push({
      text: item.DetectedText,
      normalized,
      confidence: item.Confidence,
      bbox: { width: box.Width, height: box.Height, left: box.Left, top: box.Top }
    });
  }
  return detections;
};

/** Liegt der Mittelpunkt der Text-BBox innerhalb der Fahrzeug-BBox? (Abschnitt F: `ocr_in_bbox`). */
export const isTextInsideVehicle = (text: BoundingBoxRatio, vehicle: BoundingBoxRatio): boolean => {
  const centerX = text.left + text.width / 2;
  const centerY = text.top + text.height / 2;
  return centerX >= vehicle.left && centerX <= vehicle.left + vehicle.width && centerY >= vehicle.top && centerY <= vehicle.top + vehicle.height;
};
