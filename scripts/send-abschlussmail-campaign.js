'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const campaign = require(path.resolve(__dirname, 'campaigns/2026-09-abschlussmail.i18n.json'));
const { renderMailContract } = require(path.resolve(__dirname, '../api/dist/mail/rendering.js'));
const { sendEmail } = require(path.resolve(__dirname, '../api/dist/mail/ses.js'));

const NEWSLETTER_URL = campaign.newsletter.signupUrl;
const INFO_RECIPIENT = 'info@msc-oberlausitzer-dreilaendereck.eu';
const SUPPORTED_LOCALES = new Set(['de', 'en', 'cs', 'pl']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAMPAIGN_ID = '2026-09-abschlussmail';
const ledgerPath = path.resolve(__dirname, 'campaigns/2026-09-abschlussmail.delivery-log.json');

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const recipientHash = (email) => crypto.createHash('sha256').update(email).digest('hex');

const normalizeLocale = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('cs') || normalized.startsWith('cz')) return 'cs';
  if (normalized.startsWith('pl')) return 'pl';
  return 'de';
};

const splitFreeFormContent = (value) => {
  const blocks = value.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length < 4) throw new Error('Campaign body has too few blocks.');
  const greetingText = blocks.shift();
  const closingText = blocks.splice(-2).join('\n\n');
  return { greetingText, contentText: blocks.join('\n\n'), closingText };
};

const renderLocale = (locale) => {
  const content = campaign.localizedContent[locale];
  if (!content) throw new Error(`Campaign content missing for locale ${locale}.`);
  const freeFormContent = splitFreeFormContent(content.bodyText);
  const rendered = renderMailContract({
    templateKey: 'free_form',
    subjectTemplate: content.subject,
    bodyTextTemplate: content.bodyText,
    bodyHtmlTemplate: null,
    data: {
      eventName: '12. Oberlausitzer Dreieck 2026',
      locale,
      preheader: content.preheader,
      heroSubtitle: content.heroSubtitle,
      eventDateText: content.eventDateText,
      ...freeFormContent,
      ctaText: content.ctaText,
      ctaUrl: NEWSLETTER_URL
    },
    renderOptions: { showBadge: false, mailLabel: null, includeEntryContext: false },
    hasContentOverride: false
  });
  if (rendered.missingPlaceholders.length || rendered.unknownPlaceholders.length) {
    throw new Error(`Invalid ${locale} rendering placeholders.`);
  }
  const ctaPosition = rendered.htmlDocument.indexOf('class="mail-cta"');
  const closingPosition = rendered.htmlDocument.indexOf(freeFormContent.closingText.split(/\r?\n/)[0]);
  if (
    ctaPosition < 0 ||
    closingPosition < 0 ||
    ctaPosition > closingPosition ||
    !rendered.htmlDocument.includes(`href="${NEWSLETTER_URL}"`) ||
    !rendered.htmlDocument.includes('background:#FACC15')
  ) {
    throw new Error(`Invalid ${locale} CTA rendering.`);
  }
  return rendered;
};

const loadCandidates = async () => {
  const secretResponse = await new SecretsManagerClient({ region: requiredEnv('AWS_REGION') }).send(
    new GetSecretValueCommand({ SecretId: requiredEnv('DB_SECRET_ARN') })
  );
  const secret = JSON.parse(secretResponse.SecretString);
  const db = new Client({
    host: requiredEnv('DB_HOST'),
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'eventdb',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(requiredEnv('DB_CA_PATH'), 'utf8') }
  });
  await db.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const result = await db.query(`
      with target_event as (
        select id
        from event
        where starts_at = date '2026-09-12'
          and ends_at = date '2026-09-13'
        order by is_current desc, created_at desc
        limit 1
      ), eligible_roles as (
        select distinct e.driver_person_id as person_id, 'driver'::text as participant_role
        from entry e
        join target_event te on te.id = e.event_id
        where e.acceptance_status = 'accepted'
          and e.deleted_at is null
          and exists (
            select 1 from document d
            where d.event_id = e.event_id
              and d.driver_person_id = e.driver_person_id
              and d.type = 'waiver_signed'
              and d.status = 'generated'
          )
        union
        select distinct e.codriver_person_id as person_id, 'regular_codriver'::text as participant_role
        from entry e
        join target_event te on te.id = e.event_id
        where e.acceptance_status = 'accepted'
          and e.deleted_at is null
          and e.codriver_person_id is not null
          and exists (
            select 1 from document d
            where d.event_id = e.event_id
              and d.driver_person_id = e.codriver_person_id
              and d.type = 'waiver_signed'
              and d.status = 'generated'
          )
      )
      select
        er.person_id,
        p.email,
        p.processing_restricted,
        p.objection_flag,
        array_agg(distinct er.participant_role order by er.participant_role) as participant_roles,
        coalesce((
          select ce.locale
          from consent_evidence ce
          join entry locale_entry on locale_entry.id = ce.entry_id
          join target_event te on te.id = locale_entry.event_id
          where ce.person_id = er.person_id
          order by ce.created_at desc
          limit 1
        ), (
          select ce.locale
          from consent_evidence ce
          join entry locale_entry on locale_entry.id = ce.entry_id
          join target_event te on te.id = locale_entry.event_id
          where locale_entry.driver_person_id = er.person_id
            and (ce.participant_role is null or ce.participant_role = 'driver')
          order by ce.created_at desc, locale_entry.created_at desc
          limit 1
        ), (
          select d.template_variant
          from document d
          join target_event te on te.id = d.event_id
          where d.driver_person_id = er.person_id
            and d.type = 'waiver_signed'
            and d.status = 'generated'
          order by d.created_at desc
          limit 1
        ), 'de') as locale
      from eligible_roles er
      join person p on p.id = er.person_id
      group by er.person_id, p.email, p.processing_restricted, p.objection_flag
      order by er.person_id
    `);
    const consentLocaleAudit = await db.query(`
      select ce.locale, coalesce(ce.participant_role, 'legacy') as participant_role, count(*)::int as evidence_count
      from consent_evidence ce
      join entry e on e.id = ce.entry_id
      join event ev on ev.id = e.event_id
      where ev.starts_at = date '2026-09-12' and ev.ends_at = date '2026-09-13'
      group by ce.locale, coalesce(ce.participant_role, 'legacy')
      order by ce.locale, participant_role
    `);
    const documentVariantAudit = await db.query(`
      select coalesce(d.template_variant, 'null') as template_variant, count(*)::int as document_count
      from document d
      join event ev on ev.id = d.event_id
      where ev.starts_at = date '2026-09-12'
        and ev.ends_at = date '2026-09-13'
        and d.type = 'waiver_signed'
        and d.status = 'generated'
      group by coalesce(d.template_variant, 'null')
      order by template_variant
    `);
    await db.query('rollback');
    return {
      rows: result.rows,
      localeAudit: {
        consentEvidence: consentLocaleAudit.rows,
        waiverDocuments: documentVariantAudit.rows
      }
    };
  } finally {
    await db.end();
  }
};

const prepareRecipients = (rows) => {
  const excluded = { restricted: 0, objection: 0, missingOrInvalidEmail: 0 };
  const byEmail = new Map();
  for (const row of rows) {
    if (row.processing_restricted) { excluded.restricted += 1; continue; }
    if (row.objection_flag) { excluded.objection += 1; continue; }
    const email = String(row.email || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) { excluded.missingOrInvalidEmail += 1; continue; }
    const locale = normalizeLocale(row.locale);
    const current = byEmail.get(email);
    if (!current) {
      byEmail.set(email, { email, locale, roles: new Set(row.participant_roles) });
      continue;
    }
    row.participant_roles.forEach((role) => current.roles.add(role));
    if (current.locale !== locale) current.locale = 'de';
  }
  const recipients = [...byEmail.values()]
    .map((item) => ({ ...item, roles: [...item.roles].sort() }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return { recipients, excluded, duplicateEmailCount: rows.length - Object.values(excluded).reduce((a, b) => a + b, 0) - recipients.length };
};

const fingerprintRecipients = (recipients) => crypto
  .createHash('sha256')
  .update(recipients.map((item) => `${item.email}|${item.locale}|${item.roles.join('+')}`).join('\n'))
  .digest('hex');

const auditSummary = (rows, prepared, fingerprint) => {
  const localeCounts = {};
  const roleCounts = { driver: 0, regular_codriver: 0, both: 0 };
  for (const recipient of prepared.recipients) {
    localeCounts[recipient.locale] = (localeCounts[recipient.locale] || 0) + 1;
    if (recipient.roles.length > 1) roleCounts.both += 1;
    else if (recipient.roles[0] === 'driver') roleCounts.driver += 1;
    else roleCounts.regular_codriver += 1;
  }
  return {
    campaignId: CAMPAIGN_ID,
    candidatePeople: rows.length,
    uniqueParticipantRecipients: prepared.recipients.length,
    additionalGermanRecipients: [INFO_RECIPIENT],
    totalMessages: prepared.recipients.length + 1,
    localeCounts,
    roleCounts,
    excluded: prepared.excluded,
    duplicateEmailCount: prepared.duplicateEmailCount,
    charityCodriversIncluded: 0,
    recipientFingerprint: fingerprint
  };
};

const loadLedger = (fingerprint) => {
  if (!fs.existsSync(ledgerPath)) return { campaignId: CAMPAIGN_ID, recipientFingerprint: fingerprint, deliveries: [] };
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (ledger.campaignId !== CAMPAIGN_ID || ledger.recipientFingerprint !== fingerprint) {
    throw new Error('Existing delivery ledger does not match this recipient selection.');
  }
  return ledger;
};

const saveLedger = (ledger) => {
  const temporaryPath = `${ledgerPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, ledgerPath);
};

const sendCampaign = async (recipients, fingerprint) => {
  const ledger = loadLedger(fingerprint);
  const completed = new Set(ledger.deliveries.map((item) => item.recipientHash));
  const deliveries = [
    ...recipients,
    { email: INFO_RECIPIENT, locale: 'de', roles: ['organization_copy'] }
  ];
  let sentThisRun = 0;
  let skipped = 0;
  for (const recipient of deliveries) {
    const hash = recipientHash(recipient.email);
    if (completed.has(hash)) { skipped += 1; continue; }
    const rendered = renderLocale(recipient.locale);
    const result = await sendEmail(
      recipient.email,
      rendered.subjectRendered,
      rendered.bodyTextRendered,
      rendered.htmlDocument
    );
    ledger.deliveries.push({
      recipientHash: hash,
      locale: recipient.locale,
      roles: recipient.roles,
      messageId: result.MessageId ?? null,
      sentAt: new Date().toISOString()
    });
    saveLedger(ledger);
    completed.add(hash);
    sentThisRun += 1;
    if (sentThisRun % 25 === 0) process.stdout.write(`Sent ${sentThisRun}/${deliveries.length - skipped}\n`);
  }
  return { sentThisRun, skipped, totalRecorded: ledger.deliveries.length, ledgerPath };
};

const main = async () => {
  if (process.env.AWS_PROFILE !== 'verein') throw new Error('AWS_PROFILE must be "verein".');
  if (!NEWSLETTER_URL) throw new Error('Newsletter URL is missing.');
  const loaded = await loadCandidates();
  const rows = loaded.rows;
  const prepared = prepareRecipients(rows);
  const fingerprint = fingerprintRecipients(prepared.recipients);
  const summary = auditSummary(rows, prepared, fingerprint);
  ['de', 'en', 'cs', 'pl'].forEach(renderLocale);

  if (process.argv.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify({ ...summary, localeAudit: loaded.localeAudit }, null, 2)}\n`);
    return;
  }
  if (!process.argv.includes('--send')) throw new Error('Use --dry-run or --send.');
  const fingerprintIndex = process.argv.indexOf('--expected-fingerprint');
  const expectedFingerprint = fingerprintIndex >= 0 ? process.argv[fingerprintIndex + 1] : '';
  if (expectedFingerprint !== fingerprint) throw new Error('Recipient fingerprint confirmation does not match.');
  const result = await sendCampaign(prepared.recipients, fingerprint);
  process.stdout.write(`${JSON.stringify({ ...summary, ...result }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
