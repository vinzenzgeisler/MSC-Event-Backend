const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

process.env.MAIL_PUBLIC_BASE_URL = 'https://event.example.test/';

const {
  createInspectionQrDownload,
  validateInspectionDecisionInput
} = require('../dist/routes/technicalInspection');

void (async () => {
  assert.deepEqual(validateInspectionDecisionInput({ techStatus: 'passed', note: '' }), {
    techStatus: 'passed',
    note: ''
  });
  assert.throws(
    () => validateInspectionDecisionInput({ techStatus: 'failed', note: '   ' }),
    /A note is required/
  );
  assert.equal(
    validateInspectionDecisionInput({ techStatus: 'failed', note: 'Bremsleitung undicht' }).note,
    'Bremsleitung undicht'
  );

  const svg = await createInspectionQrDownload(
    '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
    'svg'
  );
  assert.equal(svg.mimeType, 'image/svg+xml');
  assert.match(svg.data.toString('utf8'), /<svg/);
  assert.match(svg.data.toString('utf8'), /<rect/);

  const png = await createInspectionQrDownload(
    '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
    'png'
  );
  assert.equal(png.mimeType, 'image/png');
  assert.equal(png.data.subarray(1, 4).toString('ascii'), 'PNG');

  const migration = readFileSync(
    join(__dirname, '..', 'migrations', '0058_technical_inspection_access_and_history.sql'),
    'utf8'
  );
  assert.match(migration, /technical_inspector_assignment/);
  assert.match(migration, /technical_inspection_decision/);
  assert.match(migration, /technical_inspection_decision_failed_note_check/);

  console.log('technical-inspection.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
