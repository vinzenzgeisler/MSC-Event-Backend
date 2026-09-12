import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, event as eventTable, eventClass, eventHubCandidateOverride, eventHubConfig, eventVote, person } from '../db/schema';
import { isPubliclyEligible } from '../domain/eventHubFacts';
import { loadCandidateRows } from './eventHub';

export type AdminCandidateExclusionReason = 'processing_restricted' | 'objection_flag' | 'publication_name_protected' | 'hidden' | null;

export const getAdminCandidates = async (eventId: string) => {
  const db = await getDb();
  const [rows, classRows] = await Promise.all([
    loadCandidateRows(db, eventId),
    db.select({ id: eventClass.id, name: eventClass.name }).from(eventClass).where(eq(eventClass.eventId, eventId))
  ]);
  const classNames = new Map(classRows.map((eventClassRow) => [eventClassRow.id, eventClassRow.name]));
  return rows.map((row) => {
    let exclusionReason: AdminCandidateExclusionReason = null;
    if (row.overrideState === 'hidden') {
      exclusionReason = 'hidden';
    } else if (row.driverProcessingRestricted) {
      exclusionReason = 'processing_restricted';
    } else if (row.driverObjectionFlag) {
      exclusionReason = 'objection_flag';
    } else if (row.driverPublicationName) {
      exclusionReason = 'publication_name_protected';
    }
    return {
      entryId: row.entryId,
      classId: row.classId,
      className: classNames.get(row.classId) ?? row.classId,
      startNumberNorm: row.startNumberNorm,
      driverName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      vehicleMake: row.vehicleMake,
      vehicleModel: row.vehicleModel,
      overrideState: row.overrideState ?? 'auto',
      featured: Boolean(row.featured),
      eligible: isPubliclyEligible(row),
      exclusionReason
    };
  });
};

const patchEventHubConfigSchema = z
  .object({
    votingOpensAt: z.string().datetime().nullable().optional(),
    votingClosesAt: z.string().datetime().nullable().optional(),
    votingMode: z.enum(['auto', 'forced_open', 'forced_closed']).optional(),
    venueLat: z.string().regex(/^-?\d{1,3}(\.\d+)?$/).nullable().optional(),
    venueLng: z.string().regex(/^-?\d{1,3}(\.\d+)?$/).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' });
export type PatchEventHubConfigInput = z.infer<typeof patchEventHubConfigSchema>;
export const validatePatchEventHubConfigInput = (payload: unknown): PatchEventHubConfigInput =>
  patchEventHubConfigSchema.parse(payload);

export const getEventHubConfig = async (eventId: string) => {
  const db = await getDb();
  const [config] = await db.select().from(eventHubConfig).where(eq(eventHubConfig.eventId, eventId)).limit(1);
  return config ?? {
    eventId,
    votingOpensAt: null,
    votingClosesAt: null,
    votingMode: 'auto' as const,
    venueLat: null,
    venueLng: null
  };
};

export const patchEventHubConfig = async (eventId: string, input: PatchEventHubConfigInput, actorUserId: string | null) => {
  const db = await getDb();
  const normalized = {
    ...input,
    votingOpensAt: input.votingOpensAt === undefined ? undefined : input.votingOpensAt === null ? null : new Date(input.votingOpensAt),
    votingClosesAt: input.votingClosesAt === undefined ? undefined : input.votingClosesAt === null ? null : new Date(input.votingClosesAt)
  };
  const [updated] = await db
    .insert(eventHubConfig)
    .values({ eventId, ...normalized, updatedAt: new Date(), updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: eventHubConfig.eventId,
      set: { ...normalized, updatedAt: new Date(), updatedBy: actorUserId }
    })
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'event_hub_config_updated',
    entityType: 'event_hub_config',
    entityId: eventId,
    payload: { fieldMask: Object.keys(input) }
  });
  return updated;
};

const candidateOverrideSchema = z.object({
  state: z.enum(['auto', 'pinned', 'hidden']).optional(),
  featured: z.boolean().optional()
}).refine((value) => value.state !== undefined || value.featured !== undefined, 'Provide state or featured');
export type CandidateOverrideInput = z.infer<typeof candidateOverrideSchema>;
export const validateCandidateOverrideInput = (payload: unknown): CandidateOverrideInput =>
  candidateOverrideSchema.parse(payload);

export const putCandidateOverride = async (
  eventId: string,
  entryId: string,
  input: CandidateOverrideInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const [updated] = await db
    .insert(eventHubCandidateOverride)
    .values({ eventId, entryId, state: input.state ?? 'auto', featured: input.featured ?? false, updatedAt: new Date(), updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: [eventHubCandidateOverride.eventId, eventHubCandidateOverride.entryId],
      set: {
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.featured === undefined ? {} : { featured: input.featured }),
        updatedAt: new Date(), updatedBy: actorUserId
      }
    })
    .returning();

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'event_hub_candidate_override_updated',
    entityType: 'event_hub_candidate_override',
    entityId: entryId,
    payload: { entryId, state: input.state, featured: input.featured }
  });
  return updated;
};

export const getVotingResults = async (eventId: string) => {
  const db = await getDb();
  const invalidVoteCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventVote)
    .innerJoin(entry, eq(eventVote.entryId, entry.id))
    .where(
      and(
        eq(eventVote.eventId, eventId),
        sql`(${entry.deletedAt} is not null or ${entry.acceptanceStatus} != 'accepted')`
      )
    );

  const rows = await db
    .select({
      classId: eventVote.classId,
      className: eventClass.name,
      entryId: eventVote.entryId,
      startNumberNorm: entry.startNumberNorm,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      voteCount: sql<number>`count(*)::int`
    })
    .from(eventVote)
    .innerJoin(entry, eq(eventVote.entryId, entry.id))
    .innerJoin(eventClass, and(eq(eventVote.classId, eventClass.id), eq(eventVote.eventId, eventClass.eventId)))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(eq(eventVote.eventId, eventId))
    .groupBy(eventVote.classId, eventClass.name, eventVote.entryId, entry.startNumberNorm, person.firstName, person.lastName);

  const byClass = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byClass.get(row.classId) ?? [];
    list.push(row);
    byClass.set(row.classId, list);
  }

  const classes = Array.from(byClass.entries()).map(([classId, classRows]) => {
    const total = classRows.reduce((sum, r) => sum + r.voteCount, 0);
    const sorted = [...classRows].sort((a, b) => b.voteCount - a.voteCount);
    let rank = 0;
    let previousCount: number | null = null;
    const ranked = sorted.map((r, index) => {
      if (previousCount === null || r.voteCount !== previousCount) {
        rank = index + 1;
        previousCount = r.voteCount;
      }
      return {
        rank,
        entryId: r.entryId,
        startNumberNorm: r.startNumberNorm,
        driverName: `${r.driverFirstName} ${r.driverLastName}`.trim(),
        voteCount: r.voteCount,
        percent: total > 0 ? Math.round((r.voteCount / total) * 1000) / 10 : 0
      };
    });
    return { classId, className: classRows[0]?.className ?? classId, entries: ranked };
  });

  return { classes, invalidVoteCount: invalidVoteCount[0]?.count ?? 0 };
};

const escapeCsv = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

export const votingResultsToCsv = (results: Awaited<ReturnType<typeof getVotingResults>>): string => {
  const headers = ['classId', 'className', 'rank', 'entryId', 'startNumber', 'driverName', 'voteCount', 'percent'];
  const lines = [headers.join(',')];
  for (const cls of results.classes) {
    for (const entryRow of cls.entries) {
      lines.push(
        [cls.classId, cls.className, entryRow.rank, entryRow.entryId, entryRow.startNumberNorm, entryRow.driverName, entryRow.voteCount, entryRow.percent]
          .map(escapeCsv)
          .join(',')
      );
    }
  }
  return `${lines.join('\n')}\n`;
};

export const eventExists = async (eventId: string): Promise<boolean> => {
  const db = await getDb();
  const [row] = await db.select({ id: eventTable.id }).from(eventTable).where(eq(eventTable.id, eventId)).limit(1);
  return Boolean(row);
};
