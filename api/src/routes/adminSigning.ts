import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { standardPersonIdentity } from '../domain/personIdentity';
import { buildWaiverContract, WAIVER_VERSION } from '../legal/waiverContract';
import {
  consentEvidence,
  document,
  emailOutbox,
  emailOutboxAttachment,
  emailTemplate,
  emailTemplateVersion,
  entry,
  event,
  eventClass,
  invoice,
  person,
  signingDeviceSession,
  signingSession,
  vehicle
} from '../db/schema';
import { renderSignedWaiverEvidencePdf } from '../docs/pdf';
import { deleteDocumentObject, getAssetObjectBuffer, getDocumentObjectBuffer, uploadFile, uploadPdf } from '../docs/storage';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';

const pairingClaimSchema = z.object({
  pairingCode: z.string().trim().regex(/^[0-9]{6}$/),
  deviceName: z.string().trim().max(80).optional()
});

const createSigningSessionSchema = z.object({
  deviceSessionId: z.string().uuid(),
  entryId: z.string().uuid(),
  signerPersonId: z.string().uuid().optional(),
  precheck: z
    .object({
      identityChecked: z.boolean(),
      signerPresent: z.boolean(),
      medicalCertificateChecked: z.boolean().optional().default(false),
      guardianPresent: z.boolean().optional().default(false),
      guardianAuthorityChecked: z.boolean().optional().default(false)
    })
    .optional(),
  precheckTimestamps: z
    .object({
      identityCheckedAt: z.string().datetime().nullable().optional(),
      signerPresentAt: z.string().datetime().nullable().optional(),
      medicalCertificateCheckedAt: z.string().datetime().nullable().optional(),
      guardianPresentAt: z.string().datetime().nullable().optional(),
      guardianAuthorityCheckedAt: z.string().datetime().nullable().optional()
    })
    .optional(),
  signer: z
    .object({
      type: z.enum(['driver', 'codriver', 'guardian']),
      guardianName: z.string().trim().max(160).nullable().optional(),
      guardianRelationship: z.string().trim().max(80).nullable().optional()
    })
    .superRefine((value, context) => {
      if (value.type !== 'guardian') return;
      if (!value.guardianName?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['guardianName'], message: 'guardianName is required' });
      if (!value.guardianRelationship?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['guardianRelationship'], message: 'guardianRelationship is required' });
    })
    .optional()
});

const completeSigningSessionSchema = z.object({
  displayedAt: z.string().datetime(),
  waiverAcceptedAt: z.string().datetime(),
  signedAt: z.string().datetime(),
  signatureDataUrl: z.string().startsWith('data:image/png;base64,').max(2_000_000),
  guardianEmail: z.string().trim().email().transform((value) => value.toLowerCase()).optional()
});

const waiverMailRecipientSchema = z.string().trim().email().transform((value) => value.toLowerCase());

export const normalizeWaiverMailRecipient = (value: string): string => {
  const parsed = waiverMailRecipientSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('WAIVER_MAIL_RECIPIENT_INVALID');
  }
  return parsed.data;
};

const formatWaiverDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

export const formatWaiverMailEventDates = (startsAt: string, endsAt: string): string => {
  const start = formatWaiverDate(startsAt);
  const end = formatWaiverDate(endsAt);
  return start === end ? start : `${start} – ${end}`;
};

export const formatWaiverMailSignedAt = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

type CreateSigningSessionInput = z.infer<typeof createSigningSessionSchema>;
type CompleteSigningSessionInput = z.infer<typeof completeSigningSessionSchema>;

type PrecheckTimestamps = NonNullable<CreateSigningSessionInput['precheckTimestamps']>;
type SignerInput = {
  type: 'driver' | 'codriver' | 'guardian';
  guardianName: string | null;
  guardianEmail: string | null;
  guardianRelationship: string | null;
  representationMode: 'sole' | null;
};

const SIGNING_SESSION_TTL_MS = 5 * 60 * 1000;

type SigningPersonSnapshot = {
  id: string;
  firstName: string;
  lastName: string;
  birthdate: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  publicationName?: string | null;
};

type SigningCasePayload = {
  id: string;
  event: {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    location: string;
  };
  driver: {
    id: string;
    firstName: string;
    lastName: string;
    birthdate: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
  };
  signer: SigningPersonSnapshot & {
    role: 'driver' | 'codriver';
    label: string;
  };
  isMinor: boolean;
  requiresMedicalCertificate: boolean;
  contract: ReturnType<typeof buildWaiverContract>;
  entries: Array<{
    id: string;
    className: string;
    orgaCode: string | null;
    startNumber: string | null;
    codriver: {
      id: string;
      firstName: string;
      lastName: string;
      birthdate: string | null;
      email: string | null;
      phone: string | null;
      country: string | null;
    } | null;
    vehicles: Array<{
      id: string;
      vehicleType: 'auto' | 'moto';
      make: string;
      model: string;
      year: number | null;
      startNumber: string | null;
      ownerName: string | null;
      role: 'primary' | 'backup';
    }>;
  }>;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hashText = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let waiverPdfFontsPromise: Promise<{ regular: Buffer; bold: Buffer }> | null = null;
let waiverPdfLogoPromise: Promise<Buffer> | null = null;
export const loadWaiverPdfFonts = () => {
  if (!waiverPdfFontsPromise) {
    const pending = Promise.all([
      getAssetObjectBuffer('public/mail/fonts/arial.ttf'),
      getAssetObjectBuffer('public/mail/fonts/arialbd.ttf')
    ]).then(([regular, bold]) => {
      if (!regular || !bold) throw new Error('WAIVER_PDF_FONT_UNAVAILABLE');
      return { regular, bold };
    });
    waiverPdfFontsPromise = pending.catch((error) => {
      waiverPdfFontsPromise = null;
      throw error;
    });
  }
  return waiverPdfFontsPromise;
};

export const loadWaiverPdfLogo = () => {
  if (!waiverPdfLogoPromise) {
    const pending = getAssetObjectBuffer('public/mail/msc-logo.png').then((logo) => {
      if (!logo) throw new Error('WAIVER_PDF_LOGO_UNAVAILABLE');
      return logo;
    });
    waiverPdfLogoPromise = pending.catch((error) => {
      waiverPdfLogoPromise = null;
      throw error;
    });
  }
  return waiverPdfLogoPromise;
};

export const signatureDataUrlToBuffer = (value: string): Buffer => {
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error('SIGNATURE_INVALID');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 60 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('SIGNATURE_INVALID');
  return buffer;
};

const assertSigningChronology = (displayedAt: string, acceptedAt: string, signedAt: string, now = new Date()) => {
  const displayed = new Date(displayedAt).getTime();
  const accepted = new Date(acceptedAt).getTime();
  const signed = new Date(signedAt).getTime();
  if (![displayed, accepted, signed].every(Number.isFinite) || displayed > accepted || accepted > signed || signed > now.getTime() + 60_000) {
    throw new Error('SIGNING_TIMESTAMPS_INVALID');
  }
};

const COUNTRY_LOCALE_FALLBACK: Record<string, SigningCasePayload['contract']['locale']> = {
  DE: 'de-DE',
  AT: 'de-DE',
  CH: 'de-DE',
  CZ: 'cs-CZ',
  PL: 'pl-PL'
};

export const normalizeConsentLocale = (
  value: string | null | undefined,
  countryFallback?: string | null
): SigningCasePayload['contract']['locale'] => {
  if (value === 'en-GB' || value === 'en' || value === 'en-US') {
    return 'en-GB';
  }
  if (value === 'cs-CZ' || value === 'cs' || value === 'cz') {
    return 'cs-CZ';
  }
  if (value === 'pl-PL' || value === 'pl') {
    return 'pl-PL';
  }
  if (value === 'de-DE' || value === 'de') {
    return 'de-DE';
  }
  // No usable consent locale on file (e.g. signer never went through the
  // online consent flow, or the recorded consent belongs to someone else on
  // the entry). Fall back to a locale inferred from the signer's own
  // registered country instead of silently defaulting to German.
  const country = countryFallback?.trim().toUpperCase();
  if (country) {
    return COUNTRY_LOCALE_FALLBACK[country] ?? 'en-GB';
  }
  return 'de-DE';
};

const ageAt = (birthdate: string | null, date: Date): number | null => {
  if (!birthdate) return null;
  const match = birthdate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = date.getUTCFullYear() - year;
  const currentMonth = date.getUTCMonth() + 1;
  const currentDay = date.getUTCDate();
  if (currentMonth < month || (currentMonth === month && currentDay < day)) {
    age -= 1;
  }
  return age;
};

const assertPrecheckComplete = (input: {
  isMinor: boolean;
  requiresMedicalCertificate: boolean;
  precheckTimestamps: PrecheckTimestamps;
  signer: SignerInput;
}) => {
  if (!input.precheckTimestamps.identityCheckedAt || !input.precheckTimestamps.signerPresentAt) {
    throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  }
  if (input.requiresMedicalCertificate && !input.precheckTimestamps.medicalCertificateCheckedAt) {
    throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  }
  if (input.isMinor) {
    if (input.signer.type !== 'guardian') {
      throw new Error('SIGNING_GUARDIAN_REQUIRED');
    }
    if (!input.precheckTimestamps.guardianPresentAt || !input.precheckTimestamps.guardianAuthorityCheckedAt) {
      throw new Error('SIGNING_PRECHECK_INCOMPLETE');
    }
    if (!input.signer.guardianName?.trim() || !input.signer.guardianRelationship?.trim() || input.signer.representationMode !== 'sole') {
      throw new Error('SIGNING_GUARDIAN_REQUIRED');
    }
  }
};

const precheckTimestampsFromInput = (input: CreateSigningSessionInput): PrecheckTimestamps => {
  const now = new Date().toISOString();
  return {
    identityCheckedAt: input.precheckTimestamps?.identityCheckedAt ?? (input.precheck?.identityChecked ? now : null),
    signerPresentAt: input.precheckTimestamps?.signerPresentAt ?? (input.precheck?.signerPresent ? now : null),
    medicalCertificateCheckedAt: input.precheckTimestamps?.medicalCertificateCheckedAt ?? (input.precheck?.medicalCertificateChecked ? now : null),
    guardianPresentAt: input.precheckTimestamps?.guardianPresentAt ?? (input.precheck?.guardianPresent ? now : null),
    guardianAuthorityCheckedAt: input.precheckTimestamps?.guardianAuthorityCheckedAt ?? (input.precheck?.guardianAuthorityChecked ? now : null)
  };
};

const signerFromInput = (input: CreateSigningSessionInput, payload: SigningCasePayload): SignerInput => {
  if (payload.isMinor) {
    return {
      type: 'guardian',
      guardianName: input.signer?.guardianName?.trim() || null,
      guardianEmail: null,
      guardianRelationship: input.signer?.guardianRelationship?.trim() || null,
      representationMode: 'sole'
    };
  }
  return {
    type: payload.signer.role,
    guardianName: null,
    guardianEmail: null,
    guardianRelationship: null,
    representationMode: null
  };
};

const getDeviceTokenFromHeaders = (headers: Record<string, string | undefined>): string | null => {
  const explicit = headers['x-signing-device-token'] ?? headers['X-Signing-Device-Token'];
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const authorization = headers.authorization ?? headers.Authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
};

export const resolveDeviceByToken = async (deviceToken: string) => {
  const db = await getDb();
  const tokenHash = hashToken(deviceToken);
  const rows = await db
    .select()
    .from(signingDeviceSession)
    .where(and(eq(signingDeviceSession.tokenHash, tokenHash), eq(signingDeviceSession.status, 'connected')))
    .limit(1);
  const device = rows[0];
  if (!device) {
    return null;
  }
  await db
    .update(signingDeviceSession)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(signingDeviceSession.id, device.id));
  return device;
};

export const expireOpenSigningSessions = async (db: Awaited<ReturnType<typeof getDb>>, now = new Date()) => {
  await db
    .update(signingSession)
    .set({
      status: 'cancelled',
      workflowStage: 'cancelled',
      draftPayload: null,
      updatedAt: now,
      errorLast: 'SIGNING_SESSION_EXPIRED'
    })
    .where(and(sql`${signingSession.status} in ('pending', 'displayed')`, sql`${signingSession.expiresAt} <= ${now}`));
};

const buildSigningCasePayload = async (sourceEntryId: string, signerPersonId?: string): Promise<SigningCasePayload | null> => {
  const db = await getDb();
  const sourceRows = await db
    .select({
      entryId: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      driverBirthdate: person.birthdate,
      driverEmail: person.email,
      driverPhone: person.phone,
      driverCountry: person.country
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(and(eq(entry.id, sourceEntryId), sql`${entry.deletedAt} is null`))
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    return null;
  }

  const entryRows = await db
    .select({
      entryId: entry.id,
      className: eventClass.name,
      orgaCode: entry.orgaCode,
      startNumber: entry.startNumberNorm,
      codriverPersonId: entry.codriverPersonId,
      vehicleId: entry.vehicleId,
      backupVehicleId: entry.backupVehicleId,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleStartNumber: vehicle.startNumberRaw,
      vehicleOwnerName: vehicle.ownerName
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(and(eq(entry.eventId, source.eventId), eq(entry.driverPersonId, source.driverPersonId), sql`${entry.deletedAt} is null`))
    .orderBy(eventClass.name, entry.startNumberNorm);

  const codriverIds = Array.from(new Set(entryRows.map((row) => row.codriverPersonId).filter((id): id is string => Boolean(id))));
  const codriverRows = codriverIds.length
    ? await db
        .select({
          id: person.id,
          firstName: person.firstName,
          lastName: person.lastName,
          birthdate: person.birthdate,
          email: person.email,
          phone: person.phone,
          country: person.country,
          publicationName: person.publicationName
        })
        .from(person)
        .where(inArray(person.id, codriverIds))
    : [];
  const codriverById = new Map(codriverRows.map((row) => [row.id, row]));

  const backupIds = Array.from(new Set(entryRows.map((row) => row.backupVehicleId).filter((id): id is string => Boolean(id))));
  const backupRows = backupIds.length
    ? await db
        .select({
          id: vehicle.id,
          vehicleType: vehicle.vehicleType,
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          startNumber: vehicle.startNumberRaw,
          ownerName: vehicle.ownerName
        })
        .from(vehicle)
        .where(inArray(vehicle.id, backupIds))
    : [];
  const backupById = new Map(backupRows.map((row) => [row.id, row]));

  const driverSnapshot: SigningPersonSnapshot = {
    id: source.driverPersonId,
    firstName: source.driverFirstName,
    lastName: source.driverLastName,
    birthdate: source.driverBirthdate?.toString() ?? null,
    email: source.driverEmail,
    phone: source.driverPhone,
    country: source.driverCountry,
    publicationName: source.driverPublicationName
  };
  const requestedSignerId = signerPersonId ?? source.driverPersonId;
  const codriverSnapshot = codriverById.get(requestedSignerId);
  const signer =
    requestedSignerId === source.driverPersonId
      ? { ...driverSnapshot, role: 'driver' as const, label: 'Fahrer' }
      : codriverSnapshot
        ? {
            id: codriverSnapshot.id,
            firstName: codriverSnapshot.firstName,
            lastName: codriverSnapshot.lastName,
            birthdate: codriverSnapshot.birthdate?.toString() ?? null,
            email: codriverSnapshot.email,
            phone: codriverSnapshot.phone,
            country: codriverSnapshot.country,
            publicationName: codriverSnapshot.publicationName,
            role: 'codriver' as const,
            label: 'Beifahrer'
          }
        : null;
  if (!signer) {
    throw new Error('SIGNING_SIGNER_NOT_FOUND');
  }
  const signerEntryRows = signer.role === 'codriver' ? entryRows.filter((row) => row.codriverPersonId === signer.id) : entryRows;
  if (signerEntryRows.length === 0) {
    throw new Error('SIGNING_SIGNER_NOT_FOUND');
  }

  const consentRows = await db
    .select({
      consentVersion: consentEvidence.consentVersion,
      consentTextHash: consentEvidence.consentTextHash,
      locale: consentEvidence.locale
    })
    .from(consentEvidence)
    .where(and(eq(consentEvidence.entryId, source.entryId), eq(consentEvidence.personId, signer.id)))
    .orderBy(desc(consentEvidence.capturedAt), desc(consentEvidence.createdAt))
    .limit(1);
  const consent = consentRows[0] ?? null;
  const locale = normalizeConsentLocale(consent?.locale, signer.country);
  const eventStart = new Date(`${source.eventStartsAt}T12:00:00.000Z`);
  const signerAge = ageAt(signer.birthdate, eventStart);

  return {
    id: `signing-case:${source.eventId}:${source.driverPersonId}:${signer.id}`,
    event: {
      id: source.eventId,
      name: source.eventName,
      startsAt: source.eventStartsAt?.toString() ?? '',
      endsAt: source.eventEndsAt?.toString() ?? '',
      location: 'MSC Oberlausitzer Dreiländereck'
    },
    driver: {
      ...driverSnapshot
    },
    signer,
    isMinor: signerAge !== null && signerAge < 18,
    requiresMedicalCertificate: signerAge !== null && signerAge >= 70,
    contract: buildWaiverContract(locale),
    entries: signerEntryRows.map((row) => {
      const codriver = row.codriverPersonId ? codriverById.get(row.codriverPersonId) ?? null : null;
      const vehicles: SigningCasePayload['entries'][number]['vehicles'] = [
        {
          id: row.vehicleId,
          vehicleType: row.vehicleType === 'moto' ? 'moto' : 'auto',
          make: row.vehicleMake ?? '',
          model: row.vehicleModel ?? '',
          year: row.vehicleYear ?? null,
          startNumber: row.vehicleStartNumber ?? row.startNumber ?? null,
          ownerName: row.vehicleOwnerName ?? null,
          role: 'primary'
        }
      ];
      const backup = row.backupVehicleId ? backupById.get(row.backupVehicleId) : null;
      if (backup) {
        vehicles.push({
          id: backup.id,
          vehicleType: backup.vehicleType === 'moto' ? 'moto' : 'auto',
          make: backup.make ?? '',
          model: backup.model ?? '',
          year: backup.year ?? null,
          startNumber: backup.startNumber ?? null,
          ownerName: backup.ownerName ?? null,
          role: 'backup'
        });
      }
      return {
        id: row.entryId,
        className: row.className,
        orgaCode: row.orgaCode ?? null,
        startNumber: row.startNumber ?? null,
        codriver: codriver
          ? {
              id: codriver.id,
              firstName: codriver.firstName,
              lastName: codriver.lastName,
              birthdate: codriver.birthdate?.toString() ?? null,
              email: codriver.email,
              phone: codriver.phone,
              country: codriver.country,
              publicationName: codriver.publicationName
            }
          : null,
        vehicles
      };
    })
  };
};

type LivePublicationIdentity = {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
  publicationName: string | null;
};

const projectSigningPerson = (
  source: any,
  identityById = new Map<string, LivePublicationIdentity>(),
  identityByEmail = new Map<string, LivePublicationIdentity>()
) => {
  if (!source) return source;
  const liveIdentity = (typeof source.id === 'string' ? identityById.get(source.id) : undefined)
    ?? (typeof source.email === 'string' ? identityByEmail.get(source.email.trim().toLowerCase()) : undefined);
  const identity = standardPersonIdentity({
    firstName: source.firstName ?? liveIdentity?.firstName ?? null,
    lastName: source.lastName ?? liveIdentity?.lastName ?? null,
    publicationName: liveIdentity ? liveIdentity.publicationName : source.publicationName ?? null
  });
  return {
    ...source,
    displayName: identity.displayName,
    identityProtected: identity.identityProtected,
    firstName: identity.firstName,
    lastName: identity.lastName,
    birthdate: identity.identityProtected ? null : source.birthdate,
    email: identity.identityProtected ? null : source.email,
    phone: identity.identityProtected ? null : source.phone,
    country: identity.identityProtected ? null : source.country,
    publicationName: undefined
  };
};

const projectSigningCasePayload = (
  payload: any,
  identityById = new Map<string, LivePublicationIdentity>(),
  identityByEmail = new Map<string, LivePublicationIdentity>()
) => {
  if (!payload || typeof payload !== 'object') return payload;
  const driver = projectSigningPerson(payload.driver, identityById, identityByEmail);
  return {
    ...payload,
    driver,
    signer: projectSigningPerson(payload.signer, identityById, identityByEmail),
    participant: projectSigningPerson(payload.participant, identityById, identityByEmail),
    entries: Array.isArray(payload.entries) ? payload.entries.map((item: any) => ({
      ...item,
      codriver: projectSigningPerson(item.codriver, identityById, identityByEmail),
      vehicles: Array.isArray(item.vehicles) ? item.vehicles.map((vehicleItem: any) => ({
        ...vehicleItem,
        ownerName: driver?.identityProtected ? null : vehicleItem.ownerName
      })) : []
    })) : []
  };
};

const projectSigningSession = (
  session: any,
  identityById = new Map<string, LivePublicationIdentity>(),
  identityByEmail = new Map<string, LivePublicationIdentity>()
) => session
  ? {
      ...session,
      sessionPayload: projectSigningCasePayload(session.sessionPayload, identityById, identityByEmail),
      draftPayload: session.draftPayload
        ? (() => {
            const projected = projectSigningPerson(session.draftPayload, identityById, identityByEmail);
            return projected.identityProtected
              ? {
                  displayName: projected.displayName,
                  identityProtected: true,
                  firstName: null,
                  lastName: null,
                  birthdate: null,
                  country: null,
                  street: null,
                  zip: null,
                  city: null,
                  email: null,
                  phone: null,
                  emergencyContactFirstName: null,
                  emergencyContactLastName: null,
                  emergencyContactPhone: null,
                  motorsportHistory: null,
                  guardianFullName: null,
                  guardianEmail: null,
                  guardianPhone: null,
                  guardianRelationship: null
                }
              : session.draftPayload;
          })()
        : session.draftPayload
    }
  : session;

const projectSigningSessionWithLiveIdentity = async (db: any, session: any) => {
  if (!session) return session;
  const payload = session.sessionPayload as any;
  const personIds = Array.from(new Set<string>([
    session.driverPersonId,
    payload?.driver?.id,
    payload?.signer?.id,
    payload?.participant?.id,
    ...(Array.isArray(payload?.entries) ? payload.entries.map((item: any) => item?.codriver?.id) : [])
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const liveRows: LivePublicationIdentity[] = personIds.length > 0
    ? await db.select({
        id: person.id,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        publicationName: person.publicationName
      }).from(person).where(inArray(person.id, personIds))
    : [];
  const draftEmail = typeof session.draftPayload?.email === 'string'
    ? session.draftPayload.email.trim().toLowerCase()
    : null;
  if (draftEmail && !liveRows.some((item) => item.email?.trim().toLowerCase() === draftEmail)) {
    const [draftPerson] = await db.select({
      id: person.id,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      publicationName: person.publicationName
    }).from(person).where(sql`lower(${person.email}) = ${draftEmail}`).limit(1);
    if (draftPerson) liveRows.push(draftPerson);
  }
  const identityById = new Map(liveRows.map((item) => [item.id, item]));
  const identityByEmail = new Map(liveRows.flatMap((item) => item.email ? [[item.email.trim().toLowerCase(), item] as const] : []));
  return projectSigningSession(session, identityById, identityByEmail);
};

export const createSigningPairingCode = async (actorUserId: string | null) => {
  const db = await getDb();
  const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await db
    .update(signingDeviceSession)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(signingDeviceSession.status, 'pairing'), sql`${signingDeviceSession.expiresAt} < ${now}`));
  await db
    .update(signingDeviceSession)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(signingDeviceSession.status, 'pairing'), sql`${signingDeviceSession.pairedBy} = ${actorUserId}`));
  const [created] = await db
    .insert(signingDeviceSession)
    .values({
      pairingCode,
      status: 'pairing',
      pairedBy: actorUserId,
      expiresAt,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  return { deviceSession: created, pairingCode, expiresAt: expiresAt.toISOString() };
};

export const listSigningDevices = async () => {
  const db = await getDb();
  const now = new Date();
  await db
    .update(signingDeviceSession)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(signingDeviceSession.status, 'pairing'), sql`${signingDeviceSession.expiresAt} < ${now}`));
  const rows = await db
    .select({
      id: signingDeviceSession.id,
      deviceName: signingDeviceSession.deviceName,
      status: signingDeviceSession.status,
      pairedAt: signingDeviceSession.pairedAt,
      lastSeenAt: signingDeviceSession.lastSeenAt,
      expiresAt: signingDeviceSession.expiresAt
    })
    .from(signingDeviceSession)
    .where(and(sql`${signingDeviceSession.status} in ('pairing', 'connected')`, sql`${signingDeviceSession.status} != 'pairing' or ${signingDeviceSession.expiresAt} >= ${now}`))
    .orderBy(desc(signingDeviceSession.createdAt))
    .limit(20);
  return rows;
};

export const revokeSigningDevice = async (deviceSessionId: string, actorUserId: string | null) => {
  const db = await getDb();
  const [updated] = await db
    .update(signingDeviceSession)
    .set({ status: 'revoked', tokenHash: null, updatedAt: new Date() })
    .where(eq(signingDeviceSession.id, deviceSessionId))
    .returning();
  if (!updated) {
    return null;
  }
  await writeAuditLog(db as never, {
    eventId: null,
    actorUserId,
    action: 'signing_device_revoked',
    entityType: 'signing_device_session',
    entityId: updated.id,
    payload: {
      deviceName: updated.deviceName
    }
  });
  return updated;
};

export const getSigningRequirements = async (entryId: string) => {
  const payload = await buildSigningCasePayload(entryId);
  if (!payload) {
    return null;
  }
  const eventStart = new Date(`${payload.event.startsAt}T12:00:00.000Z`);
  const signerCandidates = [
    { ...payload.driver, role: 'driver' as const, label: 'Fahrer' },
    ...payload.entries
      .map((item) => item.codriver)
      .filter((item): item is NonNullable<(typeof payload.entries)[number]['codriver']> => Boolean(item))
      .map((item) => ({ ...item, role: 'codriver' as const, label: 'Beifahrer' }))
  ].filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
  const db = await getDb();
  const now = new Date();
  await expireOpenSigningSessions(db, now);
  const entryIds = payload.entries.map((item) => item.id);
  const signerIds = signerCandidates.map((item) => item.id);
  const [payment] = await db
    .select({
      status: invoice.paymentStatus,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents
    })
    .from(invoice)
    .where(and(eq(invoice.eventId, payload.event.id), eq(invoice.driverPersonId, payload.driver.id)))
    .limit(1);
  const [activeSession] = await db
    .select({
      id: signingSession.id,
      operatorDisplay: signingSession.operatorDisplay,
      deviceName: signingDeviceSession.deviceName,
      createdAt: signingSession.createdAt,
      expiresAt: signingSession.expiresAt
    })
    .from(signingSession)
    .leftJoin(signingDeviceSession, eq(signingDeviceSession.id, signingSession.deviceSessionId))
    .where(and(
      eq(signingSession.eventId, payload.event.id),
      eq(signingSession.driverPersonId, payload.driver.id),
      inArray(signingSession.status, ['pending', 'displayed']),
      sql`${signingSession.expiresAt} > ${now}`
    ))
    .limit(1);
  const signedRows =
    entryIds.length > 0 && signerIds.length > 0
      ? await db
          .select({
            entryId: document.entryId,
            driverPersonId: document.driverPersonId,
            documentId: document.id,
            createdAt: document.createdAt
          })
          .from(document)
          .where(and(
            eq(document.type, 'waiver_signed'),
            eq(document.templateVersion, WAIVER_VERSION),
            eq(document.status, 'generated'),
            inArray(document.entryId, entryIds),
            inArray(document.driverPersonId, signerIds)
          ))
          .orderBy(desc(document.createdAt))
      : [];
  const signedByPersonId = new Map<string, { documentId: string; signedAt: string }>();
  for (const row of signedRows) {
    if (!row.driverPersonId || signedByPersonId.has(row.driverPersonId)) {
      continue;
    }
    signedByPersonId.set(row.driverPersonId, {
      documentId: row.documentId,
      signedAt: row.createdAt.toISOString()
    });
  }
  return {
    entryId,
    caseId: payload.id,
    driverName: standardPersonIdentity(payload.driver).displayName,
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    signerType: payload.isMinor ? 'guardian' : 'driver',
    entryCount: payload.entries.length,
    vehicleCount: payload.entries.reduce((count, item) => count + item.vehicles.length, 0),
    payment: payment
      ? {
          status: payment.status,
          totalCents: payment.totalCents,
          paidAmountCents: payment.paidAmountCents ?? 0,
          amountOpenCents: Math.max(0, payment.totalCents - (payment.paidAmountCents ?? 0))
        }
      : { status: 'unknown', totalCents: null, paidAmountCents: null, amountOpenCents: null },
    activeSession: activeSession
      ? {
          id: activeSession.id,
          operatorDisplay: activeSession.operatorDisplay,
          deviceName: activeSession.deviceName,
          createdAt: activeSession.createdAt.toISOString(),
          expiresAt: activeSession.expiresAt.toISOString()
        }
      : null,
    contract: {
      locale: payload.contract.locale,
      version: payload.contract.version,
      textHash: payload.contract.textHash
    },
    signers: signerCandidates.map((item) => {
      const signerAge = ageAt(item.birthdate, eventStart);
      const signed = signedByPersonId.get(item.id) ?? null;
      return {
        personId: item.id,
        role: item.role,
        label: item.label,
        name: standardPersonIdentity(item).displayName,
        isMinor: signerAge !== null && signerAge < 18,
        requiresMedicalCertificate: signerAge !== null && signerAge >= 70,
        signed: Boolean(signed),
        signedAt: signed?.signedAt ?? null,
        documentId: signed?.documentId ?? null
      };
    }),
    entries: projectSigningCasePayload(payload).entries
  };
};

export const claimSigningDevice = async (input: z.infer<typeof pairingClaimSchema>) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db
    .select()
    .from(signingDeviceSession)
    .where(and(eq(signingDeviceSession.pairingCode, input.pairingCode), eq(signingDeviceSession.status, 'pairing'), sql`${signingDeviceSession.expiresAt} >= ${now}`))
    .orderBy(desc(signingDeviceSession.createdAt))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    throw new Error('SIGNING_PAIRING_CODE_INVALID');
  }
  const deviceToken = randomBytes(32).toString('base64url');
  const [updated] = await db
    .update(signingDeviceSession)
    .set({
      deviceName: input.deviceName?.trim() || 'Signaturterminal',
      tokenHash: hashToken(deviceToken),
      status: 'connected',
      pairedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: now
    })
    .where(eq(signingDeviceSession.id, existing.id))
    .returning({
      id: signingDeviceSession.id,
      deviceName: signingDeviceSession.deviceName,
      status: signingDeviceSession.status
    });
  return { device: updated, deviceToken };
};

export const createSigningSession = async (input: CreateSigningSessionInput, actorUserId: string | null, actorDisplay: string | null) => {
  const db = await getDb();
  const deviceRows = await db
    .select()
    .from(signingDeviceSession)
    .where(and(eq(signingDeviceSession.id, input.deviceSessionId), eq(signingDeviceSession.status, 'connected')))
    .limit(1);
  if (!deviceRows[0]) {
    throw new Error('SIGNING_DEVICE_NOT_CONNECTED');
  }

  const payload = await buildSigningCasePayload(input.entryId, input.signerPersonId);
  if (!payload) {
    return null;
  }
  const precheckTimestamps = precheckTimestampsFromInput(input);
  const signer = signerFromInput(input, payload);
  assertPrecheckComplete({
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    precheckTimestamps,
    signer
  });

  const now = new Date();
  await expireOpenSigningSessions(db, now);
  const expiresAt = new Date(now.getTime() + SIGNING_SESSION_TTL_MS);
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`signing-active:${payload.event.id}:${payload.driver.id}`}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`signing-device:${input.deviceSessionId}`}, 0))`);
    const [activeForDriver] = await tx
      .select({ id: signingSession.id })
      .from(signingSession)
      .where(and(
        eq(signingSession.eventId, payload.event.id),
        eq(signingSession.driverPersonId, payload.driver.id),
        inArray(signingSession.status, ['pending', 'displayed']),
        sql`${signingSession.expiresAt} > ${now}`
      ))
      .limit(1);
    if (activeForDriver) throw new Error('SIGNING_SESSION_ALREADY_ACTIVE');

    const [activeForDevice] = await tx
      .select({ id: signingSession.id })
      .from(signingSession)
      .where(and(
        eq(signingSession.deviceSessionId, input.deviceSessionId),
        inArray(signingSession.status, ['pending', 'displayed']),
        sql`${signingSession.expiresAt} > ${now}`
      ))
      .limit(1);
    if (activeForDevice) throw new Error('SIGNING_DEVICE_BUSY');

    if (payload.signer.role === 'driver') {
      const [paymentRow] = await tx
        .select({ status: invoice.paymentStatus })
        .from(invoice)
        .where(and(eq(invoice.eventId, payload.event.id), eq(invoice.driverPersonId, payload.driver.id)))
        .limit(1);
      const paymentStatus = paymentRow?.status;
      if (paymentStatus !== 'paid' && paymentStatus !== 'not_required') {
        throw new Error('SIGNING_PAYMENT_REQUIRED');
      }
    }

    const [existingSignedDocument] = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(
        eq(document.eventId, payload.event.id),
        eq(document.driverPersonId, payload.signer.id),
        eq(document.type, 'waiver_signed'),
        eq(document.templateVersion, WAIVER_VERSION),
        eq(document.status, 'generated')
      ))
      .limit(1);
    if (existingSignedDocument) throw new Error('WAIVER_ALREADY_SIGNED');

    const [inserted] = await tx
      .insert(signingSession)
      .values({
        deviceSessionId: input.deviceSessionId,
        eventId: payload.event.id,
        driverPersonId: payload.driver.id,
        sourceEntryId: input.entryId,
        status: 'pending',
        sessionPayload: payload,
        precheckPayload: precheckTimestamps,
        signerPayload: signer,
        operatorUserId: actorUserId,
        operatorDisplay: actorDisplay,
        expiresAt,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    await writeAuditLog(tx as never, {
      eventId: payload.event.id,
      actorUserId,
      action: 'signing_session_started',
      entityType: 'signing_session',
      entityId: inserted.id,
      payload: {
        entryIds: payload.entries.map((entryItem) => entryItem.id),
        signerPersonId: payload.signer.id,
        signerRole: payload.signer.role,
        deviceSessionId: input.deviceSessionId
      }
    });
    return inserted;
  });

  return { session: projectSigningSession(created), signingCase: projectSigningCasePayload(payload) };
};

export const getSigningSession = async (sessionId: string) => {
  const db = await getDb();
  await expireOpenSigningSessions(db);
  const rows = await db.select().from(signingSession).where(eq(signingSession.id, sessionId)).limit(1);
  return projectSigningSessionWithLiveIdentity(db, rows[0] ?? null);
};

export const cancelSigningSession = async (sessionId: string, actorUserId: string | null) => {
  const db = await getDb();
  const [updated] = await db
    .update(signingSession)
    .set({ status: 'cancelled', workflowStage: 'cancelled', draftPayload: null, updatedAt: new Date() })
    .where(and(eq(signingSession.id, sessionId), sql`${signingSession.status} in ('pending', 'displayed')`))
    .returning();
  if (!updated) {
    return null;
  }
  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'signing_session_cancelled',
    entityType: 'signing_session',
    entityId: updated.id,
    payload: {
      deviceSessionId: updated.deviceSessionId
    }
  });
  return projectSigningSessionWithLiveIdentity(db, updated);
};

export const restartSignedWaiver = async (
  entryId: string,
  signerPersonId: string | undefined,
  actorUserId: string | null
) => {
  const payload = await buildSigningCasePayload(entryId, signerPersonId);
  if (!payload) {
    return null;
  }
  const db = await getDb();
  const superseded = await db
    .update(document)
    .set({ status: 'superseded' })
    .where(and(
      eq(document.eventId, payload.event.id),
      eq(document.driverPersonId, payload.signer.id),
      eq(document.type, 'waiver_signed'),
      eq(document.status, 'generated')
    ))
    .returning({ id: document.id });
  if (superseded.length === 0) {
    throw new Error('SIGNING_WAIVER_NOT_SIGNED');
  }
  await writeAuditLog(db as never, {
    eventId: payload.event.id,
    actorUserId,
    action: 'signing_waiver_restarted',
    entityType: 'person',
    entityId: payload.signer.id,
    payload: {
      entryId,
      signerRole: payload.signer.role,
      supersededDocumentIds: superseded.map((row) => row.id)
    }
  });
  return getSigningRequirements(entryId);
};

export const getCurrentDeviceSigningSession = async (deviceToken: string) => {
  const device = await resolveDeviceByToken(deviceToken);
  if (!device) {
    throw new Error('SIGNING_DEVICE_UNAUTHORIZED');
  }
  const db = await getDb();
  const now = new Date();
  await expireOpenSigningSessions(db, now);
  const rows = await db
    .select()
    .from(signingSession)
    .where(and(eq(signingSession.deviceSessionId, device.id), sql`${signingSession.status} in ('pending', 'displayed')`, sql`${signingSession.expiresAt} > ${now}`))
    .orderBy(desc(signingSession.createdAt))
    .limit(1);
  const current = rows[0] ?? null;
  const shouldRecordContractDisplay = current && (
    (current.workflowType === 'waiver_signature' && current.status === 'pending')
    || (current.workflowStage === 'ready_to_sign' && !current.displayedAt)
  );
  if (shouldRecordContractDisplay) {
    const [displayed] = await db
      .update(signingSession)
      .set({ status: 'displayed', displayedAt: now, updatedAt: now })
      .where(eq(signingSession.id, current.id))
      .returning();
    return projectSigningSessionWithLiveIdentity(db, displayed ?? current);
  }
  return projectSigningSessionWithLiveIdentity(db, current);
};

export const completeDeviceSigningSession = async (sessionId: string, input: CompleteSigningSessionInput, deviceToken: string) => {
  const device = await resolveDeviceByToken(deviceToken);
  if (!device) {
    throw new Error('SIGNING_DEVICE_UNAUTHORIZED');
  }
  const db = await getDb();
  const now = new Date();
  await expireOpenSigningSessions(db, now);
  const rows = await db
    .select()
    .from(signingSession)
    .where(and(eq(signingSession.id, sessionId), eq(signingSession.deviceSessionId, device.id)))
    .limit(1);
  const current = rows[0];
  if (!current) {
    return null;
  }
  if (current.status === 'completed') {
    return projectSigningSessionWithLiveIdentity(db, current);
  }
  if (current.status !== 'pending' && current.status !== 'displayed') {
    throw new Error('SIGNING_SESSION_NOT_ACTIVE');
  }
  if (current.expiresAt <= now) {
    await db
      .update(signingSession)
      .set({ status: 'cancelled', workflowStage: 'cancelled', draftPayload: null, updatedAt: now, errorLast: 'SIGNING_SESSION_EXPIRED' })
      .where(eq(signingSession.id, current.id));
    throw new Error('SIGNING_SESSION_EXPIRED');
  }

  const payload = current.sessionPayload as SigningCasePayload;
  const precheckTimestamps = current.precheckPayload as PrecheckTimestamps;
  const storedSigner = current.signerPayload as SignerInput;
  const signer: SignerInput = payload.isMinor
    ? { ...storedSigner, guardianEmail: input.guardianEmail?.trim().toLowerCase() ?? null }
    : storedSigner;
  if (payload.isMinor && !signer.guardianEmail) {
    throw new Error('SIGNING_GUARDIAN_EMAIL_REQUIRED');
  }
  assertPrecheckComplete({
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    precheckTimestamps,
    signer
  });
  const effectiveDisplayedAt = current.displayedAt?.toISOString() ?? input.displayedAt;
  assertSigningChronology(effectiveDisplayedAt, input.waiverAcceptedAt, input.signedAt, now);
  const signatureBuffer = signatureDataUrlToBuffer(input.signatureDataUrl);
  const signatureSha256 = hashText(signatureBuffer);
  const evidenceId = `${current.id}-${randomUUID()}`;
  const baseKey = `signing/${payload.event.id}/${payload.signer.id}/${evidenceId}`;
  const documentS3Key = `${baseKey}/waiver.pdf`;
  const auditS3Key = `${baseKey}/audit.json`;
  const signatureS3Key = `${baseKey}/signature.png`;
  const auditPayload = {
    auditSchemaVersion: 'signing-terminal-v1',
    evidenceId,
    sessionId: current.id,
    eventId: payload.event.id,
    driverPersonId: payload.driver.id,
    signerPersonId: payload.signer.id,
    signerRole: payload.signer.role,
    entryIds: payload.entries.map((entryItem) => entryItem.id),
    vehicleIds: payload.entries.flatMap((entryItem) => entryItem.vehicles.map((vehicleItem) => vehicleItem.id)),
    signer,
    waiver: {
      locale: payload.contract.locale,
      version: payload.contract.version,
      authoritativeLocale: payload.contract.authoritativeLocale,
      authoritativeText: payload.contract.authoritativeFullText,
      authoritativeTextHash: payload.contract.authoritativeTextHash,
      translation: payload.contract.translation,
      displayedAt: effectiveDisplayedAt,
      acceptedAt: input.waiverAcceptedAt
    },
    precheckTimestamps,
    operator: {
      id: current.operatorUserId,
      displayName: current.operatorDisplay
    },
    signature: {
      capturedAt: input.signedAt,
      imageSha256: signatureSha256,
      s3Key: signatureS3Key
    },
    document: {
      sha256: '',
      s3Key: documentS3Key
    }
  };
  const pdfBuffer = await renderSignedWaiverEvidencePdf({
    sessionId: current.id,
    payload,
    signer,
    precheckTimestamps,
    operatorDisplay: current.operatorDisplay,
    displayedAt: effectiveDisplayedAt,
    waiverAcceptedAt: input.waiverAcceptedAt,
    signedAt: input.signedAt,
    signatureDataUrl: input.signatureDataUrl,
    fonts: await loadWaiverPdfFonts()
  });
  const documentSha256 = hashText(pdfBuffer);
  auditPayload.document.sha256 = documentSha256;
  const auditJson = JSON.stringify(auditPayload, null, 2);

  try {
    await uploadPdf(documentS3Key, pdfBuffer);
    await uploadFile(signatureS3Key, signatureBuffer, 'image/png');
    await uploadFile(auditS3Key, Buffer.from(auditJson, 'utf8'), 'application/json; charset=utf-8');
  } catch (error) {
    await Promise.allSettled([deleteDocumentObject(documentS3Key), deleteDocumentObject(signatureS3Key), deleteDocumentObject(auditS3Key)]);
    logOperationalEvent('error', 'signing.evidence_upload_failed', {
      eventId: payload.event.id,
      sessionId: current.id,
      errorCode: errorCodeOf(error)
    });
    throw error;
  }

  const signedAt = new Date(input.signedAt);
  let completion: { updated: typeof current; docRow: { id: string } | null } | null = null;
  try {
    completion = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${payload.event.id}:${payload.signer.id}`}, 0))`);
      const [alreadySigned] = await tx
        .select({ id: document.id })
        .from(document)
        .where(and(
          eq(document.eventId, payload.event.id),
          eq(document.driverPersonId, payload.signer.id),
          eq(document.type, 'waiver_signed'),
          eq(document.templateVersion, payload.contract.version),
          eq(document.status, 'generated')
        ))
        .limit(1);
      if (alreadySigned) throw new Error('WAIVER_ALREADY_SIGNED');

      const [claimed] = await tx
        .update(signingSession)
        .set({
          status: 'completed',
          workflowStage: 'completed',
          displayedAt: new Date(effectiveDisplayedAt),
          signedAt,
          signerPayload: signer,
          evidenceAuditS3Key: auditS3Key,
          updatedAt: new Date()
        })
        .where(and(eq(signingSession.id, current.id), inArray(signingSession.status, ['pending', 'displayed'])))
        .returning();
      if (!claimed) return null;

      const documentRows = await tx
        .insert(document)
        .values(
          payload.entries.map((entryItem) => ({
            eventId: payload.event.id,
            entryId: entryItem.id,
            driverPersonId: payload.signer.id,
            signingSessionId: current.id,
            type: 'waiver_signed',
            templateVariant: payload.contract.locale,
            templateVersion: payload.contract.version,
            sha256: documentSha256,
            s3Key: documentS3Key,
            status: 'generated',
            createdBy: current.operatorUserId
          }))
        )
        .returning();
      const docRow = documentRows.find((row) => row.entryId === current.sourceEntryId) ?? documentRows[0] ?? null;

      if (payload.signer.role === 'driver') {
        await tx.insert(consentEvidence).values(
          payload.entries.map((entryItem) => ({
            entryId: entryItem.id,
            personId: payload.signer.id,
            participantRole: 'driver',
            terminalSessionId: current.id,
            consentVersion: payload.contract.version,
            consentTextHash: payload.contract.textHash,
            locale: payload.contract.locale,
            consentSource: 'admin_ui',
            termsAccepted: true,
            privacyAccepted: true,
            waiverAccepted: true,
            mediaAccepted: false,
            clubInfoAccepted: false,
            guardianFullName: signer.type === 'guardian' ? signer.guardianName ?? null : null,
            guardianEmail: signer.type === 'guardian' ? signer.guardianEmail ?? null : null,
            guardianPhone: null,
            guardianConsentAccepted: signer.type === 'guardian',
            capturedAt: signedAt,
            createdAt: new Date()
          }))
        );
      }

      const [updated] = await tx
        .update(signingSession)
        .set({ documentId: docRow?.id ?? null, updatedAt: new Date() })
        .where(eq(signingSession.id, current.id))
        .returning();
      await writeAuditLog(tx as never, {
        eventId: payload.event.id,
        actorUserId: current.operatorUserId,
        action: 'signing_session_completed',
        entityType: 'signing_session',
        entityId: current.id,
        payload: {
          documentId: docRow?.id ?? null,
          documentSha256,
          auditS3Key,
          signerPersonId: payload.signer.id,
          signerRole: payload.signer.role,
          entryIds: payload.entries.map((entryItem) => entryItem.id)
        }
      });
      return { updated, docRow: docRow ? { id: docRow.id } : null };
    });
  } catch (error) {
    await Promise.allSettled([deleteDocumentObject(documentS3Key), deleteDocumentObject(signatureS3Key), deleteDocumentObject(auditS3Key)]);
    logOperationalEvent('error', 'signing.completion_transaction_failed', {
      eventId: payload.event.id,
      sessionId: current.id,
      errorCode: errorCodeOf(error)
    });
    throw error;
  }
  if (!completion) {
    await Promise.allSettled([deleteDocumentObject(documentS3Key), deleteDocumentObject(signatureS3Key), deleteDocumentObject(auditS3Key)]);
    const completed = await getSigningSession(current.id);
    if (completed?.status === 'completed') return completed;
    throw new Error('SIGNING_SESSION_NOT_ACTIVE');
  }
  const { updated, docRow } = completion;
  logOperationalEvent('info', 'signing.session_completed', {
    eventId: payload.event.id,
    sessionId: current.id,
    documentId: docRow?.id ?? undefined,
    workflowType: current.workflowType
  });

  // Queue the signed document for the person whose waiver was captured.
  // Delivery remains best-effort and must never roll back valid evidence.
  try {
    const recipientEmail = signer.type === 'guardian' ? signer.guardianEmail?.trim() : payload.signer.email?.trim();
    const signerName = signer.type === 'guardian' && signer.guardianName?.trim()
      ? signer.guardianName.trim()
      : standardPersonIdentity(payload.signer).displayName;
    if (!recipientEmail) {
      throw new Error('WAIVER_MAIL_RECIPIENT_MISSING');
    }
    await queueWaiverSignedMail(db, {
      toEmail: recipientEmail,
      driverName: standardPersonIdentity(payload.driver).displayName,
      signerName,
      signerRole: signer.type === 'guardian' ? 'Erziehungsberechtigte Person' : payload.signer.label,
      eventId: payload.event.id,
      eventName: payload.event.name,
      eventDates: formatWaiverMailEventDates(payload.event.startsAt, payload.event.endsAt),
      signedAt: formatWaiverMailSignedAt(input.signedAt),
      documentS3Key,
      sessionId: current.id,
      entryId: current.sourceEntryId ?? undefined,
      documentId: docRow?.id ?? undefined,
      signingSessionId: current.id,
      queueAudit: {
        actorUserId: current.operatorUserId,
        entityId: current.id,
        redactRecipient: standardPersonIdentity(payload.signer).identityProtected
      }
    });
  } catch (error) {
    // Mail failure must never abort the signing session, but it must leave a trace.
    await db
      .update(signingSession)
      .set({
        errorLast: error instanceof Error ? `WAIVER_MAIL_QUEUE_FAILED:${error.message}` : 'WAIVER_MAIL_QUEUE_FAILED',
        updatedAt: new Date()
      })
      .where(eq(signingSession.id, current.id));
    logOperationalEvent('error', 'signing.waiver_mail_queue_failed', {
      eventId: payload.event.id,
      sessionId: current.id,
      workflowType: current.workflowType,
      errorCode: errorCodeOf(error)
    });
  }

  return projectSigningSessionWithLiveIdentity(db, updated);
};

export const queueWaiverSignedMail = async (
  db: Awaited<ReturnType<typeof getDb>>,
  input: {
    toEmail: string;
    driverName: string;
    signerName: string;
    signerRole: string;
    eventId: string;
    eventName: string;
    eventDates: string;
    signedAt: string;
    documentS3Key: string;
    sessionId: string;
    entryId?: string;
    documentId?: string;
    signingSessionId?: string;
    idempotencyKey?: string;
    queueAudit?: {
      actorUserId: string | null;
      entityId: string;
      redactRecipient?: boolean;
    };
  }
): Promise<{ outboxId: string }> => {
  const toEmail = normalizeWaiverMailRecipient(input.toEmail);
  // Resolve template
  const templateRows = await db
    .select({
      templateKey: emailTemplate.templateKey,
      version: emailTemplateVersion.version,
      subjectTemplate: emailTemplateVersion.subjectTemplate
    })
    .from(emailTemplate)
    .innerJoin(emailTemplateVersion, eq(emailTemplateVersion.templateId, emailTemplate.id))
    .where(
      and(
        eq(emailTemplate.templateKey, 'waiver_signed'),
        eq(emailTemplate.isActive, true),
        eq(emailTemplateVersion.status, 'published')
      )
    )
    .orderBy(desc(emailTemplateVersion.version))
    .limit(1);
  if (templateRows.length === 0) {
    // Surfaced by the caller onto signingSession.errorLast instead of vanishing.
    throw new Error('WAIVER_SIGNED_TEMPLATE_NOT_PUBLISHED');
  }
  const { templateKey, version, subjectTemplate } = templateRows[0];

  const idempotencyKey = input.idempotencyKey ?? `waiver_signed:${input.sessionId}`;
  const outboxId = await db.transaction(async (tx) => {
    const [outboxRow] = await tx
      .insert(emailOutbox)
      .values({
        eventId: input.eventId,
        toEmail,
        subject: subjectTemplate,
        templateId: templateKey,
        templateVersion: version,
        templateData: {
          driverName: input.driverName,
          signerName: input.signerName,
          signerRole: input.signerRole,
          eventName: input.eventName,
          eventDates: input.eventDates,
          signedAt: input.signedAt,
          eventDateText: input.eventDates,
          headerTitle: 'Haftverzicht unterschrieben',
          preheader: 'Deine unterschriebene Haftverzichtserklärung liegt als PDF bei.',
          entryId: input.entryId,
          signingSessionId: input.signingSessionId ?? input.sessionId,
          documentId: input.documentId
        },
        idempotencyKey
      })
      // The production database still has the original partial unique index
      // (WHERE idempotency_key IS NOT NULL). PostgreSQL cannot infer that index
      // from ON CONFLICT (idempotency_key) without repeating its predicate.
      // The key is NOT NULL nowadays, so an untargeted conflict handler keeps
      // the intended idempotency semantics and works with both index shapes.
      .onConflictDoNothing()
      .returning({ id: emailOutbox.id });

    const resolvedOutboxId = outboxRow?.id ?? (await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, idempotencyKey))
      .limit(1))[0]?.id;

    if (!resolvedOutboxId) {
      throw new Error('WAIVER_SIGNED_OUTBOX_NOT_FOUND');
    }

    const existingAttachments = await tx
      .select({ id: emailOutboxAttachment.id })
      .from(emailOutboxAttachment)
      .where(and(eq(emailOutboxAttachment.outboxId, resolvedOutboxId), eq(emailOutboxAttachment.s3Key, input.documentS3Key)))
      .limit(1);

    if (existingAttachments.length === 0) {
      await tx.insert(emailOutboxAttachment).values({
        outboxId: resolvedOutboxId,
        fileName: 'Haftverzichtserklaerung.pdf',
        contentType: 'application/pdf',
        s3Key: input.documentS3Key,
        source: 'document'
      });
    }
    if (outboxRow && input.queueAudit) {
      await writeAuditLog(tx as never, {
        eventId: input.eventId,
        actorUserId: input.queueAudit.actorUserId,
        action: 'waiver_signed_mail_queued',
        entityType: 'signing_session',
        entityId: input.queueAudit.entityId,
        payload: {
          signingSessionId: input.signingSessionId ?? input.sessionId,
          outboxId: resolvedOutboxId,
          recipient: input.queueAudit.redactRecipient ? 'geschützt' : toEmail
        }
      });
    }
    return resolvedOutboxId;
  });

  return { outboxId };
};

export const resendSignedWaiverMail = async (documentId: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      documentId: document.id,
      documentEntryId: document.entryId,
      documentS3Key: document.s3Key,
      documentType: document.type,
      documentStatus: document.status,
      sessionId: signingSession.id,
      sessionStatus: signingSession.status,
      workflowType: signingSession.workflowType,
      sessionPayload: signingSession.sessionPayload,
      signerPayload: signingSession.signerPayload,
      signedAt: signingSession.signedAt,
      eventId: signingSession.eventId
    })
    .from(document)
    .innerJoin(signingSession, eq(document.signingSessionId, signingSession.id))
    .where(eq(document.id, documentId))
    .limit(1);
  const row = rows[0];
  if (!row || row.documentType !== 'waiver_signed' || row.documentStatus !== 'generated' || row.sessionStatus !== 'completed') {
    return null;
  }

  const payload = row.sessionPayload as SigningCasePayload & {
    participant?: SigningPersonSnapshot & { guardianEmail?: string | null };
  };
  const signerInput = row.signerPayload as SignerInput;
  const recipient = row.workflowType === 'waiver_signature' ? payload.signer ?? payload.driver : payload.participant;
  if (!recipient) {
    throw new Error('WAIVER_MAIL_RECIPIENT_MISSING');
  }
  const recipientEmail = signerInput.type === 'guardian'
    ? signerInput.guardianEmail?.trim().toLowerCase()
    : recipient?.email?.trim();
  if (!recipientEmail) {
    throw new Error('WAIVER_MAIL_RECIPIENT_MISSING');
  }
  const identityIds = Array.from(new Set([payload.driver?.id, recipient.id].filter((id): id is string => Boolean(id))));
  const livePeople = identityIds.length > 0
    ? await db.select({
        id: person.id,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        publicationName: person.publicationName
      }).from(person).where(inArray(person.id, identityIds))
    : [];
  const liveById = new Map(livePeople.map((item) => [item.id, item]));
  const recipientIdentity = standardPersonIdentity(liveById.get(recipient.id) ?? recipient);
  const driverIdentity = standardPersonIdentity(liveById.get(payload.driver?.id) ?? payload.driver);
  const signerName = signerInput.type === 'guardian' && signerInput.guardianName?.trim()
    ? signerInput.guardianName.trim()
    : recipientIdentity.displayName;
  const signerRole = signerInput.type === 'guardian'
    ? 'Erziehungsberechtigte Person'
    : row.workflowType === 'charity_codriver_registration'
      ? 'Charity-Beifahrer'
      : row.workflowType === 'regular_codriver_registration'
        ? 'Beifahrer'
        : payload.signer?.label ?? 'Fahrer';
  const queued = await queueWaiverSignedMail(db, {
    toEmail: recipientEmail,
    driverName: driverIdentity.displayName,
    signerName,
    signerRole,
    eventId: row.eventId,
    eventName: payload.event.name,
    eventDates: formatWaiverMailEventDates(payload.event.startsAt, payload.event.endsAt),
    signedAt: formatWaiverMailSignedAt(row.signedAt?.toISOString() ?? new Date().toISOString()),
    documentS3Key: row.documentS3Key,
    sessionId: row.sessionId,
    entryId: row.documentEntryId ?? undefined,
    documentId: row.documentId,
    signingSessionId: row.sessionId,
    idempotencyKey: `waiver_signed:manual:${row.sessionId}:${randomUUID()}`
  });

  await db
    .update(signingSession)
    .set({ errorLast: null, updatedAt: new Date() })
    .where(and(eq(signingSession.id, row.sessionId), sql`${signingSession.errorLast} like 'WAIVER_MAIL_QUEUE_FAILED%'`));

  await writeAuditLog(db as never, {
    eventId: row.eventId,
    actorUserId,
    action: 'waiver_signed_mail_resent',
    entityType: 'document',
    entityId: row.documentId,
    payload: {
      signingSessionId: row.sessionId,
      outboxId: queued.outboxId,
      recipient: recipientIdentity.identityProtected ? 'geschützt' : recipientEmail
    }
  });
  return { outboxId: queued.outboxId, recipient: recipientIdentity.identityProtected ? 'geschützt' : recipientEmail };
};

export const listSigningSessions = async (opts: {
  limit?: number;
  offset?: number;
  status?: string;
  eventId?: string;
}) => {
  const db = await getDb();
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.status) {
    conditions.push(sql`${signingSession.status} = ${opts.status}`);
  }
  if (opts.eventId) {
    conditions.push(eq(signingSession.eventId, opts.eventId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: signingSession.id,
      status: signingSession.status,
      eventId: signingSession.eventId,
      sourceEntryId: signingSession.sourceEntryId,
      driverPersonId: signingSession.driverPersonId,
      deviceSessionId: signingSession.deviceSessionId,
      deviceName: signingDeviceSession.deviceName,
      operatorDisplay: signingSession.operatorDisplay,
      signedAt: signingSession.signedAt,
      createdAt: signingSession.createdAt,
      documentId: signingSession.documentId,
      sessionPayload: signingSession.sessionPayload,
      signerPayload: signingSession.signerPayload,
      errorLast: signingSession.errorLast,
    })
    .from(signingSession)
    .leftJoin(signingDeviceSession, eq(signingSession.deviceSessionId, signingDeviceSession.id))
    .where(where)
    .orderBy(desc(signingSession.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(signingSession)
    .where(where);

  const signerIds = Array.from(new Set(rows.map((row) => (row.sessionPayload as any)?.signer?.id).filter((id): id is string => Boolean(id))));
  const liveSigners = signerIds.length > 0
    ? await db.select({
        id: person.id,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        publicationName: person.publicationName
      }).from(person).where(inArray(person.id, signerIds))
    : [];
  const liveSignerById = new Map(liveSigners.map((item) => [item.id, item]));

  const sessions = rows.map((row) => {
    const payload = row.sessionPayload as SigningCasePayload;
    const signer = payload?.signer;
    return {
      id: row.id,
      status: row.status,
      eventId: row.eventId,
      eventName: payload?.event?.name ?? null,
      sourceEntryId: row.sourceEntryId,
      driverPersonId: row.driverPersonId,
      deviceSessionId: row.deviceSessionId,
      deviceName: row.deviceName ?? null,
      operatorDisplay: row.operatorDisplay ?? null,
      signerName: signer ? standardPersonIdentity(liveSignerById.get(signer.id) ?? signer).displayName : null,
      signerRole: signer?.role ?? null,
      signedAt: row.signedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      documentId: row.documentId ?? null,
      errorLast: row.errorLast ?? null,
    };
  });

  return { sessions, total: countRow?.count ?? 0 };
};

export const getSignedWaiverDocument = async (
  entryId: string
): Promise<{ buffer: Buffer; filename: string } | null> => {
  const db = await getDb();
  const [row] = await db
    .select({
      s3Key: document.s3Key,
    })
    .from(signingSession)
    .innerJoin(document, eq(signingSession.documentId, document.id))
    .where(
      and(
        eq(signingSession.sourceEntryId, entryId),
        sql`${signingSession.status} = 'completed'`,
        sql`${signingSession.documentId} IS NOT NULL`
      )
    )
    .orderBy(desc(signingSession.signedAt))
    .limit(1);

  if (!row) {
    return null;
  }

  const buffer = await getDocumentObjectBuffer(row.s3Key);
  if (!buffer) {
    return null;
  }

  return { buffer, filename: 'Haftverzicht.pdf' };
};

export const validatePairingClaimInput = (payload: unknown) => pairingClaimSchema.parse(payload);
export const validateCreateSigningSessionInput = (payload: unknown) => createSigningSessionSchema.parse(payload);
export const validateCompleteSigningSessionInput = (payload: unknown) => completeSigningSessionSchema.parse(payload);
export const extractSigningDeviceToken = getDeviceTokenFromHeaders;
