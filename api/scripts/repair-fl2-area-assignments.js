/**
 * repair-fl2-area-assignments.js
 *
 * Findet alle Personen in marshal_person, die für das aktuelle Event
 * KEINE marshal_area_assignment für das Bereich "Aufbau Fahrerlager 2"
 * (setup_fl2) haben, und legt diese Zuweisungen nach.
 *
 * Typisches Szenario: Helfer wurden über "Stammdaten" angelegt,
 * aber ohne direkte Event-Zuweisung.
 *
 * Usage:
 *   node repair-fl2-area-assignments.js \
 *     --secret-arn arn:aws:secretsmanager:eu-central-1:ACCOUNT:secret:... \
 *     [--event-id <uuid>]          # Standard: aktuelles (isCurrent=true) Event
 *     [--created-on YYYY-MM-DD]    # Nur Personen angelegt am diesem Tag (UTC)
 *     [--created-since YYYY-MM-DD] # Nur Personen angelegt seit diesem Tag
 *     [--region eu-central-1]
 *     [--apply]                    # Ohne: Dry-Run
 *     [--expected-count N]         # Pflicht mit --apply: Absicherung
 */

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// ── Argumente ────────────────────────────────────────────────────────────────
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(key, next); i += 1; }
  else args.set(key, true);
}

const secretArn   = args.get('--secret-arn');
const region      = args.get('--region') ?? 'eu-central-1';
const eventId     = args.get('--event-id') ?? null;
const createdOn   = args.get('--created-on') ?? null;
const createdSince = args.get('--created-since') ?? null;
const apply       = args.has('--apply');
const expectedCount = args.has('--expected-count') ? Number(args.get('--expected-count')) : null;

if (!secretArn) {
  console.error('Fehler: --secret-arn <arn> ist erforderlich');
  console.error('Optional: --event-id <uuid> --created-on YYYY-MM-DD --created-since YYYY-MM-DD --region eu-central-1 --apply --expected-count N');
  process.exitCode = 1;
  process.exit();
}
if (apply && expectedCount === null) {
  console.error('Fehler: --expected-count N ist bei --apply erforderlich');
  process.exitCode = 1;
  process.exit();
}
if (createdOn && !/^\d{4}-\d{2}-\d{2}$/.test(createdOn)) {
  console.error('Fehler: --created-on muss YYYY-MM-DD sein');
  process.exitCode = 1;
  process.exit();
}
if (createdSince && !/^\d{4}-\d{2}-\d{2}$/.test(createdSince)) {
  console.error('Fehler: --created-since muss YYYY-MM-DD sein');
  process.exitCode = 1;
  process.exit();
}

// ── RDS CA ───────────────────────────────────────────────────────────────────
const caPath = '/tmp/rds-global-bundle.pem';
const caUrl  = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

const downloadFile = (url, destination) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(destination);
  https.get(url, (response) => {
    if (response.statusCode !== 200) {
      file.close();
      fs.unlink(destination, () => undefined);
      reject(new Error(`CA download failed with HTTP ${response.statusCode}`));
      return;
    }
    response.pipe(file);
    file.on('finish', () => file.close(resolve));
  }).on('error', reject);
});

// ── Main ─────────────────────────────────────────────────────────────────────
const main = async () => {
  if (!fs.existsSync(caPath)) {
    process.stdout.write('Lade RDS-CA-Bundle… ');
    await downloadFile(caUrl, caPath);
    console.log('OK');
  }

  const secrets = new SecretsManagerClient({ region });
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const secret = JSON.parse(response.SecretString ?? '{}');

  const client = new Client({
    host: secret.host,
    port: Number(secret.port ?? 5432),
    user: secret.username,
    password: secret.password,
    database: secret.dbname ?? secret.database,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') }
  });

  await client.connect();

  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE${apply ? '' : ' READ ONLY'}`);

    // ── 1. Event bestimmen ────────────────────────────────────────────────
    let resolvedEventId = eventId;
    if (!resolvedEventId) {
      const evResult = await client.query(`
        SELECT id, name, starts_at
        FROM event
        WHERE is_current = true
        ORDER BY starts_at DESC
        LIMIT 1
      `);
      if (evResult.rowCount === 0) throw new Error('Kein aktuelles Event (is_current=true) gefunden');
      resolvedEventId = evResult.rows[0].id;
      console.log(`Event: "${evResult.rows[0].name}" (${evResult.rows[0].starts_at?.toISOString?.() ?? evResult.rows[0].starts_at})`);
      console.log(`Event-ID: ${resolvedEventId}`);
    } else {
      const evResult = await client.query('SELECT id, name FROM event WHERE id = $1', [resolvedEventId]);
      if (evResult.rowCount === 0) throw new Error(`Event ${resolvedEventId} nicht gefunden`);
      console.log(`Event: "${evResult.rows[0].name}" (${resolvedEventId})`);
    }

    // ── 2. FL2-Area ID für dieses Event ──────────────────────────────────
    const areaResult = await client.query(`
      SELECT id, code, name
      FROM marshal_helper_area
      WHERE event_id = $1 AND code = 'setup_fl2'
    `, [resolvedEventId]);

    let fl2AreaId;
    if (areaResult.rowCount === 0) {
      // Area noch nicht angelegt — ensureMarshalEventStructure wurde nicht aufgerufen
      // Im Apply-Modus anlegen
      if (apply) {
        console.log('setup_fl2-Bereich fehlt — lege an…');
        const insertArea = await client.query(`
          INSERT INTO marshal_helper_area (event_id, code, name, area_type, sort_order)
          VALUES ($1, 'setup_fl2', 'Aufbau Fahrerlager 2', 'setup', 1)
          ON CONFLICT (event_id, code) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [resolvedEventId]);
        fl2AreaId = insertArea.rows[0].id;
        console.log(`FL2-Bereich angelegt: ${fl2AreaId}`);
      } else {
        console.log('⚠ WARNUNG: setup_fl2-Bereich existiert noch nicht im System.');
        console.log('  Er wird beim Apply-Lauf automatisch angelegt.');
        fl2AreaId = '(wird beim Apply angelegt)';
      }
    } else {
      fl2AreaId = areaResult.rows[0].id;
      console.log(`FL2-Bereich: "${areaResult.rows[0].name}" (${fl2AreaId})`);
    }

    // ── 3. Personen ohne FL2-Zuweisung für dieses Event finden ───────────
    const dateConditions = [];
    const dateParams = [resolvedEventId];

    if (createdOn) {
      dateParams.push(createdOn);
      dateConditions.push(`p.created_at::date = $${dateParams.length}::date`);
    }
    if (createdSince) {
      dateParams.push(createdSince);
      dateConditions.push(`p.created_at::date >= $${dateParams.length}::date`);
    }

    const whereClause = dateConditions.length > 0
      ? `AND (${dateConditions.join(' AND ')})`
      : '';

    const peopleResult = await client.query(`
      SELECT
        p.id,
        p.helper_number,
        p.first_name,
        p.last_name,
        p.shirt_size,
        p.activity_areas,
        p.created_at::date AS created_date,
        ep.id AS participation_id
      FROM marshal_person p
      -- hat KEINE FL2-Zuweisung für dieses Event
      WHERE NOT EXISTS (
        SELECT 1
        FROM marshal_event_participation ep2
        JOIN marshal_area_assignment aa ON aa.participation_id = ep2.id
        JOIN marshal_helper_area ha ON ha.id = aa.area_id
        WHERE ep2.person_id = p.id
          AND ep2.event_id = $1
          AND ha.code = 'setup_fl2'
      )
      ${whereClause}
      -- Vorhandene Participation für dieses Event (falls vorhanden, für Upsert)
      LEFT JOIN marshal_event_participation ep
        ON ep.person_id = p.id AND ep.event_id = $1
      ORDER BY p.created_at DESC, p.last_name, p.first_name
    `, dateParams);

    console.log('');
    console.log(`Personen ohne FL2-Zuweisung: ${peopleResult.rowCount}`);

    if (peopleResult.rowCount === 0) {
      console.log('✓ Alle Personen haben bereits eine FL2-Zuweisung. Nichts zu tun.');
      await client.query('ROLLBACK');
      return;
    }

    // Übersicht nach Anlagedatum gruppieren
    const byDate = new Map();
    for (const row of peopleResult.rows) {
      const date = String(row.created_date);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(row);
    }

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│  Betroffene Personen (ohne FL2-Zuweisung)                       │');
    console.log('├──────────────┬────┬─────────────────────────────────────────────┤');

    let totalShown = 0;
    for (const [date, people] of [...byDate.entries()].sort().reverse()) {
      console.log(`│ Angelegt: ${date}  (${people.length} Personen)${' '.repeat(Math.max(0, 22 - people.length.toString().length - date.length))}│`);
      for (const p of people) {
        const name = `${p.last_name}, ${p.first_name}`.padEnd(35);
        const nr   = String(p.helper_number).padStart(4);
        const areas = (p.activity_areas ?? []).join(', ').substring(0, 20).padEnd(20);
        console.log(`│  ${nr}  ${name}  ${areas} │`);
        totalShown++;
        if (totalShown >= 200) {
          console.log('│  … (mehr als 200 Einträge — Filter nutzen)                       │');
          break;
        }
      }
    }
    console.log('└──────────────┴────┴─────────────────────────────────────────────┘');
    console.log('');

    if (!apply) {
      console.log('ℹ DRY-RUN — keine Änderungen vorgenommen.');
      console.log(`  Zum Ausführen: --apply --expected-count ${peopleResult.rowCount}`);
      await client.query('ROLLBACK');
      return;
    }

    // ── 4. Apply ─────────────────────────────────────────────────────────
    if (expectedCount !== null && expectedCount !== peopleResult.rowCount) {
      throw new Error(
        `Erwartete Anzahl (${expectedCount}) stimmt nicht mit tatsächlicher (${peopleResult.rowCount}) überein. Abbruch.`
      );
    }

    console.log(`Lege ${peopleResult.rowCount} FL2-Zuweisungen an…`);
    let created = 0;

    for (const row of peopleResult.rows) {
      // Participation anlegen / aktualisieren
      const partResult = await client.query(`
        INSERT INTO marshal_event_participation (event_id, person_id, shirt_size_snapshot)
        VALUES ($1, $2, $3)
        ON CONFLICT (event_id, person_id)
          DO UPDATE SET updated_at = now()
        RETURNING id
      `, [resolvedEventId, row.id, row.shirt_size ?? null]);
      const participationId = partResult.rows[0].id;

      // Area-Zuweisung anlegen
      await client.query(`
        INSERT INTO marshal_area_assignment
          (event_id, participation_id, area_id, commitment_status)
        VALUES ($1, $2, $3, 'not_asked')
        ON CONFLICT (participation_id, area_id)
          DO UPDATE SET updated_at = now()
        RETURNING id
      `, [resolvedEventId, participationId, fl2AreaId]);

      created++;
    }

    await client.query('COMMIT');
    console.log('');
    console.log(`✓ ${created} FL2-Zuweisungen erfolgreich angelegt.`);
    console.log('  Status: not_asked — Kontaktierung ausstehend.');

  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
