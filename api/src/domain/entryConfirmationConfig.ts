import { z } from 'zod';

const optionalTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(500))
  .optional()
  .nullable();

const optionalUrl = z.string().url().optional().nullable();
const optionalEmail = z.string().email().optional().nullable();

export const entryConfirmationScheduleItemSchema = z.object({
  label: z.string().trim().min(1).max(80),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  note: z.string().trim().max(160).optional().nullable()
});

export const entryConfirmationConfigSchema = z.object({
  organizerName: optionalTrimmedString,
  organizerAddressLine: optionalTrimmedString,
  organizerContactEmail: optionalEmail,
  organizerContactPhone: optionalTrimmedString,
  websiteUrl: optionalUrl,
  gateHeadline: optionalTrimmedString,
  venueName: optionalTrimmedString,
  venueStreet: optionalTrimmedString,
  venueZip: optionalTrimmedString,
  venueCity: optionalTrimmedString,
  paddockInfo: optionalTrimmedString,
  arrivalNotes: optionalTrimmedString,
  accessNotes: optionalTrimmedString,
  importantNotes: z.array(z.string().trim().min(1).max(240)).max(12).optional().nullable(),
  scheduleItems: z.array(entryConfirmationScheduleItemSchema).max(12).optional().nullable(),
  paymentRecipient: optionalTrimmedString,
  paymentIban: optionalTrimmedString,
  paymentBic: optionalTrimmedString,
  paymentBankName: optionalTrimmedString,
  paymentReferencePrefix: optionalTrimmedString,
  orgaCodePrefix: optionalTrimmedString
});

export type EntryConfirmationConfig = z.infer<typeof entryConfirmationConfigSchema>;

const normalizeValue = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseScheduleEnvLine = (
  line: string
): { label: string; startsAt?: string | null; endsAt?: string | null; note?: string | null } | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const [labelRaw, restRaw] = trimmed.split(':', 2);
  const label = normalizeValue(labelRaw);
  const rest = normalizeValue(restRaw);
  if (!label) {
    return null;
  }
  return {
    label,
    note: rest
  };
};

export const buildEntryConfirmationConfigFallback = (): EntryConfirmationConfig => ({
  organizerName: 'MSC Oberlausitzer Dreiländereck e.V.',
  organizerAddressLine: 'Am Weiher 4 · 02791 Oderwitz',
  organizerContactEmail: null,
  organizerContactPhone: null,
  websiteUrl: 'https://www.msc-oberlausitzer-dreilaendereck.eu',
  gateHeadline: 'Bitte bei der Einfahrt in das Fahrerlager bereithalten.',
  venueName: null,
  venueStreet: 'Jägerwäldchen 2',
  venueZip: '02763',
  venueCity: 'Bertsdorf-Hörnitz',
  paddockInfo:
    'Das Fahrerlager ist am Veranstaltungstag ab 08:00 Uhr geöffnet. Für Anreisende aus der Ferne ist die Zufahrt bereits am Vortag ab 16:00 Uhr möglich.',
  arrivalNotes: 'GPS-Daten: 50.72738; 14.684114',
  accessNotes: null,
  importantNotes: [
    'Bitte sichern Sie Ölablassschrauben und Ölfilter gemäß Reglement.',
    'Die Abreise aus dem Fahrerlager ist erst nach Ende der Veranstaltung möglich.'
  ],
  scheduleItems: [],
  paymentRecipient: 'MSC Oberlausitzer Dreiländereck e.V.',
  paymentIban: 'DE38 8505 0100 0232 0498 07',
  paymentBic: 'WELADED1GRL',
  paymentBankName: 'Sparkasse Oberlausitz Niederschlesien',
  paymentReferencePrefix: null,
  orgaCodePrefix: null
});

export const mergeEntryConfirmationConfig = (
  value: EntryConfirmationConfig | null | undefined,
  fallback = buildEntryConfirmationConfigFallback()
): EntryConfirmationConfig => {
  const parsed = entryConfirmationConfigSchema.parse(value ?? {});
  return {
    ...fallback,
    ...parsed,
    importantNotes: parsed.importantNotes ?? fallback.importantNotes ?? [],
    scheduleItems: parsed.scheduleItems ?? fallback.scheduleItems ?? []
  };
};

export const overlayEntryConfirmationConfig = (
  base: EntryConfirmationConfig | null | undefined,
  override: EntryConfirmationConfig | null | undefined
): EntryConfirmationConfig => {
  const normalizedBase = entryConfirmationConfigSchema.parse(base ?? {});
  const normalizedOverride = entryConfirmationConfigSchema.parse(override ?? {});
  return {
    ...normalizedBase,
    ...normalizedOverride,
    importantNotes: normalizedOverride.importantNotes ?? normalizedBase.importantNotes ?? [],
    scheduleItems: normalizedOverride.scheduleItems ?? normalizedBase.scheduleItems ?? []
  };
};
