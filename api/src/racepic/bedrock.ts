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
 * Modell-ID `eu.cohere.embed-v4:0` - **Inference-Profile-ID**, nicht die rohe Modell-ID
 * `cohere.embed-v4:0` (Bug gefunden 2026-09-23, per Live-Test verifiziert: ein direkter Aufruf
 * der rohen Modell-ID schlaegt mit `ValidationException: ... isn't supported with on-demand
 * throughput` fehl - dieses Modell verlangt in diesem Account ein systemdefiniertes
 * Cross-Region-Inference-Profile. `eu.*` routet dabei weiterhin nur innerhalb der EU
 * (eu-central-1/eu-west-1/eu-west-3/eu-north-1/eu-south-1/eu-south-2), kein Drittlandtransfer -
 * die IAM-Policy braucht deshalb Rechte auf die Profil-ARN UND alle sechs zugrundeliegenden
 * Foundation-Model-ARNs, siehe api-stack.ts.
 *
 * Bild-Input ueber `images: ["data:<mime>;base64,..."]`. Das Response-Format wurde urspruenglich
 * (Paket 6) anhand der AWS-Doku als `{ response_type: 'embeddings_floats', embeddings: number[][] }`
 * angenommen - der erste echte Live-Aufruf (2026-09-22, nach Abschluss der AWS-Kontoverifizierung
 * fuer Bedrock) zeigte das tatsaechliche Format:
 * `{ response_type: 'embeddings_by_type', embeddings: { float: number[][] } }` - `embeddings` ist
 * nach Embedding-Typ verschluesselt (`embedding_types: ['float']` steuert, welche Keys vorhanden
 * sind), nicht direkt ein Array.
 */

const EMBEDDING_MODEL_ID = process.env.RACEPIC_EMBEDDING_MODEL_ID ?? 'eu.cohere.embed-v4:0';
export const EMBEDDING_DIMENSIONS = 1024; // muss zu vector(1024) in db/schema.ts passen.

const getClient = () => new BedrockRuntimeClient({ region: process.env.RACEPIC_EMBEDDING_REGION ?? 'eu-central-1' });

type CohereEmbedV4FloatResponse = {
  response_type: 'embeddings_by_type';
  embeddings: { float?: number[][] };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isThrottling = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'ThrottlingException' || /throttl/i.test(error.message));

const MAX_THROTTLE_RETRIES = 4;

/**
 * Embeddet ein einzelnes Bild (Fahrzeug-Crop oder Referenzfoto). `input_type: search_document`
 * wird fuer beide Seiten (Referenz und Kandidat) verwendet, damit sie im selben Vektorraum liegen
 * und per Kosinus-Aehnlichkeit vergleichbar sind (kein Query/Dokument-Verhaeltnis wie bei Textsuche).
 *
 * Retry mit Backoff bei ThrottlingException (Bug gefunden 2026-09-23: 154 ThrottlingExceptions in
 * 2h im Match-Worker allein - das frisch freigeschaltete Inference-Profile hat offenbar ein
 * niedriges TPS-Kontingent, `matchWorker.ts` ruft aber pro Match-Lauf ein Embedding je noch nicht
 * gecachtem Fahrzeug auf, mit bis zu 5 gleichzeitigen Aufrufen. Ohne Retry wurde ein gedrosselter
 * Aufruf einfach als "kein Embedding" gewertet (`matching.ts` setzt dafuer neutral 0.5 ein) - bei
 * vielen gleichzeitigen Drosselungen bekam so praktisch jeder Kandidat denselben neutralen Bonus,
 * unabhaengig von echter visueller Aehnlichkeit, was Fehltreffer mit unplausibel hoher Konfidenz
 * begsuenstigte.
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

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const backoffMs = 300 * 2 ** (attempt - 1) + Math.round(Math.random() * 200);
      await sleep(backoffMs);
    }
    try {
      const result = await client.send(
        new InvokeModelCommand({ modelId: EMBEDDING_MODEL_ID, contentType: 'application/json', accept: 'application/json', body })
      );
      const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as CohereEmbedV4FloatResponse;
      const embedding = parsed.embeddings?.float?.[0];
      if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error('RACEPIC_EMBEDDING_INVALID_RESPONSE');
      }
      return embedding;
    } catch (error) {
      lastError = error;
      if (!isThrottling(error)) throw error;
    }
  }
  throw lastError;
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
