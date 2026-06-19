import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, PoolClient } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { buildPricingSnapshot } from '../routes/adminFinance';

const TOOL_VERSION = 1;
const TEMPLATE_KEY = 'doublestarter_migration_notice';
const AUDIT_ACTION = 'doublestarter_registration_merged';

type Mode = 'detect' | 'notify' | 'migrate' | 'verify';

type CliOptions = {
  mode: Mode;
  eventId?: string;
  manifestPath: string;
  expectedCount?: number;
  actorUserId: string;
};

type CandidateRow = {
  event_id: string;
  event_name: string;
  entry_id: string;
  class_id: string;
  class_name: string;
  vehicle_id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  backup_vehicle_id: string | null;
  start_number_norm: string | null;
  driver_person_id: string;
  registration_group_id: string;
  driver_email_norm: string;
  person_email: string | null;
  first_name: string;
  last_name: string;
  birthdate: string;
  registration_status: string;
  acceptance_status: string;
  orga_code: string | null;
  entry_created_at: Date | string;
  group_created_at: Date | string;
  invoice_id: string | null;
  invoice_total_cents: number | string | null;
  invoice_paid_amount_cents: number | string | null;
  invoice_payment_status: string | null;
  invoice_pricing_snapshot: unknown;
  invoice_payment_count: number | string;
};

export type CandidateSnapshot = {
  eventId: string;
  eventName: string;
  identityKey: string;
  rows: CandidateRow[];
};

export type ManifestCandidate = {
  candidateKey: string;
  fingerprint: string;
  canonicalGroupId: string;
  secondaryGroupId: string;
  canonicalPersonId: string;
  secondaryPersonId: string;
  canonicalEntryId: string;
  secondaryEntryId: string;
};

type MigrationManifest = {
  toolVersion: number;
  generatedAt: string;
  eventId: string;
  eventName: string;
  activeGroupsBefore: number;
  activeEntriesBefore: number;
  candidates: ManifestCandidate[];
};

type DetectionResult = {
  automatic: CandidateSnapshot[];
  manualSameClass: CandidateSnapshot[];
};

type DbSecret = {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  dbname?: string;
};

const normalizeText = (value: string): string => value.trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
const asNumber = (value: unknown): number => Number(value ?? 0);
const iso = (value: Date | string): string => new Date(value).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const identityKeyForRow = (row: CandidateRow): string =>
  [row.event_id, normalizeText(row.first_name), normalizeText(row.last_name), row.birthdate].join('|');

const sortRows = (rows: CandidateRow[]): CandidateRow[] =>
  [...rows].sort((left, right) => {
    const timeDiff = new Date(left.entry_created_at).getTime() - new Date(right.entry_created_at).getTime();
    return timeDiff !== 0 ? timeDiff : left.entry_id.localeCompare(right.entry_id);
  });

export const fingerprintCandidate = (candidate: CandidateSnapshot): string =>
  sha256(
    stableStringify(
      sortRows(candidate.rows).map((row) => ({
        eventId: row.event_id,
        entryId: row.entry_id,
        classId: row.class_id,
        className: row.class_name,
        vehicleId: row.vehicle_id,
        vehicleMake: row.vehicle_make,
        vehicleModel: row.vehicle_model,
        backupVehicleId: row.backup_vehicle_id,
        startNumber: row.start_number_norm,
        personId: row.driver_person_id,
        groupId: row.registration_group_id,
        emailHash: sha256(normalizeText(row.driver_email_norm)),
        firstName: normalizeText(row.first_name),
        lastName: normalizeText(row.last_name),
        birthdate: row.birthdate,
        registrationStatus: row.registration_status,
        acceptanceStatus: row.acceptance_status,
        orgaCode: row.orga_code,
        entryCreatedAt: iso(row.entry_created_at),
        groupCreatedAt: iso(row.group_created_at),
        invoiceId: row.invoice_id,
        invoiceTotalCents: asNumber(row.invoice_total_cents),
        invoicePaidAmountCents: asNumber(row.invoice_paid_amount_cents),
        invoicePaymentStatus: row.invoice_payment_status,
        invoicePaymentCount: asNumber(row.invoice_payment_count)
      }))
    )
  );

export const classifyCandidates = (rows: CandidateRow[]): DetectionResult => {
  const grouped = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = identityKeyForRow(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const automatic: CandidateSnapshot[] = [];
  const manualSameClass: CandidateSnapshot[] = [];

  for (const [identityKey, clusterRows] of grouped) {
    const ordered = sortRows(clusterRows);
    const groups = new Set(ordered.map((row) => row.registration_group_id));
    const persons = new Set(ordered.map((row) => row.driver_person_id));
    const entries = new Set(ordered.map((row) => row.entry_id));
    const vehicles = new Set(ordered.map((row) => row.vehicle_id));
    const emails = new Set(ordered.map((row) => normalizeText(row.driver_email_norm)));
    const invoices = new Set(ordered.map((row) => row.invoice_id).filter((value): value is string => Boolean(value)));
    const safe =
      groups.size === 2 &&
      persons.size === 2 &&
      entries.size === 2 &&
      vehicles.size === 2 &&
      emails.size === 2 &&
      invoices.size === 2 &&
      Boolean(ordered[0].orga_code) &&
      ordered.every((row) => row.acceptance_status === 'pending') &&
      ordered.every((row) => row.registration_status === 'submitted_verified') &&
      ordered.every(
        (row) =>
          row.invoice_payment_status !== 'paid' &&
          asNumber(row.invoice_paid_amount_cents) === 0 &&
          asNumber(row.invoice_payment_count) === 0
      );
    if (!safe) {
      continue;
    }

    const snapshot = {
      eventId: ordered[0].event_id,
      eventName: ordered[0].event_name,
      identityKey,
      rows: ordered
    };
    if (new Set(ordered.map((row) => row.class_id)).size === 2) {
      automatic.push(snapshot);
    } else {
      manualSameClass.push(snapshot);
    }
  }

  return { automatic, manualSameClass };
};

export const toManifestCandidate = (candidate: CandidateSnapshot): ManifestCandidate => {
  const [canonical, secondary] = sortRows(candidate.rows);
  const candidateKey = sha256(
    [candidate.eventId, canonical.registration_group_id, secondary.registration_group_id].join(':')
  ).slice(0, 24);
  return {
    candidateKey,
    fingerprint: fingerprintCandidate(candidate),
    canonicalGroupId: canonical.registration_group_id,
    secondaryGroupId: secondary.registration_group_id,
    canonicalPersonId: canonical.driver_person_id,
    secondaryPersonId: secondary.driver_person_id,
    canonicalEntryId: canonical.entry_id,
    secondaryEntryId: secondary.entry_id
  };
};

const parseArgs = (argv: string[]): CliOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${current}`);
    }
    values.set(current.slice(2), next);
    index += 1;
  }

  const mode = values.get('mode') as Mode | undefined;
  if (!mode || !['detect', 'notify', 'migrate', 'verify'].includes(mode)) {
    throw new Error('Use --mode detect|notify|migrate|verify');
  }
  const expectedCountRaw = values.get('expected-count');
  const expectedCount = expectedCountRaw === undefined ? undefined : Number.parseInt(expectedCountRaw, 10);
  if (expectedCountRaw !== undefined && (!Number.isInteger(expectedCount) || (expectedCount ?? -1) < 0)) {
    throw new Error('--expected-count must be a non-negative integer');
  }
  if (mode === 'detect' && !values.get('event-id')) {
    throw new Error('--event-id is required for detect');
  }
  if (mode === 'detect' && expectedCount === undefined) {
    throw new Error('--expected-count is required for detect');
  }

  return {
    mode,
    eventId: values.get('event-id'),
    manifestPath: resolve(values.get('manifest') ?? 'doublestarter-manifest.json'),
    expectedCount,
    actorUserId: values.get('actor') ?? 'doublestarter-migration-tool'
  };
};

const loadSecret = async (secretArn: string): Promise<DbSecret> => {
  const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error('DB secret is empty');
  }
  return JSON.parse(response.SecretString) as DbSecret;
};

const createClient = async (): Promise<Client> => {
  const sslPath = process.env.DB_SSL_CA_PATH;
  const ssl = process.env.DB_SSL === 'false'
    ? undefined
    : {
        rejectUnauthorized: true,
        ca: sslPath ? await readFile(sslPath, 'utf8') : undefined
      };
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL, ssl });
  }
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error('Set DATABASE_URL or DB_SECRET_ARN');
  }
  const secret = await loadSecret(secretArn);
  if (!secret.host || !secret.username || !secret.password || !secret.dbname) {
    throw new Error('DB secret misses host, username, password, or dbname');
  }
  return new Client({
    host: secret.host,
    port: Number(secret.port ?? 5432),
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl
  });
};

const candidateRowsSql = `
  with duplicate_identities as (
    select
      e.event_id,
      lower(regexp_replace(trim(p.first_name), '\\s+', ' ', 'g')) as first_name_norm,
      lower(regexp_replace(trim(p.last_name), '\\s+', ' ', 'g')) as last_name_norm,
      p.birthdate
    from entry e
    inner join person p on p.id = e.driver_person_id
    where e.event_id = $1
      and e.deleted_at is null
      and e.registration_group_id is not null
      and p.birthdate is not null
    group by
      e.event_id,
      lower(regexp_replace(trim(p.first_name), '\\s+', ' ', 'g')),
      lower(regexp_replace(trim(p.last_name), '\\s+', ' ', 'g')),
      p.birthdate
    having count(distinct e.registration_group_id) > 1
  )
  select
    e.event_id,
    ev.name as event_name,
    e.id as entry_id,
    e.class_id,
    ec.name as class_name,
    e.vehicle_id,
    v.make as vehicle_make,
    v.model as vehicle_model,
    e.backup_vehicle_id,
    e.start_number_norm,
    e.driver_person_id,
    e.registration_group_id,
    rg.driver_email_norm,
    p.email as person_email,
    p.first_name,
    p.last_name,
    p.birthdate::text,
    e.registration_status,
    e.acceptance_status,
    e.orga_code,
    e.created_at as entry_created_at,
    rg.created_at as group_created_at,
    i.id as invoice_id,
    i.total_cents as invoice_total_cents,
    i.paid_amount_cents as invoice_paid_amount_cents,
    i.payment_status as invoice_payment_status,
    i.pricing_snapshot as invoice_pricing_snapshot,
    coalesce((select count(*) from invoice_payment ip where ip.invoice_id = i.id), 0)::int as invoice_payment_count
  from entry e
  inner join event ev on ev.id = e.event_id
  inner join "class" ec on ec.id = e.class_id
  inner join person p on p.id = e.driver_person_id
  inner join registration_group rg on rg.id = e.registration_group_id
  inner join vehicle v on v.id = e.vehicle_id
  inner join duplicate_identities d
    on d.event_id = e.event_id
    and d.first_name_norm = lower(regexp_replace(trim(p.first_name), '\\s+', ' ', 'g'))
    and d.last_name_norm = lower(regexp_replace(trim(p.last_name), '\\s+', ' ', 'g'))
    and d.birthdate = p.birthdate
  left join invoice i on i.event_id = e.event_id and i.driver_person_id = e.driver_person_id
  where e.event_id = $1 and e.deleted_at is null
  order by p.birthdate, lower(p.last_name), lower(p.first_name), e.created_at, e.id
`;

const loadCandidateRows = async (client: Client | PoolClient, eventId: string): Promise<CandidateRow[]> => {
  const result = await client.query<CandidateRow>(candidateRowsSql, [eventId]);
  return result.rows;
};

const loadEventCounts = async (client: Client | PoolClient, eventId: string) => {
  const result = await client.query<{ active_groups: string; active_entries: string }>(
    `select
       count(distinct registration_group_id)::text as active_groups,
       count(*)::text as active_entries
     from entry
     where event_id = $1 and deleted_at is null`,
    [eventId]
  );
  return {
    activeGroups: Number(result.rows[0]?.active_groups ?? 0),
    activeEntries: Number(result.rows[0]?.active_entries ?? 0)
  };
};

const loadManifest = async (path: string): Promise<MigrationManifest> => {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as MigrationManifest;
  if (parsed.toolVersion !== TOOL_VERSION || !parsed.eventId || !Array.isArray(parsed.candidates)) {
    throw new Error('Manifest is invalid or uses an unsupported tool version');
  }
  return parsed;
};

const resolveManifestSnapshot = async (
  client: Client | PoolClient,
  manifest: MigrationManifest,
  target: ManifestCandidate
): Promise<CandidateSnapshot> => {
  const rows = await loadCandidateRows(client, manifest.eventId);
  const matching = classifyCandidates(rows).automatic.find((candidate) => {
    const ids = new Set(candidate.rows.map((row) => row.entry_id));
    return ids.has(target.canonicalEntryId) && ids.has(target.secondaryEntryId);
  });
  if (!matching || fingerprintCandidate(matching) !== target.fingerprint) {
    throw new Error(`Candidate ${target.candidateKey} changed since detect`);
  }
  return matching;
};

const detect = async (client: Client, options: CliOptions) => {
  const eventId = options.eventId as string;
  const rows = await loadCandidateRows(client, eventId);
  const result = classifyCandidates(rows);
  if (result.automatic.length !== options.expectedCount) {
    throw new Error(
      `Expected ${options.expectedCount} automatic candidates, found ${result.automatic.length}; manifest was not written`
    );
  }
  const counts = await loadEventCounts(client, eventId);
  const eventName = result.automatic[0]?.eventName ?? result.manualSameClass[0]?.eventName;
  if (!eventName) {
    throw new Error('Event not found or no duplicate identity clusters found');
  }
  const manifest: MigrationManifest = {
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    eventId,
    eventName,
    activeGroupsBefore: counts.activeGroups,
    activeEntriesBefore: counts.activeEntries,
    candidates: result.automatic.map(toManifestCandidate)
  };
  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        mode: 'detect',
        eventId,
        eventName,
        automaticCandidates: result.automatic.length,
        manualSameClassCandidates: result.manualSameClass.length,
        activeGroups: counts.activeGroups,
        activeEntries: counts.activeEntries,
        manifest: options.manifestPath
      },
      null,
      2
    )
  );
};

const mailKey = (candidateKey: string, role: 'canonical' | 'secondary'): string =>
  `doublestarter-migration:${candidateKey}:${role}:v1`;

const formatEntrySummary = (row: CandidateRow): string =>
  [
    row.class_name,
    row.start_number_norm ? `Startnummer ${row.start_number_norm}` : null,
    [row.vehicle_make, row.vehicle_model].filter((value): value is string => Boolean(value?.trim())).join(' ') || null
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' · ');

const notify = async (client: Client, options: CliOptions) => {
  const manifest = await loadManifest(options.manifestPath);
  const templateResult = await client.query<{
    version: number;
    subject_template: string;
  }>(
    `select v.version, v.subject_template
     from email_template t
     inner join email_template_version v on v.template_id = t.id
     where t.template_key = $1 and t.is_active = true and v.status = 'published'
     order by v.version desc
     limit 1`,
    [TEMPLATE_KEY]
  );
  const template = templateResult.rows[0];
  if (!template) {
    throw new Error(`Published template ${TEMPLATE_KEY} not found; apply migrations first`);
  }

  let queued = 0;
  for (const target of manifest.candidates) {
    const snapshot = await resolveManifestSnapshot(client, manifest, target);
    const [canonical, secondary] = sortRows(snapshot.rows);
    const entrySummaries = [formatEntrySummary(canonical), formatEntrySummary(secondary)].filter((value) => value.length > 0);
    const recipients = [
      { role: 'canonical' as const, email: canonical.person_email ?? canonical.driver_email_norm },
      { role: 'secondary' as const, email: secondary.person_email ?? secondary.driver_email_norm }
    ];
    for (const recipient of recipients) {
      const result = await client.query(
        `insert into email_outbox (
           event_id, to_email, subject, template_id, template_version, template_data,
           status, send_after, idempotency_key, max_attempts, created_at, updated_at
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, 'queued', now(), $7, 5, now(), now())
         on conflict (idempotency_key) where idempotency_key is not null do nothing
         returning id`,
        [
          manifest.eventId,
          recipient.email,
          template.subject_template,
          TEMPLATE_KEY,
          template.version,
          JSON.stringify({
            eventName: manifest.eventName,
            driverName: `${canonical.first_name} ${canonical.last_name}`.trim(),
            locale: 'de',
            preheader: 'Information zur Zusammenführung deiner Nennungen',
            headerTitle: 'Nennungen werden zusammengeführt',
            entryCount: 2,
            entrySummaries,
            renderOptions: { showBadge: false, mailLabel: null, includeEntryContext: true },
            migrationCandidateKey: target.candidateKey
          }),
          mailKey(target.candidateKey, recipient.role)
        ]
      );
      queued += result.rowCount ?? 0;
    }
  }
  console.log(JSON.stringify({ mode: 'notify', candidates: manifest.candidates.length, newlyQueued: queued }, null, 2));
};

const assertMailGate = async (client: Client | PoolClient, target: ManifestCandidate) => {
  const keys = [mailKey(target.candidateKey, 'canonical'), mailKey(target.candidateKey, 'secondary')];
  const result = await client.query<{ idempotency_key: string; status: string }>(
    `select idempotency_key, status from email_outbox where idempotency_key = any($1::text[])`,
    [keys]
  );
  if (result.rows.length !== 2 || result.rows.some((row) => row.status === 'failed')) {
    throw new Error(`Candidate ${target.candidateKey} has not passed the two-mail queue gate`);
  }
};

const hasCompletedAudit = async (client: Client | PoolClient, eventId: string, candidateKey: string): Promise<boolean> => {
  const result = await client.query(
    `select 1 from audit_log
     where event_id = $1 and action = $2 and payload->>'candidateKey' = $3
     limit 1`,
    [eventId, AUDIT_ACTION, candidateKey]
  );
  return result.rowCount === 1;
};

const mergePricingOverrides = (rows: CandidateRow[]): Map<string, number> => {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const snapshot = row.invoice_pricing_snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      continue;
    }
    const overrides = (snapshot as { manualOverrides?: unknown }).manualOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      continue;
    }
    for (const [entryId, value] of Object.entries(overrides as Record<string, unknown>)) {
      const cents = Number(value);
      if (Number.isFinite(cents)) {
        merged.set(entryId, cents);
      }
    }
  }
  return merged;
};

const migrateCandidate = async (
  client: Client,
  manifest: MigrationManifest,
  target: ManifestCandidate,
  actorUserId: string
): Promise<'migrated' | 'already_migrated'> => {
  await client.query('begin');
  try {
    if (await hasCompletedAudit(client, manifest.eventId, target.candidateKey)) {
      await client.query('rollback');
      return 'already_migrated';
    }

    await client.query(
      `select id from entry where id = any($1::uuid[]) for update`,
      [[target.canonicalEntryId, target.secondaryEntryId]]
    );
    await client.query(
      `select id from registration_group where id = any($1::uuid[]) for update`,
      [[target.canonicalGroupId, target.secondaryGroupId]]
    );
    await assertMailGate(client, target);
    const snapshot = await resolveManifestSnapshot(client, manifest, target);
    const [canonical, secondary] = sortRows(snapshot.rows);
    const invoiceIds = snapshot.rows.map((row) => row.invoice_id).filter((value): value is string => Boolean(value));
    await client.query(`select id from invoice where id = any($1::uuid[]) for update`, [invoiceIds]);
    const paymentGuard = await client.query<{ payment_count: string; paid_invoice_count: string }>(
      `select
         (select count(*) from invoice_payment where invoice_id = any($1::uuid[]))::text as payment_count,
         (select count(*) from invoice
          where id = any($1::uuid[])
            and (payment_status = 'paid' or coalesce(paid_amount_cents, 0) > 0))::text as paid_invoice_count`,
      [invoiceIds]
    );
    if (
      invoiceIds.length !== 2 ||
      Number(paymentGuard.rows[0]?.payment_count ?? 0) !== 0 ||
      Number(paymentGuard.rows[0]?.paid_invoice_count ?? 0) !== 0
    ) {
      throw new Error(`Candidate ${target.candidateKey} acquired a payment and cannot be migrated`);
    }

    await client.query(
      `update vehicle
       set owner_person_id = $1, updated_at = now()
       where id = any($2::uuid[])`,
      [
        canonical.driver_person_id,
        [secondary.vehicle_id, secondary.backup_vehicle_id].filter((value): value is string => Boolean(value))
      ]
    );
    await client.query(
      `update entry
       set driver_person_id = $1,
           registration_group_id = $2,
           driver_email_norm = $3,
           orga_code = $4,
           updated_at = now()
       where id = $5`,
      [
        canonical.driver_person_id,
        canonical.registration_group_id,
        canonical.driver_email_norm,
        canonical.orga_code,
        secondary.entry_id
      ]
    );
    await client.query(
      `update registration_group
       set driver_person_id = $1, driver_email_norm = $2, updated_at = now()
       where id = $3`,
      [canonical.driver_person_id, canonical.driver_email_norm, canonical.registration_group_id]
    );
    await client.query(
      `update registration_group set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null`,
      [secondary.registration_group_id]
    );
    await client.query(
      `update public_entry_submission
       set response_payload = jsonb_set(response_payload, '{groupId}', to_jsonb($1::text), false),
           updated_at = now()
       where event_id = $2 and response_payload->>'groupId' = $3`,
      [canonical.registration_group_id, manifest.eventId, secondary.registration_group_id]
    );
    await client.query(
      `update vehicle_image_upload
       set consumed_by_registration_group_id = $1, updated_at = now()
       where consumed_by_registration_group_id = $2`,
      [canonical.registration_group_id, secondary.registration_group_id]
    );
    await client.query(
      `update document
       set driver_person_id = $1
       where event_id = $2 and (entry_id = $3 or driver_person_id = $4)`,
      [canonical.driver_person_id, manifest.eventId, secondary.entry_id, secondary.driver_person_id]
    );

    const pricingRuleResult = await client.query<{
      early_deadline: Date | string;
      late_fee_cents: number;
      second_vehicle_discount_cents: number;
    }>(
      `select early_deadline, late_fee_cents, second_vehicle_discount_cents
       from event_pricing_rule where event_id = $1`,
      [manifest.eventId]
    );
    const pricingRule = pricingRuleResult.rows[0];
    if (!pricingRule) {
      throw new Error('Pricing rules not found');
    }
    const classRuleResult = await client.query<{ class_id: string; base_fee_cents: number }>(
      `select class_id, base_fee_cents from class_pricing_rule where event_id = $1`,
      [manifest.eventId]
    );
    const pricingEntries = sortRows(snapshot.rows).map((row) => ({
      entryId: row.entry_id,
      eventId: row.event_id,
      driverPersonId: canonical.driver_person_id,
      classId: row.class_id,
      acceptanceStatus: row.acceptance_status,
      createdAt: new Date(row.entry_created_at)
    }));
    const pricing = buildPricingSnapshot(
      pricingEntries,
      new Map(classRuleResult.rows.map((row) => [row.class_id, asNumber(row.base_fee_cents)])),
      new Date(pricingRule.early_deadline),
      asNumber(pricingRule.late_fee_cents),
      asNumber(pricingRule.second_vehicle_discount_cents),
      new Map([[canonical.driver_person_id, mergePricingOverrides(snapshot.rows)]])
    )[0];
    if (!pricing) {
      throw new Error('Pricing calculation returned no result');
    }

    const canonicalInvoiceId = canonical.invoice_id;
    if (!canonicalInvoiceId || !secondary.invoice_id) {
      throw new Error('Both candidate invoices are required');
    }
    await client.query(`delete from invoice where id = $1`, [secondary.invoice_id]);
    await client.query(
      `update invoice
       set driver_person_id = $1,
           total_cents = $2,
           pricing_snapshot = $3::jsonb,
           payment_status = 'due',
           paid_at = null,
           paid_amount_cents = null,
           updated_at = now()
       where id = $4`,
      [canonical.driver_person_id, pricing.totalCents, JSON.stringify(pricing.snapshot), canonicalInvoiceId]
    );

    await client.query(
      `insert into audit_log (event_id, actor_user_id, action, entity_type, entity_id, payload, created_at)
       values ($1, $2, $3, 'registration_group', $4, $5::jsonb, now())`,
      [
        manifest.eventId,
        actorUserId,
        AUDIT_ACTION,
        canonical.registration_group_id,
        JSON.stringify({
          candidateKey: target.candidateKey,
          manifestFingerprint: target.fingerprint,
          canonicalGroupId: canonical.registration_group_id,
          secondaryGroupId: secondary.registration_group_id,
          canonicalPersonId: canonical.driver_person_id,
          secondaryPersonId: secondary.driver_person_id,
          entryIds: [canonical.entry_id, secondary.entry_id]
        })
      ]
    );
    await client.query('commit');
    return 'migrated';
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

const migrate = async (client: Client, options: CliOptions) => {
  const manifest = await loadManifest(options.manifestPath);
  let migrated = 0;
  let alreadyMigrated = 0;
  for (const target of manifest.candidates) {
    const result = await migrateCandidate(client, manifest, target, options.actorUserId);
    if (result === 'migrated') {
      migrated += 1;
    } else {
      alreadyMigrated += 1;
    }
  }
  console.log(JSON.stringify({ mode: 'migrate', migrated, alreadyMigrated }, null, 2));
};

const verify = async (client: Client, options: CliOptions) => {
  const manifest = await loadManifest(options.manifestPath);
  const failures: string[] = [];
  const discountResult = await client.query<{ second_vehicle_discount_cents: number }>(
    `select second_vehicle_discount_cents from event_pricing_rule where event_id = $1`,
    [manifest.eventId]
  );
  const expectedDiscount = asNumber(discountResult.rows[0]?.second_vehicle_discount_cents);

  for (const target of manifest.candidates) {
    const result = await client.query<{
      active_entries: string;
      person_count: string;
      group_count: string;
      orga_code_count: string;
      invoice_count: string;
      pricing_snapshot: unknown;
      secondary_group_deleted_at: Date | null;
    }>(
      `select
         count(distinct e.id)::text as active_entries,
         count(distinct e.driver_person_id)::text as person_count,
         count(distinct e.registration_group_id)::text as group_count,
         count(distinct e.orga_code)::text as orga_code_count,
         count(distinct i.id)::text as invoice_count,
         max(i.pricing_snapshot::text)::jsonb as pricing_snapshot,
         max(rg2.deleted_at) as secondary_group_deleted_at
       from entry e
       left join invoice i on i.event_id = e.event_id and i.driver_person_id = e.driver_person_id
       left join registration_group rg2 on rg2.id = $4
       where e.event_id = $1
         and e.id = any($2::uuid[])
         and e.deleted_at is null
         and e.registration_group_id = $3`,
      [
        manifest.eventId,
        [target.canonicalEntryId, target.secondaryEntryId],
        target.canonicalGroupId,
        target.secondaryGroupId
      ]
    );
    const row = result.rows[0];
    const snapshot =
      row?.pricing_snapshot && typeof row.pricing_snapshot === 'object' && !Array.isArray(row.pricing_snapshot)
        ? (row.pricing_snapshot as { forecastLines?: Array<{ secondVehicleDiscountCents?: unknown }> })
        : null;
    const discounts = snapshot?.forecastLines?.map((line) => asNumber(line.secondVehicleDiscountCents)) ?? [];
    if (
      Number(row?.active_entries ?? 0) !== 2 ||
      Number(row?.person_count ?? 0) !== 1 ||
      Number(row?.group_count ?? 0) !== 1 ||
      Number(row?.orga_code_count ?? 0) !== 1 ||
      Number(row?.invoice_count ?? 0) !== 1 ||
      !row?.secondary_group_deleted_at ||
      !discounts.includes(expectedDiscount) ||
      !(await hasCompletedAudit(client, manifest.eventId, target.candidateKey))
    ) {
      failures.push(target.candidateKey);
    }
  }

  const counts = await loadEventCounts(client, manifest.eventId);
  if (counts.activeEntries !== manifest.activeEntriesBefore) {
    failures.push('event-entry-count');
  }
  if (counts.activeGroups !== manifest.activeGroupsBefore - manifest.candidates.length) {
    failures.push('event-group-count');
  }
  if (failures.length > 0) {
    throw new Error(`Verification failed: ${failures.join(', ')}`);
  }
  console.log(
    JSON.stringify(
      {
        mode: 'verify',
        verifiedCandidates: manifest.candidates.length,
        activeGroups: counts.activeGroups,
        activeEntries: counts.activeEntries,
        secondVehicleDiscountCents: expectedDiscount
      },
      null,
      2
    )
  );
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const client = await createClient();
  await client.connect();
  try {
    if (options.mode === 'detect') {
      await detect(client, options);
    } else if (options.mode === 'notify') {
      await notify(client, options);
    } else if (options.mode === 'migrate') {
      await migrate(client, options);
    } else {
      await verify(client, options);
    }
  } finally {
    await client.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
