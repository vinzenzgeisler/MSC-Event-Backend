const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

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
const region = args.get('--region') ?? 'eu-central-1';
const outputPath = args.get('--output');
const workbookPath = args.get('--workbook');
const lauferWorkbookPath = args.get('--laufer-workbook');
const includeSensitiveDetails = args.has('--include-sensitive-details');
if (!secretArn) throw new Error('Use --secret-arn <arn> [--region <region>] [--output <path>]');

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
const normalizeKey = (value) => normalizeText(value).toLocaleLowerCase('de-DE');
const trackAreaAliases = new Set(['strecke', 'streckenposten', 'team strecke', 'team streckenposten', 'track', 'marshal']);
const isTrackArea = (areas) => Array.isArray(areas) && areas.some((area) => trackAreaAliases.has(normalizeKey(area).replace(/[_-]+/g, ' ')));

const canonicalizeShirtSize = (value) => {
  const raw = normalizeText(value);
  if (!raw) return { classification: 'missing', canonical: null };
  const match = raw.toUpperCase().match(/^(?:(H|D|K|HERREN|DAMEN|KINDER)\s*[-/ ]\s*)?(XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|[2-6]XL|\d{2,3}(?:\s*\/\s*\d{2,3})?)$/);
  if (!match) return { classification: 'invalid', canonical: null };
  const prefix = ({ HERREN: 'H', DAMEN: 'D', KINDER: 'K' })[match[1]] ?? match[1] ?? null;
  const size = ({ XXL: '2XL', XXXL: '3XL', XXXXL: '4XL' })[match[2]] ?? match[2].replace(/\s/g, '');
  return { classification: raw === `${prefix ? `${prefix}-` : ''}${size}` ? 'canonical' : 'normalizable', canonical: `${prefix ? `${prefix}-` : ''}${size}` };
};

const workbookCellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('').trim();
    if (value.result !== undefined) return workbookCellText(value.result);
  }
  return String(value).trim();
};

const readImportRepairSource = async (filename) => {
  if (!filename) return null;
  const buffer = fs.readFileSync(filename);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const people = new Map();
  const base = workbook.getWorksheet('Vorlage Lily 2022');
  base?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const helperNumber = Number(workbookCellText(row.getCell(1).value));
    if (!Number.isInteger(helperNumber) || helperNumber <= 0) return;
    people.set(helperNumber, {
      helperNumber,
      shirtSize: workbookCellText(row.getCell(12).value) || null,
      note: workbookCellText(row.getCell(13).value) || null,
      clubMember: Boolean(row.getCell(11).value),
      buggyShirtSize: workbookCellText(row.getCell(12).value) || null,
      buggyNote: workbookCellText(row.getCell(13).value) || null,
      buggyClubMember: Boolean(row.getCell(11).value),
      presentInCurrentSheet: false
    });
  });
  const current = workbook.getWorksheet('Helfernummern gesamt');
  current?.eachRow((row, rowNumber) => {
    if (rowNumber < 5) return;
    const helperNumber = Math.round(Number(workbookCellText(row.getCell(2).value)));
    if (!Number.isInteger(helperNumber) || helperNumber <= 0) return;
    const existing = people.get(helperNumber);
    const shirtSize = workbookCellText(row.getCell(12).value) || existing?.shirtSize || null;
    const note = workbookCellText(row.getCell(13).value) || existing?.note || null;
    people.set(helperNumber, {
      helperNumber,
      shirtSize,
      note,
      clubMember: existing?.clubMember ?? false,
      buggyShirtSize: workbookCellText(row.getCell(13).value) || existing?.buggyShirtSize || null,
      buggyNote: workbookCellText(row.getCell(14).value) || existing?.buggyNote || null,
      buggyClubMember: Boolean(row.getCell(12).value),
      presentInCurrentSheet: true
    });
  });
  return { sha256, people };
};

const decodeXmlText = (value) => value
  .replace(/<text:line-break\s*\/?\s*>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const readOdsRows = async (filename) => {
  if (!filename) return null;
  const buffer = fs.readFileSync(filename);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const archive = await JSZip.loadAsync(buffer);
  const content = await archive.file('content.xml')?.async('string');
  if (!content) throw new Error('ODS source has no content.xml');
  const tableMatch = content.match(/<table:table\b[^>]*table:name="Team_Laufer_2023"[^>]*>([\s\S]*?)<\/table:table>/);
  if (!tableMatch) throw new Error('ODS source has no Team_Laufer_2023 table');
  const rows = [];
  for (const rowMatch of tableMatch[1].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)) {
    const rowRepeat = Number(rowMatch[1].match(/table:number-rows-repeated="(\d+)"/)?.[1] ?? 1);
    const cells = [];
    const cellPattern = /<table:(?:table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:table-cell|covered-table-cell)>)/g;
    for (const cellMatch of rowMatch[2].matchAll(cellPattern)) {
      const columnRepeat = Number(cellMatch[1].match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? 1);
      const paragraphs = [...(cellMatch[2] ?? '').matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
        .map((match) => decodeXmlText(match[1]).trim());
      const value = paragraphs.join('\n').trim();
      for (let index = 0; index < Math.min(columnRepeat, 100); index += 1) cells.push(value);
    }
    for (let index = 0; index < Math.min(rowRepeat, 10000); index += 1) rows.push(cells);
  }
  return { sha256, rows };
};

const countBy = (rows, value) => Object.fromEntries([...rows.reduce((counts, row) => {
  const key = value(row);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true })));

const compactPerson = (row) => ({
  ref: `H${row.helper_number}`,
  hasEmail: Boolean(normalizeText(row.email)),
  hasPhone: Boolean(normalizeText(row.phone))
});

const invalidValueSignature = (value) => {
  const normalized = normalizeText(value);
  return {
    length: normalized.length,
    containsYear: /\b(?:19|20)\d{2}\b/.test(normalized),
    containsPostCode: /\b[1-5]\s*\/\s*\d{1,2}\b/.test(normalized),
    containsSizeToken: /\b(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)\b/i.test(normalized),
    looksLikeTrackText: /strecke|posten|marshal/i.test(normalized)
  };
};

const compactDayAssignment = (row) => ({
  ref: `H${row.helper_number}`,
  eventName: row.event_name,
  currentEvent: row.is_current,
  day: row.day_key,
  commitmentStatus: row.commitment_status,
  role: row.role,
  hasSection: Boolean(row.section_id),
  hasPost: Boolean(row.post_id),
  hasFunctionCode: Boolean(normalizeText(row.function_code)),
  trackMasterArea: isTrackArea(row.activity_areas)
});

const main = async () => {
  const importRepairSource = await readImportRepairSource(workbookPath);
  const lauferSource = await readOdsRows(lauferWorkbookPath);
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
    await client.query('begin transaction isolation level repeatable read read only');
    const [peopleResult, participationResult, dayResult, areaResult, shiftResult, trainingResult, importResult, integrityResult] = await Promise.all([
      client.query(`select id, helper_number, first_name, last_name, email, phone, shirt_size, club_member, note, activity_areas, is_active, no_deployment, created_at, updated_at from marshal_person order by helper_number`),
      client.query(`select ep.id, ep.person_id, p.helper_number, ep.event_id, e.name as event_name, e.is_current, ep.shirt_size_snapshot, p.shirt_size as master_shirt_size from marshal_event_participation ep join marshal_person p on p.id = ep.person_id join event e on e.id = ep.event_id order by e.starts_at desc, ep.person_id`),
      client.query(`select da.id, da.participation_id, ep.person_id, p.helper_number, p.first_name, p.last_name, p.email, p.phone, p.activity_areas, ep.event_id, e.name as event_name, e.is_current, d.day_key, d.event_date, da.commitment_status, da.role, da.section_id, da.post_id, da.function_code from marshal_day_assignment da join marshal_event_participation ep on ep.id = da.participation_id join marshal_person p on p.id = ep.person_id join marshal_event_day d on d.id = da.day_id join event e on e.id = ep.event_id order by e.starts_at desc, d.event_date, p.helper_number`),
      client.query(`select aa.id, aa.participation_id, ep.person_id, p.helper_number, p.first_name, p.last_name, p.activity_areas, e.name as event_name, e.is_current, a.code, a.name as area_name, a.area_type, a.day_scope, aa.commitment_status from marshal_area_assignment aa join marshal_event_participation ep on ep.id = aa.participation_id join marshal_person p on p.id = ep.person_id join marshal_helper_area a on a.id = aa.area_id join event e on e.id = aa.event_id order by e.starts_at desc, a.sort_order, p.helper_number`),
      client.query(`select sa.id, sa.participation_id, ep.person_id, p.helper_number, p.first_name, p.last_name, p.activity_areas, e.name as event_name, e.is_current, a.code, a.name as area_name, s.label as shift_label, s.shift_date, sa.commitment_status from marshal_shift_assignment sa join marshal_event_participation ep on ep.id = sa.participation_id join marshal_person p on p.id = ep.person_id join marshal_area_shift s on s.id = sa.shift_id join marshal_helper_area a on a.id = s.area_id join event e on e.id = sa.event_id order by e.starts_at desc, s.shift_date, p.helper_number`),
      client.query(`select tp.id, tp.person_id, p.helper_number, p.first_name, p.last_name, e.name as event_name, e.is_current, ts.session_type, ts.title, ts.session_date, tp.attendance_status from marshal_training_participant tp join marshal_training_session ts on ts.id = tp.session_id join marshal_person p on p.id = tp.person_id join event e on e.id = ts.event_id order by ts.session_date desc, p.helper_number`),
      client.query(`select ir.id, ir.event_id, e.name as event_name, e.is_current, ir.workbook_sha256, ir.filename, ir.status, ir.summary, jsonb_array_length(ir.conflicts) as conflict_count, ir.created_at from marshal_import_run ir join event e on e.id = ir.event_id order by ir.created_at desc`),
      client.query(`
        select
          (select count(*)::int from marshal_person where helper_number <= 0) as non_positive_helper_numbers,
          (select count(*)::int from marshal_person where btrim(first_name) = '' or btrim(last_name) = '') as blank_names,
          (select count(*)::int from marshal_person where shirt_size is not null and shirt_size <> btrim(shirt_size)) as shirt_values_with_outer_whitespace,
          (select count(*)::int from marshal_person where club_member) as club_members,
          (select count(*)::int from marshal_person where club_member and shirt_size is not null) as club_members_with_shirt_value,
          (select count(*)::int from marshal_person where btrim(coalesce(note, '')) in ('x', 'X')) as master_notes_equal_registration_marker,
          (select count(*)::int from marshal_person where jsonb_typeof(activity_areas) <> 'array') as non_array_activity_areas,
          (select count(*)::int from marshal_person where jsonb_typeof(activity_areas) = 'array' and jsonb_array_length(activity_areas) = 0) as empty_activity_area_arrays,
          (select count(*)::int from (
            select p.id
            from marshal_person p
            cross join lateral jsonb_array_elements_text(case when jsonb_typeof(p.activity_areas) = 'array' then p.activity_areas else '[]'::jsonb end) value
            group by p.id
            having count(*) <> count(distinct lower(btrim(value))) or bool_or(btrim(value) = '')
          ) duplicate_areas) as people_with_duplicate_or_blank_activity_areas,
          (select count(*)::int from marshal_day_assignment da join marshal_event_participation ep on ep.id = da.participation_id join marshal_event_day d on d.id = da.day_id where ep.event_id <> d.event_id) as day_participation_event_mismatches,
          (select count(*)::int from marshal_day_assignment da join marshal_event_participation ep on ep.id = da.participation_id join marshal_section s on s.id = da.section_id where ep.event_id <> s.event_id) as day_section_event_mismatches,
          (select count(*)::int from marshal_day_assignment da join marshal_event_participation ep on ep.id = da.participation_id join marshal_post p on p.id = da.post_id where ep.event_id <> p.event_id) as day_post_event_mismatches,
          (select count(*)::int from marshal_post p join marshal_section s on s.id = p.section_id where p.event_id <> s.event_id) as post_section_event_mismatches,
          (select count(*)::int from marshal_day_assignment da join marshal_post p on p.id = da.post_id where da.section_id is not null and da.section_id <> p.section_id) as assignment_post_section_mismatches
      `)
    ]);
    const people = peopleResult.rows;
    const participations = participationResult.rows;
    const dayAssignments = dayResult.rows;
    const areaAssignments = areaResult.rows;
    const shiftAssignments = shiftResult.rows;
    const trainings = trainingResult.rows;
    const imports = importResult.rows;
    const integrity = integrityResult.rows[0];

    const shirtFindings = people.map((person) => ({ person, ...canonicalizeShirtSize(person.shirt_size) }));
    const duplicateNames = [...people.reduce((groups, person) => {
      const key = `${normalizeKey(person.first_name)}|${normalizeKey(person.last_name)}`;
      groups.set(key, [...(groups.get(key) ?? []), compactPerson(person)]);
      return groups;
    }, new Map()).values()].filter((rows) => rows.length > 1);
    const duplicateEmails = [...people.filter((person) => normalizeText(person.email)).reduce((groups, person) => {
      const key = normalizeKey(person.email);
      groups.set(key, [...(groups.get(key) ?? []), compactPerson(person)]);
      return groups;
    }, new Map()).values()].filter((rows) => rows.length > 1);
    const duplicatePhones = [...people.filter((person) => normalizeText(person.phone)).reduce((groups, person) => {
      const key = normalizeText(person.phone).replace(/[^0-9+]/g, '');
      groups.set(key, [...(groups.get(key) ?? []), compactPerson(person)]);
      return groups;
    }, new Map()).values()].filter((rows) => rows.length > 1);
    const snapshotDifferences = participations.filter((row) => normalizeText(row.shirt_size_snapshot) && normalizeText(row.shirt_size_snapshot) !== normalizeText(row.master_shirt_size));
    const acceptedDayAssignments = dayAssignments.filter((row) => row.commitment_status === 'accepted');
    const acceptedOutsideTrack = acceptedDayAssignments.filter((row) => !isTrackArea(row.activity_areas));
    const acceptedWithoutTarget = acceptedDayAssignments.filter((row) => !row.role && !row.section_id && !row.post_id && !normalizeText(row.function_code));
    const acceptedWithoutContact = acceptedDayAssignments.filter((row) => !normalizeText(row.email) && !normalizeText(row.phone));
    const rawAreaValues = people.flatMap((person) => Array.isArray(person.activity_areas) ? person.activity_areas : []);
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const currentAcceptedTrackAssignments = dayAssignments.filter((row) => row.is_current && row.commitment_status === 'accepted' && isTrackArea(row.activity_areas));
    const currentAcceptedTrackPersonIds = new Set(currentAcceptedTrackAssignments.map((row) => row.person_id));
    const currentAcceptedAreaPersonIds = new Set([
      ...areaAssignments.filter((row) => row.is_current && row.commitment_status === 'accepted').map((row) => row.person_id),
      ...shiftAssignments.filter((row) => row.is_current && row.commitment_status === 'accepted').map((row) => row.person_id)
    ]);
    const currentShirtPeople = [...new Set([...currentAcceptedTrackPersonIds, ...currentAcceptedAreaPersonIds])]
      .map((personId) => peopleById.get(personId))
      .filter(Boolean);
    const currentShirtFindings = currentShirtPeople.map((person) => ({ person, ...canonicalizeShirtSize(person.shirt_size) }));
    const currentDayAssignments = dayAssignments.filter((row) => row.is_current);
    const peopleByHelperNumber = new Map(people.map((person) => [person.helper_number, person]));
    const latestImport = imports[0];
    const sourceRows = importRepairSource ? [...importRepairSource.people.values()] : [];
    const matchedSourceRows = sourceRows.filter((source) => peopleByHelperNumber.has(source.helperNumber));
    const sourceDiffs = matchedSourceRows.map((source) => {
      const person = peopleByHelperNumber.get(source.helperNumber);
      const shirtTarget = canonicalizeShirtSize(source.shirtSize).canonical ?? source.shirtSize;
      const shirtChanged = normalizeText(person.shirt_size) !== normalizeText(shirtTarget);
      const noteChanged = normalizeText(person.note) !== normalizeText(source.note);
      const clubMemberChanged = person.club_member !== source.clubMember;
      return {
        source,
        person,
        shirtTarget,
        shirtChanged,
        noteChanged,
        clubMemberChanged,
        shirtSafe: shirtChanged && normalizeText(person.shirt_size) === normalizeText(source.buggyShirtSize),
        noteSafe: noteChanged && normalizeText(person.note) === normalizeText(source.buggyNote),
        clubMemberSafe: clubMemberChanged && person.club_member === source.buggyClubMember
      };
    });
    const importedEventSnapshotDiffs = latestImport ? participations.filter((participation) => {
      const source = importRepairSource?.people.get(participation.helper_number);
      const target = canonicalizeShirtSize(source?.shirtSize).canonical ?? source?.shirtSize;
      return participation.event_id === latestImport.event_id && source?.presentInCurrentSheet
        && normalizeText(participation.shirt_size_snapshot) !== normalizeText(target);
    }) : [];
    const safeImportedEventSnapshotDiffs = importedEventSnapshotDiffs.filter((participation) => {
      const source = importRepairSource?.people.get(participation.helper_number);
      return normalizeText(participation.shirt_size_snapshot) === normalizeText(source?.buggyShirtSize);
    });
    const invalidCurrentShirtRecovery = sourceDiffs.filter((row) => canonicalizeShirtSize(row.person.shirt_size).classification === 'invalid');
    const lauferRows = (lauferSource?.rows ?? []).slice(1).map((cells) => ({
      lastName: normalizeText(cells[0]),
      firstName: normalizeText(cells[1]),
      shirtSize: normalizeText(cells[9]) || null
    })).filter((row) => row.firstName && row.lastName);
    const peopleByName = people.reduce((groups, person) => {
      const key = `${normalizeKey(person.first_name)}|${normalizeKey(person.last_name)}`;
      groups.set(key, [...(groups.get(key) ?? []), person]);
      return groups;
    }, new Map());
    const lauferMatches = lauferRows.map((source) => ({
      source,
      matches: peopleByName.get(`${normalizeKey(source.firstName)}|${normalizeKey(source.lastName)}`) ?? []
    }));
    const uniqueLauferMatches = lauferMatches.filter((row) => row.matches.length === 1).map((row) => ({ ...row, person: row.matches[0] }));
    const currentAreaPersonIds = new Set(areaAssignments.filter((row) => row.is_current).map((row) => row.person_id));

    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'repeatable-read/read-only',
      summary: {
        people: people.length,
        activePeople: people.filter((row) => row.is_active && !row.no_deployment).length,
        participations: participations.length,
        dayAssignments: dayAssignments.length,
        areaAssignments: areaAssignments.length,
        shiftAssignments: shiftAssignments.length,
        trainingParticipants: trainings.length,
        importRuns: imports.length,
        latestImportAt: imports[0]?.created_at ?? null,
        latestImportSha256: imports[0]?.workbook_sha256 ?? null,
        shirtClassifications: countBy(shirtFindings, (row) => row.classification),
        canonicalShirtSizes: countBy(shirtFindings.filter((row) => row.classification === 'canonical'), (row) => row.canonical),
        shirtNormalizationTargets: countBy(shirtFindings.filter((row) => row.classification === 'normalizable'), (row) => row.canonical),
        invalidShirtSignatures: countBy(shirtFindings.filter((row) => row.classification === 'invalid'), (row) => JSON.stringify(invalidValueSignature(row.person.shirt_size))),
        activityAreaClasses: countBy(rawAreaValues.map((value) => ({ value })), (row) => {
          const normalized = normalizeKey(row.value).replace(/[_-]+/g, ' ');
          if (!normalized) return 'empty';
          if (trackAreaAliases.has(normalized)) return 'track';
          if (normalized === 'aufbau') return 'setup';
          return 'other';
        }),
        dayStatuses: countBy(dayAssignments, (row) => row.commitment_status ?? '(null)'),
        areaStatuses: countBy(areaAssignments, (row) => row.commitment_status ?? '(null)'),
        shiftStatuses: countBy(shiftAssignments, (row) => row.commitment_status ?? '(null)')
      },
      currentEvent: {
        dayStatuses: countBy(currentDayAssignments, (row) => `${row.day_key}:${row.commitment_status ?? '(null)'}`),
        acceptedTrackPeople: currentAcceptedTrackPersonIds.size,
        acceptedAreaPeople: currentAcceptedAreaPersonIds.size,
        uniquePeopleCountedForShirts: currentShirtPeople.length,
        shirtClassifications: countBy(currentShirtFindings, (row) => row.classification),
        canonicalShirtSizes: countBy(currentShirtFindings.filter((row) => row.classification === 'canonical'), (row) => row.canonical),
        invalidShirtSignatures: countBy(currentShirtFindings.filter((row) => row.classification === 'invalid'), (row) => JSON.stringify(invalidValueSignature(row.person.shirt_size))),
        normalizationTargets: countBy(currentShirtFindings.filter((row) => row.classification === 'normalizable'), (row) => row.canonical),
        acceptedOutsideTrackTeam: dayAssignments.filter((row) => row.is_current && row.commitment_status === 'accepted' && !isTrackArea(row.activity_areas)).length,
        acceptedWithoutTarget: currentAcceptedTrackAssignments.filter((row) => !row.role && !row.section_id && !row.post_id && !normalizeText(row.function_code)).length
      },
      ...(importRepairSource ? {
        importRepairSource: {
          sha256: importRepairSource.sha256,
          matchesLatestImport: importRepairSource.sha256.toLowerCase() === normalizeText(latestImport?.workbook_sha256).toLowerCase(),
          sourcePeople: sourceRows.length,
          currentSheetPeople: sourceRows.filter((row) => row.presentInCurrentSheet).length,
          matchedDatabasePeople: matchedSourceRows.length,
          missingDatabasePeople: sourceRows.length - matchedSourceRows.length,
          peopleWithAnyAffectedFieldDifference: sourceDiffs.filter((row) => row.shirtChanged || row.noteChanged || row.clubMemberChanged).length,
          masterShirtDifferences: sourceDiffs.filter((row) => row.shirtChanged).length,
          safeMasterShirtRepairs: sourceDiffs.filter((row) => row.shirtSafe).length,
          conflictingMasterShirtDifferences: sourceDiffs.filter((row) => row.shirtChanged && !row.shirtSafe).length,
          masterNoteDifferences: sourceDiffs.filter((row) => row.noteChanged).length,
          safeMasterNoteRepairs: sourceDiffs.filter((row) => row.noteSafe).length,
          conflictingMasterNoteDifferences: sourceDiffs.filter((row) => row.noteChanged && !row.noteSafe).length,
          clubMemberDifferences: sourceDiffs.filter((row) => row.clubMemberChanged).length,
          safeClubMemberRepairs: sourceDiffs.filter((row) => row.clubMemberSafe).length,
          conflictingClubMemberDifferences: sourceDiffs.filter((row) => row.clubMemberChanged && !row.clubMemberSafe).length,
          importedEventSnapshotShirtDifferences: importedEventSnapshotDiffs.length,
          safeImportedEventSnapshotShirtRepairs: safeImportedEventSnapshotDiffs.length,
          conflictingImportedEventSnapshotShirtDifferences: importedEventSnapshotDiffs.length - safeImportedEventSnapshotDiffs.length,
          correctedSourceShirtClassifications: countBy(sourceRows.map((source) => canonicalizeShirtSize(source.shirtSize)), (row) => row.classification),
          invalidCurrentShirtRecovery: countBy(invalidCurrentShirtRecovery, (row) => canonicalizeShirtSize(row.source.shirtSize).classification)
        }
      } : {}),
      ...(lauferSource ? {
        lauferSource: {
          sha256: lauferSource.sha256,
          sourcePeople: lauferRows.length,
          uniqueDatabaseMatches: uniqueLauferMatches.length,
          ambiguousDatabaseMatches: lauferMatches.filter((row) => row.matches.length > 1).length,
          missingDatabaseMatches: lauferMatches.filter((row) => row.matches.length === 0).length,
          sourceShirtClassifications: countBy(lauferRows.map((row) => canonicalizeShirtSize(row.shirtSize)), (row) => row.classification),
          matchedMasterShirtDifferences: uniqueLauferMatches.filter((row) => canonicalizeShirtSize(row.person.shirt_size).canonical !== canonicalizeShirtSize(row.source.shirtSize).canonical).length,
          matchedPeopleWithSetupMasterArea: uniqueLauferMatches.filter((row) => Array.isArray(row.person.activity_areas) && row.person.activity_areas.some((area) => normalizeKey(area) === 'aufbau')).length,
          matchedPeopleWithCurrentAreaAssignment: uniqueLauferMatches.filter((row) => currentAreaPersonIds.has(row.person.id)).length
        }
      } : {}),
      integrity,
      findings: {
        invalidShirtSizes: shirtFindings.filter((row) => row.classification === 'invalid').map((row) => ({ ...compactPerson(row.person), signature: invalidValueSignature(row.person.shirt_size) })),
        missingShirtSizes: shirtFindings.filter((row) => row.classification === 'missing').map((row) => compactPerson(row.person)),
        normalizableShirtSizes: shirtFindings.filter((row) => row.classification === 'normalizable').map((row) => ({ ...compactPerson(row.person), canonical: row.canonical })),
        snapshotDifferences: snapshotDifferences.map((row) => ({
          eventName: row.event_name,
          currentEvent: row.is_current,
          master: canonicalizeShirtSize(row.master_shirt_size).classification,
          snapshot: canonicalizeShirtSize(row.shirt_size_snapshot).classification,
          sameCanonicalValue: canonicalizeShirtSize(row.master_shirt_size).canonical === canonicalizeShirtSize(row.shirt_size_snapshot).canonical
        })),
        duplicateNames,
        duplicateEmails,
        duplicatePhones,
        acceptedDayAssignmentsOutsideTrackTeam: acceptedOutsideTrack.map(compactDayAssignment),
        acceptedDayAssignmentsWithoutTarget: acceptedWithoutTarget.map(compactDayAssignment),
        acceptedDayAssignmentsWithoutContact: acceptedWithoutContact.map(compactDayAssignment),
        inactiveAndNoDeployment: people.filter((row) => !row.is_active && row.no_deployment).map(compactPerson),
        importRuns: imports
      },
      ...(includeSensitiveDetails ? {
        detailedReview: {
          unclearShirtValues: shirtFindings.filter((row) => row.classification === 'invalid').map((row) => ({
            helperNumber: row.person.helper_number,
            name: `${row.person.first_name} ${row.person.last_name}`,
            shirtSizeRaw: row.person.shirt_size
          })),
          acceptedDayAssignmentsOutsideTrackTeam: acceptedOutsideTrack.map((row) => ({
            eventName: row.event_name,
            day: row.day_key,
            commitmentStatus: row.commitment_status
          }))
        }
      } : {})
    };
    if (outputPath) {
      const fileReport = includeSensitiveDetails
        ? { generatedAt: report.generatedAt, detailedReview: report.detailedReview }
        : report;
      fs.writeFileSync(outputPath, `${JSON.stringify(fileReport, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    console.log(JSON.stringify({ generatedAt: report.generatedAt, mode: report.mode, summary: report.summary, currentEvent: report.currentEvent, importRepairSource: report.importRepairSource, lauferSource: report.lauferSource, integrity: report.integrity, findingCounts: Object.fromEntries(Object.entries(report.findings).map(([key, value]) => [key, value.length])) }, null, 2));
    await client.query('rollback');
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
