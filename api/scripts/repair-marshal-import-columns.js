const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

const secretArn = args.get('--secret-arn');
const workbookPath = args.get('--workbook');
const region = args.get('--region') ?? 'eu-central-1';
const apply = args.has('--apply');
const expectedSourceSha256 = String(args.get('--expected-source-sha256') ?? '').toLowerCase();
const expectedChangedPeople = Number(args.get('--expected-changed-people'));
const repairKey = 'marshal-import-column-shift-v1';
const createdBy = args.get('--created-by') ?? null;

if (!secretArn || !workbookPath) {
  throw new Error('Use --secret-arn <arn> --workbook <xlsx> [--region <region>]');
}
if (apply && (!/^[a-f0-9]{64}$/.test(expectedSourceSha256) || !Number.isInteger(expectedChangedPeople) || expectedChangedPeople < 1)) {
  throw new Error('Apply additionally requires --expected-source-sha256 <sha256> and --expected-changed-people <count>');
}

const caPath = '/tmp/rds-global-bundle.pem';
const caUrl = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

const downloadFile = (url, destination) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(destination);
  https.get(url, (response) => {
    if (response.statusCode !== 200) {
      file.close();
      fs.unlink(destination, () => undefined);
      reject(new Error(`CA download failed with HTTP ${response.statusCode ?? 'unknown'}`));
      return;
    }
    response.pipe(file);
    file.on('finish', () => file.close(resolve));
  }).on('error', reject);
});

const normalizeText = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const sameText = (left, right) => normalizeText(left) === normalizeText(right);
const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('').trim();
    if (value.result !== undefined) return cellText(value.result);
  }
  return String(value).trim();
};

const canonicalizeShirtSize = (value) => {
  const raw = normalizeText(value);
  if (!raw) return null;
  const match = raw.toUpperCase().match(/^(?:(H|D|K|HERREN|DAMEN|KINDER)\s*[-/ ]\s*)?(XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|[2-6]XL|\d{2,3}(?:\s*\/\s*\d{2,3})?)$/);
  if (!match) return raw;
  const prefix = ({ HERREN: 'H', DAMEN: 'D', KINDER: 'K' })[match[1]] ?? match[1] ?? null;
  const size = ({ XXL: '2XL', XXXL: '3XL', XXXXL: '4XL' })[match[2]] ?? match[2].replace(/\s/g, '');
  return `${prefix ? `${prefix}-` : ''}${size}`;
};

const readRepairSource = async (filename) => {
  const buffer = fs.readFileSync(filename);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const people = new Map();
  const base = workbook.getWorksheet('Vorlage Lily 2022');
  const current = workbook.getWorksheet('Helfernummern gesamt');
  if (!base || !current) throw new Error('Workbook does not have the expected marshal source sheets');

  base.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const helperNumber = Number(cellText(row.getCell(1).value));
    if (!Number.isInteger(helperNumber) || helperNumber <= 0) return;
    const shirtSize = cellText(row.getCell(12).value) || null;
    const note = cellText(row.getCell(13).value) || null;
    const clubMember = Boolean(row.getCell(11).value);
    people.set(helperNumber, {
      helperNumber,
      shirtSize,
      note,
      clubMember,
      buggyShirtSize: shirtSize,
      buggyNote: note,
      buggyClubMember: clubMember,
      presentInCurrentSheet: false
    });
  });

  current.eachRow((row, rowNumber) => {
    if (rowNumber < 5) return;
    const helperNumber = Math.round(Number(cellText(row.getCell(2).value)));
    if (!Number.isInteger(helperNumber) || helperNumber <= 0) return;
    const existing = people.get(helperNumber);
    people.set(helperNumber, {
      helperNumber,
      shirtSize: cellText(row.getCell(12).value) || existing?.shirtSize || null,
      note: cellText(row.getCell(13).value) || existing?.note || null,
      clubMember: existing?.clubMember ?? false,
      buggyShirtSize: cellText(row.getCell(13).value) || existing?.buggyShirtSize || null,
      buggyNote: cellText(row.getCell(14).value) || existing?.buggyNote || null,
      buggyClubMember: Boolean(row.getCell(12).value),
      presentInCurrentSheet: true
    });
  });
  return { sha256, people };
};

const main = async () => {
  const source = await readRepairSource(workbookPath);
  if (apply && source.sha256 !== expectedSourceSha256) throw new Error('Source workbook hash does not match the approved hash');
  if (!fs.existsSync(caPath)) await downloadFile(caUrl, caPath);
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
    await client.query(`begin transaction isolation level serializable ${apply ? '' : 'read only'}`);
    const importResult = await client.query(`
      select event_id, workbook_sha256
      from marshal_import_run
      where workbook_sha256 = $1 and status = 'completed'
      order by completed_at desc
      limit 1
    `, [source.sha256]);
    if (importResult.rowCount !== 1) throw new Error('No completed import matches the source workbook hash');
    const importedEventId = importResult.rows[0].event_id;
    const peopleResult = await client.query(`
      select id, helper_number, shirt_size, note, club_member
      from marshal_person
      ${apply ? 'for update' : ''}
    `);
    const participationResult = await client.query(`
      select ep.id, ep.person_id, p.helper_number, ep.shirt_size_snapshot
      from marshal_event_participation ep
      join marshal_person p on p.id = ep.person_id
      where ep.event_id = $1
      ${apply ? 'for update of ep' : ''}
    `, [importedEventId]);
    const peopleByNumber = new Map(peopleResult.rows.map((row) => [row.helper_number, row]));
    const participationByNumber = new Map(participationResult.rows.map((row) => [row.helper_number, row]));
    const changes = [];
    const conflicts = { shirtSize: 0, note: 0, clubMember: 0, shirtSizeSnapshot: 0 };

    for (const sourcePerson of source.people.values()) {
      const person = peopleByNumber.get(sourcePerson.helperNumber);
      if (!person) continue;
      const target = {
        shirtSize: canonicalizeShirtSize(sourcePerson.shirtSize),
        note: sourcePerson.note,
        clubMember: sourcePerson.clubMember
      };
      const fields = [];
      if (!sameText(person.shirt_size, target.shirtSize)) {
        if (sameText(person.shirt_size, sourcePerson.buggyShirtSize)) fields.push('shirtSize');
        else conflicts.shirtSize += 1;
      }
      if (!sameText(person.note, target.note)) {
        if (sameText(person.note, sourcePerson.buggyNote)) fields.push('note');
        else conflicts.note += 1;
      }
      if (person.club_member !== target.clubMember) {
        if (person.club_member === sourcePerson.buggyClubMember) fields.push('clubMember');
        else conflicts.clubMember += 1;
      }
      const participation = sourcePerson.presentInCurrentSheet ? participationByNumber.get(sourcePerson.helperNumber) : undefined;
      if (participation && !sameText(participation.shirt_size_snapshot, target.shirtSize)) {
        if (sameText(participation.shirt_size_snapshot, sourcePerson.buggyShirtSize)) fields.push('shirtSizeSnapshot');
        else conflicts.shirtSizeSnapshot += 1;
      }
      if (fields.length) changes.push({ person, participation, target, fields });
    }

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      repairKey,
      sourceSha256: source.sha256,
      sourcePeople: source.people.size,
      matchedPeople: [...source.people.keys()].filter((number) => peopleByNumber.has(number)).length,
      changedPeople: changes.length,
      safeFieldChanges: {
        shirtSize: changes.filter((change) => change.fields.includes('shirtSize')).length,
        note: changes.filter((change) => change.fields.includes('note')).length,
        clubMember: changes.filter((change) => change.fields.includes('clubMember')).length,
        shirtSizeSnapshot: changes.filter((change) => change.fields.includes('shirtSizeSnapshot')).length
      },
      preservedConflicts: conflicts
    };
    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      await client.query('rollback');
      return;
    }
    if (changes.length !== expectedChangedPeople) {
      throw new Error(`Safe changed-person count is ${changes.length}, expected ${expectedChangedPeople}; nothing was applied`);
    }

    for (const change of changes) {
      const afterPerson = {
        shirtSize: change.fields.includes('shirtSize') ? change.target.shirtSize : change.person.shirt_size,
        note: change.fields.includes('note') ? change.target.note : change.person.note,
        clubMember: change.fields.includes('clubMember') ? change.target.clubMember : change.person.club_member
      };
      const beforeData = {
        person: { shirtSize: change.person.shirt_size, note: change.person.note, clubMember: change.person.club_member },
        participation: change.participation ? { id: change.participation.id, shirtSizeSnapshot: change.participation.shirt_size_snapshot } : null
      };
      const afterData = {
        person: afterPerson,
        participation: change.participation ? {
          id: change.participation.id,
          shirtSizeSnapshot: change.fields.includes('shirtSizeSnapshot') ? change.target.shirtSize : change.participation.shirt_size_snapshot
        } : null
      };
      await client.query(`
        insert into marshal_import_repair_snapshot
          (repair_key, source_workbook_sha256, person_id, event_id, before_data, after_data, applied_fields, created_by)
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8)
        on conflict (repair_key, person_id) do nothing
      `, [repairKey, source.sha256, change.person.id, importedEventId, JSON.stringify(beforeData), JSON.stringify(afterData), change.fields, createdBy]);

      const personFields = change.fields.filter((field) => field !== 'shirtSizeSnapshot');
      if (personFields.length) {
        await client.query(`
          update marshal_person
          set shirt_size = $2, note = $3, club_member = $4, updated_at = now()
          where id = $1
        `, [change.person.id, afterPerson.shirtSize, afterPerson.note, afterPerson.clubMember]);
      }
      if (change.fields.includes('shirtSizeSnapshot') && change.participation) {
        await client.query(`
          update marshal_event_participation
          set shirt_size_snapshot = $2, updated_at = now()
          where id = $1
        `, [change.participation.id, change.target.shirtSize]);
      }
    }
    await client.query('commit');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
