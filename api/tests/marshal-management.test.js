const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseMarshalAssignmentCell, parseMarshalWorkbookBuffer } = require('../dist/routes/adminMarshals');
const { getAuthContext, hasPermission } = require('../dist/http/auth');

const eventWithClaims = (claims) => ({ requestContext: { authorizer: { jwt: { claims } } } });

async function run() {
  const manager = getAuthContext(eventWithClaims({ sub: 'josi', 'cognito:groups': '["marshal_manager"]' }));
  assert.deepEqual(manager.groups, ['marshal_manager']);
  assert.equal(hasPermission(manager, 'marshals.read'), true);
  assert.equal(hasPermission(manager, 'marshals.write'), true);
  assert.equal(hasPermission(manager, 'entries.read'), false);

  const admin = getAuthContext(eventWithClaims({ sub: 'admin', 'cognito:groups': '["admin"]' }));
  assert.equal(hasPermission(admin, 'marshals.export'), true);

  assert.deepEqual(parseMarshalAssignmentCell(' 5/2'), {
    commitmentStatus: 'accepted', role: 'marshal', code: '5/2', functionCode: null
  });
  assert.deepEqual(parseMarshalAssignmentCell('AL 5'), {
    commitmentStatus: 'accepted', role: 'section_leader', code: null, functionCode: 'AL4'
  });
  assert.equal(parseMarshalAssignmentCell('evtl 2/3').commitmentStatus, 'tentative');
  assert.equal(parseMarshalAssignmentCell('nein').commitmentStatus, 'declined');

  const workbook = new ExcelJS.Workbook();
  const master = workbook.addWorksheet('Vorlage Lily 2022');
  master.addRow(['Helfernummer', 'Name', 'Vorname', 'Adresse', 'Postleitzahl', 'Wohnort', 'Geburtsdatum', 'Telefonnummer', 'Email-Adresse', 'Bereich', 'Vereinsmitglied', 'T-Shirt', 'Notiz', '', 'Kennzeichen', 'DMSB-Lizenz']);
  master.addRow([67, 'Anders', 'Steffen', 'Alt 1', '02763', 'Mittelherwigsdorf', new Date('1957-04-12'), '123', 'alt@example.org', 'Strecke', true, 'H-L', '', '', 'ZI-A', 'SP-67']);
  const current = workbook.addWorksheet('Helfernummern gesamt');
  current.addRow([]); current.addRow([]); current.addRow([]);
  current.addRow(['Telefonhelfer', 'Helfernummer', 'Name', 'Vorname', 'Adresse', 'PLZ', 'Wohnort', 'Geburtsdatum', 'Telefonnummer', 'Email-Adresse', 'Bereich', 'T-Shirt', 'Notiz', 'Angemeldet', 'Sa', 'So', 'Wunsch']);
  current.addRow(['Josi', 67, 'Anders', 'Steffen', 'Neu 2', '02763', 'Mittelherwigsdorf', new Date('1957-04-12'), '456', 'neu@example.org', 'Strecke', 'H-XL', '', 'x', '5/2', 'nein', 'gleicher Posten']);
  current.addRow(['Josi', 753, 'Baldt', 'Fabian', 'Weg 3', '02796', 'Jonsdorf', new Date('2008-06-02'), '789', '', 'Strecke', 'H-XL', 'neu', 'x', '4/5', '4/5', '']);
  const saturday2024 = workbook.addWorksheet('Samstag 2024');
  saturday2024.addRow([]); saturday2024.addRow(['Name', 'Vorname', 'T-Shirt', 'erhalten', 'Posten']);
  saturday2024.addRow(['Anders', 'Steffen', 'H-L', '', '5/2']);
  const training = workbook.addWorksheet('Lizenzschulung 29.03.2025');
  for (let i = 0; i < 6; i += 1) training.addRow([]);
  training.addRow([67, 'Anders', 'Steffen']);
  const briefing = workbook.addWorksheet('Einweisung 11.09.2025');
  briefing.addRow([]); briefing.addRow(['Name', 'Vorname']); briefing.addRow(['Baldt', 'Fabian']);

  const parsed = await parseMarshalWorkbookBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(parsed.people.length, 2);
  assert.equal(parsed.participations.length, 2);
  assert.equal(parsed.historicalAssignments.length, 1);
  assert.equal(parsed.trainings.length, 2);
  assert.equal(parsed.people.find((person) => person.helperNumber === 67).street, 'Neu 2');
  assert.equal(parsed.people.find((person) => person.helperNumber === 67).licenseNumber, 'SP-67');
  assert.equal(parsed.conflicts.length, 0);

  console.log('marshal management tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
