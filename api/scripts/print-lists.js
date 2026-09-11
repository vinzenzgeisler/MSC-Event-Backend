// Generates the four organizer print checklists directly from the database:
//   1. Fahrer mit offenem Nenngeld (Kästchen zum Abhaken)
//   2. Fahrer, die wegen U70 ein ärztliches Attest liefern müssen
//   3. Fallback-Prüfblatt für die technische Abnahme (je Klasse, mit Notizfeld)
//   4. Fahrer, die Medien im Anmeldeformular abgelehnt haben
//
// Standalone script, independent of the deployed API/Lambda code. Run with
// AWS_PROFILE=verein (or any profile with Secrets Manager access) set, then:
//   node scripts/print-lists.js --secret-arn <db-secret-arn> --event-id <uuid> --output-dir ./print-lists
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const PDFDocument = require('pdfkit');

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

const selfTest = args.has('--self-test');
const secretArn = args.get('--secret-arn');
const region = args.get('--region') ?? 'eu-central-1';
const eventIdArg = args.get('--event-id');
const outputDir = args.get('--output-dir') ?? './print-lists';
const assetsBucket = args.get('--assets-bucket');
if (!selfTest && !secretArn) throw new Error('Use --secret-arn <arn> [--region <region>] [--event-id <uuid>] [--output-dir <path>] [--assets-bucket <name>], or --self-test to render sample PDFs without a database.');

// The built-in PDF core fonts (Helvetica) only cover WinAnsi/Latin-1 and silently corrupt
// characters outside that range (e.g. Czech/Polish diacritics like ě, ř, ł — confirmed via
// fontkit that Helvetica AND the Barlow webfont used for stamp cards both lack these glyphs,
// while a standard system font like Arial has full Central European coverage). We embed a
// local system font when available; --assets-bucket is only a fallback for machines/CI
// without one, and does not currently guarantee Czech/Polish coverage.
const LOCAL_FONT_CANDIDATES = [
  { regular: 'C:/Windows/Fonts/arial.ttf', bold: 'C:/Windows/Fonts/arialbd.ttf' },
  { regular: 'C:/Windows/Fonts/calibri.ttf', bold: 'C:/Windows/Fonts/calibrib.ttf' },
  { regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
  { regular: '/System/Library/Fonts/Supplemental/Arial.ttf', bold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf' }
];
const FONT_KEYS = { regular: 'public/stamp-cards/fonts/barlow-500.ttf', bold: 'public/stamp-cards/fonts/barlow-700.ttf' };
const loadFonts = async () => {
  for (const candidate of LOCAL_FONT_CANDIDATES) {
    if (fs.existsSync(candidate.regular) && fs.existsSync(candidate.bold)) {
      return { regular: fs.readFileSync(candidate.regular), bold: fs.readFileSync(candidate.bold) };
    }
  }
  if (assetsBucket) {
    console.warn('No local system font found; falling back to the bundled Barlow font from S3, which does not cover Czech/Polish diacritics.');
    const s3 = new S3Client({ region });
    const getBuffer = async (key) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: assetsBucket, Key: key }));
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    };
    const [regular, bold] = await Promise.all([getBuffer(FONT_KEYS.regular), getBuffer(FONT_KEYS.bold)]);
    return { regular, bold };
  }
  console.warn('No embeddable Unicode font found (system or --assets-bucket); falling back to the built-in Helvetica font, which cannot render Czech/Polish diacritics correctly.');
  return null;
};

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

const naturalStartNumberSort = `(case when start_number_norm ~ '^[0-9]+$' then lpad(start_number_norm, 8, '0') else coalesce(start_number_norm, 'zzzzzzzz') end)`;

const formatDate = (value) => {
  if (!value) return '-';
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const [year, month, day] = raw.split('-');
  return day && month && year ? `${day}.${month}.${year}` : raw;
};

const ageAt = (birthdate, referenceDate) => {
  if (!birthdate) return null;
  const raw = birthdate instanceof Date ? birthdate.toISOString().slice(0, 10) : String(birthdate).slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = referenceDate.getUTCFullYear() - year;
  const currentMonth = referenceDate.getUTCMonth() + 1;
  const currentDay = referenceDate.getUTCDate();
  if (currentMonth < month || (currentMonth === month && currentDay < day)) age -= 1;
  return age;
};

const displayName = (row) => `${row.last_name}, ${row.first_name}`.trim();

// ── minimal, self-contained checklist-table PDF renderer (pdfkit) ─────────────────────
// One or more sections (each with its own heading, e.g. a vehicle class), rendered as a
// table with an optional checkbox column, auto-paginating with a repeated header/footer.
const renderChecklistPdf = (title, sections, layout = 'portrait', fonts = null) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', layout, margin: 30, bufferPages: true, info: { Title: title, Author: 'MSC Oberlausitzer Dreiländereck e.V.' } });
  const chunks = [];
  const pageX = 30;
  const pageWidth = doc.page.width - 60;
  const pageBottom = () => doc.page.height - 50;
  const generatedAt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
  let cursorY = 0;
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  if (fonts) {
    doc.registerFont('Body', fonts.regular);
    doc.registerFont('BodyBold', fonts.bold);
  }
  const REGULAR = fonts ? 'Body' : 'Helvetica';
  const BOLD = fonts ? 'BodyBold' : 'Helvetica-Bold';

  const drawPageHeader = (continued = false) => {
    doc.font(BOLD).fontSize(8.2).fillColor('#163A70').text('MSC OBERLAUSITZER DREILÄNDERECK E.V.', pageX, 25, { width: pageWidth, characterSpacing: 0.6 });
    doc.font(BOLD).fontSize(17).fillColor('#0F172A').text(title, pageX, 40, { width: pageWidth });
    doc.font(REGULAR).fontSize(7.8).fillColor('#64748B').text(`Erstellt am ${generatedAt}${continued ? ' · Fortsetzung' : ''}`, pageX, doc.y, { width: pageWidth });
    const dividerY = doc.y + 8;
    doc.save().lineWidth(1.2).strokeColor('#E6B800').moveTo(pageX, dividerY).lineTo(pageX + pageWidth, dividerY).stroke().restore();
    cursorY = dividerY + 12;
  };

  const scaledWidths = (widths) => {
    const total = widths.reduce((sum, w) => sum + w, 0) || 1;
    const result = widths.map((w) => (w * pageWidth) / total);
    result[result.length - 1] += pageWidth - result.reduce((sum, w) => sum + w, 0);
    return result;
  };

  const drawSectionHeading = (heading, continued = false) => {
    if (!heading) return;
    doc.font(BOLD).fontSize(9).fillColor('#163A70').text((continued ? `${heading} · Fortsetzung` : heading).toUpperCase(), pageX, cursorY, { width: pageWidth, characterSpacing: 0.4 });
    cursorY += 16;
  };

  const drawTableHeader = (headers, widths) => {
    const height = 26;
    let x = pageX;
    headers.forEach((header, index) => {
      const width = widths[index];
      doc.save().rect(x, cursorY, width, height).fill('#163A70').restore();
      doc.font(BOLD).fontSize(7.5).fillColor('#FFFFFF').text(header.toUpperCase(), x + 6, cursorY + 8, { width: width - 12 });
      x += width;
    });
    cursorY += height;
  };

  const drawTableRow = (row, widths, rowIndex, checkboxColumns, minimumRowHeight) => {
    doc.font(REGULAR).fontSize(8.5);
    const contentHeight = row.reduce((max, value, index) => checkboxColumns.has(index) ? max : Math.max(max, doc.heightOfString(value || ' ', { width: widths[index] - 14 })), 0);
    const height = Math.max(minimumRowHeight, contentHeight + 14);
    let x = pageX;
    row.forEach((value, index) => {
      const width = widths[index];
      doc.save().rect(x, cursorY, width, height).fill(rowIndex % 2 === 0 ? '#FFFFFF' : '#F8FAFC').restore();
      doc.save().lineWidth(0.5).strokeColor('#CBD5E1').rect(x, cursorY, width, height).stroke().restore();
      if (checkboxColumns.has(index)) {
        const boxSize = 12;
        doc.save().lineWidth(1).strokeColor('#334155').roundedRect(x + (width - boxSize) / 2, cursorY + (height - boxSize) / 2, boxSize, boxSize, 1.5).stroke().restore();
      } else if (value) {
        doc.font(REGULAR).fontSize(8.5).fillColor('#0F172A').text(value, x + 7, cursorY + 7, { width: width - 14 });
      }
      x += width;
    });
    cursorY += height;
    return height;
  };

  drawPageHeader();
  sections.forEach((section) => {
    const widths = scaledWidths(section.widths);
    const checkboxColumns = new Set(section.checkboxColumns ?? []);
    const minimumRowHeight = section.minimumRowHeight ?? 28;
    // Avoid a "widow" section heading + table header sitting alone at the bottom of a page
    // with no rows following it: require room for the heading, the header row, and at
    // least one data row before starting a new section on the current page.
    const sectionStartHeight = (section.heading ? 16 : 0) + 26 + minimumRowHeight;
    if (cursorY + sectionStartHeight > pageBottom()) {
      doc.addPage();
      drawPageHeader(true);
    }
    drawSectionHeading(section.heading);
    drawTableHeader(section.headers, widths);
    section.rows.forEach((row, rowIndex) => {
      doc.font(REGULAR).fontSize(8.5);
      const contentHeight = row.reduce((max, value, index) => checkboxColumns.has(index) ? max : Math.max(max, doc.heightOfString(value || ' ', { width: widths[index] - 14 })), 0);
      const estimatedHeight = Math.max(minimumRowHeight, contentHeight + 14);
      if (cursorY + estimatedHeight > pageBottom()) {
        doc.addPage();
        drawPageHeader(true);
        drawSectionHeading(section.heading, true);
        drawTableHeader(section.headers, widths);
      }
      drawTableRow(row, widths, rowIndex, checkboxColumns, minimumRowHeight);
    });
    cursorY += 10;
  });

  // Drawing this close to the page's bottom margin can otherwise silently trigger pdfkit's
  // own automatic page-break (it inserts and switches to a brand-new blank page instead of
  // rendering on the current one), which is exactly what produced the extra blank pages at
  // the end of the document. Temporarily removing the bottom margin during the footer draw
  // prevents that.
  const pageRange = doc.bufferedPageRange();
  const originalBottomMargin = doc.page.margins.bottom;
  for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex += 1) {
    doc.switchToPage(pageRange.start + pageIndex);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - 38;
    doc.save().lineWidth(0.6).strokeColor('#D8DEE9').moveTo(pageX, footerY - 6).lineTo(pageX + pageWidth, footerY - 6).stroke().restore();
    doc.font(REGULAR).fontSize(7.4).fillColor('#64748B').text('Interne Arbeitsliste', pageX, footerY, { width: pageWidth / 2, lineBreak: false });
    doc.text(`Seite ${pageIndex + 1} / ${pageRange.count}`, pageX + pageWidth / 2, footerY, { width: pageWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }
  doc.end();
});

const runSelfTest = async () => {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const sampleRow = (className, startNumber, firstName, lastName, birthdate) => ({
    class_name: className, start_number_norm: startNumber, first_name: firstName, last_name: lastName, birthdate,
    vehicle_make: 'Trabant', vehicle_model: '601', vehicle_year: 1985, backup_vehicle_id: null
  });
  const rows = [sampleRow('Klasse 9', '42', 'Max', 'Mustermann', '1950-01-01'), sampleRow('Klasse 9', '7', 'Erika', 'Musterfrau', '1995-05-05')];
  await fs.promises.writeFile(path.join(outputDir, 'selftest-01-offenes-nenngeld.pdf'), await renderChecklistPdf('Offenes Nenngeld (Testdaten)', [{
    heading: `${rows.length} Fahrer (Testdaten)`,
    headers: ['Bezahlt', 'Klasse', 'Nr.', 'Fahrer'],
    rows: rows.map((row) => ['', row.class_name, row.start_number_norm, displayName(row)]),
    widths: [70, 190, 60, 250],
    checkboxColumns: [0],
    minimumRowHeight: 30
  }], 'portrait'));
  await fs.promises.writeFile(path.join(outputDir, 'selftest-03-technische-abnahme-fallback.pdf'), await renderChecklistPdf('Technische Abnahme – Fallback-Prüfblatt (Testdaten)', [{
    heading: 'Klasse 9',
    headers: ['Nr.', 'Fahrer', 'Fahrzeug', 'Bestanden', 'Notiz'],
    rows: rows.map((row) => [row.start_number_norm, displayName(row), `${row.vehicle_make} ${row.vehicle_model} ${row.vehicle_year}`, '', '']),
    widths: [50, 170, 220, 65, 220],
    checkboxColumns: [3],
    minimumRowHeight: 34
  }], 'landscape'));
  console.log(JSON.stringify({ selfTest: true, outputDir, files: ['selftest-01-offenes-nenngeld.pdf', 'selftest-03-technische-abnahme-fallback.pdf'] }, null, 2));
};

const main = async () => {
  if (selfTest) {
    await runSelfTest();
    return;
  }
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
    const fonts = await loadFonts();
    await client.query('begin transaction isolation level repeatable read read only');

    const eventResult = eventIdArg
      ? await client.query('select id, name, starts_at, ends_at from event where id = $1', [eventIdArg])
      : await client.query('select id, name, starts_at, ends_at from event where is_current = true order by starts_at desc limit 1');
    const eventRow = eventResult.rows[0];
    if (!eventRow) throw new Error(eventIdArg ? `Event ${eventIdArg} not found` : 'No current event found; pass --event-id explicitly');
    const startsAtRaw = eventRow.starts_at instanceof Date ? eventRow.starts_at.toISOString().slice(0, 10) : String(eventRow.starts_at).slice(0, 10);
    const eventStart = new Date(`${startsAtRaw}T12:00:00.000Z`);

    const entriesResult = await client.query(`
      select
        e.id as entry_id,
        e.driver_person_id,
        e.start_number_norm,
        e.orga_code,
        e.consent_media_accepted,
        e.tech_status,
        e.backup_tech_status,
        ec.name as class_name,
        p.first_name,
        p.last_name,
        p.birthdate,
        v.make as vehicle_make,
        v.model as vehicle_model,
        v.year as vehicle_year,
        bv.make as backup_vehicle_make,
        bv.model as backup_vehicle_model,
        e.backup_vehicle_id
      from entry e
      join person p on p.id = e.driver_person_id
      join class ec on ec.id = e.class_id
      join vehicle v on v.id = e.vehicle_id
      left join vehicle bv on bv.id = e.backup_vehicle_id
      where e.event_id = $1 and e.acceptance_status = 'accepted' and e.deleted_at is null
      order by ec.name, ${naturalStartNumberSort}
    `, [eventRow.id]);
    const entries = entriesResult.rows;

    const invoicesResult = await client.query(`select driver_person_id, payment_status, total_cents, paid_amount_cents from invoice where event_id = $1`, [eventRow.id]);
    const invoiceByDriver = new Map(invoicesResult.rows.map((row) => [row.driver_person_id, row]));

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const writeFile = (filename, buffer) => {
      const target = path.join(outputDir, filename);
      fs.writeFileSync(target, buffer);
      return target;
    };

    // Dedupe by driver for the two driver-level lists (a doppelstarter appears once).
    const driverRows = [...entries.reduce((map, row) => {
      if (!map.has(row.driver_person_id)) map.set(row.driver_person_id, row);
      return map;
    }, new Map()).values()];

    // 1. Offenes Nenngeld
    const unpaidDrivers = driverRows
      .filter((row) => (invoiceByDriver.get(row.driver_person_id)?.payment_status ?? 'due') === 'due')
      .sort((a, b) => `${a.class_name}|${a.start_number_norm}`.localeCompare(`${b.class_name}|${b.start_number_norm}`, 'de', { numeric: true }));
    const unpaidBuffer = await renderChecklistPdf('Offenes Nenngeld', [{
      heading: `${unpaidDrivers.length} Fahrer mit offenem Nenngeld`,
      headers: ['Bezahlt', 'Klasse', 'Nr.', 'Fahrer'],
      rows: unpaidDrivers.map((row) => ['', row.class_name, row.start_number_norm ?? '-', displayName(row)]),
      widths: [70, 190, 60, 250],
      checkboxColumns: [0],
      minimumRowHeight: 30
    }], 'portrait', fonts);
    writeFile('01-offenes-nenngeld.pdf', unpaidBuffer);

    // 2. Ärztliches Attest ab 70 Jahren
    const medicalDrivers = driverRows
      .filter((row) => {
        const age = ageAt(row.birthdate, eventStart);
        return age !== null && age >= 70;
      })
      .sort((a, b) => `${a.class_name}|${a.start_number_norm}`.localeCompare(`${b.class_name}|${b.start_number_norm}`, 'de', { numeric: true }));
    const medicalBuffer = await renderChecklistPdf('Ärztliches Attest erforderlich (ab 70 Jahren)', [{
      heading: `${medicalDrivers.length} Fahrer ab 70 Jahren`,
      headers: ['Attest', 'Klasse', 'Nr.', 'Fahrer', 'Geburtsdatum'],
      rows: medicalDrivers.map((row) => ['', row.class_name, row.start_number_norm ?? '-', displayName(row), formatDate(row.birthdate)]),
      widths: [65, 170, 55, 220, 90],
      checkboxColumns: [0],
      minimumRowHeight: 30
    }], 'portrait', fonts);
    writeFile('02-aerztliches-attest-u70.pdf', medicalBuffer);

    // 3. Fallback-Prüfblatt Technische Abnahme, je Klasse
    const entriesByClass = [...entries.reduce((map, row) => {
      const list = map.get(row.class_name) ?? [];
      list.push(row);
      map.set(row.class_name, list);
      return map;
    }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true }));
    const inspectionSections = entriesByClass.map(([className, rows]) => ({
      heading: className,
      headers: ['Nr.', 'Fahrer', 'Fahrzeug', 'Bestanden', 'Notiz'],
      rows: rows.map((row) => {
        const vehicleParts = [row.vehicle_make, row.vehicle_model, row.vehicle_year ? String(row.vehicle_year) : null].filter(Boolean);
        const vehicleLabel = row.backup_vehicle_id
          ? `${vehicleParts.join(' ')} (+ Ersatz: ${[row.backup_vehicle_make, row.backup_vehicle_model].filter(Boolean).join(' ')})`
          : vehicleParts.join(' ');
        return [row.start_number_norm ?? '-', displayName(row), vehicleLabel, '', ''];
      }),
      widths: [50, 170, 220, 65, 220],
      checkboxColumns: [3],
      minimumRowHeight: 34
    }));
    const inspectionBuffer = await renderChecklistPdf('Technische Abnahme – Fallback-Prüfblatt', inspectionSections, 'landscape', fonts);
    writeFile('03-technische-abnahme-fallback.pdf', inspectionBuffer);

    // 4. Medien im Anmeldeformular abgelehnt
    const mediaDeclinedDrivers = driverRows
      .filter((row) => !row.consent_media_accepted)
      .sort((a, b) => `${a.class_name}|${a.start_number_norm}`.localeCompare(`${b.class_name}|${b.start_number_norm}`, 'de', { numeric: true }));
    const mediaBuffer = await renderChecklistPdf('Medien-Einwilligung abgelehnt', [{
      heading: `${mediaDeclinedDrivers.length} Fahrer ohne Medien-Einwilligung`,
      headers: ['Klasse', 'Nr.', 'Fahrer'],
      rows: mediaDeclinedDrivers.map((row) => [row.class_name, row.start_number_norm ?? '-', displayName(row)]),
      widths: [190, 60, 320],
      minimumRowHeight: 26
    }], 'portrait', fonts);
    writeFile('04-medien-abgelehnt.pdf', mediaBuffer);

    console.log(JSON.stringify({
      event: { id: eventRow.id, name: eventRow.name, startsAt: eventRow.starts_at },
      outputDir,
      counts: {
        unpaidDrivers: unpaidDrivers.length,
        medicalDrivers: medicalDrivers.length,
        inspectionEntries: entries.length,
        inspectionClasses: entriesByClass.length,
        mediaDeclinedDrivers: mediaDeclinedDrivers.length
      }
    }, null, 2));

    await client.query('rollback');
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
