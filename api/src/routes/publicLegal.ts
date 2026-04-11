import { z } from 'zod';
import { CONSENT_VERSION, computeConsentTextHash, getLegalTexts, type LegalUiLocale } from './publicLegalTextsSource';

const LEGAL_PUBLISHED_AT = '2026-04-10T00:00:00.000Z';

const localeQuerySchema = z.object({
  locale: z.string().trim().optional()
});

const normalizeLocale = (input?: string | null): string => {
  const value = (input ?? '').trim().toLowerCase();
  if (!value) {
    return 'de-DE';
  }
  if (value === 'de' || value === 'de-de') {
    return 'de-DE';
  }
  if (value === 'en' || value === 'en-gb' || value === 'en-us') {
    return 'en-GB';
  }
  if (value === 'cz' || value === 'cs' || value === 'cs-cz' || value === 'cz-cz') {
    return 'cs-CZ';
  }
  if (value === 'pl' || value === 'pl-pl') {
    return 'pl-PL';
  }
  return 'de-DE';
};

const consentLocaleToUiLocale = (locale: string): LegalUiLocale => {
  if (locale === 'en-GB') {
    return 'en';
  }
  if (locale === 'cs-CZ') {
    return 'cz';
  }
  if (locale === 'pl-PL') {
    return 'pl';
  }
  return 'de';
};

export const getPublicLegalCurrent = async (query: unknown) => {
  const input = localeQuerySchema.parse(query ?? {});
  const consentLocale = normalizeLocale(input.locale);
  const uiLocale = consentLocaleToUiLocale(consentLocale);
  const texts = getLegalTexts(uiLocale);
  const consentTextHash = await computeConsentTextHash(uiLocale);
  return {
    consent: {
      consentLocale,
      consentVersion: CONSENT_VERSION,
      publishedAt: LEGAL_PUBLISHED_AT
    },
    internalConsentTextHash: consentTextHash,
    texts,
    availableLocales: ['de-DE', 'en-GB', 'cs-CZ', 'pl-PL']
  };
};

export const validatePublicLegalCurrentQuery = (query: unknown) => localeQuerySchema.parse(query ?? {});
export const resolvePublicLegalLocale = normalizeLocale;
