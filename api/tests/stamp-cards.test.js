const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit/js/pdfkit.standalone');
const { renderStampCardPdf, validateStampCardExportInput } = require('../dist/routes/stampCards');
const { defaultStampCardAccentColor } = require('../dist/routes/adminEvents');

const eventId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';

assert.deepEqual(validateStampCardExportInput({ eventId, selection: { type: 'accepted_regular' } }), {
  eventId,
  startSlot: 1,
  selection: { type: 'accepted_regular' }
});

assert.equal(validateStampCardExportInput({
  eventId,
  startSlot: 10,
  selection: { type: 'subjects', subjects: [{ cardType: 'driver', personId }] }
}).startSlot, 10);

assert.throws(() => validateStampCardExportInput({ eventId, startSlot: 11, selection: { type: 'accepted_regular' } }));
assert.throws(() => validateStampCardExportInput({ eventId, startSlot: 1, selection: { type: 'subjects', subjects: [] } }));
assert.deepEqual(
  [2026, 2027, 2028, 2029, 2030].map((year) => defaultStampCardAccentColor(`${year}-07-31`)),
  ['#153A81', '#B5121B', '#1F7A4D', '#C9A227', '#153A81']
);

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/stampCards.ts'), 'utf8');
const handlerSource = fs.readFileSync(path.join(__dirname, '../src/handler.ts'), 'utf8');
const apiStackSource = fs.readFileSync(path.join(__dirname, '../../infra/lib/stacks/api-stack.ts'), 'utf8');
const storageStackSource = fs.readFileSync(path.join(__dirname, '../../infra/lib/stacks/storage-stack.ts'), 'utf8');
const migrationSource = fs.readFileSync(path.join(__dirname, '../migrations/0078_stamp_card_design_palette.sql'), 'utf8');
const stampCardHandlerBlock = handlerSource.slice(
  handlerSource.indexOf("path === '/admin/stamp-cards/export'"),
  handlerSource.indexOf('const inspectionQrExportMatch')
);
assert.match(routeSource, /await uploadPdf\(s3Key, data\)/);
assert.match(routeSource, /getPresignedDownloadUrl\(s3Key, 300, filename\)/);
assert.match(routeSource, /for \(let row = 0; row < matrix\.size; row \+= 1\)/);
assert.match(routeSource, /const shortYear = year\.slice\(-2\)/);
assert.match(routeSource, /errorCorrectionLevel|buildQrCodeMatrix\(inspectionUrl\(eventId, card\.personId\), 'H'\)/);
assert.match(routeSource, /const clearSize = mm\(8\)/);
assert.match(routeSource, /fillColor\('#FFFFFF'\)\.rect\(clearX, clearY, clearSize, clearSize\)\.fill\(\)/);
assert.match(routeSource, /public\/stamp-cards\/msc-logo-clean-transparent\.png/);
assert.match(routeSource, /public\/stamp-cards\/fonts\/oswald-700\.ttf/);
assert.match(routeSource, /drawCornerLogo\(doc, cornerLogoImage, logoRight, y \+ mm\(5\)\)/);
assert.match(routeSource, /const logoRight = x \+ CARD_WIDTH - mm\(3\.6\) - logoQuietInset/);
assert.match(routeSource, /drawDriverBanner\(doc, visibleQrX, qrY - mm\(6\), visibleQrWidth, accentColor, fonts\)/);
assert.match(routeSource, /const visibleQrBottom = y \+ CARD_HEIGHT - mm\(4\) \+ BOTTOM_EDGE_COMPENSATION/);
assert.match(routeSource, /const BOTTOM_EDGE_COMPENSATION = STAMP_BOX_STROKE_WIDTH \/ 2/);
assert.match(routeSource, /const qrY = visibleQrBottom - qrSize \+ quietInset/);
assert.match(routeSource, /const visibleQrWidth = matrix\.size \* module/);
assert.doesNotMatch(routeSource, /fillColor\(accentColor\)\.rect\(x, y, size, size\)\.fill\(\)/);
assert.match(routeSource, /\['TA', 'FB', 'FB'\]/);
assert.match(routeSource, /\['FB', 'FB'\]/);
assert.match(routeSource, /CHARITY-BEIFAHRER/);
assert.match(routeSource, /fillColor\(accentColor\)\.rect\(roleX, y, roleWidth, height\)\.fill\(\)/);
assert.match(routeSource, /\.text\(year, yearX/);
assert.match(routeSource, /mergeDriverName\(codriver, standardPersonIdentity\(\{ firstName: row\.driverFirstName, lastName: row\.driverLastName, publicationName: row\.driverPublicationName \}\)\.displayName\)/);
assert.match(routeSource, /type: 'stamp_cards_pdf'/);
assert.match(routeSource, /exportJobPerson/);
assert.match(routeSource, /const driverLine = `BEI /);
assert.match(routeSource, /const nameY = y \+ mm\(4\)/);
assert.match(routeSource, /const nameWidth = logoLeft - contentLeft - mm\(2\)/);
assert.match(routeSource, /const fittedNumberSize = fitText\(doc\.font\(fonts\.display\), numberText, numberWidth, numberSize, 7\.5\)/);
assert.match(routeSource, /const numberX = left \+ width - doc\.widthOfString\(numberText\)/);
assert.doesNotMatch(routeSource, /text\(`#\$\{start\.startNumber\}`[^;]+width: numberWidth/s);
assert.doesNotMatch(routeSource, /drawCornerMarks/);
assert.match(routeSource, /data:image\/png;base64/);
assert.match(storageStackSource, /destinationKeyPrefix: 'public\/stamp-cards'/);
assert.match(migrationSource, /when 2026 then '#153A81'/i);
assert.match(migrationSource, /upper\("stamp_card_accent_color"\) = '#0F6B65'/i);
assert.match(stampCardHandlerBlock, /downloadUrl: download\.downloadUrl/);
assert.doesNotMatch(stampCardHandlerBlock, /dataBase64: download\.data\.toString\('base64'\)/);
assert.match(stampCardHandlerBlock, /console\.error\('stamp_card_export_failed'/);
assert.match(apiStackSource, /memorySize: 1024/);
assert.match(apiStackSource, /timeout: cdk\.Duration\.seconds\(29\)/);

const assetRoot = path.join(__dirname, '../../infra/assets/stamp-cards');
const cornerLogoBuffer = fs.readFileSync(path.join(assetRoot, 'msc-logo-clean-transparent.png'));
assert.equal(cornerLogoBuffer.readUInt8(25), 6, 'corner logo must be an RGBA PNG');
const displayFont = fs.readFileSync(path.join(assetRoot, 'fonts/oswald-700.ttf'));
const textFont = fs.readFileSync(path.join(assetRoot, 'fonts/barlow-500.ttf'));
const boldFont = fs.readFileSync(path.join(assetRoot, 'fonts/barlow-700.ttf'));
const previewDocument = new PDFDocument({ size: [243.8, 155.65], margin: 0 });
const previewCornerLogo = previewDocument.openImage(`data:image/png;base64,${cornerLogoBuffer.toString('base64')}`);
assert.equal(previewCornerLogo.width, 1254);
assert.equal(previewCornerLogo.height, 1254);
assert.doesNotThrow(() => previewDocument.image(previewCornerLogo, 8, 4, { fit: [26, 26] }));
assert.doesNotThrow(() => previewDocument.registerFont('OswaldPreview', displayFont));
assert.doesNotThrow(() => previewDocument.registerFont('BarlowPreview', textFont));
assert.doesNotThrow(() => previewDocument.registerFont('BarlowBoldPreview', boldFont));
previewDocument.on('data', () => {});
previewDocument.end();

const cards = [
  {
    key: `driver:${personId}`,
    kind: 'driver',
    personId,
    personName: 'Jürgen Weiß-Zimmermann',
    starts: [
      { className: 'Klasse 1 · Motorräder bis Baujahr 1949', startNumber: '4' },
      { className: 'Klasse 6 · Rennmotorräder 500–1000 cm³ bis Baujahr 1995', startNumber: '410' },
      { className: 'Klasse 7 · Seitenwagen offen', startNumber: '65' },
      { className: 'Sonderklasse historische Fahrzeuge', startNumber: '101' },
      { className: 'Zusätzlicher Start', startNumber: '202' }
    ]
  },
  {
    key: 'driver:55555555-5555-4555-8555-555555555555',
    kind: 'driver',
    personId: '55555555-5555-4555-8555-555555555555',
    personName: 'Lukas Pötschke',
    starts: [{ className: 'Sonderlauf', startNumber: '500' }]
  },
  {
    key: 'regular:33333333-3333-4333-8333-333333333333',
    kind: 'regular_codriver',
    personId: '33333333-3333-4333-8333-333333333333',
    personName: 'Anna Beispiel',
    driverNames: ['Dietmar Zimmermann'],
    starts: [{ className: 'Klasse 7 · Seitenwagen offen', startNumber: '65' }]
  },
  {
    key: 'charity:44444444-4444-4444-8444-444444444444',
    kind: 'charity_codriver',
    registrationId: '44444444-4444-4444-8444-444444444444',
    personName: 'Maria Musterfrau',
    driverNames: ['Dietmar Zimmermann'],
    starts: [{ className: 'Charity-Runde · Seitenwagen', startNumber: '65' }]
  }
];

const main = async () => {
  process.env.MAIL_PUBLIC_BASE_URL = 'https://example.test';
  const data = await renderStampCardPdf({
    cards,
    eventId,
    startSlot: 10,
    year: '2026',
    accentColor: '#153A81',
    assets: { cornerLogo: cornerLogoBuffer, displayFont, textFont, boldFont }
  });
  assert.equal(data.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(data.length > 50_000);

  const fallbackData = await renderStampCardPdf({
    cards: cards.slice(1),
    eventId,
    startSlot: 1,
    year: '2026',
    accentColor: '#153A81',
    assets: { cornerLogo: null, displayFont: null, textFont: null, boldFont: null }
  });
  assert.equal(fallbackData.subarray(0, 4).toString('ascii'), '%PDF');

  console.log('stamp-card contract tests passed');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
