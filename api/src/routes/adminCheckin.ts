import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { entry } from '../db/schema';
import { writeAuditLog } from '../audit/log';
import { assertEventStatusAllowed } from '../domain/eventStatus';

const idVerifySchema = z.object({
  checkinIdVerified: z.boolean()
});

type IdVerifyInput = z.infer<typeof idVerifySchema>;

export const setCheckinIdVerified = async (entryId: string, input: IdVerifyInput, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db
    .select({
      eventId: entry.eventId
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  if (rows.length === 0) {
    return null;
  }
  await assertEventStatusAllowed(rows[0].eventId, ['open', 'closed']);

  const [updated] = await db
    .update(entry)
    .set({
      checkinIdVerified: input.checkinIdVerified,
      checkinIdVerifiedAt: input.checkinIdVerified ? now : null,
      checkinIdVerifiedBy: input.checkinIdVerified ? actorUserId : null,
      updatedAt: now
    })
    .where(eq(entry.id, entryId))
    .returning({
      id: entry.id,
      eventId: entry.eventId,
      checkinIdVerified: entry.checkinIdVerified,
      checkinIdVerifiedAt: entry.checkinIdVerifiedAt,
      checkinIdVerifiedBy: entry.checkinIdVerifiedBy
    });

  if (!updated) {
    return null;
  }

  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'checkin_id_verified_set',
    entityType: 'entry',
    entityId: updated.id,
    payload: {
      checkinIdVerified: updated.checkinIdVerified
    }
  });

  return updated;
};

export const validateIdVerifyInput = (payload: unknown) => idVerifySchema.parse(payload);
