import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicMatchingConfig } from '../db/schema';
import { RacePicError } from './repository';

/**
 * Matching-Konfiguration (Paket 6), siehe docs/memory-bank/racepic-architecture.md Abschnitt F
 * "Score" und Abschnitt E-Prinzip: "Die Grenzwerte duerfen nicht hart in die Architektur eingebaut
 * sein." Konservative Default-Gewichte fuer den Start, gedacht zur Kalibrierung anhand der
 * Review-Entscheidungen aus dem Piloten (Paket 10).
 */

export type MatchingWeights = {
  ocrExact: number;
  ocrConfidence: number;
  vehicleTypeMatch: number;
  embeddingSimilarity: number;
  colorSimilarity: number;
  ambiguityPenalty: number;
};

// Rebalanciert 2026-09-23 (Bug gefunden: ein Foto ganz ohne sichtbare Startnummer konnte mit den
// urspruenglichen Gewichten rechnerisch NIE reviewThreshold erreichen - selbst bei rechnerisch
// perfekter embeddingSimilarity/colorSimilarity (je 1.0) lag das Maximum bei
// 0.1 (vehicleTypeMatch) + 0.2 + 0.1 = 0.4, unter dem alten reviewThreshold von 0.55. Erst mit dem
// Bedrock-Fix (siehe bedrock.ts) liefert embeddingSimilarity ueberhaupt echte Werte statt immer
// neutral 0.5 - diese Neugewichtung ist der naechste noetige Schritt, damit ein rein visueller
// Treffer wenigstens in die Review-Queue kommt (nicht automatisch zugeordnet wird - dafuer bleibt
// weiterhin praktisch immer eine erkannte Startnummer noetig, autoThreshold ist unveraendert 0.85).
// Grobe Erstkalibrierung ohne echte Pilotdaten - ueber den "Qualitätsreport" (KI-Konfiguration-Tab)
// mit echten Review-Entscheidungen nachjustieren, sobald mehr Bilder durchgelaufen sind.
export const DEFAULT_WEIGHTS: MatchingWeights = {
  ocrExact: 0.45,
  ocrConfidence: 0.05,
  vehicleTypeMatch: 0.1,
  embeddingSimilarity: 0.25,
  colorSimilarity: 0.15,
  ambiguityPenalty: 0.15
};

export type MatchingConfig = {
  id: string | null;
  version: number;
  weights: MatchingWeights;
  autoThreshold: number;
  reviewThreshold: number;
  minMargin: number;
};

const FALLBACK_CONFIG: MatchingConfig = {
  id: null,
  version: 0,
  weights: DEFAULT_WEIGHTS,
  // Konservativ gewaehlt: lieber REVIEW_REQUIRED als ein falsches AUTO_MATCHED, siehe Prinzip 6
  // im Architekturplan ("KI-Zuordnungen muessen nachvollziehbar und korrigierbar sein"). Durch den
  // ersten echten Qualitaetsreport (2026-09-23, 28 geprueft/22 mit bestaetigtem Treffer) bestaetigt:
  // bei 0.85/0.9 100% Precision (2/2 bzw. 1/1) - kein Grund zur Aenderung.
  autoThreshold: 0.85,
  // Auf 0.5 angehoben (2026-09-23, datenbasiert statt geraten - siehe Qualitaetsreport oben): bei
  // 0.4 lag die Precision nur bei 58% (24 Vorschlaege, 14 richtig) - fast jeder zweite Vorschlag in
  // der Review-Queue war falsch. Bei 0.5 steigt die Precision auf 82% (17 Vorschlaege, 14 richtig)
  // bei UNVERAENDERTEM Recall (64% in beiden Faellen) - kein einziger echter Treffer geht verloren,
  // es werden nur die falschen rausgefiltert. Bleibt bis 0.65 stabil, erst ab 0.7 sinkt der Recall.
  reviewThreshold: 0.5,
  minMargin: 0.08
};

/** Event-spezifische Config hat Vorrang vor der globalen (event_id ist null), sonst Fallback-Konstanten. */
export const getActiveMatchingConfig = async (eventId: string): Promise<MatchingConfig> => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(racepicMatchingConfig)
    .where(and(eq(racepicMatchingConfig.active, true), or(eq(racepicMatchingConfig.eventId, eventId), isNull(racepicMatchingConfig.eventId))))
    .orderBy(desc(racepicMatchingConfig.eventId), desc(racepicMatchingConfig.version));
  // eventId-spezifische Zeilen sortieren wegen NULLS LAST bei desc(eventId) nicht zuverlaessig vor
  // globalen - deshalb hier explizit bevorzugen.
  const eventSpecific = rows.find((row) => row.eventId === eventId);
  const row = eventSpecific ?? rows.find((r) => r.eventId === null);
  if (!row) return FALLBACK_CONFIG;
  return {
    id: row.id,
    version: row.version,
    weights: row.weights as unknown as MatchingWeights,
    autoThreshold: Number(row.autoThreshold),
    reviewThreshold: Number(row.reviewThreshold),
    minMargin: Number(row.minMargin)
  };
};

export const listMatchingConfigs = async (eventId?: string) => {
  const db = await getDb();
  if (eventId) return db.select().from(racepicMatchingConfig).where(eq(racepicMatchingConfig.eventId, eventId));
  return db.select().from(racepicMatchingConfig);
};

export const createMatchingConfig = async (input: {
  eventId: string | null;
  weights: MatchingWeights;
  autoThreshold: number;
  reviewThreshold: number;
  minMargin: number;
}) => {
  if (input.reviewThreshold > input.autoThreshold) {
    throw new RacePicError('RACEPIC_MATCHING_CONFIG_THRESHOLDS_INVALID');
  }
  const db = await getDb();
  const existing = await db.select({ version: racepicMatchingConfig.version }).from(racepicMatchingConfig).where(
    input.eventId ? eq(racepicMatchingConfig.eventId, input.eventId) : isNull(racepicMatchingConfig.eventId)
  );
  const nextVersion = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

  return db.transaction(async (tx) => {
    // Vorherige Version(en) fuer denselben Scope deaktivieren statt zu loeschen - Kandidaten
    // referenzieren die verwendete configVersion (Abschnitt F: "Re-Runs reproduzierbar").
    await tx
      .update(racepicMatchingConfig)
      .set({ active: false })
      .where(input.eventId ? eq(racepicMatchingConfig.eventId, input.eventId) : isNull(racepicMatchingConfig.eventId));
    const [created] = await tx
      .insert(racepicMatchingConfig)
      .values({
        eventId: input.eventId,
        version: nextVersion,
        weights: input.weights,
        autoThreshold: input.autoThreshold.toString(),
        reviewThreshold: input.reviewThreshold.toString(),
        minMargin: input.minMargin.toString(),
        active: true
      })
      .returning();
    return created;
  });
};
