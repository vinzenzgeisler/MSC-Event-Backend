import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { queueLifecycleMail } from './adminMail';
import { emailOutbox, entry, event, eventClass, exportJob, geoLocationCache, invoice, person, vehicle } from '../db/schema';

const dashboardSummaryQuerySchema = z.object({
  eventId: z.string().uuid()
});

const dashboardDriverLocationsQuerySchema = dashboardSummaryQuerySchema.extend({
  refresh: z.enum(['1', 'true']).optional(),
  refreshLimit: z.coerce.number().int().min(1).max(20).optional()
});

const dashboardWarningsQuerySchema = z.object({
  eventId: z.string().uuid().optional(),
  sampleLimit: z.coerce.number().int().min(1).max(25).optional()
});
const dashboardOverviewQuerySchema = z.object({
  eventId: z.string().uuid(),
  sampleLimit: z.coerce.number().int().min(1).max(25).optional()
});

const dashboardQueueMissingAcceptanceMailsSchema = z.object({
  eventId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  dryRun: z.boolean().optional().default(false)
});

const RECENT_ENTRIES_LIMIT = 10;
const DRIVER_LOCATION_GEOCODE_DEFAULT_LIMIT = 10;
const DRIVER_LOCATION_AUTO_GEOCODE_DEFAULT_LIMIT = 10;
const GEOCODE_REQUEST_DELAY_MS = 1100;

type DriverLocationQuery = z.infer<typeof dashboardDriverLocationsQuerySchema>;
type DashboardWarningsQuery = z.infer<typeof dashboardWarningsQuerySchema>;
type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;
type DashboardQueueMissingAcceptanceMailsInput = z.infer<typeof dashboardQueueMissingAcceptanceMailsSchema>;

type DashboardWarningSeverity = 'ok' | 'warning' | 'critical';

type DashboardWarningCheck = {
  code: string;
  severity: DashboardWarningSeverity;
  title: string;
  description: string;
  count: number;
  status: 'ok' | 'active';
  actionHint: string | null;
  samples: Array<Record<string, unknown>>;
};

const DEFAULT_WARNING_SAMPLE_LIMIT = 10;

const toNumber = (value: unknown): number => Number(value ?? 0) || 0;

const severityRank: Record<DashboardWarningSeverity, number> = {
  ok: 0,
  warning: 1,
  critical: 2
};

const maxSeverity = (checks: DashboardWarningCheck[]): DashboardWarningSeverity =>
  checks.reduce<DashboardWarningSeverity>(
    (current, check) => (severityRank[check.severity] > severityRank[current] ? check.severity : current),
    'ok'
  );

const normalizeRows = (rows: unknown): Array<Record<string, unknown>> =>
  Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];

const withScope = (eventId: string | undefined) =>
  eventId ? sql`and e.event_id = ${eventId}` : sql``;

const withOutboxScope = (eventId: string | undefined) =>
  eventId ? sql`and o.event_id = ${eventId}` : sql``;

const buildWarningCheck = (input: {
  code: string;
  severityWhenActive: Exclude<DashboardWarningSeverity, 'ok'>;
  title: string;
  description: string;
  count: number;
  actionHint: string | null;
  samples: Array<Record<string, unknown>>;
}): DashboardWarningCheck => ({
  code: input.code,
  severity: input.count > 0 ? input.severityWhenActive : 'ok',
  title: input.title,
  description: input.description,
  count: input.count,
  status: input.count > 0 ? 'active' : 'ok',
  actionHint: input.count > 0 ? input.actionHint : null,
  samples: input.count > 0 ? input.samples : []
});

export const getDashboardWarnings = async (query: DashboardWarningsQuery) => {
  const db = await getDb();
  const sampleLimit = query.sampleLimit ?? DEFAULT_WARNING_SAMPLE_LIMIT;

  if (query.eventId) {
    const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, query.eventId)).limit(1);
    if (eventRows.length === 0) {
      throw new Error('EVENT_NOT_FOUND');
    }
  }

  const [
    acceptedWithoutMailRows,
    acceptedWithoutMailSamples,
    acceptanceMailWithoutPdfRows,
    acceptanceMailWithoutPdfSamples,
    failedOutboxRows,
    failedOutboxSamples,
    staleQueuedRows,
    staleQueuedSamples,
    stuckSendingRows,
    stuckSendingSamples,
    sentWithoutDeliveryRows,
    sentWithoutDeliverySamples,
    recentDeliveryFailureRows,
    recentDeliveryFailureSamples
  ] = await Promise.all([
    db.execute(sql`
      select count(*)::int as count
      from entry e
      where e.deleted_at is null
        and e.acceptance_status = 'accepted'
        ${withScope(query.eventId)}
        and not exists (
          select 1
          from email_outbox o
          where o.event_id = e.event_id
            and o.template_id = 'accepted_open_payment'
            and o.template_data->>'entryId' = e.id::text
        )
    `),
    db.execute(sql`
      select ev.name as "eventName",
             e.id::text as "entryId",
             to_char(e.updated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "updatedAtBerlin",
             e.start_number_norm as "startNumber",
             c.name as "className",
             trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as "driverName",
             left(coalesce(p.email, ''), 2) || '***@' || split_part(coalesce(p.email, ''), '@', 2) as "emailMasked"
      from entry e
      join event ev on ev.id = e.event_id
      join class c on c.id = e.class_id
      join person p on p.id = e.driver_person_id
      where e.deleted_at is null
        and e.acceptance_status = 'accepted'
        ${withScope(query.eventId)}
        and not exists (
          select 1
          from email_outbox o
          where o.event_id = e.event_id
            and o.template_id = 'accepted_open_payment'
            and o.template_data->>'entryId' = e.id::text
        )
      order by e.updated_at desc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from entry e
      join email_outbox o
        on o.event_id = e.event_id
       and o.template_id = 'accepted_open_payment'
       and o.template_data->>'entryId' = e.id::text
      where e.deleted_at is null
        and e.acceptance_status = 'accepted'
        ${withScope(query.eventId)}
        and not exists (
          select 1
          from email_outbox_attachment att
          where att.outbox_id = o.id
            and att.source = 'document'
            and att.content_type = 'application/pdf'
        )
    `),
    db.execute(sql`
      select ev.name as "eventName",
             e.id::text as "entryId",
             o.id::text as "outboxId",
             to_char(o.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "outboxCreatedAtBerlin",
             e.start_number_norm as "startNumber",
             c.name as "className"
      from entry e
      join event ev on ev.id = e.event_id
      join class c on c.id = e.class_id
      join email_outbox o
        on o.event_id = e.event_id
       and o.template_id = 'accepted_open_payment'
       and o.template_data->>'entryId' = e.id::text
      where e.deleted_at is null
        and e.acceptance_status = 'accepted'
        ${withScope(query.eventId)}
        and not exists (
          select 1
          from email_outbox_attachment att
          where att.outbox_id = o.id
            and att.source = 'document'
            and att.content_type = 'application/pdf'
        )
      order by o.created_at desc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from email_outbox o
      where o.status = 'failed'
        ${withOutboxScope(query.eventId)}
    `),
    db.execute(sql`
      select o.id::text as "outboxId",
             ev.name as "eventName",
             o.template_id as "templateId",
             left(coalesce(o.to_email, ''), 2) || '***@' || split_part(coalesce(o.to_email, ''), '@', 2) as "emailMasked",
             o.error_last as "errorLast",
             o.attempt_count as "attemptCount",
             to_char(o.updated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "updatedAtBerlin"
      from email_outbox o
      left join event ev on ev.id = o.event_id
      where o.status = 'failed'
        ${withOutboxScope(query.eventId)}
      order by o.updated_at desc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from email_outbox o
      where o.status = 'queued'
        and o.send_after <= now() - interval '15 minutes'
        ${withOutboxScope(query.eventId)}
    `),
    db.execute(sql`
      select o.id::text as "outboxId",
             ev.name as "eventName",
             o.template_id as "templateId",
             to_char(o.send_after at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "sendAfterBerlin",
             to_char(o.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "createdAtBerlin"
      from email_outbox o
      left join event ev on ev.id = o.event_id
      where o.status = 'queued'
        and o.send_after <= now() - interval '15 minutes'
        ${withOutboxScope(query.eventId)}
      order by o.send_after asc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from email_outbox o
      where o.status = 'sending'
        and o.updated_at <= now() - interval '15 minutes'
        ${withOutboxScope(query.eventId)}
    `),
    db.execute(sql`
      select o.id::text as "outboxId",
             ev.name as "eventName",
             o.template_id as "templateId",
             o.attempt_count as "attemptCount",
             to_char(o.updated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "updatedAtBerlin"
      from email_outbox o
      left join event ev on ev.id = o.event_id
      where o.status = 'sending'
        and o.updated_at <= now() - interval '15 minutes'
        ${withOutboxScope(query.eventId)}
      order by o.updated_at asc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from email_outbox o
      where o.status = 'sent'
        ${withOutboxScope(query.eventId)}
        and not exists (
          select 1
          from email_delivery d
          where d.outbox_id = o.id
            and d.status = 'sent'
        )
    `),
    db.execute(sql`
      select o.id::text as "outboxId",
             ev.name as "eventName",
             o.template_id as "templateId",
             to_char(o.updated_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "updatedAtBerlin"
      from email_outbox o
      left join event ev on ev.id = o.event_id
      where o.status = 'sent'
        ${withOutboxScope(query.eventId)}
        and not exists (
          select 1
          from email_delivery d
          where d.outbox_id = o.id
            and d.status = 'sent'
        )
      order by o.updated_at desc
      limit ${sampleLimit}
    `),
    db.execute(sql`
      select count(*)::int as count
      from email_delivery d
      join email_outbox o on o.id = d.outbox_id
      where d.status = 'failed'
        and d.sent_at >= now() - interval '24 hours'
        ${withOutboxScope(query.eventId)}
    `),
    db.execute(sql`
      select d.outbox_id::text as "outboxId",
             ev.name as "eventName",
             o.template_id as "templateId",
             d.provider_response as "providerResponse",
             to_char(d.sent_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as "failedAtBerlin"
      from email_delivery d
      join email_outbox o on o.id = d.outbox_id
      left join event ev on ev.id = o.event_id
      where d.status = 'failed'
        and d.sent_at >= now() - interval '24 hours'
        ${withOutboxScope(query.eventId)}
      order by d.sent_at desc
      limit ${sampleLimit}
    `)
  ]);

  const checks: DashboardWarningCheck[] = [
    buildWarningCheck({
      code: 'accepted_entry_without_acceptance_mail',
      severityWhenActive: 'critical',
      title: 'Zugelassene Nennungen ohne Zulassungsmail',
      description: 'Aktive zugelassene Nennungen muessen genau ueber eine accepted_open_payment-Outbox-Mail nachvollziehbar sein.',
      count: toNumber(acceptedWithoutMailRows.rows[0]?.count),
      actionHint: 'Betroffene Nennungen ueber den Lifecycle-Prozess accepted_open_payment nachqueueen und danach Delivery pruefen.',
      samples: normalizeRows(acceptedWithoutMailSamples.rows)
    }),
    buildWarningCheck({
      code: 'acceptance_mail_without_pdf_attachment',
      severityWhenActive: 'critical',
      title: 'Zulassungsmails ohne PDF-Anhang',
      description: 'accepted_open_payment-Mails muessen eine generierte Nennbestaetigung als PDF-Anhang enthalten.',
      count: toNumber(acceptanceMailWithoutPdfRows.rows[0]?.count),
      actionHint: 'Outbox-Eintrag pruefen und Mail mit korrekt generierter Nennbestaetigung neu erzeugen.',
      samples: normalizeRows(acceptanceMailWithoutPdfSamples.rows)
    }),
    buildWarningCheck({
      code: 'failed_outbox_mail',
      severityWhenActive: 'critical',
      title: 'Fehlgeschlagene Outbox-Mails',
      description: 'Outbox-Mails mit Status failed werden nicht mehr automatisch zugestellt.',
      count: toNumber(failedOutboxRows.rows[0]?.count),
      actionHint: 'Fehlerursache pruefen und passende Outbox-Mails ueber Retry erneut einplanen.',
      samples: normalizeRows(failedOutboxSamples.rows)
    }),
    buildWarningCheck({
      code: 'stale_queued_outbox_mail',
      severityWhenActive: 'warning',
      title: 'Queue-Stau bei E-Mails',
      description: 'Queued-Outbox-Mails mit faelligem sendAfter sollten zeitnah vom Mail-Worker verarbeitet werden.',
      count: toNumber(staleQueuedRows.rows[0]?.count),
      actionHint: 'Mail-Worker/Scheduler pruefen und bei Bedarf Worker manuell starten.',
      samples: normalizeRows(staleQueuedSamples.rows)
    }),
    buildWarningCheck({
      code: 'stuck_sending_outbox_mail',
      severityWhenActive: 'critical',
      title: 'Mails haengen im Sending-Status',
      description: 'Sending-Outbox-Mails, die laenger als 15 Minuten unveraendert sind, deuten auf einen abgebrochenen Worker-Lauf hin.',
      count: toNumber(stuckSendingRows.rows[0]?.count),
      actionHint: 'Outbox-Eintraege und Worker-Logs pruefen; Status korrigieren oder erneut einplanen.',
      samples: normalizeRows(stuckSendingSamples.rows)
    }),
    buildWarningCheck({
      code: 'sent_outbox_without_delivery',
      severityWhenActive: 'warning',
      title: 'Gesendete Mails ohne Delivery-Nachweis',
      description: 'Sent-Outbox-Mails sollten einen email_delivery-Nachweis mit Status sent besitzen.',
      count: toNumber(sentWithoutDeliveryRows.rows[0]?.count),
      actionHint: 'Delivery-Audit pruefen; bei fehlendem Nachweis Provider-/Worker-Antwort kontrollieren.',
      samples: normalizeRows(sentWithoutDeliverySamples.rows)
    }),
    buildWarningCheck({
      code: 'recent_delivery_failure',
      severityWhenActive: 'warning',
      title: 'Neue Zustellfehler in den letzten 24 Stunden',
      description: 'Aktuelle Delivery-Fehler koennen trotz Retry Hinweise auf Empfaenger- oder Providerprobleme geben.',
      count: toNumber(recentDeliveryFailureRows.rows[0]?.count),
      actionHint: 'Provider-Response auswerten und bei Bedarf betroffene Empfaenger kontaktieren oder Retry beobachten.',
      samples: normalizeRows(recentDeliveryFailureSamples.rows)
    })
  ];

  const activeChecks = checks.filter((check) => check.status === 'active');
  return {
    checkedAt: new Date().toISOString(),
    scope: {
      eventId: query.eventId ?? null
    },
    summary: {
      severity: maxSeverity(checks),
      activeCheckTotal: activeChecks.length,
      criticalTotal: activeChecks.filter((check) => check.severity === 'critical').length,
      warningTotal: activeChecks.filter((check) => check.severity === 'warning').length,
      issueTotal: activeChecks.reduce((sum, check) => sum + check.count, 0)
    },
    checks
  };
};
const toAgeYears = (birthdate: Date | string | null, referenceDate: Date): number | null => {
  if (!birthdate) {
    return null;
  }
  const date = birthdate instanceof Date ? birthdate : new Date(birthdate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  let age = referenceDate.getUTCFullYear() - date.getUTCFullYear();
  const m = referenceDate.getUTCMonth() - date.getUTCMonth();
  if (m < 0 || (m === 0 && referenceDate.getUTCDate() < date.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
};

const normalizeLocationPart = (value: string | null | undefined): string => {
  return (value ?? '').trim().replace(/\s+/g, ' ');
};

const normalizeLocationKeyPart = (value: string | null | undefined): string => {
  return normalizeLocationPart(value).toLowerCase();
};

const buildLocationKey = (input: { country?: string | null; zip?: string | null; city?: string | null }): string => {
  return [input.country, input.zip, input.city].map(normalizeLocationKeyPart).join('|');
};

const hasUsableLocation = (input: { country?: string | null; zip?: string | null; city?: string | null }): boolean => {
  return Boolean(normalizeLocationPart(input.country) || normalizeLocationPart(input.zip) || normalizeLocationPart(input.city));
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const vehicleLabelFromParts = (row: { vehicleMake: string | null; vehicleModel: string | null; vehicleYear: number | null }): string => {
  const label = [row.vehicleMake, row.vehicleModel].filter(Boolean).join(' ').trim();
  if (label) {
    return row.vehicleYear ? `${label} (${row.vehicleYear})` : label;
  }
  return 'Fahrzeug';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getDashboardSummary = async (eventId: string) => {
  const db = await getDb();

  const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (eventRows.length === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const [
    entriesTotalRows,
    paymentSummaryRows,
    checkinPendingTotalRows,
    mailFailedTotalRows,
    mailQueuedTotalRows,
    exportsQueuedTotalRows,
    exportsProcessingTotalRows,
    classDistribution,
    recentEntryRows,
    driverAgeRows
  ] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`, eq(entry.acceptanceStatus, 'accepted'))),
    db
      .select({
        eligibleTotal: sql<number>`count(${entry.id})::int`,
        paidTotal: sql<number>`count(${entry.id}) filter (where ${invoice.paymentStatus} = 'paid')::int`,
        dueTotal: sql<number>`count(${entry.id}) filter (where ${invoice.id} is null or ${invoice.paymentStatus} != 'paid')::int`
      })
      .from(entry)
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`, eq(entry.acceptanceStatus, 'accepted'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(
        and(
          eq(entry.eventId, eventId),
          sql`${entry.deletedAt} is null`,
          eq(entry.acceptanceStatus, 'accepted'),
          eq(entry.checkinIdVerified, false)
        )
      ),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'failed'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'processing'))),
    db
      .select({
        classId: eventClass.id,
        className: eventClass.name,
        count: sql<number>`count(${entry.id})::int`
      })
      .from(eventClass)
      .leftJoin(
        entry,
        and(
          eq(entry.classId, eventClass.id),
          eq(entry.eventId, eventId),
          sql`${entry.deletedAt} is null`,
          eq(entry.acceptanceStatus, 'accepted')
        )
      )
      .where(eq(eventClass.eventId, eventId))
      .groupBy(eventClass.id, eventClass.name)
      .orderBy(asc(eventClass.name)),
    db
      .select({
        entryId: entry.id,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        createdAt: entry.createdAt
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
      .orderBy(desc(entry.createdAt))
      .limit(RECENT_ENTRIES_LIMIT),
    db
      .select({
        driverPersonId: entry.driverPersonId,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        birthdate: person.birthdate
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
  ]);

  const activityResult = await db.execute(sql`
    with days as (
      select generate_series(
        (timezone('Europe/Berlin', now())::date - interval '6 days'),
        timezone('Europe/Berlin', now())::date,
        interval '1 day'
      )::date as day
    )
    select
      to_char(days.day, 'YYYY-MM-DD') as day,
      count(e.id)::int as count
    from days
    left join ${entry} e
      on e.event_id = ${eventId}
      and e.deleted_at is null
      and (timezone('Europe/Berlin', e.created_at))::date = days.day
    group by days.day
    order by days.day
  `);
  const dailyActivity = activityResult.rows.map((row) => ({
    day: String(row.day),
    count: Number(row.count) || 0
  }));
  const entriesLast7DaysTotal = dailyActivity.reduce((sum, item) => sum + item.count, 0);

  const now = new Date();
  const ageRowsByDriver = new Map<string, { age: number; driverLabel: string; className: string }>();
  driverAgeRows.forEach((row) => {
    if (ageRowsByDriver.has(row.driverPersonId)) {
      return;
    }
    const age = toAgeYears(row.birthdate, now);
    if (age === null) {
      return;
    }
    ageRowsByDriver.set(row.driverPersonId, {
      age,
      driverLabel: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className
    });
  });
  const ageRows = Array.from(ageRowsByDriver.values());

  const sortedAgeRows = [...ageRows].sort((a, b) => a.age - b.age);
  const youngestDriverAge = sortedAgeRows.length > 0 ? sortedAgeRows[0].age : null;
  const youngestRow = sortedAgeRows.length > 0 ? sortedAgeRows[0] : null;
  const oldestRow = sortedAgeRows.length > 0 ? sortedAgeRows[sortedAgeRows.length - 1] : null;
  const youngestDriverLabel = youngestRow ? `${youngestRow.driverLabel} (${youngestRow.className})` : '';
  const oldestDriverAge = oldestRow ? oldestRow.age : null;
  const oldestDriverLabel = oldestRow ? `${oldestRow.driverLabel} (${oldestRow.className})` : '';

  let medianDriverAge: number | null = null;
  if (sortedAgeRows.length > 0) {
    const mid = Math.floor(sortedAgeRows.length / 2);
    if (sortedAgeRows.length % 2 === 1) {
      medianDriverAge = sortedAgeRows[mid].age;
    } else {
      medianDriverAge = (sortedAgeRows[mid - 1].age + sortedAgeRows[mid].age) / 2;
    }
  }

  return {
    summary: {
      entriesTotal: entriesTotalRows[0]?.value ?? 0,
      paymentsDueTotal: paymentSummaryRows[0]?.dueTotal ?? 0,
      paymentsPaidTotal: paymentSummaryRows[0]?.paidTotal ?? 0,
      paymentRelevantTotal: paymentSummaryRows[0]?.eligibleTotal ?? 0,
      entriesLast7DaysTotal,
      checkinPendingTotal: checkinPendingTotalRows[0]?.value ?? 0,
      mailFailedTotal: mailFailedTotalRows[0]?.value ?? 0,
      mailQueuedTotal: mailQueuedTotalRows[0]?.value ?? 0,
      exportsQueuedTotal: exportsQueuedTotalRows[0]?.value ?? 0,
      exportsProcessingTotal: exportsProcessingTotalRows[0]?.value ?? 0,
      driverAgeStats: {
        oldestDriverAge,
        oldestDriverLabel,
        youngestDriverAge,
        youngestDriverLabel,
        medianDriverAge
      }
    },
    classDistribution,
    recentEntries: recentEntryRows.map((row) => ({
      entryId: row.entryId,
      driverName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className,
      createdAt: row.createdAt
    })),
    dailyActivity
  };
};

export const getDashboardOverview = async (query: DashboardOverviewQuery) => {
  const db = await getDb();
  const sampleLimit = query.sampleLimit ?? DEFAULT_WARNING_SAMPLE_LIMIT;

  const eventRows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      isCurrent: event.isCurrent,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt
    })
    .from(event)
    .where(eq(event.id, query.eventId))
    .limit(1);
  const currentEvent = eventRows[0];
  if (!currentEvent) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const [summaryResult, eventWarnings, globalWarnings] = await Promise.all([
    getDashboardSummary(query.eventId),
    getDashboardWarnings({ eventId: query.eventId, sampleLimit }),
    getDashboardWarnings({ sampleLimit })
  ]);

  const [registrationRows, financeRows, mailRows, templateRows, driverRows, countryRows, cityRows, vehicleRows, brandRows, classRows, operationRows, documentRows, documentTypeRows, activity30Rows, mapRows] =
    await Promise.all([
      db.execute(sql`
        select
          count(*) filter (where e.deleted_at is null)::int as "activeTotal",
          count(*) filter (where e.deleted_at is not null)::int as "deletedTotal",
          count(*) filter (where e.deleted_at is null and e.acceptance_status = 'pending')::int as "pendingTotal",
          count(*) filter (where e.deleted_at is null and e.acceptance_status = 'shortlist')::int as "shortlistTotal",
          count(*) filter (where e.deleted_at is null and e.acceptance_status = 'accepted')::int as "acceptedTotal",
          count(*) filter (where e.deleted_at is null and e.acceptance_status = 'rejected')::int as "rejectedTotal",
          count(*) filter (where e.deleted_at is null and e.acceptance_status = 'withdrawn')::int as "withdrawnTotal",
          count(*) filter (where e.deleted_at is null and e.registration_status = 'submitted_verified')::int as "verifiedTotal",
          count(*) filter (where e.deleted_at is null and e.registration_status = 'submitted_unverified')::int as "unverifiedTotal",
          count(distinct e.driver_person_id) filter (where e.deleted_at is null)::int as "driverTotal",
          count(*) filter (where e.deleted_at is null and (timezone('Europe/Berlin', e.created_at))::date = timezone('Europe/Berlin', now())::date)::int as "newTodayTotal",
          count(*) filter (where e.deleted_at is null and e.created_at >= now() - interval '7 days')::int as "new7DaysTotal",
          count(*) filter (where e.deleted_at is null and e.created_at >= now() - interval '30 days')::int as "new30DaysTotal"
        from entry e
        where e.event_id = ${query.eventId}
      `),
      db.execute(sql`
        select
          count(*)::int as "invoiceTotal",
          count(*) filter (where i.payment_status = 'paid')::int as "paidInvoiceTotal",
          count(*) filter (where i.payment_status = 'due')::int as "dueInvoiceTotal",
          coalesce(sum(i.total_cents), 0)::int as "expectedCents",
          coalesce(sum(coalesce(i.paid_amount_cents, 0)), 0)::int as "paidCents",
          coalesce(sum(greatest(i.total_cents - coalesce(i.paid_amount_cents, 0), 0)), 0)::int as "openCents",
          count(*) filter (where i.total_cents = 0)::int as "zeroEuroInvoiceTotal"
        from invoice i
        where i.event_id = ${query.eventId}
          and exists (
            select 1
            from entry e
            where e.event_id = i.event_id
              and e.driver_person_id = i.driver_person_id
              and e.deleted_at is null
              and e.acceptance_status = 'accepted'
          )
      `),
      db.execute(sql`
        select
          count(*)::int as "total",
          count(*) filter (where o.status = 'queued')::int as "queuedTotal",
          count(*) filter (where o.status = 'sending')::int as "sendingTotal",
          count(*) filter (where o.status = 'sent')::int as "sentTotal",
          count(*) filter (where o.status = 'failed')::int as "failedTotal",
          count(*) filter (where o.created_at >= now() - interval '24 hours')::int as "created24hTotal",
          count(*) filter (where o.updated_at >= now() - interval '24 hours' and o.status = 'sent')::int as "sent24hTotal"
        from email_outbox o
        where o.event_id = ${query.eventId}
      `),
      db.execute(sql`
        select o.template_id as "templateId", count(*)::int as count
        from email_outbox o
        where o.event_id = ${query.eventId}
        group by o.template_id
        order by count(*) desc, o.template_id asc
        limit 10
      `),
      db.execute(sql`
        with drivers as (
          select distinct on (p.id) p.id, p.country, p.city, p.birthdate, p.email
          from entry e
          join person p on p.id = e.driver_person_id
          where e.event_id = ${query.eventId} and e.deleted_at is null
          order by p.id, e.created_at desc
        ), ages as (
          select *, extract(year from age(now(), birthdate::timestamp))::int as age_years
          from drivers
          where birthdate is not null
        )
        select
          (select count(*)::int from drivers) as "driverTotal",
          (select count(*)::int from drivers where coalesce(trim(country), '') = '') as "missingCountryTotal",
          (select count(*)::int from drivers where coalesce(trim(city), '') = '') as "missingCityTotal",
          (select count(*)::int from drivers where coalesce(trim(email), '') = '') as "missingEmailTotal",
          (select count(*)::int from drivers where upper(coalesce(trim(country), '')) not in ('', 'DE', 'DEUTSCHLAND', 'GERMANY')) as "internationalTotal",
          count(*) filter (where age_years < 18)::int as "under18Total",
          count(*) filter (where age_years between 18 and 29)::int as "age18To29Total",
          count(*) filter (where age_years between 30 and 49)::int as "age30To49Total",
          count(*) filter (where age_years >= 50)::int as "age50PlusTotal",
          percentile_cont(0.5) within group (order by age_years)::numeric(10,1) as "medianAge"
        from ages
      `),
      db.execute(sql`
        select coalesce(nullif(trim(p.country), ''), 'Unbekannt') as country, count(distinct p.id)::int as count
        from entry e
        join person p on p.id = e.driver_person_id
        where e.event_id = ${query.eventId} and e.deleted_at is null
        group by coalesce(nullif(trim(p.country), ''), 'Unbekannt')
        order by count(distinct p.id) desc, country asc
        limit 12
      `),
      db.execute(sql`
        select coalesce(nullif(trim(p.city), ''), 'Unbekannt') as city, count(distinct p.id)::int as count
        from entry e
        join person p on p.id = e.driver_person_id
        where e.event_id = ${query.eventId} and e.deleted_at is null
        group by coalesce(nullif(trim(p.city), ''), 'Unbekannt')
        order by count(distinct p.id) desc, city asc
        limit 12
      `),
      db.execute(sql`
        select
          count(*)::int as "entryVehicleTotal",
          count(*) filter (where v.vehicle_type = 'auto')::int as "autoTotal",
          count(*) filter (where v.vehicle_type = 'moto')::int as "motoTotal",
          count(*) filter (where coalesce(trim(v.image_s3_key), '') = '')::int as "missingImageTotal",
          count(*) filter (where v.year is null)::int as "missingYearTotal",
          min(v.year)::int as "oldestYear",
          max(v.year)::int as "newestYear"
        from entry e
        join vehicle v on v.id = e.vehicle_id
        where e.event_id = ${query.eventId} and e.deleted_at is null
      `),
      db.execute(sql`
        select coalesce(nullif(trim(coalesce(v.brand, v.make)), ''), 'Unbekannt') as brand, count(*)::int as count
        from entry e
        join vehicle v on v.id = e.vehicle_id
        where e.event_id = ${query.eventId} and e.deleted_at is null
        group by coalesce(nullif(trim(coalesce(v.brand, v.make)), ''), 'Unbekannt')
        order by count(*) desc, brand asc
        limit 12
      `),
      db.execute(sql`
        select c.id::text as "classId", c.name as "className", c.vehicle_type as "vehicleType", count(e.id)::int as count,
               count(e.id) filter (where e.acceptance_status = 'accepted')::int as "acceptedTotal"
        from class c
        left join entry e on e.class_id = c.id and e.event_id = c.event_id and e.deleted_at is null
        where c.event_id = ${query.eventId}
        group by c.id, c.name, c.vehicle_type
        order by count(e.id) desc, c.name asc
      `),
      db.execute(sql`
        select
          count(*) filter (where e.checkin_id_verified = true and e.deleted_at is null)::int as "checkinCompletedTotal",
          count(*) filter (where e.checkin_id_verified = false and e.deleted_at is null)::int as "checkinPendingTotal",
          count(*) filter (where e.tech_status = 'pending' and e.deleted_at is null)::int as "techPendingTotal",
          count(*) filter (where e.tech_status = 'passed' and e.deleted_at is null)::int as "techPassedTotal",
          count(*) filter (where e.tech_status = 'failed' and e.deleted_at is null)::int as "techFailedTotal",
          (select count(*)::int from export_job x where x.event_id = ${query.eventId} and x.status = 'queued') as "exportsQueuedTotal",
          (select count(*)::int from export_job x where x.event_id = ${query.eventId} and x.status = 'processing') as "exportsProcessingTotal",
          (select count(*)::int from export_job x where x.event_id = ${query.eventId} and x.status = 'failed') as "exportsFailedTotal",
          (select count(*)::int from signing_session s where s.event_id = ${query.eventId} and s.status in ('pending', 'displayed')) as "signingOpenTotal",
          (select count(*)::int from signing_session s where s.event_id = ${query.eventId} and s.status = 'completed') as "signingCompletedTotal"
        from entry e
        where e.event_id = ${query.eventId}
      `),
      db.execute(sql`
        select
          count(*)::int as "documentTotal",
          count(*) filter (where d.status = 'generated')::int as "generatedTotal",
          count(*) filter (where d.status = 'failed')::int as "failedTotal",
          (select count(*)::int from document_generation_job j join document jd on jd.id = j.document_id where jd.event_id = ${query.eventId} and j.status = 'queued') as "jobsQueuedTotal",
          (select count(*)::int from document_generation_job j join document jd on jd.id = j.document_id where jd.event_id = ${query.eventId} and j.status = 'processing') as "jobsProcessingTotal",
          (select count(*)::int from document_generation_job j join document jd on jd.id = j.document_id where jd.event_id = ${query.eventId} and j.status = 'failed') as "jobsFailedTotal"
        from document d
        where d.event_id = ${query.eventId}
      `),
      db.execute(sql`
        select d.type, count(*)::int as count
        from document d
        where d.event_id = ${query.eventId}
        group by d.type
        order by count(*) desc, d.type asc
      `),
      db.execute(sql`
        with days as (
          select generate_series(
            (timezone('Europe/Berlin', now())::date - interval '29 days'),
            timezone('Europe/Berlin', now())::date,
            interval '1 day'
          )::date as day
        )
        select to_char(days.day, 'YYYY-MM-DD') as day, count(e.id)::int as count
        from days
        left join entry e on e.event_id = ${query.eventId}
          and e.deleted_at is null
          and (timezone('Europe/Berlin', e.created_at))::date = days.day
        group by days.day
        order by days.day
      `),
      db.execute(sql`
        with locations as (
          select distinct
            lower(trim(coalesce(p.country, ''))) || '|' || lower(trim(coalesce(p.zip, ''))) || '|' || lower(trim(coalesce(p.city, ''))) as location_key,
            p.id as driver_id,
            coalesce(trim(p.country), '') as country,
            coalesce(trim(p.zip), '') as zip,
            coalesce(trim(p.city), '') as city
          from entry e
          join person p on p.id = e.driver_person_id
          where e.event_id = ${query.eventId} and e.deleted_at is null
        )
        select
          count(distinct l.driver_id)::int as "driverTotal",
          count(distinct l.location_key) filter (where l.country <> '' or l.zip <> '' or l.city <> '')::int as "locationTotal",
          count(distinct l.driver_id) filter (where l.country = '' and l.zip = '' and l.city = '')::int as "missingAddressDriverTotal",
          count(distinct l.location_key) filter (where (l.country <> '' or l.zip <> '' or l.city <> '') and g.status = 'resolved')::int as "resolvedLocationTotal",
          count(distinct l.location_key) filter (where (l.country <> '' or l.zip <> '' or l.city <> '') and (g.location_key is null or g.status <> 'resolved'))::int as "pendingLocationTotal"
        from locations l
        left join geo_location_cache g on g.location_key = l.location_key
      `)
    ]);

  const registration = normalizeRows(registrationRows.rows)[0] ?? {};
  const finance = normalizeRows(financeRows.rows)[0] ?? {};
  const communication = normalizeRows(mailRows.rows)[0] ?? {};
  const drivers = normalizeRows(driverRows.rows)[0] ?? {};
  const vehicles = normalizeRows(vehicleRows.rows)[0] ?? {};
  const operations = normalizeRows(operationRows.rows)[0] ?? {};
  const documents = normalizeRows(documentRows.rows)[0] ?? {};
  const map = normalizeRows(mapRows.rows)[0] ?? {};
  const eventActiveWarnings = eventWarnings.checks.filter((check) => check.status === 'active');
  const globalCriticalWarnings = globalWarnings.checks.filter((check) => check.status === 'active' && check.severity === 'critical');
  const expectedCents = toNumber(finance.expectedCents);
  const paidCents = toNumber(finance.paidCents);
  const activeTotal = toNumber(registration.activeTotal);
  const acceptedTotal = toNumber(registration.acceptedTotal);
  const verifiedTotal = toNumber(registration.verifiedTotal);
  const generatedAt = new Date().toISOString();

  return {
    generatedAt,
    event: {
      id: currentEvent.id,
      name: currentEvent.name,
      startsAt: currentEvent.startsAt,
      endsAt: currentEvent.endsAt,
      status: currentEvent.status,
      isCurrent: currentEvent.isCurrent,
      registrationOpenAt: currentEvent.registrationOpenAt,
      registrationCloseAt: currentEvent.registrationCloseAt
    },
    health: {
      severity: globalWarnings.summary.severity === 'critical' ? 'critical' : eventWarnings.summary.severity,
      globalCriticalTotal: globalCriticalWarnings.length,
      eventWarningTotal: eventActiveWarnings.length,
      issueTotal: globalWarnings.summary.issueTotal + eventWarnings.summary.issueTotal,
      checkedAt: globalWarnings.checkedAt
    },
    kpis: {
      entriesTotal: activeTotal,
      acceptedTotal,
      paymentsDueTotal: summaryResult.summary.paymentsDueTotal,
      paymentsPaidTotal: summaryResult.summary.paymentsPaidTotal,
      mailFailedTotal: summaryResult.summary.mailFailedTotal,
      checkinPendingTotal: summaryResult.summary.checkinPendingTotal,
      newTodayTotal: toNumber(registration.newTodayTotal),
      new7DaysTotal: toNumber(registration.new7DaysTotal)
    },
    warnings: {
      global: globalWarnings,
      event: eventWarnings
    },
    registrations: {
      ...registration,
      acceptanceRatePercent: activeTotal > 0 ? Math.round((acceptedTotal / activeTotal) * 100) : 0,
      verificationRatePercent: activeTotal > 0 ? Math.round((verifiedTotal / activeTotal) * 100) : 0
    },
    finance: {
      ...finance,
      paymentCompletionPercent: expectedCents > 0 ? Math.round((paidCents / expectedCents) * 100) : 100
    },
    communication: {
      ...communication,
      templates: normalizeRows(templateRows.rows)
    },
    drivers: {
      ...drivers,
      countries: normalizeRows(countryRows.rows),
      cities: normalizeRows(cityRows.rows)
    },
    vehicles: {
      ...vehicles,
      brands: normalizeRows(brandRows.rows)
    },
    classes: normalizeRows(classRows.rows),
    operations,
    documents: {
      ...documents,
      byType: normalizeRows(documentTypeRows.rows)
    },
    activity: {
      last7Days: summaryResult.dailyActivity,
      last30Days: normalizeRows(activity30Rows.rows)
    },
    distributions: {
      classes: summaryResult.classDistribution,
      countries: normalizeRows(countryRows.rows),
      vehicleBrands: normalizeRows(brandRows.rows),
      mailTemplates: normalizeRows(templateRows.rows)
    },
    map: {
      ...map,
      hasPendingGeocoding: toNumber(map.pendingLocationTotal) > 0
    },
    niceToKnow: {
      recentEntries: summaryResult.recentEntries,
      driverAgeStats: summaryResult.summary.driverAgeStats
    }
  };
};
export const queueMissingAcceptanceMailsFromDashboard = async (input: DashboardQueueMissingAcceptanceMailsInput, actorUserId: string | null) => {
  const db = await getDb();
  const limit = input.limit ?? 500;

  if (input.eventId) {
    const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, input.eventId)).limit(1);
    if (eventRows.length === 0) {
      throw new Error('EVENT_NOT_FOUND');
    }
  }

  const candidateRows = await db.execute(sql`
    select e.event_id::text as "eventId", e.id::text as "entryId"
    from entry e
    where e.deleted_at is null
      and e.acceptance_status = 'accepted'
      ${withScope(input.eventId)}
      and not exists (
        select 1
        from email_outbox o
        where o.event_id = e.event_id
          and o.template_id = 'accepted_open_payment'
          and o.template_data->>'entryId' = e.id::text
      )
    order by e.updated_at asc
    limit ${limit}
  `);
  const candidates = normalizeRows(candidateRows.rows)
    .map((row) => ({ eventId: String(row.eventId ?? ''), entryId: String(row.entryId ?? '') }))
    .filter((row) => row.eventId && row.entryId);

  if (input.dryRun) {
    return {
      dryRun: true,
      affected: candidates.length,
      queued: 0,
      skipped: 0,
      errors: [] as Array<Record<string, unknown>>
    };
  }

  let queued = 0;
  let skipped = 0;
  const errors: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    try {
      const result = await queueLifecycleMail(
        {
          eventId: candidate.eventId,
          entryId: candidate.entryId,
          eventType: 'accepted_open_payment',
          includeDriverNote: false,
          allowDuplicate: false
        },
        actorUserId
      );
      queued += Number(result.queued ?? 0) || 0;
      skipped += Number(result.skipped ?? 0) || 0;
    } catch (error) {
      skipped += 1;
      errors.push({
        eventId: candidate.eventId,
        entryId: candidate.entryId,
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
      });
    }
  }

  return {
    dryRun: false,
    affected: candidates.length,
    queued,
    skipped,
    errors
  };
};
export const getDashboardDriverLocations = async (query: DriverLocationQuery) => {
  const db = await getDb();
  const { eventId } = query;
  const explicitRefresh = Boolean(query.refresh);
  const shouldRefresh = true;
  const refreshLimit = query.refreshLimit ?? (explicitRefresh ? DRIVER_LOCATION_GEOCODE_DEFAULT_LIMIT : DRIVER_LOCATION_AUTO_GEOCODE_DEFAULT_LIMIT);
  let geocodeAttemptedTotal = 0;
  let geocodeResolvedTotal = 0;

  const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (eventRows.length === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const rows = await db
    .select({
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      country: person.country,
      zip: person.zip,
      city: person.city,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      acceptanceStatus: entry.acceptanceStatus,
      registrationStatus: entry.registrationStatus,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      createdAt: entry.createdAt
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
    .orderBy(desc(entry.createdAt));

  const groups = new Map<
    string,
    {
      locationKey: string;
      country: string;
      zip: string;
      city: string;
      entryCount: number;
      drivers: Map<
        string,
        {
          entryId: string;
          driverName: string;
          className: string;
          startNumber: string;
          vehicleLabel: string;
          acceptanceStatus: string;
          registrationStatus: string;
        }
      >;
    }
  >();
  const allDriverIds = new Set<string>();
  const missingDriverIds = new Set<string>();

  for (const row of rows) {
    allDriverIds.add(row.driverPersonId);

    if (!hasUsableLocation(row)) {
      missingDriverIds.add(row.driverPersonId);
      continue;
    }

    const locationKey = buildLocationKey(row);
    const existing =
      groups.get(locationKey) ??
      {
        locationKey,
        country: normalizeLocationPart(row.country),
        zip: normalizeLocationPart(row.zip),
        city: normalizeLocationPart(row.city),
        entryCount: 0,
        drivers: new Map()
      };

    existing.entryCount += 1;
    if (!existing.drivers.has(row.driverPersonId)) {
      existing.drivers.set(row.driverPersonId, {
        entryId: row.entryId,
        driverName: `${row.driverFirstName} ${row.driverLastName}`.trim() || 'Fahrer',
        className: row.className,
        startNumber: row.startNumber ?? '-',
        vehicleLabel: vehicleLabelFromParts(row),
        acceptanceStatus: row.acceptanceStatus,
        registrationStatus: row.registrationStatus
      });
    }
    groups.set(locationKey, existing);
  }

  const locationKeys = Array.from(groups.keys());
  const cacheRows =
    locationKeys.length > 0
      ? await db
          .select({
            locationKey: geoLocationCache.locationKey,
            lat: geoLocationCache.lat,
            lng: geoLocationCache.lng,
            status: geoLocationCache.status
          })
          .from(geoLocationCache)
          .where(inArray(geoLocationCache.locationKey, locationKeys))
      : [];
  const cacheByKey = new Map(cacheRows.map((row) => [row.locationKey, row]));

  if (shouldRefresh) {
    const candidates = Array.from(groups.values())
      .filter((group) => {
        const cached = cacheByKey.get(group.locationKey);
        const lat = cached?.status === 'resolved' ? toFiniteNumber(cached.lat) : null;
        const lng = cached?.status === 'resolved' ? toFiniteNumber(cached.lng) : null;
        return lat === null || lng === null;
      })
      .sort((left, right) => right.drivers.size - left.drivers.size)
      .slice(0, refreshLimit);

    geocodeAttemptedTotal = candidates.length;

    for (const [index, group] of candidates.entries()) {
      if (index > 0) {
        await sleep(GEOCODE_REQUEST_DELAY_MS);
      }
      const resolved = await geocodeLocation(group);
      if (!resolved) {
        continue;
      }

      const cacheValue = {
        locationKey: group.locationKey,
        country: group.country,
        zip: group.zip,
        city: group.city,
        lat: String(resolved.lat),
        lng: String(resolved.lng),
        source: 'nominatim',
        status: 'resolved',
        updatedAt: new Date()
      };

      await db
        .insert(geoLocationCache)
        .values(cacheValue)
        .onConflictDoUpdate({
          target: geoLocationCache.locationKey,
          set: {
            country: cacheValue.country,
            zip: cacheValue.zip,
            city: cacheValue.city,
            lat: cacheValue.lat,
            lng: cacheValue.lng,
            source: cacheValue.source,
            status: cacheValue.status,
            updatedAt: cacheValue.updatedAt
          }
        });
      cacheByKey.set(group.locationKey, cacheValue);
      geocodeResolvedTotal += 1;
    }
  }

  let missingLocationsTotal = 0;
  const locations = Array.from(groups.values())
    .map((group) => {
      const cached = cacheByKey.get(group.locationKey);
      const lat = cached?.status === 'resolved' ? toFiniteNumber(cached.lat) : null;
      const lng = cached?.status === 'resolved' ? toFiniteNumber(cached.lng) : null;
      const driverCount = group.drivers.size;

      if (lat === null || lng === null) {
        missingLocationsTotal += 1;
        group.drivers.forEach((_, driverPersonId) => missingDriverIds.add(driverPersonId));
        return null;
      }

      return {
        locationKey: group.locationKey,
        country: group.country,
        zip: group.zip,
        city: group.city,
        lat,
        lng,
        driverCount,
        entryCount: group.entryCount,
        drivers: Array.from(group.drivers.values()).map((driver) => ({
          entryId: driver.entryId,
          driverName: driver.driverName,
          className: driver.className,
          startNumber: driver.startNumber,
          vehicleLabel: driver.vehicleLabel,
          acceptanceStatus: driver.acceptanceStatus,
          registrationStatus: driver.registrationStatus
        }))
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.driverCount - left.driverCount);

  return {
    locations,
    totalLocations: groups.size,
    totalDrivers: allDriverIds.size,
    missingLocationsTotal,
    missingEntriesTotal: missingDriverIds.size,
    pendingGeocodeTotal: missingLocationsTotal,
    geocodeAttemptedTotal,
    geocodeResolvedTotal,
    autoRefreshTriggered: !explicitRefresh && geocodeAttemptedTotal > 0,
    hasPendingGeocoding: missingLocationsTotal > 0,
    maxPoints: locations.length
  };
};

const normalizeGeocodeCountry = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  const labels: Record<string, string> = {
    DE: 'Deutschland',
    D: 'Deutschland',
    GER: 'Deutschland',
    CZ: 'Czechia',
    CZE: 'Czechia',
    PL: 'Poland',
    POL: 'Poland',
    AT: 'Austria',
    AUT: 'Austria'
  };
  return labels[normalized] ?? value.trim();
};

const buildGeocodeQuery = (location: { country: string; zip: string; city: string }): string => {
  const country = normalizeGeocodeCountry(location.country || 'Deutschland');
  return [location.zip, location.city, country].filter(Boolean).join(', ');
};

const geocodeLocation = async (location: { country: string; zip: string; city: string }): Promise<{ lat: number; lng: number } | null> => {
  const query = buildGeocodeQuery(location);
  if (!query) {
    return null;
  }

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', query);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'msc-event-dashboard/1.0 (event.msc-oberlausitz.de)'
      }
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first || typeof first !== 'object') {
    return null;
  }

  const lat = toFiniteNumber((first as { lat?: unknown }).lat);
  const lng = toFiniteNumber((first as { lon?: unknown }).lon);
  return lat !== null && lng !== null ? { lat, lng } : null;
};

export const validateDashboardOverviewQuery = (query: Record<string, string | undefined>) =>
  dashboardOverviewQuerySchema.parse({
    eventId: query.eventId,
    sampleLimit: query.sampleLimit
  });

export const validateDashboardSummaryQuery = (query: Record<string, string | undefined>) =>
  dashboardSummaryQuerySchema.parse({
    eventId: query.eventId
  });

export const validateDashboardDriverLocationsQuery = (query: Record<string, string | undefined>) =>
  dashboardDriverLocationsQuerySchema.parse({
    eventId: query.eventId,
    refresh: query.refresh,
    refreshLimit: query.refreshLimit
  });

export const validateDashboardWarningsQuery = (query: Record<string, string | undefined>) =>
  dashboardWarningsQuerySchema.parse({
    eventId: query.eventId,
    sampleLimit: query.sampleLimit
  });

export const validateDashboardQueueMissingAcceptanceMailsInput = (payload: unknown) =>
  dashboardQueueMissingAcceptanceMailsSchema.parse(payload);
