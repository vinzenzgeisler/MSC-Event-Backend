const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit/js/pdfkit.standalone');
const { validateStampCardExportInput } = require('../dist/routes/stampCards');

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

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/stampCards.ts'), 'utf8');
const handlerSource = fs.readFileSync(path.join(__dirname, '../src/handler.ts'), 'utf8');
const apiStackSource = fs.readFileSync(path.join(__dirname, '../../infra/lib/stacks/api-stack.ts'), 'utf8');
const storageStackSource = fs.readFileSync(path.join(__dirname, '../../infra/lib/stacks/storage-stack.ts'), 'utf8');
const stampCardHandlerBlock = handlerSource.slice(
  handlerSource.indexOf("path === '/admin/stamp-cards/export'"),
  handlerSource.indexOf('const inspectionQrExportMatch')
);
assert.match(routeSource, /await uploadPdf\(s3Key, data\)/);
assert.match(routeSource, /getPresignedDownloadUrl\(s3Key, 300, filename\)/);
assert.match(routeSource, /for \(let row = 0; row < matrix\.size; row \+= 1\)/);
assert.match(routeSource, /const shortYear = year\.slice\(-2\)/);
assert.match(routeSource, /fillColor\(accentColor\)\.roundedRect\(bx, by, badge, badge/);
assert.match(routeSource, /getAssetObjectBuffer\(STAMP_CARD_LOGO_KEY\)/);
assert.match(routeSource, /opacity\(0\.42\)\.image\(logoImage/);
assert.match(routeSource, /data:image\/png;base64/);
assert.match(storageStackSource, /destinationKeyPrefix: 'public\/stamp-cards'/);
assert.match(stampCardHandlerBlock, /downloadUrl: download\.downloadUrl/);
assert.doesNotMatch(stampCardHandlerBlock, /dataBase64: download\.data\.toString\('base64'\)/);
assert.match(stampCardHandlerBlock, /console\.error\('stamp_card_export_failed'/);
assert.match(apiStackSource, /memorySize: 1024/);
assert.match(apiStackSource, /timeout: cdk\.Duration\.seconds\(29\)/);

const logoBuffer = fs.readFileSync(path.join(__dirname, '../../infra/assets/stamp-cards/msc-wordmark.png'));
const previewDocument = new PDFDocument({ size: [243.8, 155.65], margin: 0 });
const previewLogo = previewDocument.openImage(`data:image/png;base64,${logoBuffer.toString('base64')}`);
assert.equal(previewLogo.width, 320);
assert.equal(previewLogo.height, 267);
assert.doesNotThrow(() => previewDocument.image(previewLogo, 8, 4, { fit: [39, 27] }));
previewDocument.on('data', () => {});
previewDocument.end();

console.log('stamp-card contract tests passed');
