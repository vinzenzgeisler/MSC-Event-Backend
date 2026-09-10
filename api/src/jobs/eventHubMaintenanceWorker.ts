import { getDb, getPool } from '../db/client';
import { writeAuditLog } from '../audit/log';

const parseRetention = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const handler = async () => {
  const pool = await getPool();
  const windowStart = new Date().toISOString();

  const expiredChallenges = await pool.query(
    `delete from "event_vote_challenge" where "expires_at" < now() - interval '24 hours'`
  );

  const resultRetentionDays = parseRetention('RETENTION_EVENT_HUB_RESULT_DAYS', 90);

  await pool.query(
    `insert into "event_vote_result_snapshot" (event_id, class_id, entry_id, vote_count, captured_at)
     select v."event_id", v."class_id", v."entry_id", count(*)::int, now()
     from "event_vote" v
     inner join "event" e on e."id" = v."event_id"
     where e."ends_at" < current_date - ($1 * interval '1 day')
       and not exists (
         select 1 from "event_vote_result_snapshot" s
         where s."event_id" = v."event_id"
       )
     group by v."event_id", v."class_id", v."entry_id"`,
    [resultRetentionDays]
  );

  const deletedVotes = await pool.query(
    `delete from "event_vote" v
     using "event" e
     where e."id" = v."event_id"
       and e."ends_at" < current_date - ($1 * interval '1 day')
       and exists (
         select 1 from "event_vote_result_snapshot" s
         where s."event_id" = v."event_id"
       )`,
    [resultRetentionDays]
  );

  const db = await getDb();
  const windowEnd = new Date().toISOString();
  await writeAuditLog(db as never, {
    eventId: null,
    actorUserId: 'system',
    action: 'event_hub_maintenance_run',
    entityType: 'system_job',
    payload: {
      windowStart,
      windowEnd,
      expiredChallengesDeleted: expiredChallenges.rowCount ?? 0,
      eventsSnapshotted: deletedVotes.rowCount ?? 0
    }
  });

  return {
    ok: true,
    expiredChallengesDeleted: expiredChallenges.rowCount ?? 0,
    votesArchived: deletedVotes.rowCount ?? 0
  };
};
