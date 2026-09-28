/**
 * Preis- und Steuerberechnung (Commerce AP12). Reine Funktionen ohne Datenbank; alle Werte in Integer-Cents,
 * Saetze in Basispunkten (1900 = 19 %). Jeder steuerlich offene Punkt ist ein Parameter (`PricingSettings`),
 * keine Konstante: Verkaufssteuersatz, Provision, Bezugsgroesse des Fotografenanteils, Steuersatz der
 * Fotograf:innen und Kuenstlersozialabgabe. Siehe docs/memory-bank/racepic-open-items.md.
 *
 * Modell (Standard, Variante B): Der MSC verkauft brutto zum Preis P. Darin steckt Umsatzsteuer nach dem
 * Verkaufssteuersatz. Der Fotografenanteil ist (1 - Provision) vom Nettobetrag; ist der Fotograf regelbesteuert,
 * kommt in der Gutschrift seine Umsatzsteuer hinzu (der MSC zieht sie als Vorsteuer ab), sonst nicht. Damit ist
 * der MSC-Anteil unabhaengig vom Steuerstatus des Fotografen. Variante A (Bezug auf Brutto) ist ueber
 * `sellerShareBasis = 'GROSS'` einstellbar.
 */

export type ShareBasis = 'NET' | 'GROSS';
export type SellerTaxStatus = 'UNCLEARED' | 'PRIVATE' | 'SMALL_BUSINESS' | 'REGULAR';

export type PricingSettings = {
  /** Umsatzsteuersatz des MSC auf den Verkauf; `null` = noch nicht entschieden (dann wird nichts berechnet). */
  saleTaxRateBp: number | null;
  commissionBp: number;
  sellerShareBasis: ShareBasis;
  /** Steuersatz eines regelbesteuerten Fotografen; `null` = derselbe Satz wie beim Verkauf. */
  sellerVatRateBp: number | null;
  artistSocialLevyBp: number;
};

export type PricingErrorCode = 'TAX_NOT_CONFIGURED' | 'INVALID_AMOUNT' | 'INVALID_SETTINGS' | 'SELLER_TAX_UNCLEARED';

export class PricingError extends Error {
  constructor(public readonly code: PricingErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PricingError';
  }
}

const BP = 10000;

/** Kaufmaennisch gerundete Ganzzahldivision fuer nicht-negative Werte (ohne Gleitkomma). */
export const roundDiv = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator));

const assertBp = (value: number, max: number, name: string) => {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new PricingError('INVALID_SETTINGS', `${name} ungueltig`);
};

export const validateSettings = (settings: PricingSettings): void => {
  if (settings.saleTaxRateBp !== null) assertBp(settings.saleTaxRateBp, 3000, 'saleTaxRateBp');
  assertBp(settings.commissionBp, BP, 'commissionBp');
  if (settings.sellerVatRateBp !== null) assertBp(settings.sellerVatRateBp, 3000, 'sellerVatRateBp');
  assertBp(settings.artistSocialLevyBp, 1000, 'artistSocialLevyBp');
  if (settings.sellerShareBasis !== 'NET' && settings.sellerShareBasis !== 'GROSS') throw new PricingError('INVALID_SETTINGS', 'sellerShareBasis ungueltig');
};

export type SalePricing = {
  grossCents: number;
  netCents: number;
  taxCents: number;
  taxRateBp: number;
  /** Anteil des MSC an der Bezugsgroesse (Netto oder Brutto, siehe `sellerShareBasis`); Cent-Reste gehen an den MSC. */
  commissionCents: number;
  /** Fotografenanteil in der Bezugsgroesse, ohne die Umsatzsteuer eines regelbesteuerten Fotografen (die kommt erst in der Gutschrift). */
  sellerShareCents: number;
  sellerShareBasis: ShareBasis;
};

/**
 * Preisaufteilung beim Verkauf. `taxRateBpOverride` erlaubt einen Satz pro Angebotsversion; sonst gilt der
 * Verkaufssteuersatz der Einstellungen. Ohne Satz wird nichts berechnet.
 */
export const priceSale = (grossCents: number, settings: PricingSettings, taxRateBpOverride?: number | null): SalePricing => {
  if (!Number.isInteger(grossCents) || grossCents <= 0) throw new PricingError('INVALID_AMOUNT');
  validateSettings(settings);
  const taxRateBp = taxRateBpOverride ?? settings.saleTaxRateBp;
  if (taxRateBp === null || taxRateBp === undefined) throw new PricingError('TAX_NOT_CONFIGURED');
  assertBp(taxRateBp, 3000, 'taxRateBp');
  const taxCents = roundDiv(grossCents * taxRateBp, BP + taxRateBp);
  const netCents = grossCents - taxCents;
  const basisCents = settings.sellerShareBasis === 'NET' ? netCents : grossCents;
  const sellerShareCents = Math.floor((basisCents * (BP - settings.commissionBp)) / BP);
  return {
    grossCents,
    netCents,
    taxCents,
    taxRateBp,
    commissionCents: basisCents - sellerShareCents,
    sellerShareCents,
    sellerShareBasis: settings.sellerShareBasis
  };
};

export type SellerLine = {
  /** Nettoanteil des Fotografen (Grundlage der Gutschrift). */
  netCents: number;
  /** Umsatzsteuer, die der Fotograf ausweist (0 bei Kleinunternehmer/Privat). */
  vatCents: number;
  /** Betrag, der an den Fotografen ausgezahlt wird. */
  payableCents: number;
  vatRateBp: number;
};

/**
 * Gutschriftszeile fuer eine Position, berechnet zum Zeitpunkt der Abrechnung mit dem dann geltenden Steuerstatus
 * des Fotografen. Bei `UNCLEARED` wird bewusst nicht gerechnet (Auszahlungen bleiben blockiert).
 */
export const sellerLine = (input: {
  basis: ShareBasis;
  shareCents: number;
  sellerTaxStatus: SellerTaxStatus;
  saleTaxRateBp: number;
  sellerVatRateBp: number | null;
}): SellerLine => {
  if (!Number.isInteger(input.shareCents) || input.shareCents < 0) throw new PricingError('INVALID_AMOUNT');
  if (input.sellerTaxStatus === 'UNCLEARED') throw new PricingError('SELLER_TAX_UNCLEARED');
  const vatRateBp = input.sellerTaxStatus === 'REGULAR' ? (input.sellerVatRateBp ?? input.saleTaxRateBp) : 0;
  assertBp(vatRateBp, 3000, 'vatRateBp');
  if (input.basis === 'NET') {
    const vatCents = roundDiv(input.shareCents * vatRateBp, BP);
    return { netCents: input.shareCents, vatCents, payableCents: input.shareCents + vatCents, vatRateBp };
  }
  const vatCents = vatRateBp === 0 ? 0 : roundDiv(input.shareCents * vatRateBp, BP + vatRateBp);
  return { netCents: input.shareCents - vatCents, vatCents, payableCents: input.shareCents, vatRateBp };
};

/** Kuenstlersozialabgabe auf den Nettoanteil des Fotografen (Kostenposition des MSC, wird nicht vom Fotografen abgezogen). */
export const artistSocialLevyCents = (sellerNetCents: number, levyBp: number): number => roundDiv(sellerNetCents * levyBp, BP);

export const sumSales = (sales: SalePricing[]) =>
  sales.reduce(
    (total, sale) => ({
      grossCents: total.grossCents + sale.grossCents,
      netCents: total.netCents + sale.netCents,
      taxCents: total.taxCents + sale.taxCents
    }),
    { grossCents: 0, netCents: 0, taxCents: 0 }
  );
