import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, eventClass, runGroup } from '../db/schema';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { assertUniqueEffectiveRunGroups, type RunGroupClass } from '../domain/runGroups';

const runGroupPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  classIds: z.array(z.string().uuid()).max(100).refine((ids) => new Set(ids).size === ids.length, 'classIds must be unique')
});

type RunGroupPayload = z.infer<typeof runGroupPayloadSchema>;

const loadValidationRows = async (tx: any, eventId: string) => {
  const [classes, entries] = await Promise.all([
    tx
      .select({ id: eventClass.id, eventId: eventClass.eventId, runGroupId: eventClass.runGroupId })
      .from(eventClass)
      .where(eq(eventClass.eventId, eventId)),
    tx
      .select({
        id: entry.id,
        driverPersonId: entry.driverPersonId,
        classId: entry.classId,
        backupClassId: entry.backupClassId,
        isBackupVehicle: entry.isBackupVehicle
      })
      .from(entry)
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`, ne(entry.acceptanceStatus, 'withdrawn')))
  ]);
  return { classes: classes as RunGroupClass[], entries };
};

const validateAndRebuildReservations = async (tx: any, eventId: string) => {
  const rows = await loadValidationRows(tx, eventId);
  assertUniqueEffectiveRunGroups(rows.entries, new Map(rows.classes.map((item) => [item.id, item])));
  await tx.execute(sql`delete from entry_run_group_reservation where event_id = ${eventId}`);
  await tx.execute(sql`
    insert into entry_run_group_reservation (entry_id, event_id, driver_person_id, effective_group_id)
    select e.id, e.event_id, e.driver_person_id, coalesce(c.run_group_id, c.id)
    from entry e join class c on c.id = e.class_id
    where e.event_id = ${eventId} and e.deleted_at is null and e.acceptance_status <> 'withdrawn' and not e.is_backup_vehicle
  `);
};

export const listRunGroups = async (eventId: string) => {
  const db = await getDb();
  const [groups, classes] = await Promise.all([
    db.select().from(runGroup).where(eq(runGroup.eventId, eventId)).orderBy(asc(runGroup.name)),
    db
      .select({ id: eventClass.id, runGroupId: eventClass.runGroupId })
      .from(eventClass)
      .where(eq(eventClass.eventId, eventId))
  ]);
  return groups.map((group) => ({ ...group, classIds: classes.filter((item) => item.runGroupId === group.id).map((item) => item.id) }));
};

const assertPayloadClasses = async (tx: any, eventId: string, groupId: string | null, input: RunGroupPayload) => {
  if (input.classIds.length === 0) return;
  const rows = await tx
    .select({ id: eventClass.id, eventId: eventClass.eventId, runGroupId: eventClass.runGroupId })
    .from(eventClass)
    .where(inArray(eventClass.id, input.classIds));
  if (rows.length !== input.classIds.length || rows.some((row: RunGroupClass) => row.eventId !== eventId)) {
    throw new Error('RUN_GROUP_CLASS_INVALID');
  }
  if (rows.some((row: RunGroupClass) => row.runGroupId !== null && row.runGroupId !== groupId)) {
    throw new Error('RUN_GROUP_CLASS_ASSIGNED');
  }
};

export const createRunGroup = async (eventId: string, input: RunGroupPayload, actorUserId: string | null) => {
  await assertEventStatusAllowed(eventId, ['draft', 'open']);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${eventId}))`);
    await assertPayloadClasses(tx, eventId, null, input);
    const [created] = await tx.insert(runGroup).values({ eventId, name: input.name }).returning();
    if (!created) throw new Error('RUN_GROUP_CREATE_FAILED');
    if (input.classIds.length > 0) {
      await tx.update(eventClass).set({ runGroupId: created.id, updatedAt: new Date() }).where(inArray(eventClass.id, input.classIds));
    }
    await validateAndRebuildReservations(tx, eventId);
    await writeAuditLog(tx as never, {
      eventId,
      actorUserId,
      action: 'run_group_created',
      entityType: 'run_group',
      entityId: created.id,
      payload: { name: input.name, classIds: input.classIds }
    });
    return { ...created, classIds: input.classIds };
  });
};

export const updateRunGroup = async (id: string, input: RunGroupPayload, actorUserId: string | null) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(runGroup).where(eq(runGroup.id, id)).limit(1);
    if (!existing) return null;
    await assertEventStatusAllowed(existing.eventId, ['draft', 'open']);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${existing.eventId}))`);
    await assertPayloadClasses(tx, existing.eventId, id, input);
    await tx.update(eventClass).set({ runGroupId: null, updatedAt: new Date() }).where(eq(eventClass.runGroupId, id));
    if (input.classIds.length > 0) {
      await tx.update(eventClass).set({ runGroupId: id, updatedAt: new Date() }).where(inArray(eventClass.id, input.classIds));
    }
    const [updated] = await tx.update(runGroup).set({ name: input.name, updatedAt: new Date() }).where(eq(runGroup.id, id)).returning();
    await validateAndRebuildReservations(tx, existing.eventId);
    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'run_group_updated',
      entityType: 'run_group',
      entityId: id,
      payload: { previousName: existing.name, name: input.name, classIds: input.classIds }
    });
    return { ...updated, classIds: input.classIds };
  });
};

export const deleteRunGroup = async (id: string, actorUserId: string | null) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(runGroup).where(eq(runGroup.id, id)).limit(1);
    if (!existing) return null;
    await assertEventStatusAllowed(existing.eventId, ['draft', 'open']);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${existing.eventId}))`);
    await tx.update(eventClass).set({ runGroupId: null, updatedAt: new Date() }).where(eq(eventClass.runGroupId, id));
    await validateAndRebuildReservations(tx, existing.eventId);
    await tx.delete(runGroup).where(eq(runGroup.id, id));
    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'run_group_deleted',
      entityType: 'run_group',
      entityId: id,
      payload: { name: existing.name }
    });
    return { id, eventId: existing.eventId };
  });
};

export const validateRunGroupPayload = (payload: unknown) => runGroupPayloadSchema.parse(payload);
