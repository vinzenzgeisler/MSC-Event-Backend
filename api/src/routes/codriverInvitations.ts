import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { codriverInvitation, consentEvidence, entry, event, eventClass, person } from '../db/schema';
import { validateParticipantDraft, type ParticipantDraft } from './terminalWorkflows';
import { CONSENT_VERSION, computeConsentTextHash } from './publicLegalTextsSource';

const createSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length),
  recipientName: z.string().trim().min(1).max(200).optional(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  expiresAt: z.string().datetime()
});

const completeSchema = z.object({
  participant: z.unknown(),
  privacyAccepted: z.literal(true)
});

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const invitationState = (row: { revokedAt: Date | null; consumedAt: Date | null; expiresAt: Date }) =>
  row.revokedAt ? 'revoked' : row.consumedAt ? 'used' : row.expiresAt < new Date() ? 'expired' : 'active';

const ageAt = (birthdate: string, startsAt: string) => {
  const born = new Date(`${birthdate}T12:00:00Z`);
  const date = new Date(`${startsAt}T12:00:00Z`);
  let age = date.getUTCFullYear() - born.getUTCFullYear();
  if (date.getUTCMonth() < born.getUTCMonth() || (date.getUTCMonth() === born.getUTCMonth() && date.getUTCDate() < born.getUTCDate())) age -= 1;
  return age;
};

const publicUrl = (token: string) => {
  const base = (process.env.MAIL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('PUBLIC_URL_NOT_CONFIGURED');
  return `${base}/beifahrer-anmeldung/${encodeURIComponent(token)}`;
};

const loadEntryContext = async (entryIds: string[]) => {
  const db = await getDb();
  const rows = await db.select({
    entryId: entry.id,
    eventId: entry.eventId,
    driverPersonId: entry.driverPersonId,
    driverFirstName: person.firstName,
    driverLastName: person.lastName,
    driverEmail: person.email,
    eventName: event.name,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    className: eventClass.name,
    startNumber: entry.startNumberNorm,
    allowsCodriver: eventClass.allowsCodriver,
    acceptanceStatus: entry.acceptanceStatus,
    codriverPersonId: entry.codriverPersonId,
    deletedAt: entry.deletedAt
  }).from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(inArray(entry.id, entryIds))
    .orderBy(asc(eventClass.name), asc(entry.startNumberNorm));
  if (rows.length !== entryIds.length) throw new Error('CODRIVER_INVITATION_ENTRY_INVALID');
  const first = rows[0];
  if (rows.some((row) => row.eventId !== first.eventId || row.driverPersonId !== first.driverPersonId)) throw new Error('CODRIVER_INVITATION_ENTRIES_MUST_SHARE_DRIVER');
  if (rows.some((row) => row.deletedAt || row.acceptanceStatus !== 'accepted' || !row.allowsCodriver || row.codriverPersonId)) throw new Error('CODRIVER_INVITATION_ENTRY_NOT_ELIGIBLE');
  return { first, rows };
};

const loadByToken = async (token: string) => {
  const db = await getDb();
  const [row] = await db.select().from(codriverInvitation).where(eq(codriverInvitation.tokenHash, hashToken(token))).limit(1);
  if (!row) throw new Error('CODRIVER_INVITATION_INVALID');
  const status = invitationState(row);
  if (status !== 'active') throw new Error(`CODRIVER_INVITATION_${status.toUpperCase()}`);
  return row;
};

export const createCodriverInvitation = async (input: z.infer<typeof createSchema>, actorUserId: string | null) => {
  const expiresAt = new Date(input.expiresAt);
  const validForMs = expiresAt.getTime() - Date.now();
  if (validForMs < 5 * 60_000 || validForMs > 90 * 24 * 60 * 60_000) throw new Error('CODRIVER_INVITATION_EXPIRY_INVALID');
  const context = await loadEntryContext(input.entryIds);
  const token = randomBytes(32).toString('base64url');
  const url = publicUrl(token);
  const db = await getDb();
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(codriverInvitation).values({
      eventId: context.first.eventId,
      sourceEntryId: input.entryIds[0],
      entryIds: input.entryIds,
      tokenHash: hashToken(token),
      recipientName: input.recipientName ?? null,
      recipientEmailNorm: input.recipientEmail?.toLowerCase() ?? null,
      expiresAt,
      createdBy: actorUserId
    }).returning();
    if (!row) throw new Error('CODRIVER_INVITATION_CREATE_FAILED');
    await writeAuditLog(tx as never, {
      eventId: context.first.eventId,
      actorUserId,
      action: 'codriver_invitation_created',
      entityType: 'codriver_invitation',
      entityId: row.id,
      payload: { entryIds: input.entryIds, expiresAt: input.expiresAt, recipientBound: Boolean(input.recipientEmail), invitationKind: 'regular_codriver' }
    });
    return row;
  });
  return {
    invitation: { id: created.id, entryIds: created.entryIds, recipientName: created.recipientName, recipientEmail: created.recipientEmailNorm, expiresAt: created.expiresAt, status: 'active' },
    url
  };
};

export const listCodriverInvitations = async (sourceEntryId: string) => {
  const db = await getDb();
  const rows = await db.select().from(codriverInvitation)
    .where(sql`${codriverInvitation.sourceEntryId} = ${sourceEntryId}::uuid or ${sourceEntryId}::uuid = any(${codriverInvitation.entryIds})`)
    .orderBy(sql`${codriverInvitation.createdAt} desc`);
  return rows.map((row) => ({
    id: row.id,
    entryIds: row.entryIds,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmailNorm,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    status: invitationState(row)
  }));
};

export const revokeCodriverInvitation = async (id: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const [row] = await db.update(codriverInvitation)
    .set({ revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(and(eq(codriverInvitation.id, id), isNull(codriverInvitation.revokedAt), isNull(codriverInvitation.consumedAt), sql`${codriverInvitation.expiresAt} >= ${now}`))
    .returning();
  if (row) await writeAuditLog(db as never, { eventId: row.eventId, actorUserId, action: 'codriver_invitation_revoked', entityType: 'codriver_invitation', entityId: row.id, payload: {} });
  return row ?? null;
};

export const getPublicCodriverInvitation = async (token: string) => {
  const invitation = await loadByToken(token);
  const context = await loadEntryContext(invitation.entryIds);
  return {
    invitation: { recipientName: invitation.recipientName, recipientEmail: invitation.recipientEmailNorm, expiresAt: invitation.expiresAt },
    event: { name: context.first.eventName, startsAt: context.first.startsAt, endsAt: context.first.endsAt },
    driver: { firstName: context.first.driverFirstName, lastName: context.first.driverLastName },
    entries: context.rows.map((row) => ({ id: row.entryId, className: row.className, startNumber: row.startNumber }))
  };
};

export const completePublicCodriverInvitation = async (token: string, participant: ParticipantDraft) => {
  const invitation = await loadByToken(token);
  const context = await loadEntryContext(invitation.entryIds);
  if (invitation.recipientEmailNorm && invitation.recipientEmailNorm !== participant.email) throw new Error('CODRIVER_INVITATION_EMAIL_MISMATCH');
  if (context.first.driverEmail && participant.email === context.first.driverEmail.toLowerCase()) throw new Error('CODRIVER_EMAIL_MUST_DIFFER');
  const age = ageAt(participant.birthdate, String(context.first.startsAt));
  if (age < 6 || age > 100) throw new Error('BIRTHDATE_OUT_OF_RANGE');
  if (age < 18 && (!participant.guardianFullName || !participant.guardianEmail || !participant.guardianPhone || !participant.guardianRelationship)) throw new Error('GUARDIAN_REQUIRED');
  const db = await getDb();
  const [existingPerson] = await db.select().from(person).where(sql`lower(${person.email}) = ${participant.email}`).limit(1);
  if (existingPerson?.id === context.first.driverPersonId) throw new Error('CODRIVER_EMAIL_MUST_DIFFER');
  if (existingPerson && `${existingPerson.firstName} ${existingPerson.lastName}`.trim().toLowerCase() !== `${participant.firstName} ${participant.lastName}`.trim().toLowerCase()) throw new Error('EMAIL_ALREADY_USED_BY_DIFFERENT_PERSON');
  const participantId = existingPerson?.id ?? randomUUID();
  const legalLocale = participant.locale === 'en-GB' ? 'en' : participant.locale === 'cs-CZ' ? 'cz' : participant.locale === 'pl-PL' ? 'pl' : 'de';
  const consentTextHash = await computeConsentTextHash(legalLocale);
  return db.transaction(async (tx) => {
    const now = new Date();
    const personValues = {
      birthdate: participant.birthdate,
      country: participant.country,
      street: participant.street,
      zip: participant.zip,
      city: participant.city,
      phone: participant.phone,
      emergencyContactFirstName: participant.emergencyContactFirstName,
      emergencyContactLastName: participant.emergencyContactLastName,
      emergencyContactPhone: participant.emergencyContactPhone,
      motorsportHistory: participant.motorsportHistory ?? null,
      updatedAt: now
    };
    if (existingPerson) await tx.update(person).set(personValues).where(eq(person.id, participantId));
    else await tx.insert(person).values({ id: participantId, email: participant.email, firstName: participant.firstName, lastName: participant.lastName, ...personValues, createdAt: now });
    const [claimed] = await tx.update(codriverInvitation).set({ consumedAt: now, codriverPersonId: participantId, updatedAt: now })
      .where(and(eq(codriverInvitation.id, invitation.id), isNull(codriverInvitation.revokedAt), isNull(codriverInvitation.consumedAt), sql`${codriverInvitation.expiresAt} >= ${now}`)).returning();
    if (!claimed) throw new Error('CODRIVER_INVITATION_USED');
    const linked = await tx.update(entry).set({ codriverPersonId: participantId, updatedAt: now })
      .where(and(inArray(entry.id, invitation.entryIds), eq(entry.acceptanceStatus, 'accepted'), isNull(entry.deletedAt), isNull(entry.codriverPersonId))).returning({ id: entry.id });
    if (linked.length !== invitation.entryIds.length) throw new Error('CODRIVER_ALREADY_ASSIGNED');
    await tx.insert(consentEvidence).values(invitation.entryIds.map((entryId) => ({
      entryId,
      personId: participantId,
      participantRole: 'codriver',
      consentVersion: CONSENT_VERSION,
      consentTextHash,
      locale: participant.locale,
      consentSource: 'public_form',
      termsAccepted: false,
      privacyAccepted: true,
      waiverAccepted: false,
      mediaAccepted: false,
      clubInfoAccepted: false,
      guardianFullName: participant.guardianFullName ?? null,
      guardianEmail: participant.guardianEmail ?? null,
      guardianPhone: participant.guardianPhone ?? null,
      guardianRelationship: participant.guardianRelationship ?? null,
      guardianConsentAccepted: false,
      capturedAt: now,
      createdAt: now
    })));
    await writeAuditLog(tx as never, { eventId: context.first.eventId, actorUserId: null, action: 'codriver_invitation_completed', entityType: 'codriver_invitation', entityId: invitation.id, payload: { participantId, entryIds: invitation.entryIds, invitationCreatedBy: invitation.createdBy, waiverRequiredOnSite: true } });
    return { participantId, entryIds: invitation.entryIds, waiverRequiredOnSite: true };
  });
};

export const validateCreateCodriverInvitation = (payload: unknown) => createSchema.parse(payload);
export const validateCompleteCodriverInvitation = (payload: unknown) => {
  const parsed = completeSchema.parse(payload);
  return { participant: validateParticipantDraft(parsed.participant), privacyAccepted: parsed.privacyAccepted };
};
