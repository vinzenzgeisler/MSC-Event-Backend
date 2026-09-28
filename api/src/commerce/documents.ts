import type { Queryable } from './offers';

/**
 * Belegkreise und Absender (Commerce AP18).
 *
 * Nummernformat: `<Praefix>-<Jahr>-<laufende Nummer, 6-stellig>`, je Belegart und Kalenderjahr lueckenlos
 *   Rechnung an Kaeufer    RP-2026-000001
 *   Gutschrift Fotograf    RPG-2026-000001
 *   Korrektur/Storno       RPK-2026-000001
 * Das Jahr ist das Kalenderjahr des Belegdatums in der Zeitzone Europe/Berlin.
 */

export type DocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'CORRECTION';

const PREFIX: Record<DocumentKind, string> = { INVOICE: 'RP', CREDIT_NOTE: 'RPG', CORRECTION: 'RPK' };

export const formatDocumentNumber = (kind: DocumentKind, year: number, sequence: number): string => {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new Error('DOCUMENT_YEAR_INVALID');
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999999) throw new Error('DOCUMENT_SEQUENCE_INVALID');
  return `${PREFIX[kind]}-${year}-${String(sequence).padStart(6, '0')}`;
};

/** Kalenderjahr eines Zeitpunkts in Europe/Berlin (Silvester 23:30 UTC ist dort schon Neujahr). */
export const documentYear = (date: Date): number =>
  Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(date));

/**
 * Vergibt die naechste Belegnummer. Muss in derselben Transaktion laufen wie das Anlegen des Belegs, sonst
 * entstehen bei Fehlern Luecken.
 */
export const allocateDocumentNumber = async (tx: Queryable, kind: DocumentKind, date: Date = new Date()): Promise<string> => {
  const year = documentYear(date);
  const result = await tx.query<{ last_number: number }>(
    `insert into commerce_document_sequence (kind, year, last_number) values ($1, $2, 1)
     on conflict (kind, year) do update set last_number = commerce_document_sequence.last_number + 1
     returning last_number`,
    [kind, year]
  );
  return formatDocumentNumber(kind, year, Number(result.rows[0].last_number));
};

/** Absender der Rechnungen und Gutschriften. Steuernummer bzw. USt-IdNr. kommen aus der Umgebung (siehe `getIssuerTaxIdentity`). */
export const DOCUMENT_ISSUER = {
  name: 'MSC Oberlausitzer Dreiländereck e.V.',
  street: 'Am Weiher 4',
  postalCode: '02791',
  city: 'Oderwitz',
  country: 'Deutschland'
} as const;

export type IssuerTaxIdentity = { vatId: string | null; taxNumber: string | null };

/**
 * Pflichtangabe nach § 14 Abs. 4 UStG ist Steuernummer oder USt-IdNr. des Ausstellers. Ohne beide darf kein Beleg
 * erzeugt werden (`hasIssuerTaxIdentity`).
 */
export const getIssuerTaxIdentity = (env: NodeJS.ProcessEnv = process.env): IssuerTaxIdentity => ({
  vatId: (env.COMMERCE_ISSUER_VAT_ID ?? '').trim() || null,
  taxNumber: (env.COMMERCE_ISSUER_TAX_NUMBER ?? '').trim() || null
});

export const hasIssuerTaxIdentity = (identity: IssuerTaxIdentity): boolean => identity.vatId !== null || identity.taxNumber !== null;
