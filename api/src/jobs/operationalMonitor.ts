import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getPool } from '../db/client';
import { doesDocumentObjectExist } from '../docs/storage';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { getOrgaNotificationRecipients } from '../observability/recipients';

type Snapshot = {
  apiUnavailable: number;
  outboxFailed: number;
  outboxOverdue: number;
  outboxStuckSending: number;
  signingEvidenceIncomplete: number;
  signingMailQueueFailed: number;
  inspectionNotificationMissing: number;
  registrationNotificationMissing: number;
  s3EvidenceMissing: number;
};

const toNumber = (value: unknown): number => Number(value ?? 0) || 0;

const probeApi = async (): Promise<number> => {
  const url = process.env.API_HEALTH_URL;
  if (!url) return 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? 0 : 1;
  } catch (error) {
    logOperationalEvent('error', 'monitor.api_probe_failed', { errorCode: errorCodeOf(error) });
    return 1;
  } finally {
    clearTimeout(timer);
  }
};

const loadSnapshot = async (): Promise<Omit<Snapshot, 'apiUnavailable' | 's3EvidenceMissing'> & { evidenceKeys: string[] }> => {
  const pool = await getPool();
  const expectedOrgaRecipients = getOrgaNotificationRecipients().length;
  const result = await pool.query(
    `
      with current_events as (
        select id from event where is_current = true
      )
      select
        (select count(*) from email_outbox o
          where o.status = 'failed' and o.updated_at >= now() - interval '10 minutes')::int as outbox_failed,
        (select count(*) from email_outbox o
          where o.status = 'queued' and o.send_after <= now() - interval '5 minutes')::int as outbox_overdue,
        (select count(*) from email_outbox o
          where o.status = 'sending' and o.updated_at <= now() - interval '5 minutes')::int as outbox_stuck_sending,
        (select count(*) from signing_session s
          where s.event_id in (select id from current_events)
            and s.status = 'completed'
            and (s.document_id is null or s.evidence_audit_s3_key is null or not exists (
              select 1 from document d where d.signing_session_id = s.id and d.status = 'generated'
            )))::int as signing_evidence_incomplete,
        (select count(*) from signing_session s
          where s.event_id in (select id from current_events)
            and s.status = 'completed'
            and s.signed_at >= now() - interval '24 hours'
            and not exists (
              select 1 from email_outbox o
              where o.template_id = 'waiver_signed'
                and o.template_data->>'signingSessionId' = s.id::text
            ))::int as signing_mail_queue_failed,
        (select count(*) from technical_inspection_decision d
          where d.event_id in (select id from current_events)
            and d.status in ('passed', 'failed')
            and d.created_at between now() - interval '10 minutes' and now() - interval '2 minutes'
            and (select count(*) from email_outbox o
              where o.template_id = 'technical_inspection_decision'
                and o.template_data->>'decisionId' = d.id::text
                and o.template_data->>'audience' = 'orga') < $1)::int as inspection_notification_missing,
        (select count(*) from registration_group g
          where g.event_id in (select id from current_events)
            and g.created_at between now() - interval '10 minutes' and now() - interval '2 minutes'
            and (select count(*) from email_outbox o
              where o.template_id = 'orga_registration_received'
                and o.template_data->>'groupId' = g.id::text
                and o.template_data->>'audience' = 'orga') < $1)::int as registration_notification_missing
    `,
    [expectedOrgaRecipients]
  );
  const evidence = await pool.query(
    `
      select distinct key
      from (
        select s.evidence_audit_s3_key as key
        from signing_session s
        where s.status = 'completed' and s.signed_at >= now() - interval '24 hours'
        union all
        select d.s3_key as key
        from document d
        where d.type = 'waiver_signed' and d.created_at >= now() - interval '24 hours'
      ) recent
      where key is not null
    `
  );
  const row = result.rows[0] ?? {};
  return {
    outboxFailed: toNumber(row.outbox_failed),
    outboxOverdue: toNumber(row.outbox_overdue),
    outboxStuckSending: toNumber(row.outbox_stuck_sending),
    signingEvidenceIncomplete: toNumber(row.signing_evidence_incomplete),
    signingMailQueueFailed: toNumber(row.signing_mail_queue_failed),
    inspectionNotificationMissing: toNumber(row.inspection_notification_missing),
    registrationNotificationMissing: toNumber(row.registration_notification_missing),
    evidenceKeys: evidence.rows.map((item) => String(item.key))
  };
};

const publishSnapshot = async (snapshot: Snapshot) => {
  const stage = process.env.STAGE ?? 'dev';
  const client = new CloudWatchClient({});
  await client.send(new PutMetricDataCommand({
    Namespace: `MSCEvent/${stage}`,
    MetricData: [
      { MetricName: 'MonitorHeartbeat', Value: 1, Unit: 'Count' },
      ...Object.entries(snapshot).map(([MetricName, Value]) => ({ MetricName, Value, Unit: 'Count' as const }))
    ]
  }));
};

export const handler = async () => {
  const apiUnavailable = await probeApi();
  const { evidenceKeys, ...databaseSnapshot } = await loadSnapshot();
  let s3EvidenceMissing = 0;
  for (let index = 0; index < evidenceKeys.length; index += 20) {
    const results = await Promise.all(evidenceKeys.slice(index, index + 20).map(doesDocumentObjectExist));
    s3EvidenceMissing += results.filter((exists) => !exists).length;
  }
  const snapshot: Snapshot = { apiUnavailable, ...databaseSnapshot, s3EvidenceMissing };
  await publishSnapshot(snapshot);
  const critical = Object.values(snapshot).some((value) => value > 0);
  logOperationalEvent(critical ? 'error' : 'info', 'monitor.snapshot', snapshot);
  return snapshot;
};
