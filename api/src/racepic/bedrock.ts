import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock-Zugriff fuer die visuelle Aehnlichkeit (Paket 6: KI-Pipeline), siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F. Region **eu-central-1** - dieselbe Region
 * wie der Rest von RacePic (Analyze-/Match-Worker, DB, S3). Urspruenglich lief das per
 * Cross-Region-Aufruf gegen eu-west-1 (Irland), da Cohere Embed v4 dort zuerst verfuegbar war;
 * Bug gefunden 2026-09-23: das Modell ist inzwischen auch in eu-central-1 gelistet, der
 * Cross-Region-Umweg (und die separate Bedrock-Modellzugriffsfreigabe in einer zweiten Region)
 * war nicht mehr noetig.
 *
 * Modell-ID `cohere.embed-v4:0`, Bild-Input ueber `images: ["data:<mime>;base64,..."]`. Das
 * Response-Format wurde urspruenglich (Paket 6) anhand der AWS-Doku als
 * `{ response_type: 'embeddings_floats', embeddings: number[][] }` angenommen - der erste echte
 * Live-Aufruf (2026-09-22, nach Abschluss der AWS-Kontoverifizierung fuer Bedrock) zeigte das
 * tatsaechliche Format: `{ response_type: 'embeddings_by_type', embeddings: { float: number[][] } }`
 * - `embeddings` ist nach Embedding-Typ verschluesselt (`embedding_types: ['float']` steuert,
 * welche Keys vorhanden sind), nicht direkt ein Array.
 */

const EMBEDDING_MODEL_ID = process.env.RACEPIC_EMBEDDING_MODEL_ID ?? 'cohere.embed-v4:0';
export const EMBEDDING_DIMENSIONS = 1024; // muss zu vector(1024) in db/schema.ts passen.

const getClient = () => new BedrockRuntimeClient({ region: process.env.RACEPIC_EMBEDDING_REGION ?? 'eu-central-1' });

type CohereEmbedV4FloatResponse = {
  response_type: 'embeddings_by_type';
  embeddings: { float?: number[][] };
};

/**
 * Embeddet ein einzelnes Bild (Fahrzeug-Crop oder Referenzfoto). `input_type: search_document`
 * wird fuer beide Seiten (Referenz und Kandidat) verwendet, damit sie im selben Vektorraum liegen
 * und per Kosinus-Aehnlichkeit vergleichbar sind (kein Query/Dokument-Verhaeltnis wie bei Textsuche).
 */
export const embedImage = async (jpegBuffer: Buffer): Promise<number[]> => {
  const client = getClient();
  const dataUri = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
  const body = JSON.stringify({
    input_type: 'search_document',
    images: [dataUri],
    embedding_types: ['float'],
    output_dimension: EMBEDDING_DIMENSIONS
  });

  const result = await client.send(
    new InvokeModelCommand({ modelId: EMBEDDING_MODEL_ID, contentType: 'application/json', accept: 'application/json', body })
  );
  const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as CohereEmbedV4FloatResponse;
  const embedding = parsed.embeddings?.float?.[0];
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('RACEPIC_EMBEDDING_INVALID_RESPONSE');
  }
  return embedding;
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
