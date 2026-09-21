import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock-Zugriff fuer die visuelle Aehnlichkeit (Paket 6: KI-Pipeline), siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F. Region **eu-west-1** (Irland), nicht
 * eu-central-1: Titan/Nova Multimodal Embeddings sind nur in den USA verfuegbar (siehe
 * Region-Check in Paket 1), Cohere Embed v4 laeuft dagegen in Irland - einer EU-Region. Die
 * Analyze-Worker-Lambda selbst bleibt in eu-central-1 und ruft hier per Cross-Region-Aufruf.
 *
 * Modell und Request-/Response-Format anhand der aktuellen AWS-Dokumentation verifiziert
 * (docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html, Stand 2026-09-21):
 * Modell-ID `cohere.embed-v4:0`, Bild-Input ueber `images: ["data:<mime>;base64,..."]`.
 */

const EMBEDDING_MODEL_ID = process.env.RACEPIC_EMBEDDING_MODEL_ID ?? 'cohere.embed-v4:0';
export const EMBEDDING_DIMENSIONS = 1024; // muss zu vector(1024) in db/schema.ts passen.

const getClient = () => new BedrockRuntimeClient({ region: process.env.RACEPIC_EMBEDDING_REGION ?? 'eu-west-1' });

type CohereEmbedV4FloatResponse = {
  response_type: 'embeddings_floats';
  embeddings: number[][];
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
  const embedding = parsed.embeddings?.[0];
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
