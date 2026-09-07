import { eq, asc, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { simulatorEntry } from '../db/schema';
import { getCurrentEvent } from './adminEvents';

export const validateUpsertSimulatorEntryInput = (body: unknown) =>
  z
    .object({
      eventId: z.string().uuid(),
      name: z.string().min(1).max(100).trim(),
      bestTimeMs: z.number().int().positive(),
      day: z.enum(['saturday', 'sunday'])
    })
    .parse(body);

export const validateListSimulatorEntriesQuery = (query: Record<string, string | undefined>) =>
  z
    .object({
      eventId: z.string().uuid(),
      day: z.enum(['saturday', 'sunday']).optional()
    })
    .parse(query);

export const listSimulatorEntries = async (
  eventId: string,
  day?: 'saturday' | 'sunday'
) => {
  const db = await getDb();
  const conditions =
    day != null
      ? and(eq(simulatorEntry.eventId, eventId), eq(simulatorEntry.day, day))
      : eq(simulatorEntry.eventId, eventId);
  const entries = await db
    .select()
    .from(simulatorEntry)
    .where(conditions)
    .orderBy(asc(simulatorEntry.day), asc(simulatorEntry.bestTimeMs));
  return entries;
};

export const upsertSimulatorEntry = async (input: {
  eventId: string;
  name: string;
  bestTimeMs: number;
  day: 'saturday' | 'sunday';
}) => {
  const db = await getDb();
  const [row] = await db
    .insert(simulatorEntry)
    .values({
      eventId: input.eventId,
      name: input.name,
      bestTimeMs: input.bestTimeMs,
      day: input.day
    })
    .onConflictDoUpdate({
      target: [simulatorEntry.eventId, simulatorEntry.name, simulatorEntry.day],
      set: {
        bestTimeMs: input.bestTimeMs,
        updatedAt: new Date()
      }
    })
    .returning();
  return row;
};

export const deleteSimulatorEntry = async (id: string) => {
  const db = await getDb();
  const [deleted] = await db
    .delete(simulatorEntry)
    .where(eq(simulatorEntry.id, id))
    .returning();
  return deleted ?? null;
};

export const getPublicSimLeaderboard = async (day?: 'saturday' | 'sunday') => {
  const currentEvent = await getCurrentEvent();
  if (!currentEvent) return { entries: [], eventId: null };
  const db = await getDb();
  const conditions =
    day != null
      ? and(eq(simulatorEntry.eventId, currentEvent.id), eq(simulatorEntry.day, day))
      : eq(simulatorEntry.eventId, currentEvent.id);
  const entries = await db
    .select({
      id: simulatorEntry.id,
      name: simulatorEntry.name,
      bestTimeMs: simulatorEntry.bestTimeMs,
      day: simulatorEntry.day
    })
    .from(simulatorEntry)
    .where(conditions)
    .orderBy(asc(simulatorEntry.day), asc(simulatorEntry.bestTimeMs));
  return { entries, eventId: currentEvent.id };
};
