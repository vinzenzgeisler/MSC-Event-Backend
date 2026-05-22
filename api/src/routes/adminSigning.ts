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
import { uploadFile } from '../docs/storage';
import { computeConsentTextHash, getLegalTexts, type LegalUiLocale } from './publicLegalTextsSource';

const pairingClaimSchema = z.object({
  pairingCode: z.string().trim().regex(/^[0-9]{6}$/),
  deviceName: z.string().trim().max(80).optional()
});

const precheckSchema = z.object({
  identityChecked: z.boolean(),
  signerPresent: z.boolean(),
  medicalCertificateChecked: z.boolean().optional().default(false),
  guardianPresent: z.boolean().optional().default(false),
  guardianAuthorityChecked: z.boolean().optional().default(false)
});

const signerSchema = z.object({
  type: z.enum(['driver', 'guardian']),
  guardianName: z.string().trim().max(160).nullable().optional(),
  guardianRelationship: z.string().trim().max(80).nullable().optional()
});

const createSigningSessionSchema = z.object({
  deviceSessionId: z.string().uuid(),
  entryId: z.string().uuid(),
  precheck: precheckSchema,
  signer: signerSchema
});

const completeSigningSessionSchema = z.object({
  displayedAt: z.string().datetime(),
  signedAt: z.string().datetime(),
  signatureDataUrl: z.string().startsWith('data:image/png;base64,').max(2_000_000)
});

type PrecheckInput = z.infer<typeof precheckSchema>;
type SignerInput = z.infer<typeof signerSchema>;
type CreateSigningSessionInput = z.infer<typeof createSigningSessionSchema>;
type CompleteSigningSessionInput = z.infer<typeof completeSigningSessionSchema>;

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
  precheck: PrecheckInput;
  signer: SignerInput;
}) => {
  if (!input.precheck.identityChecked || !input.precheck.signerPresent) {
    throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  }
  if (input.requiresMedicalCertificate && !input.precheck.medicalCertificateChecked) {
    throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  }
  if (input.isMinor) {
    if (input.signer.type !== 'guardian') {
      throw new Error('SIGNING_GUARDIAN_REQUIRED');
    }
    if (!input.precheck.guardianPresent || !input.precheck.guardianAuthorityChecked) {
      throw new Error('SIGNING_PRECHECK_INCOMPLETE');
    }
    if (!input.signer.guardianName?.trim() || !input.signer.guardianRelationship?.trim()) {
      throw new Error('SIGNING_GUARDIAN_REQUIRED');
    }
  }
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

const buildSigningCasePayload = async (sourceEntryId: string): Promise<SigningCasePayload | null> => {
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
  const driverAge = ageAt(source.driverBirthdate?.toString() ?? null, eventStart);

  return {
    id: `signing-case:${source.eventId}:${source.driverPersonId}`,
    event: {
      id: source.eventId,
      name: source.eventName,
      startsAt: source.eventStartsAt?.toString() ?? '',
      endsAt: source.eventEndsAt?.toString() ?? '',
      location: 'MSC Oberlausitzer Dreilaendereck'
    },
    driver: {
      id: source.driverPersonId,
      firstName: source.driverFirstName,
      lastName: source.driverLastName,
      birthdate: source.driverBirthdate?.toString() ?? null,
      email: source.driverEmail,
      phone: source.driverPhone,
      country: source.driverCountry
    },
    isMinor: driverAge !== null && driverAge < 18,
    requiresMedicalCertificate: driverAge !== null && driverAge >= 70,
    contract: {
      documentId: 'haftverzicht',
      locale,
      version: consent?.consentVersion ?? 'current-backend-legal-text',
      textHash,
      title: waiver.title,
      fullText: waiver.fullText,
      source: 'backend_contract_context'
    },
    entries: entryRows.map((row) => {
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

const renderEvidenceHtml = (input: {
  sessionId: string;
  payload: SigningCasePayload;
  precheck: PrecheckInput;
  signer: SignerInput;
  operatorDisplay: string | null;
  displayedAt: string;
  signedAt: string;
  signatureDataUrl: string;
}) => {
  const escape = (value: unknown) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const entryRows = input.payload.entries
    .map((item) => {
      const vehicles = item.vehicles
        .map((vehicle) => `<li>${escape(vehicle.role === 'backup' ? 'Ersatzfahrzeug' : 'Fahrzeug')}: ${escape(vehicle.make)} ${escape(vehicle.model)} ${escape(vehicle.startNumber ? `#${vehicle.startNumber}` : '')}</li>`)
        .join('');
      return `<tr><td>${escape(item.className)}</td><td>${escape(item.startNumber ?? '-')}</td><td>${escape(item.orgaCode ?? '-')}</td><td>${escape(item.codriver ? `${item.codriver.firstName} ${item.codriver.lastName}` : '-')}</td><td><ul>${vehicles}</ul></td></tr>`;
    })
    .join('');
  const signerText =
    input.signer.type === 'guardian'
      ? `Erziehungsberechtigter: ${input.signer.guardianName ?? '-'} (${input.signer.guardianRelationship ?? '-'})`
      : 'Fahrer selbst';

  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Haftverzicht ${escape(input.sessionId)}</title><style>body{font-family:Arial,sans-serif;margin:36px;color:#111827;line-height:1.45}h1{font-size:26px}h2{font-size:18px;margin-top:26px;border-bottom:1px solid #d1d5db;padding-bottom:6px}.meta{display:grid;grid-template-columns:180px 1fr;gap:6px 12px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}th{background:#f3f4f6}.waiver{white-space:pre-wrap;border:1px solid #d1d5db;padding:14px}.signature{width:360px;height:160px;border:1px solid #111827;object-fit:contain}</style></head><body><h1>Nachweis Haftverzicht vor Ort</h1><div class="meta"><strong>Veranstaltung</strong><span>${escape(input.payload.event.name)}</span><strong>Fahrer</strong><span>${escape(`${input.payload.driver.firstName} ${input.payload.driver.lastName}`)}</span><strong>Unterzeichner</strong><span>${escape(signerText)}</span><strong>Operator</strong><span>${escape(input.operatorDisplay ?? '-')}</span><strong>Angezeigt</strong><span>${escape(input.displayedAt)}</span><strong>Unterschrieben</strong><span>${escape(input.signedAt)}</span><strong>Sprache/Version/Hash</strong><span>${escape(input.payload.contract.locale)} · ${escape(input.payload.contract.version)} · ${escape(input.payload.contract.textHash)}</span></div><h2>Nennungen und Fahrzeuge</h2><table><thead><tr><th>Klasse</th><th>Startnummer</th><th>Orga-Code</th><th>Beifahrer</th><th>Fahrzeuge</th></tr></thead><tbody>${entryRows}</tbody></table><h2>Vorprüfung</h2><ul><li>Identität geprüft: ${input.precheck.identityChecked ? 'ja' : 'nein'}</li><li>Unterzeichner anwesend: ${input.precheck.signerPresent ? 'ja' : 'nein'}</li><li>Attest geprüft: ${input.payload.requiresMedicalCertificate ? (input.precheck.medicalCertificateChecked ? 'ja' : 'nein') : 'nicht erforderlich'}</li><li>Guardian anwesend: ${input.payload.isMinor ? (input.precheck.guardianPresent ? 'ja' : 'nein') : 'nicht erforderlich'}</li><li>Guardian-Berechtigung geprüft: ${input.payload.isMinor ? (input.precheck.guardianAuthorityChecked ? 'ja' : 'nein') : 'nicht erforderlich'}</li></ul><h2>${escape(input.payload.contract.title)}</h2><div class="waiver">${escape(input.payload.contract.fullText)}</div><h2>Unterschrift</h2><img class="signature" src="${escape(input.signatureDataUrl)}" alt="Unterschrift"></body></html>`;
};

export const createSigningPairingCode = async (actorUserId: string | null) => {
  const db = await getDb();
  const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
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
    .where(sql`${signingDeviceSession.status} in ('pairing', 'connected')`)
    .orderBy(desc(signingDeviceSession.createdAt))
    .limit(20);
  return rows;
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
      deviceName: input.deviceName?.trim() || 'Signing Terminal',
      tokenHash: hashToken(deviceToken),
      status: 'connected',
      pairedAt: now,
      lastSeenAt: now,
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

  const payload = await buildSigningCasePayload(input.entryId);
  if (!payload) {
    return null;
  }
  assertPrecheckComplete({
    isMinor: payload.isMinor,
    requiresMedicalCertificate: payload.requiresMedicalCertificate,
    precheck: input.precheck,
    signer: input.signer
  });

  const now = new Date();
  const [created] = await db
    .insert(signingSession)
    .values({
      deviceSessionId: input.deviceSessionId,
      eventId: payload.event.id,
      driverPersonId: payload.driver.id,
      sourceEntryId: input.entryId,
      status: 'pending',
      sessionPayload: payload,
      precheckPayload: input.precheck,
      signerPayload: input.signer,
      operatorUserId: actorUserId,
      operatorDisplay: actorDisplay,
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
      deviceSessionId: input.deviceSessionId
    }
  });

  return { session: created, signingCase: payload };
};

export const getSigningSession = async (sessionId: string) => {
  const db = await getDb();
  const rows = await db.select().from(signingSession).where(eq(signingSession.id, sessionId)).limit(1);
  return rows[0] ?? null;
};

export const getCurrentDeviceSigningSession = async (deviceToken: string) => {
  const device = await resolveDeviceByToken(deviceToken);
  if (!device) {
    throw new Error('SIGNING_DEVICE_UNAUTHORIZED');
  }
  const db = await getDb();
  const rows = await db
    .select()
    .from(signingSession)
    .where(and(eq(signingSession.deviceSessionId, device.id), sql`${signingSession.status} in ('pending', 'displayed')`))
    .orderBy(desc(signingSession.createdAt))
    .limit(1);
  const current = rows[0] ?? null;
  if (current && current.status === 'pending') {
    await db
      .update(signingSession)
      .set({ status: 'displayed', displayedAt: new Date(), updatedAt: new Date() })
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

  const payload = current.sessionPayload as SigningCasePayload;
  const precheck = current.precheckPayload as PrecheckInput;
  const signer = current.signerPayload as SignerInput;
  const evidenceHtml = renderEvidenceHtml({
    sessionId: current.id,
    payload,
    precheck,
    signer,
    operatorDisplay: current.operatorDisplay,
    displayedAt: input.displayedAt,
    signedAt: input.signedAt,
    signatureDataUrl: input.signatureDataUrl
  });
  const documentSha256 = hashText(evidenceHtml);
  const signatureSha256 = hashText(input.signatureDataUrl);
  const evidenceId = `${current.id}-${randomUUID()}`;
  const baseKey = `signing/${payload.event.id}/${payload.driver.id}/${evidenceId}`;
  const documentS3Key = `${baseKey}/evidence.html`;
  const auditS3Key = `${baseKey}/audit.json`;
  const auditPayload = {
    auditSchemaVersion: 'signing-terminal-v1',
    evidenceId,
    sessionId: current.id,
    eventId: payload.event.id,
    driverPersonId: payload.driver.id,
    entryIds: payload.entries.map((entryItem) => entryItem.id),
    vehicleIds: payload.entries.flatMap((entryItem) => entryItem.vehicles.map((vehicleItem) => vehicleItem.id)),
    signer,
    waiver: {
      locale: payload.contract.locale,
      version: payload.contract.version,
      textHash: payload.contract.textHash,
      displayedAt: input.displayedAt,
      acceptedAt: input.signedAt
    },
    precheck,
    operator: {
      id: current.operatorUserId,
      displayName: current.operatorDisplay
    },
    signature: {
      capturedAt: input.signedAt,
      imageSha256: signatureSha256
    },
    document: {
      sha256: documentSha256,
      s3Key: documentS3Key
    }
  };
  const auditJson = JSON.stringify(auditPayload, null, 2);

  await uploadFile(documentS3Key, Buffer.from(evidenceHtml, 'utf8'), 'text/html; charset=utf-8');
  await uploadFile(auditS3Key, Buffer.from(auditJson, 'utf8'), 'application/json; charset=utf-8');

  const [docRow] = await db
    .insert(document)
    .values({
      eventId: payload.event.id,
      entryId: current.sourceEntryId,
      driverPersonId: payload.driver.id,
      type: 'waiver_signed',
      templateVariant: payload.contract.locale,
      templateVersion: payload.contract.version,
      sha256: documentSha256,
      s3Key: documentS3Key,
      status: 'generated',
      createdBy: current.operatorUserId
    })
    .returning();

  const signedAt = new Date(input.signedAt);
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
      entryIds: payload.entries.map((entryItem) => entryItem.id)
    }
  });

  return updated;
};

export const validatePairingClaimInput = (payload: unknown) => pairingClaimSchema.parse(payload);
export const validateCreateSigningSessionInput = (payload: unknown) => createSigningSessionSchema.parse(payload);
export const validateCompleteSigningSessionInput = (payload: unknown) => completeSigningSessionSchema.parse(payload);
export const extractSigningDeviceToken = getDeviceTokenFromHeaders;
