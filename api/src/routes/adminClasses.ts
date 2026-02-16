import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, eventClass } from '../db/schema';
import { assertEventStatusAllowed } from '../domain/eventStatus';

const classInputSchema = z.object({
  name: z.string().min(1),
  vehicleType: z.enum(['moto', 'auto'])
});

const classUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    vehicleType: z.enum(['moto', 'auto']).optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' });

type ClassInput = z.infer<typeof classInputSchema>;
type ClassUpdateInput = z.infer<typeof classUpdateSchema>;

export const listClassesByEvent = async (eventId: string) => {
  const db = await getDb();
  return db
    .select({
      id: eventClass.id,
      eventId: eventClass.eventId,
      name: eventClass.name,
      vehicleType: eventClass.vehicleType,
      createdAt: eventClass.createdAt,
      updatedAt: eventClass.updatedAt
    })
    .from(eventClass)
    .where(eq(eventClass.eventId, eventId))
    .orderBy(asc(eventClass.name));
};

export const createClass = async (eventId: string, input: ClassInput, actorUserId: string | null) => {
  await assertEventStatusAllowed(eventId, ['draft', 'open']);
  const db = await getDb();
  const now = new Date();
  const [created] = await db
    .insert(eventClass)
    .values({
      eventId,
      name: input.name,
      vehicleType: input.vehicleType,
      createdAt: now,
      updatedAt: now
    })
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'class_created',
    entityType: 'class',
    entityId: created?.id ?? null,
    payload: {
      name: input.name,
      vehicleType: input.vehicleType
    }
  });

  return created ?? null;
};

export const updateClass = async (classId: string, input: ClassUpdateInput, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db.select().from(eventClass).where(eq(eventClass.id, classId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['draft', 'open']);

  const [updated] = await db
    .update(eventClass)
    .set({
      name: input.name ?? existing.name,
      vehicleType: input.vehicleType ?? existing.vehicleType,
      updatedAt: new Date()
    })
    .where(eq(eventClass.id, classId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'class_updated',
    entityType: 'class',
    entityId: classId,
    payload: {
      changedFields: Object.keys(input)
    }
  });

  return updated ?? null;
};

export const deleteClass = async (classId: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db.select().from(eventClass).where(eq(eventClass.id, classId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['draft', 'open']);

  const usage = await db
    .select({ id: entry.id })
    .from(entry)
    .where(and(eq(entry.eventId, existing.eventId), eq(entry.classId, classId)))
    .limit(1);
  if (usage.length > 0) {
    throw new Error('CLASS_IN_USE');
  }

  await db.delete(eventClass).where(eq(eventClass.id, classId));

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'class_deleted',
    entityType: 'class',
    entityId: classId,
    payload: {
      name: existing.name
    }
  });

  return { id: classId };
};

export const validateClassInput = (payload: unknown) => classInputSchema.parse(payload);
export const validateClassUpdateInput = (payload: unknown) => classUpdateSchema.parse(payload);
