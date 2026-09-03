import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  consentEvidence,
  document,
  entry,
  entryCharityCodriver,
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
import { queueWaiverSignedMail, resolveDeviceByToken } from './adminSigning';

const workflowTypeSchema = z.enum(['regular_codriver_registration', 'charity_codriver_registration']);
const localeSchema = z.enum(['de-DE', 'en-GB', 'cs-CZ', 'pl-PL']);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phoneSchema = z.string().trim().transform((value) => value.replace(/\D+/g, '')).refine((value) => value.length >= 6 && value.length <= 15);
const draftSchema = z.object({
  locale: localeSchema.default('de-DE'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  birthdate: isoDateSchema,
  country: z.string().trim().min(1).max(100),
  street: z.string().trim().min(1).max(160),
  zip: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9\- ]{1,11}$/),
  city: z.string().trim().min(1).max(120),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  phone: phoneSchema,
  emergencyContactFirstName: z.string().trim().min(1).max(100),
  emergencyContactLastName: z.string().trim().min(1).max(100),
  emergencyContactPhone: phoneSchema,
  motorsportHistory: z.string().trim().max(4000).nullable().optional(),
  guardianFullName: z.string().trim().max(160).nullable().optional(),
  guardianEmail: z.string().trim().email().nullable().optional(),
  guardianPhone: phoneSchema.nullable().optional(),
  guardianRelationship: z.string().trim().max(80).nullable().optional()
});

const createSessionSchema = z.object({
  deviceSessionId: z.string().uuid(),
  workflowType: workflowTypeSchema,
  entryIds: z.array(z.string().uuid()).min(1).max(20)
});

const approveSchema = z.object({
  identityCheckedAt: z.string().datetime(),
  signerPresentAt: z.string().datetime(),
  medicalCertificateCheckedAt: z.string().datetime().nullable().optional(),
  guardianPresentAt: z.string().datetime().nullable().optional(),
  guardianAuthorityCheckedAt: z.string().datetime().nullable().optional()
});

const completeSchema = z.object({
  displayedAt: z.string().datetime(),
  privacyAcceptedAt: z.string().datetime(),
  waiverAcceptedAt: z.string().datetime(),
  signedAt: z.string().datetime(),
  signatureDataUrl: z.string().startsWith('data:image/png;base64,').max(2_000_000)
});

type WorkflowType = z.infer<typeof workflowTypeSchema>;
export type ParticipantDraft = z.infer<typeof draftSchema>;
type Prechecks = z.infer<typeof approveSchema>;
type CompleteInput = z.infer<typeof completeSchema>;

const ageAt = (birthdate: string, startsAt: string) => {
  const born = new Date(`${birthdate}T12:00:00Z`);
  const eventDate = new Date(`${startsAt}T12:00:00Z`);
  let age = eventDate.getUTCFullYear() - born.getUTCFullYear();
  if (eventDate.getUTCMonth() < born.getUTCMonth() || (eventDate.getUTCMonth() === born.getUTCMonth() && eventDate.getUTCDate() < born.getUTCDate())) age -= 1;
  return age;
};

const toUiLocale = (locale: ParticipantDraft['locale']): LegalUiLocale =>
  locale === 'en-GB' ? 'en' : locale === 'cs-CZ' ? 'cz' : locale === 'pl-PL' ? 'pl' : 'de';

export const buildParticipantWaiverContract = async (locale: ParticipantDraft['locale']) => {
  const uiLocale = toUiLocale(locale);
  const waiver = getLegalTexts(uiLocale).docs.haftverzicht;
  return {
    documentId: 'haftverzicht' as const,
    locale,
    version: 'current-backend-legal-text',
    textHash: await computeConsentTextHash(uiLocale),
    title: waiver.title,
    fullText: [waiver.title, ...(waiver.intro ?? []), ...waiver.sections.flatMap((section) => [section.title, ...(section.paragraphs ?? []), ...(section.bullets ?? [])])].join('\n\n'),
    source: 'backend_contract_context' as const
  };
};

const loadWorkflowContext = async (entryIds: string[]) => {
  const db = await getDb();
  const rows = await db
    .select({
      entryId: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      codriverPersonId: entry.codriverPersonId,
      acceptanceStatus: entry.acceptanceStatus,
      deletedAt: entry.deletedAt,
      className: eventClass.name,
      allowsCodriver: eventClass.allowsCodriver,
      startNumber: entry.startNumberNorm,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleOwnerName: vehicle.ownerName
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(inArray(entry.id, entryIds));
  if (rows.length !== entryIds.length) throw new Error('ENTRY_NOT_FOUND');
  const first = rows[0];
  if (rows.some((row) => row.eventId !== first.eventId || row.driverPersonId !== first.driverPersonId)) throw new Error('TERMINAL_ENTRIES_MUST_SHARE_DRIVER');
  if (rows.some((row) => row.deletedAt || row.acceptanceStatus !== 'accepted')) throw new Error('TERMINAL_ENTRY_NOT_ELIGIBLE');
  return { first, rows };
};

export const createParticipantTerminalSession = async (
  input: z.infer<typeof createSessionSchema>,
  actorUserId: string | null,
  actorDisplay: string | null
) => {
  const db = await getDb();
  const [device] = await db.select().from(signingDeviceSession).where(and(eq(signingDeviceSession.id, input.deviceSessionId), eq(signingDeviceSession.status, 'connected'))).limit(1);
  if (!device) throw new Error('SIGNING_DEVICE_NOT_CONNECTED');
  const context = await loadWorkflowContext(input.entryIds);
  if (input.workflowType === 'charity_codriver_registration' && input.entryIds.length !== 1) throw new Error('CHARITY_SINGLE_ENTRY_REQUIRED');
  if (context.rows.some((row) => !row.allowsCodriver)) throw new Error('CODRIVER_NOT_ALLOWED');
  if (input.workflowType === 'regular_codriver_registration') {
    if (context.rows.some((row) => row.codriverPersonId)) throw new Error('CODRIVER_ALREADY_ASSIGNED');
  }
  const now = new Date();
  await db.update(signingSession).set({ status: 'cancelled', workflowStage: 'cancelled', draftPayload: null, updatedAt: now })
    .where(and(eq(signingSession.deviceSessionId, input.deviceSessionId), sql`${signingSession.status} in ('pending', 'displayed')`));
  const [created] = await db.insert(signingSession).values({
    deviceSessionId: input.deviceSessionId,
    eventId: context.first.eventId,
    driverPersonId: context.first.driverPersonId,
    sourceEntryId: context.first.entryId,
    workflowType: input.workflowType,
    workflowStage: 'collecting_data',
    status: 'pending',
    sessionPayload: {
      workflowType: input.workflowType,
      event: { id: context.first.eventId, name: context.first.eventName, startsAt: String(context.first.eventStartsAt), endsAt: String(context.first.eventEndsAt) },
      driver: { id: context.first.driverPersonId, firstName: context.first.driverFirstName, lastName: context.first.driverLastName, email: context.first.driverEmail },
      entries: context.rows.map((row) => ({ id: row.entryId, className: row.className, startNumber: row.startNumber }))
    },
    precheckPayload: {},
    signerPayload: {},
    operatorUserId: actorUserId,
    operatorDisplay: actorDisplay,
    expiresAt: new Date(now.getTime() + 20 * 60 * 1000),
    createdAt: now,
    updatedAt: now
  }).returning();
  await writeAuditLog(db as never, { eventId: context.first.eventId, actorUserId, action: 'terminal_participant_session_started', entityType: 'signing_session', entityId: created.id, payload: { workflowType: input.workflowType, entryIds: input.entryIds, deviceSessionId: input.deviceSessionId } });
  return created;
};

export const submitParticipantDraft = async (sessionId: string, draft: ParticipantDraft, deviceToken: string) => {
  const device = await resolveDeviceByToken(deviceToken);
  if (!device) throw new Error('SIGNING_DEVICE_UNAUTHORIZED');
  const db = await getDb();
  const [session] = await db.select().from(signingSession).where(and(eq(signingSession.id, sessionId), eq(signingSession.deviceSessionId, device.id))).limit(1);
  if (!session) return null;
  if (!['collecting_data', 'awaiting_operator_approval'].includes(session.workflowStage) || !['pending', 'displayed'].includes(session.status)) throw new Error('TERMINAL_SESSION_NOT_EDITABLE');
  const context = session.sessionPayload as any;
  if (draft.email === String(context.driver?.email ?? '').toLowerCase()) throw new Error('CODRIVER_EMAIL_MUST_DIFFER');
  if (`${draft.firstName} ${draft.lastName}`.trim().toLowerCase() === `${context.driver?.firstName ?? ''} ${context.driver?.lastName ?? ''}`.trim().toLowerCase()) throw new Error('CODRIVER_NAME_MUST_DIFFER');
  const age = ageAt(draft.birthdate, context.event.startsAt);
  if (age < 6 || age > 100) throw new Error('BIRTHDATE_OUT_OF_RANGE');
  if (age < 18 && (!draft.guardianFullName || !draft.guardianEmail || !draft.guardianPhone || !draft.guardianRelationship)) throw new Error('GUARDIAN_REQUIRED');
  const [updated] = await db.update(signingSession).set({
    draftPayload: draft,
    workflowStage: 'awaiting_operator_approval',
    submittedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(signingSession.id, sessionId)).returning();
  return { ...updated, requirements: { isMinor: age < 18, requiresMedicalCertificate: session.workflowType === 'regular_codriver_registration' && age >= 70 } };
};

export const approveParticipantTerminalSession = async (sessionId: string, prechecks: Prechecks, actorUserId: string | null) => {
  const db = await getDb();
  const [session] = await db.select().from(signingSession).where(eq(signingSession.id, sessionId)).limit(1);
  if (!session) return null;
  if (session.workflowStage !== 'awaiting_operator_approval' || !session.draftPayload) throw new Error('TERMINAL_SESSION_NOT_AWAITING_APPROVAL');
  const draft = session.draftPayload as ParticipantDraft;
  const context = session.sessionPayload as any;
  const entryIds = (context.entries as Array<{ id: string }>).map((item) => item.id);
  const liveContext = await loadWorkflowContext(entryIds);
  if (liveContext.rows.some((row) => !row.allowsCodriver)) throw new Error('CODRIVER_NOT_ALLOWED');
  if (session.workflowType === 'regular_codriver_registration' && liveContext.rows.some((row) => row.codriverPersonId)) {
    throw new Error('CODRIVER_ALREADY_ASSIGNED');
  }
  const age = ageAt(draft.birthdate, context.event.startsAt);
  if (session.workflowType === 'regular_codriver_registration' && age >= 70 && !prechecks.medicalCertificateCheckedAt) throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  if (age < 18 && (!prechecks.guardianPresentAt || !prechecks.guardianAuthorityCheckedAt)) throw new Error('SIGNING_PRECHECK_INCOMPLETE');
  const contract = await buildParticipantWaiverContract(draft.locale);
  const signer = age < 18
    ? { type: 'guardian', guardianName: draft.guardianFullName, guardianRelationship: draft.guardianRelationship }
    : { type: 'codriver', guardianName: null, guardianRelationship: null };
  const [updated] = await db.update(signingSession).set({
    workflowStage: 'ready_to_sign',
    precheckPayload: prechecks,
    signerPayload: signer,
    sessionPayload: { ...context, participant: draft, isMinor: age < 18, requiresMedicalCertificate: session.workflowType === 'regular_codriver_registration' && age >= 70, contract },
    approvedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(signingSession.id, sessionId)).returning();
  await writeAuditLog(db as never, { eventId: session.eventId, actorUserId, action: 'terminal_participant_session_approved', entityType: 'signing_session', entityId: sessionId, payload: { workflowType: session.workflowType } });
  return updated;
};

export const returnParticipantSessionToForm = async (sessionId: string, actorUserId: string | null) => {
  const db = await getDb();
  const [updated] = await db.update(signingSession).set({ workflowStage: 'collecting_data', approvedAt: null, precheckPayload: {}, updatedAt: new Date() })
    .where(and(eq(signingSession.id, sessionId), sql`${signingSession.status} in ('pending', 'displayed')`)).returning();
  if (updated) await writeAuditLog(db as never, { eventId: updated.eventId, actorUserId, action: 'terminal_participant_session_returned', entityType: 'signing_session', entityId: sessionId, payload: {} });
  return updated ?? null;
};

export const completeParticipantTerminalSession = async (sessionId: string, input: CompleteInput, deviceToken: string) => {
  const device = await resolveDeviceByToken(deviceToken);
  if (!device) throw new Error('SIGNING_DEVICE_UNAUTHORIZED');
  const db = await getDb();
  const [session] = await db.select().from(signingSession).where(and(eq(signingSession.id, sessionId), eq(signingSession.deviceSessionId, device.id))).limit(1);
  if (!session) return null;
  if (session.status === 'completed') return session;
  if (session.workflowStage !== 'ready_to_sign' || !session.draftPayload || session.expiresAt <= new Date()) throw new Error('TERMINAL_SESSION_NOT_READY');
  const draft = session.draftPayload as ParticipantDraft;
  const context = session.sessionPayload as any;
  const entryIds = (context.entries as Array<{ id: string }>).map((item) => item.id);
  const liveContext = await loadWorkflowContext(entryIds);
  if (liveContext.rows.some((row) => !row.allowsCodriver)) throw new Error('CODRIVER_NOT_ALLOWED');
  if (session.workflowType === 'regular_codriver_registration' && liveContext.rows.some((row) => row.codriverPersonId)) {
    throw new Error('CODRIVER_ALREADY_ASSIGNED');
  }
  const existingPeople = await db.select().from(person).where(sql`lower(${person.email}) = ${draft.email}`).limit(1);
  const existingPerson = existingPeople[0] ?? null;
  if (existingPerson && (`${existingPerson.firstName} ${existingPerson.lastName}`.trim().toLowerCase() !== `${draft.firstName} ${draft.lastName}`.trim().toLowerCase())) throw new Error('EMAIL_ALREADY_USED_BY_DIFFERENT_PERSON');
  const participantId = existingPerson?.id ?? randomUUID();
  if (session.workflowType === 'charity_codriver_registration' && existingPerson) {
    const [activeRegistration] = await db
      .select({ id: entryCharityCodriver.id })
      .from(entryCharityCodriver)
      .where(and(
        eq(entryCharityCodriver.entryId, entryIds[0]),
        eq(entryCharityCodriver.personId, participantId),
        eq(entryCharityCodriver.status, 'active')
      ))
      .limit(1);
    if (activeRegistration) throw new Error('CHARITY_CODRIVER_ALREADY_ACTIVE');
  }
  const payload = {
    ...context,
    id: `terminal-case:${session.id}`,
    driver: { ...context.driver, birthdate: null, phone: null, country: null },
    signer: { id: participantId, firstName: draft.firstName, lastName: draft.lastName, birthdate: draft.birthdate, email: draft.email, phone: draft.phone, country: draft.country, role: 'codriver', label: session.workflowType === 'charity_codriver_registration' ? 'Charity-Beifahrer' : 'Beifahrer' },
    entries: context.entries.map((item: any) => ({ ...item, orgaCode: null, codriver: null, vehicles: [] })),
    status: 'open',
    signedAt: null
  };
  const pdf = await renderSignedWaiverEvidencePdf({
    sessionId,
    payload,
    signer: session.signerPayload,
    precheckTimestamps: session.precheckPayload,
    operatorDisplay: session.operatorDisplay,
    displayedAt: input.displayedAt,
    waiverAcceptedAt: input.waiverAcceptedAt,
    signedAt: input.signedAt,
    signatureDataUrl: input.signatureDataUrl
  } as any);
  const documentSha256 = createHash('sha256').update(pdf).digest('hex');
  const evidenceId = `${session.id}-${randomUUID()}`;
  const baseKey = `signing/${session.eventId}/${participantId}/${evidenceId}`;
  const documentS3Key = `${baseKey}/waiver.pdf`;
  const auditS3Key = `${baseKey}/audit.json`;
  await uploadPdf(documentS3Key, pdf);
  await uploadFile(auditS3Key, Buffer.from(JSON.stringify({ auditSchemaVersion: 'terminal-participant-v1', sessionId, workflowType: session.workflowType, eventId: session.eventId, entryIds, participantId, signedAt: input.signedAt, privacyAcceptedAt: input.privacyAcceptedAt, waiverAcceptedAt: input.waiverAcceptedAt, documentSha256 }, null, 2)), 'application/json; charset=utf-8');

  const updatedSession = await db.transaction(async (tx) => {
    const now = new Date();
    if (existingPerson) {
      await tx.update(person).set({ birthdate: draft.birthdate, country: draft.country, street: draft.street, zip: draft.zip, city: draft.city, phone: draft.phone, emergencyContactFirstName: draft.emergencyContactFirstName, emergencyContactLastName: draft.emergencyContactLastName, emergencyContactPhone: draft.emergencyContactPhone, motorsportHistory: draft.motorsportHistory ?? null, updatedAt: now }).where(eq(person.id, participantId));
    } else {
      await tx.insert(person).values({ id: participantId, email: draft.email, firstName: draft.firstName, lastName: draft.lastName, birthdate: draft.birthdate, country: draft.country, street: draft.street, zip: draft.zip, city: draft.city, phone: draft.phone, emergencyContactFirstName: draft.emergencyContactFirstName, emergencyContactLastName: draft.emergencyContactLastName, emergencyContactPhone: draft.emergencyContactPhone, motorsportHistory: draft.motorsportHistory ?? null, createdAt: now, updatedAt: now });
    }
    if (session.workflowType === 'regular_codriver_registration') {
      const updatedEntries = await tx.update(entry).set({ codriverPersonId: participantId, updatedAt: now })
        .where(and(inArray(entry.id, entryIds), sql`${entry.codriverPersonId} is null`)).returning({ id: entry.id });
      if (updatedEntries.length !== entryIds.length) throw new Error('CODRIVER_ALREADY_ASSIGNED');
    }
    let charityRegistrationId: string | null = null;
    if (session.workflowType === 'charity_codriver_registration') {
      const [created] = await tx.insert(entryCharityCodriver).values({ eventId: session.eventId, entryId: entryIds[0], personId: participantId, terminalSessionId: sessionId, status: 'active', createdBy: session.operatorUserId, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
      if (!created) {
        throw new Error('CHARITY_CODRIVER_ALREADY_ACTIVE');
      } else charityRegistrationId = created.id;
    }
    const documents = await tx.insert(document).values(entryIds.map((entryId) => ({ eventId: session.eventId, entryId, driverPersonId: participantId, signingSessionId: sessionId, type: 'waiver_signed', templateVariant: draft.locale, templateVersion: context.contract.version, sha256: documentSha256, s3Key: documentS3Key, status: 'generated', createdBy: session.operatorUserId }))).returning();
    await tx.insert(consentEvidence).values(entryIds.map((entryId) => ({ entryId, personId: participantId, participantRole: session.workflowType === 'charity_codriver_registration' ? 'charity_codriver' : 'codriver', terminalSessionId: sessionId, consentVersion: context.contract.version, consentTextHash: context.contract.textHash, locale: draft.locale, consentSource: 'admin_ui', termsAccepted: false, privacyAccepted: true, waiverAccepted: true, mediaAccepted: false, clubInfoAccepted: false, guardianFullName: draft.guardianFullName ?? null, guardianEmail: draft.guardianEmail ?? null, guardianPhone: draft.guardianPhone ?? null, guardianRelationship: draft.guardianRelationship ?? null, guardianConsentAccepted: context.isMinor === true, capturedAt: new Date(input.signedAt), createdAt: now })));
    const [updated] = await tx.update(signingSession).set({ status: 'completed', workflowStage: 'completed', signedAt: new Date(input.signedAt), documentId: documents[0]?.id ?? null, evidenceAuditS3Key: auditS3Key, resultPayload: { participantId, charityRegistrationId, entryIds }, draftPayload: null, updatedAt: now }).where(eq(signingSession.id, sessionId)).returning();
    await writeAuditLog(tx as never, { eventId: session.eventId, actorUserId: session.operatorUserId, action: 'terminal_participant_session_completed', entityType: 'signing_session', entityId: sessionId, payload: { workflowType: session.workflowType, participantId, charityRegistrationId, entryIds, documentIds: documents.map((item) => item.id) } });
    return updated;
  });

  try {
    const terminalSigner = session.signerPayload as { type?: string; guardianName?: string | null };
    await queueWaiverSignedMail(db, {
      toEmail: terminalSigner.type === 'guardian' && draft.guardianEmail?.trim()
        ? draft.guardianEmail.trim().toLowerCase()
        : draft.email,
      driverName: `${draft.firstName} ${draft.lastName}`,
      signerName: terminalSigner.type === 'guardian' && terminalSigner.guardianName?.trim()
        ? terminalSigner.guardianName.trim()
        : `${draft.firstName} ${draft.lastName}`,
      signerRole: terminalSigner.type === 'guardian'
        ? 'Erziehungsberechtigte Person'
        : session.workflowType === 'charity_codriver_registration' ? 'Charity-Beifahrer' : 'Beifahrer',
      eventId: session.eventId,
      eventName: context.event.name,
      eventDates: `${context.event.startsAt} - ${context.event.endsAt}`,
      signedAt: input.signedAt,
      documentS3Key,
      sessionId,
      entryId: entryIds[0],
      documentId: updatedSession?.documentId ?? undefined,
      signingSessionId: sessionId
    });
  } catch (error) {
    await db.update(signingSession).set({
      errorLast: error instanceof Error ? `WAIVER_MAIL_QUEUE_FAILED:${error.message}` : 'WAIVER_MAIL_QUEUE_FAILED',
      updatedAt: new Date()
    }).where(eq(signingSession.id, sessionId));
  }

  return updatedSession;
};

export const validateCreateParticipantTerminalSession = (payload: unknown) => createSessionSchema.parse(payload);
export const validateParticipantDraft = (payload: unknown) => draftSchema.parse(payload);
export const validateParticipantApproval = (payload: unknown) => approveSchema.parse(payload);
export const validateParticipantCompletion = (payload: unknown) => completeSchema.parse(payload);
