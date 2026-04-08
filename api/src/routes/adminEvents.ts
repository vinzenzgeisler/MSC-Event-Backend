import { and, desc, eq, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { entry, event } from '../db/schema';
import { writeAuditLog } from '../audit/log';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';
import { entryConfirmationConfigSchema } from '../domain/entryConfirmationConfig';
import { buildOrgaCode } from '../domain/orgaCode';

const eventStatusSchema = z.enum(['draft', 'open', 'closed', 'archived']);

const createEventSchema = z.object({
  name: z.string().min(1),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  registrationOpenAt: z.string().datetime().optional(),
  registrationCloseAt: z.string().datetime().optional(),
  contactEmail: z.string().email().optional(),
  websiteUrl: z.string().url().optional(),
  entryConfirmationConfig: entryConfirmationConfigSchema.optional(),
  status: eventStatusSchema.default('draft')
});

const listEventsSchema = z.object({
  status: eventStatusSchema.optional(),
  currentOnly: z.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['startsAt', 'endsAt', 'name', 'status', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
});

const updateEventSchema = z
  .object({
    name: z.string().min(1).optional(),
    startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    registrationOpenAt: z.string().datetime().nullable().optional(),
    registrationCloseAt: z.string().datetime().nullable().optional(),
    contactEmail: z.string().email().nullable().optional(),
    websiteUrl: z.string().url().nullable().optional(),
    entryConfirmationConfig: entryConfirmationConfigSchema.optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' });

type CreateEventInput = z.infer<typeof createEventSchema>;
type ListEventsInput = z.infer<typeof listEventsSchema>;
type UpdateEventInput = z.infer<typeof updateEventSchema>;

const normalizePrefix = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

const refreshEventOrgaCodes = async (eventId: string, prefix: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      driverPersonId: entry.driverPersonId
    })
    .from(entry)
    .where(eq(entry.eventId, eventId));

  for (const row of rows) {
    await db
      .update(entry)
      .set({
        orgaCode: buildOrgaCode({
          eventId,
          driverPersonId: row.driverPersonId,
          prefix
        })
      })
      .where(eq(entry.id, row.id));
  }
};

const ensureTransitionAllowed = (from: string, to: string) => {
  if (from === to) {
    return;
  }

  if (to === 'open' && (from === 'draft' || from === 'closed' || from === 'open')) {
    return;
  }
  if (to === 'closed' && (from === 'open' || from === 'archived')) {
    return;
  }
  if (to === 'archived' && from === 'closed') {
    return;
  }

  throw new Error('EVENT_TRANSITION_FORBIDDEN');
};

export const listEvents = async (input: ListEventsInput) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [];
  if (input.status) {
    conditions.push(eq(event.status, input.status));
  }
  if (input.currentOnly) {
    conditions.push(eq(event.isCurrent, true));
  }

  const query = db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      isCurrent: event.isCurrent,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt,
      contactEmail: event.contactEmail,
      websiteUrl: event.websiteUrl,
      entryConfirmationConfig: event.entryConfirmationConfig,
      openedAt: event.openedAt,
      closedAt: event.closedAt,
      archivedAt: event.archivedAt,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt
    })
    .from(event)
    .orderBy(desc(event.startsAt));

  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  const paginationQuery = parseListQuery(
    {
      cursor: input.cursor,
      limit: input.limit?.toString(),
      sortBy: input.sortBy,
      sortDir: input.sortDir
    },
    ['startsAt', 'endsAt', 'name', 'status', 'updatedAt'],
    'startsAt',
    'desc'
  );
  return paginateAndSortRows(rows, paginationQuery);
};

export const getCurrentEvent = async () => {
  const db = await getDb();
  const rows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      isCurrent: event.isCurrent,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt,
      contactEmail: event.contactEmail,
      websiteUrl: event.websiteUrl,
      entryConfirmationConfig: event.entryConfirmationConfig,
      openedAt: event.openedAt,
      closedAt: event.closedAt,
      archivedAt: event.archivedAt
    })
    .from(event)
    .where(eq(event.isCurrent, true))
    .orderBy(desc(event.updatedAt))
    .limit(1);
  return rows[0] ?? null;
};

export const getEventById = async (eventId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      isCurrent: event.isCurrent,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt,
      contactEmail: event.contactEmail,
      websiteUrl: event.websiteUrl,
      entryConfirmationConfig: event.entryConfirmationConfig,
      openedAt: event.openedAt,
      closedAt: event.closedAt,
      archivedAt: event.archivedAt,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt
    })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);

  return rows[0] ?? null;
};

export const createEvent = async (input: CreateEventInput, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const status = input.status;
  const nextEntryConfirmationConfig = input.entryConfirmationConfig ?? {};
  const [created] = await db
    .insert(event)
    .values({
      name: input.name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status,
      isCurrent: false,
      registrationOpenAt: input.registrationOpenAt ? new Date(input.registrationOpenAt) : null,
      registrationCloseAt: input.registrationCloseAt ? new Date(input.registrationCloseAt) : null,
      contactEmail: input.contactEmail ?? null,
      websiteUrl: input.websiteUrl ?? null,
      entryConfirmationConfig: nextEntryConfirmationConfig,
      openedAt: status === 'open' ? now : null,
      closedAt: status === 'closed' ? now : null,
      archivedAt: status === 'archived' ? now : null,
      updatedAt: now
    })
    .returning();

  if (!created) {
    throw new Error('EVENT_CREATE_FAILED');
  }

  await refreshEventOrgaCodes(created.id, normalizePrefix(nextEntryConfirmationConfig.orgaCodePrefix));

  await writeAuditLog(db as never, {
    eventId: created.id,
    actorUserId,
    action: 'event_created',
    entityType: 'event',
    entityId: created.id,
    payload: {
      status: created.status
    }
  });

  return created;
};

export const activateEvent = async (eventId: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(event).where(eq(event.id, eventId)).limit(1);
    const existing = rows[0];
    if (!existing) {
      return null;
    }
    const restoringArchivedEvent = existing.status === 'archived';
    ensureTransitionAllowed(existing.status, restoringArchivedEvent ? 'closed' : 'open');

    if (!restoringArchivedEvent) {
      await tx.update(event).set({ isCurrent: false, updatedAt: now }).where(eq(event.isCurrent, true));
    }

    const [updated] = await tx
      .update(event)
      .set({
        status: restoringArchivedEvent ? 'closed' : 'open',
        isCurrent: restoringArchivedEvent ? false : true,
        openedAt: restoringArchivedEvent ? existing.openedAt : existing.openedAt ?? now,
        closedAt: restoringArchivedEvent ? existing.closedAt ?? now : existing.closedAt,
        archivedAt: restoringArchivedEvent ? null : existing.archivedAt,
        updatedAt: now
      })
      .where(eq(event.id, eventId))
      .returning();

    await writeAuditLog(tx as never, {
      eventId,
      actorUserId,
      action: 'event_activated',
      entityType: 'event',
      entityId: eventId,
      payload: {
        previousStatus: existing.status
      }
    });

    return updated ?? null;
  });
};

export const closeEvent = async (eventId: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  ensureTransitionAllowed(existing.status, 'closed');

  const [updated] = await db
    .update(event)
    .set({
      status: 'closed',
      isCurrent: existing.isCurrent,
      closedAt: now,
      updatedAt: now
    })
    .where(eq(event.id, eventId))
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'event_closed',
    entityType: 'event',
    entityId: eventId,
    payload: {
      previousStatus: existing.status
    }
  });

  return updated ?? null;
};

export const archiveEvent = async (eventId: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  ensureTransitionAllowed(existing.status, 'archived');

  const [updated] = await db
    .update(event)
    .set({
      status: 'archived',
      isCurrent: false,
      archivedAt: now,
      updatedAt: now
    })
    .where(eq(event.id, eventId))
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'event_archived',
    entityType: 'event',
    entityId: eventId,
    payload: {
      previousStatus: existing.status
    }
  });

  return updated ?? null;
};

export const updateEvent = async (eventId: string, input: UpdateEventInput, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  if (existing.status !== 'draft' && existing.status !== 'open') {
    throw new Error('EVENT_STATUS_FORBIDDEN');
  }

  const now = new Date();
  const nextEntryConfirmationConfig =
    input.entryConfirmationConfig === undefined ? existing.entryConfirmationConfig : input.entryConfirmationConfig;
  const [updated] = await db
    .update(event)
    .set({
      name: input.name ?? existing.name,
      startsAt: input.startsAt ?? existing.startsAt,
      endsAt: input.endsAt ?? existing.endsAt,
      registrationOpenAt:
        input.registrationOpenAt === undefined
          ? existing.registrationOpenAt
          : input.registrationOpenAt === null
            ? null
            : new Date(input.registrationOpenAt),
      registrationCloseAt:
        input.registrationCloseAt === undefined
          ? existing.registrationCloseAt
          : input.registrationCloseAt === null
            ? null
            : new Date(input.registrationCloseAt),
      contactEmail:
        input.contactEmail === undefined
          ? existing.contactEmail
          : input.contactEmail === null
            ? null
            : input.contactEmail,
      websiteUrl:
        input.websiteUrl === undefined
          ? existing.websiteUrl
          : input.websiteUrl === null
            ? null
            : input.websiteUrl,
      entryConfirmationConfig:
        nextEntryConfirmationConfig,
      updatedAt: now
    })
    .where(eq(event.id, eventId))
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'event_updated',
    entityType: 'event',
    entityId: eventId,
    payload: {
      changedFields: Object.keys(input)
    }
  });

  const previousPrefix = normalizePrefix(existing.entryConfirmationConfig?.orgaCodePrefix);
  const nextPrefix = normalizePrefix(nextEntryConfirmationConfig?.orgaCodePrefix);
  if (previousPrefix !== nextPrefix) {
    await refreshEventOrgaCodes(eventId, nextPrefix);
  }

  return updated ?? null;
};

export const validateCreateEventInput = (payload: unknown) => createEventSchema.parse(payload);
export const validateListEventsInput = (query: Record<string, string | undefined>) =>
  listEventsSchema.parse({
    status: query.status,
    currentOnly: query.currentOnly === undefined ? undefined : query.currentOnly === 'true',
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    sortBy: query.sortBy,
    sortDir: query.sortDir
  });
export const validateUpdateEventInput = (payload: unknown) => updateEventSchema.parse(payload);
