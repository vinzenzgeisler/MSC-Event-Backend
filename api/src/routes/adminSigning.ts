import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  consentEvidence,
  document,
  entry,
  event,
  eventClass,
  person,
  signingDeviceSession,
  signingSession,
  vehicle
} from '../db/schema';
import { renderSignedWaiverEvidencePdf } from '../docs/pdf';
import { uploadFile, uploadPdf } from '../docs/storage';
import { computeConsentTextHash, getLegalTexts, type LegalUiLocale } from './publicLegalTextsSource';

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
    .optional()
});

const completeSigningSessionSchema = z.object({
  displayedAt: z.string().datetime(),
  waiverAcceptedAt: z.string().datetime(),
  signedAt: z.string().datetime(),
  signatureDataUrl: z.string().startsWith('data:image/png;base64,').max(2_000_000)
});

type CreateSigningSessionInput = z.infer<typeof createSigningSessionSchema>;
type CompleteSigningSessionInput = z.infer<typeof completeSigningSessionSchema>;

type PrecheckTimestamps = NonNullable<CreateSigningSessionInput['precheckTimestamps']>;
type SignerInput = {
  type: 'driver' | 'codriver' | 'guardian';
  guardianName: string | null;
  guardianRelationship: string | null;
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
  contract: {
    documentId: 'haftverzicht';
    locale: 'de-DE' | 'en-GB' | 'cs-CZ' | 'pl-PL';
    version: string;
    textHash: string;
    title: string;
    fullText: string;
    source: 'backend_contract_context';
  };
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

const normalizeConsentLocale = (value: string | null | undefined): SigningCasePayload['contract']['locale'] => {
  if (value === 'en-GB' || value === 'en' || value === 'en-US') {
    return 'en-GB';
  }
  if (value === 'cs-CZ' || value === 'cs' || value === 'cz') {
    return 'cs-CZ';
  }
  if (value === 'pl-PL' || value === 'pl') {
    return 'pl-PL';
  }
  return 'de-DE';
};

const toUiLocale = (locale: SigningCasePayload['contract']['locale']): LegalUiLocale => {
  if (locale === 'en-GB') return 'en';
  if (locale === 'cs-CZ') return 'cz';
  if (locale === 'pl-PL') return 'pl';
  return 'de';
};

const flattenWaiver = (uiLocale: LegalUiLocale): { title: string; fullText: string } => {
  const waiver = getLegalTexts(uiLocale).docs.haftverzicht;
  const parts = [
    waiver.title,
    ...(waiver.intro ?? []),
    ...waiver.sections.flatMap((section) => [section.title, ...(section.paragraphs ?? []), ...(section.bullets ?? [])])
  ];
  return {
    title: waiver.title,
    fullText: parts.join('\n\n')
  };
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
    if (!input.signer.guardianName?.trim() || !input.signer.guardianRelationship?.trim()) {
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
      guardianRelationship: input.signer?.guardianRelationship?.trim() || null
    };
  }
  return {
    type: payload.signer.role,
    guardianName: null,
    guardianRelationship: null
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

const resolveDeviceByToken = async (deviceToken: string) => {
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

const expireOpenSigningSessions = async (db: Awaited<ReturnType<typeof getDb>>, now = new Date()) => {
  await db
    .update(signingSession)
    .set({ status: 'cancelled', updatedAt: now, errorLast: 'SIGNING_SESSION_EXPIRED' })
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
          country: person.country
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
    country: source.driverCountry
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
    .where(eq(consentEvidence.entryId, source.entryId))
    .orderBy(desc(consentEvidence.capturedAt), desc(consentEvidence.createdAt))
    .limit(1);
  const consent = consentRows[0] ?? null;
  const locale = normalizeConsentLocale(consent?.locale);
  const uiLocale = toUiLocale(locale);
  const waiver = flattenWaiver(uiLocale);
  const textHash = consent?.consentTextHash ?? (await computeConsentTextHash(uiLocale));
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
    contract: {
      documentId: 'haftverzicht',
      locale,
      version: consent?.consentVersion ?? 'current-backend-legal-text',
      textHash,
      title: waiver.title,
      fullText: waiver.fullText,
      source: 'backend_contract_context'
    },
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
              country: codriver.country
            }
          : null,
        vehicles
      };
    })
  };
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
  const entryIds = payload.entries.map((item) => item.id);
  const signerIds = signerCandidates.map((item) => item.id);
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
          .where(and(eq(document.type, 'waiver_signed'), inArray(document.entryId, entryIds), inArray(document.driverPersonId, signerIds)))
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
    driverName: `${payload.driver.firstName} ${payload.driver.lastName}`.trim(),
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    signerType: payload.isMinor ? 'guardian' : 'driver',
    entryCount: payload.entries.length,
    vehicleCount: payload.entries.reduce((count, item) => count + item.vehicles.length, 0),
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
        name: `${item.firstName} ${item.lastName}`.trim(),
        isMinor: signerAge !== null && signerAge < 18,
        requiresMedicalCertificate: signerAge !== null && signerAge >= 70,
        signed: Boolean(signed),
        signedAt: signed?.signedAt ?? null,
        documentId: signed?.documentId ?? null
      };
    }),
    entries: payload.entries
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
  const [created] = await db
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

  await writeAuditLog(db as never, {
    eventId: payload.event.id,
    actorUserId,
    action: 'signing_session_started',
    entityType: 'signing_session',
    entityId: created.id,
    payload: {
      entryIds: payload.entries.map((entryItem) => entryItem.id),
      signerPersonId: payload.signer.id,
      signerRole: payload.signer.role,
      deviceSessionId: input.deviceSessionId
    }
  });

  return { session: created, signingCase: payload };
};

export const getSigningSession = async (sessionId: string) => {
  const db = await getDb();
  await expireOpenSigningSessions(db);
  const rows = await db.select().from(signingSession).where(eq(signingSession.id, sessionId)).limit(1);
  return rows[0] ?? null;
};

export const cancelSigningSession = async (sessionId: string, actorUserId: string | null) => {
  const db = await getDb();
  const [updated] = await db
    .update(signingSession)
    .set({ status: 'cancelled', updatedAt: new Date() })
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
  return updated;
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
  if (current && current.status === 'pending') {
    await db
      .update(signingSession)
      .set({ status: 'displayed', displayedAt: now, updatedAt: now })
      .where(eq(signingSession.id, current.id));
    return { ...current, status: 'displayed' };
  }
  return current;
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
    return current;
  }
  if (current.status !== 'pending' && current.status !== 'displayed') {
    throw new Error('SIGNING_SESSION_NOT_ACTIVE');
  }
  if (current.expiresAt <= now) {
    await db
      .update(signingSession)
      .set({ status: 'cancelled', updatedAt: now, errorLast: 'SIGNING_SESSION_EXPIRED' })
      .where(eq(signingSession.id, current.id));
    throw new Error('SIGNING_SESSION_EXPIRED');
  }

  const payload = current.sessionPayload as SigningCasePayload;
  const precheckTimestamps = current.precheckPayload as PrecheckTimestamps;
  const signer = current.signerPayload as SignerInput;
  assertPrecheckComplete({
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    precheckTimestamps,
    signer
  });
  const signatureSha256 = hashText(input.signatureDataUrl);
  const evidenceId = `${current.id}-${randomUUID()}`;
  const baseKey = `signing/${payload.event.id}/${payload.signer.id}/${evidenceId}`;
  const documentS3Key = `${baseKey}/waiver.pdf`;
  const auditS3Key = `${baseKey}/audit.json`;
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
      textHash: payload.contract.textHash,
      displayedAt: input.displayedAt,
      acceptedAt: input.waiverAcceptedAt
    },
    precheckTimestamps,
    operator: {
      id: current.operatorUserId,
      displayName: current.operatorDisplay
    },
    signature: {
      capturedAt: input.signedAt,
      imageSha256: signatureSha256
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
    displayedAt: input.displayedAt,
    waiverAcceptedAt: input.waiverAcceptedAt,
    signedAt: input.signedAt,
    signatureDataUrl: input.signatureDataUrl
  });
  const documentSha256 = hashText(pdfBuffer);
  auditPayload.document.sha256 = documentSha256;
  const auditJson = JSON.stringify(auditPayload, null, 2);

  await uploadPdf(documentS3Key, pdfBuffer);
  await uploadFile(auditS3Key, Buffer.from(auditJson, 'utf8'), 'application/json; charset=utf-8');

  const signedAt = new Date(input.signedAt);
  const documentRows = await db
    .insert(document)
    .values(
      payload.entries.map((entryItem) => ({
      eventId: payload.event.id,
      entryId: entryItem.id,
      driverPersonId: payload.signer.id,
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
    await db
      .insert(consentEvidence)
      .values(
        payload.entries.map((entryItem) => ({
          entryId: entryItem.id,
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
          guardianEmail: null,
          guardianPhone: null,
          guardianConsentAccepted: signer.type === 'guardian',
          capturedAt: signedAt,
          createdAt: new Date()
        }))
      );
  }

  const [updated] = await db
    .update(signingSession)
    .set({
      status: 'completed',
      displayedAt: new Date(input.displayedAt),
      signedAt,
      documentId: docRow?.id ?? null,
      evidenceAuditS3Key: auditS3Key,
      updatedAt: new Date()
    })
    .where(eq(signingSession.id, current.id))
    .returning();

  await writeAuditLog(db as never, {
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

  return updated;
};

export const validatePairingClaimInput = (payload: unknown) => pairingClaimSchema.parse(payload);
export const validateCreateSigningSessionInput = (payload: unknown) => createSigningSessionSchema.parse(payload);
export const validateCompleteSigningSessionInput = (payload: unknown) => completeSigningSessionSchema.parse(payload);
export const extractSigningDeviceToken = getDeviceTokenFromHeaders;
