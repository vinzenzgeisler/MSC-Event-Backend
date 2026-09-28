/**
 * RacePic-Commerce-Feature-Flags (docs/memory-bank/racepic-marketplace-checkout-plan.md, Abschnitt 11).
 * Kommen als Lambda-Umgebungsvariablen aus infra/lib/config (commerceFlags); nur der exakte Wert `true`
 * schaltet ein, alles andere ist `false`.
 */
export type CommerceFlags = {
  commerceBuyerAccounts: boolean;
  commercePaidOffers: boolean;
  commerceCheckout: boolean;
  commerceSettlement: boolean;
  commerceFreeToPaidConversion: boolean;
};

const isOn = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim().toLowerCase() === 'true';

export const getCommerceFlags = (env: NodeJS.ProcessEnv = process.env): CommerceFlags => ({
  commerceBuyerAccounts: isOn(env, 'COMMERCE_BUYER_ACCOUNTS'),
  commercePaidOffers: isOn(env, 'COMMERCE_PAID_OFFERS'),
  commerceCheckout: isOn(env, 'COMMERCE_CHECKOUT'),
  commerceSettlement: isOn(env, 'COMMERCE_SETTLEMENT'),
  commerceFreeToPaidConversion: isOn(env, 'COMMERCE_FREE_TO_PAID_CONVERSION')
});
