import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appConfig } from '../db/schema';

const PUBLIC_LEGAL_TEXTS_KEY = 'public_legal_texts';
const DEFAULT_CONSENT_VERSION = 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0';

type LegalLocaleConfig = {
  consentLocale: string;
  consentVersion: string;
  consentTextHash: string;
  publishedAt: string;
};

type PublicLegalTextsConfig = {
  currentVersion: string;
  locales: Record<string, LegalLocaleConfig>;
};

const localeQuerySchema = z.object({
  locale: z.string().trim().optional()
});

const DEFAULT_LEGAL_TEXTS_CONFIG: PublicLegalTextsConfig = {
  currentVersion: DEFAULT_CONSENT_VERSION,
  locales: {
    'de-DE': {
      consentLocale: 'de-DE',
      consentVersion: DEFAULT_CONSENT_VERSION,
      consentTextHash: '5dc00be754ed72311584e7df88460471b8a5d8b979eae41f3e69c742f9a06ddd',
      publishedAt: '2026-04-10T00:00:00.000Z'
    },
    'en-GB': {
      consentLocale: 'en-GB',
      consentVersion: DEFAULT_CONSENT_VERSION,
      consentTextHash: '2d0af1fc20976749575c690623905946ba6726528043bf20b712ce48a545ccdf',
      publishedAt: '2026-04-10T00:00:00.000Z'
    },
    'cs-CZ': {
      consentLocale: 'cs-CZ',
      consentVersion: DEFAULT_CONSENT_VERSION,
      consentTextHash: '0ba11228eb03668a42fa1af962ed9431c2aa80c322c2918cc6447f27c00ffcb1',
      publishedAt: '2026-04-10T00:00:00.000Z'
    },
    'pl-PL': {
      consentLocale: 'pl-PL',
      consentVersion: DEFAULT_CONSENT_VERSION,
      consentTextHash: '558478d245fe15e1ba8dbbe9b7be5ab4fae5433d7cbef32a2d08b5397ceda3a6',
      publishedAt: '2026-04-10T00:00:00.000Z'
    }
  }
};

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

const isLegalLocaleConfig = (value: unknown): value is LegalLocaleConfig => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.consentLocale === 'string' &&
    typeof candidate.consentVersion === 'string' &&
    typeof candidate.consentTextHash === 'string' &&
    typeof candidate.publishedAt === 'string'
  );
};

const parseLegalTextsConfig = (value: unknown): PublicLegalTextsConfig => {
  if (!value || typeof value !== 'object') {
    return DEFAULT_LEGAL_TEXTS_CONFIG;
  }
  const candidate = value as Record<string, unknown>;
  const localesCandidate =
    candidate.locales && typeof candidate.locales === 'object'
      ? Object.entries(candidate.locales as Record<string, unknown>).filter(([, item]) => isLegalLocaleConfig(item))
      : [];
  if (localesCandidate.length === 0) {
    return DEFAULT_LEGAL_TEXTS_CONFIG;
  }
  return {
    currentVersion:
      typeof candidate.currentVersion === 'string' && candidate.currentVersion.trim().length > 0
        ? candidate.currentVersion
        : DEFAULT_LEGAL_TEXTS_CONFIG.currentVersion,
    locales: Object.fromEntries(localesCandidate) as Record<string, LegalLocaleConfig>
  };
};

const getPublicLegalTextsConfig = async (): Promise<PublicLegalTextsConfig> => {
  const db = await getDb();
  const rows = await db
    .select({
      payload: appConfig.payload
    })
    .from(appConfig)
    .where(eq(appConfig.configKey, PUBLIC_LEGAL_TEXTS_KEY))
    .limit(1);
  return parseLegalTextsConfig(rows[0]?.payload);
};

export const getPublicLegalCurrent = async (query: unknown) => {
  const input = localeQuerySchema.parse(query ?? {});
  const config = await getPublicLegalTextsConfig();
  const consentLocale = normalizeLocale(input.locale);
  const selected = config.locales[consentLocale] ?? config.locales['de-DE'] ?? DEFAULT_LEGAL_TEXTS_CONFIG.locales['de-DE'];
  return {
    consent: {
      consentLocale: selected.consentLocale,
      consentVersion: selected.consentVersion,
      consentTextHash: selected.consentTextHash,
      publishedAt: selected.publishedAt
    },
    availableLocales: Object.keys(config.locales).sort()
  };
};

export const validatePublicLegalCurrentQuery = (query: unknown) => localeQuerySchema.parse(query ?? {});
export const resolvePublicLegalLocale = normalizeLocale;
