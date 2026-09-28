import { CommerceFlags } from './types';

const readFlag = (name: string): boolean => (process.env[name] ?? '').trim().toLowerCase() === 'true';

/**
 * Liest die RacePic-Commerce-Flags einer Stage (z. B. prefix `DEV` -> `DEV_COMMERCE_CHECKOUT`).
 * Nur der exakte Wert `true` schaltet ein; fehlende oder leere Variablen (GitHub Actions liefert fuer
 * nicht gesetzte `vars.X` einen leeren String) bedeuten immer `false`.
 */
export const readCommerceFlags = (prefix: 'DEV' | 'PROD'): CommerceFlags => ({
  commerceBuyerAccounts: readFlag(`${prefix}_COMMERCE_BUYER_ACCOUNTS`),
  commercePaidOffers: readFlag(`${prefix}_COMMERCE_PAID_OFFERS`),
  commerceCheckout: readFlag(`${prefix}_COMMERCE_CHECKOUT`),
  commerceSettlement: readFlag(`${prefix}_COMMERCE_SETTLEMENT`),
  commerceFreeToPaidConversion: readFlag(`${prefix}_COMMERCE_FREE_TO_PAID_CONVERSION`)
});
