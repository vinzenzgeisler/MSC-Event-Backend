import { and, asc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, eventClass, invoice, person } from '../db/schema';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { queueLifecycleMail } from './adminMail';

const listEntriesQuerySchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  q: z.string().min(1).optional(),
  checkinIdVerified: z.boolean().optional(),
  techStatus: z.enum(['pending', 'passed', 'failed']).optional()
});

const entryStatusPatchSchema = z.object({
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']),
  sendLifecycleMail: z.boolean().optional().default(false),
  lifecycleEventType: z
    .enum([
      'registration_received',
      'preselection',
      'accepted_open_payment',
      'accepted_paid_completed',
      'rejected',
      'waitlist'
    ])
    .optional()
});

const techStatusPatchSchema = z.object({
  techStatus: z.enum(['pending', 'passed', 'failed'])
});

type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type EntryStatusPatch = z.infer<typeof entryStatusPatchSchema>;
type TechStatusPatch = z.infer<typeof techStatusPatchSchema>;

export const listEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [eq(entry.eventId, query.eventId)];
  if (query.classId) {
    conditions.push(eq(entry.classId, query.classId));
  }
  if (query.acceptanceStatus) {
    conditions.push(eq(entry.acceptanceStatus, query.acceptanceStatus));
  }
  if (query.registrationStatus) {
    conditions.push(eq(entry.registrationStatus, query.registrationStatus));
  }
  if (query.paymentStatus) {
    conditions.push(eq(invoice.paymentStatus, query.paymentStatus));
  }
  if (query.checkinIdVerified !== undefined) {
    conditions.push(eq(entry.checkinIdVerified, query.checkinIdVerified));
  }
  if (query.techStatus) {
    conditions.push(eq(entry.techStatus, query.techStatus));
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(
      or(
        ilike(person.firstName, pattern),
        ilike(person.lastName, pattern),
        ilike(entry.startNumberNorm, pattern)
      ) as SQL<unknown>
    );
  }

  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
      className: eventClass.name,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      checkinIdVerified: entry.checkinIdVerified,
      checkinIdVerifiedAt: entry.checkinIdVerifiedAt,
      checkinIdVerifiedBy: entry.checkinIdVerifiedBy,
      techStatus: entry.techStatus,
      techCheckedAt: entry.techCheckedAt,
      techCheckedBy: entry.techCheckedBy,
      startNumberNorm: entry.startNumberNorm,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      paymentStatus: invoice.paymentStatus
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(...conditions))
    .orderBy(asc(eventClass.name), asc(person.lastName), asc(person.firstName));

  return rows.map((row) => {
    const completed = row.acceptanceStatus === 'accepted' && row.paymentStatus === 'paid';
    return {
      ...row,
      completionStatus: completed ? 'completed' : 'open',
      driverFirstName: redactSensitiveFields ? null : row.driverFirstName,
      driverLastName: redactSensitiveFields ? null : row.driverLastName,
      driverEmail: redactSensitiveFields ? null : row.driverEmail
    };
  });
};

export const listCheckinEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) =>
  listEntries(query, redactSensitiveFields);

export const patchEntryStatus = async (entryId: string, input: EntryStatusPatch, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      acceptanceStatus: entry.acceptanceStatus
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

  const [updated] = await db
    .update(entry)
    .set({
      acceptanceStatus: input.acceptanceStatus,
      updatedAt: new Date()
    })
    .where(eq(entry.id, entryId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_status_updated',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      from: existing.acceptanceStatus,
      to: input.acceptanceStatus
    }
  });

  if (input.sendLifecycleMail) {
    if (!input.lifecycleEventType) {
      throw new Error('LIFECYCLE_EVENT_TYPE_REQUIRED');
    }
    await queueLifecycleMail(
      {
        eventId: existing.eventId,
        entryId,
        eventType: input.lifecycleEventType
      },
      actorUserId
    );
  }

  return updated ?? null;
};

export const patchEntryTechStatus = async (entryId: string, input: TechStatusPatch, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

  const now = new Date();
  const [updated] = await db
    .update(entry)
    .set({
      techStatus: input.techStatus,
      techCheckedAt: now,
      techCheckedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(entry.id, entryId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_tech_status_updated',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      techStatus: input.techStatus
    }
  });

  return updated ?? null;
};

export const validateListEntriesQuery = (query: Record<string, string | undefined>) =>
  listEntriesQuerySchema.parse({
    eventId: query.eventId,
    classId: query.classId,
    acceptanceStatus: query.acceptanceStatus,
    registrationStatus: query.registrationStatus,
    paymentStatus: query.paymentStatus,
    q: query.q,
    checkinIdVerified: query.checkinIdVerified === undefined ? undefined : query.checkinIdVerified === 'true',
    techStatus: query.techStatus
  });
export const validateEntryStatusPatchInput = (payload: unknown) => entryStatusPatchSchema.parse(payload);
export const validateEntryTechStatusPatchInput = (payload: unknown) => techStatusPatchSchema.parse(payload);
