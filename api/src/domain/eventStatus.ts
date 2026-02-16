import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { event } from '../db/schema';

export type EventStatus = 'draft' | 'open' | 'closed' | 'archived';

export type EventState = {
  id: string;
  status: EventStatus;
  registrationOpenAt: Date | null;
  registrationCloseAt: Date | null;
};

export const getEventStatus = async (eventId: string): Promise<EventStatus | null> => {
  const db = await getDb();
  const rows = await db.select({ status: event.status }).from(event).where(eq(event.id, eventId));
  if (rows.length === 0) {
    return null;
  }
  return rows[0].status as EventStatus;
};

export const getEventState = async (eventId: string): Promise<EventState | null> => {
  const db = await getDb();
  const rows = await db
    .select({
      id: event.id,
      status: event.status,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt
    })
    .from(event)
    .where(eq(event.id, eventId));
  if (rows.length === 0) {
    return null;
  }
  return rows[0] as EventState;
};

export const assertEventStatusAllowed = async (eventId: string, allowed: EventStatus[]) => {
  const status = await getEventStatus(eventId);
  if (!status) {
    throw new Error('EVENT_NOT_FOUND');
  }
  if (!allowed.includes(status)) {
    throw new Error('EVENT_STATUS_FORBIDDEN');
  }
  return status;
};
