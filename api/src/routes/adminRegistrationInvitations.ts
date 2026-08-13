import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { event, eventClass, registrationInvitation } from '../db/schema';

const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_EXPIRY_MS = 5 * 60 * 1000;

const createInvitationSchema = z.object({
  recipientName: z.string().trim().min(1).max(200).optional(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  expiresAt: z.string().datetime(),
  allowedClassIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'allowedClassIds must be unique')
}).superRefine((value, ctx) => {
  const expiry = new Date(value.expiresAt).getTime();
  const delta = expiry - Date.now();
  if (delta < MIN_EXPIRY_MS || delta > MAX_EXPIRY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'expiresAt must be between 5 minutes and 90 days from now'
    });
  }
});

export type CreateRegistrationInvitationInput = z.infer<typeof createInvitationSchema>;

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export const validateCreateRegistrationInvitationInput = (payload: unknown) => createInvitationSchema.parse(payload);

export const listRegistrationInvitations = async (eventId: string) => {
  const db = await getDb();
  return db
    .select({
      id: registrationInvitation.id,
      eventId: registrationInvitation.eventId,
      recipientName: registrationInvitation.recipientName,
      recipientEmail: registrationInvitation.recipientEmailNorm,
      allowedClassIds: registrationInvitation.allowedClassIds,
      expiresAt: registrationInvitation.expiresAt,
      revokedAt: registrationInvitation.revokedAt,
      consumedAt: registrationInvitation.consumedAt,
      consumedRegistrationGroupId: registrationInvitation.consumedRegistrationGroupId,
      createdAt: registrationInvitation.createdAt
    })
    .from(registrationInvitation)
    .where(eq(registrationInvitation.eventId, eventId))
    .orderBy(desc(registrationInvitation.createdAt));
};

export const createRegistrationInvitation = async (
  eventId: string,
  input: CreateRegistrationInvitationInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const created = await db.transaction(async (tx) => {
    const [eventRow, classRows] = await Promise.all([
      tx.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1),
      tx.select({ id: eventClass.id, eventId: eventClass.eventId }).from(eventClass).where(inArray(eventClass.id, input.allowedClassIds))
    ]);
    if (!eventRow[0]) throw new Error('EVENT_NOT_FOUND');
    if (classRows.length !== input.allowedClassIds.length || classRows.some((item) => item.eventId !== eventId)) {
      throw new Error('INVITATION_CLASS_INVALID');
    }
    const [row] = await tx.insert(registrationInvitation).values({
      eventId,
      tokenHash: hashToken(token),
      recipientName: input.recipientName ?? null,
      recipientEmailNorm: input.recipientEmail?.toLowerCase() ?? null,
      allowedClassIds: input.allowedClassIds,
      expiresAt: new Date(input.expiresAt),
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now
    }).returning();
    if (!row) throw new Error('INVITATION_CREATE_FAILED');
    await writeAuditLog(tx as never, {
      eventId,
      actorUserId,
      action: 'registration_invitation_created',
      entityType: 'registration_invitation',
      entityId: row.id,
      payload: {
        recipientBound: Boolean(input.recipientEmail),
        allowedClassIds: input.allowedClassIds,
        expiresAt: input.expiresAt
      }
    });
    return row;
  });
  return {
    invitation: {
      id: created.id,
      eventId: created.eventId,
      recipientName: created.recipientName,
      recipientEmail: created.recipientEmailNorm,
      allowedClassIds: created.allowedClassIds,
      expiresAt: created.expiresAt,
      revokedAt: created.revokedAt,
      consumedAt: created.consumedAt,
      consumedRegistrationGroupId: created.consumedRegistrationGroupId,
      createdAt: created.createdAt
    },
    token
  };
};

export const revokeRegistrationInvitation = async (id: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(registrationInvitation).set({
      revokedAt: now,
      revokedBy: actorUserId,
      updatedAt: now
    }).where(and(
      eq(registrationInvitation.id, id),
      isNull(registrationInvitation.revokedAt),
      isNull(registrationInvitation.consumedAt),
      gte(registrationInvitation.expiresAt, now)
    )).returning();
    if (!row) return null;
    await writeAuditLog(tx as never, {
      eventId: row.eventId,
      actorUserId,
      action: 'registration_invitation_revoked',
      entityType: 'registration_invitation',
      entityId: row.id,
      payload: {}
    });
    return { id: row.id, eventId: row.eventId, revokedAt: row.revokedAt };
  });
};
