import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { standardPersonIdentity } from '../domain/personIdentity';
import { codriverInvitation, consentEvidence, entry, event, eventClass, person } from '../db/schema';
import { CONSENT_VERSION, computeConsentTextHash } from './publicLegalTextsSource';

const createSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length),
  recipientName: z.string().trim().min(1).max(200).optional(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  expiresAt: z.string().datetime()
});

const localeSchema = z.enum(['de-DE', 'en-GB', 'cs-CZ', 'pl-PL']);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phoneSchema = z.string().trim().transform((value) => value.replace(/\D+/g, '')).refine((value) => value.length >= 6 && value.length <= 15);
const invitationParticipantSchema = z.object({
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
  guardianFullName: z.string().trim().max(160).nullable().optional(),
  guardianEmail: z.string().trim().email().nullable().optional(),
  guardianPhone: phoneSchema.nullable().optional(),
  guardianRelationship: z.string().trim().max(80).nullable().optional()
});

const completeSchema = z.object({
  participant: invitationParticipantSchema,
  privacyAccepted: z.literal(true)
});

type InvitationParticipant = z.infer<typeof invitationParticipantSchema>;

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
    driverPublicationName: person.publicationName,
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

const findProtectedRecipient = async (db: any, email: string | null) => {
  if (!email) return null;
  const [matched] = await db.select({
    firstName: person.firstName,
    lastName: person.lastName,
    publicationName: person.publicationName
  }).from(person).where(and(sql`lower(${person.email}) = ${email.toLowerCase()}`, sql`${person.publicationName} is not null`)).limit(1);
  return matched ?? null;
};

const projectInvitationRecipient = (row: { recipientName: string | null; recipientEmailNorm: string | null }, protectedRecipient: any) => {
  if (!protectedRecipient) {
    return { recipientName: row.recipientName, recipientEmail: row.recipientEmailNorm, identityProtected: false };
  }
  return {
    recipientName: standardPersonIdentity(protectedRecipient).displayName,
    recipientEmail: null,
    identityProtected: true
  };
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
  const recipient = projectInvitationRecipient(created, await findProtectedRecipient(db, created.recipientEmailNorm));
  return {
    invitation: { id: created.id, entryIds: created.entryIds, ...recipient, expiresAt: created.expiresAt, status: 'active' },
    url
  };
};

export const listCodriverInvitations = async (sourceEntryId: string) => {
  const db = await getDb();
  const rows = await db.select().from(codriverInvitation)
    .where(sql`${codriverInvitation.sourceEntryId} = ${sourceEntryId}::uuid or ${sourceEntryId}::uuid = any(${codriverInvitation.entryIds})`)
    .orderBy(sql`${codriverInvitation.createdAt} desc`);
  const protectedRecipients = await Promise.all(rows.map((row) => findProtectedRecipient(db, row.recipientEmailNorm)));
  return rows.map((row, index) => ({
    id: row.id,
    entryIds: row.entryIds,
    ...projectInvitationRecipient(row, protectedRecipients[index]),
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
  if (!row) return null;
  return {
    id: row.id,
    entryIds: row.entryIds,
    ...projectInvitationRecipient(row, await findProtectedRecipient(db, row.recipientEmailNorm)),
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    status: invitationState(row)
  };
};

export const getPublicCodriverInvitation = async (token: string) => {
  const invitation = await loadByToken(token);
  const context = await loadEntryContext(invitation.entryIds);
  const driverIdentity = standardPersonIdentity({
    firstName: context.first.driverFirstName,
    lastName: context.first.driverLastName,
    publicationName: context.first.driverPublicationName
  });
  const recipient = projectInvitationRecipient(invitation, await findProtectedRecipient(await getDb(), invitation.recipientEmailNorm));
  return {
    invitation: { ...recipient, expiresAt: invitation.expiresAt },
    event: { name: context.first.eventName, startsAt: context.first.startsAt, endsAt: context.first.endsAt },
    driver: {
      displayName: driverIdentity.displayName,
      identityProtected: driverIdentity.identityProtected,
      firstName: driverIdentity.firstName,
      lastName: driverIdentity.lastName
    },
    entries: context.rows.map((row) => ({ id: row.entryId, className: row.className, startNumber: row.startNumber }))
  };
};

export const completePublicCodriverInvitation = async (token: string, participant: InvitationParticipant) => {
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
export const validateCompleteCodriverInvitation = (payload: unknown) => completeSchema.parse(payload);
