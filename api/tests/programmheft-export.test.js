const assert = require('node:assert/strict');

const {
  CLASS_SEVEN_HEADERS,
  getClassHeaders,
  getClassRowValues,
  getOverallRowValues,
  isClassSeven,
  NORMAL_CLASS_HEADERS,
  normalizeProgrammheftCity,
  normalizeProgrammheftName,
  OVERALL_HEADERS
} = require('../dist/domain/programmheftExport');

assert.equal(isClassSeven('Klasse 7 Seitenwagen offen'), true);
assert.equal(isClassSeven('  KLASSE7 Seitenwagen offen'), true);
assert.equal(isClassSeven('Klasse 70'), false);
assert.equal(isClassSeven('Klasse 17'), false);
assert.equal(isClassSeven('Sonderlauf Klasse 7'), false);

assert.equal(normalizeProgrammheftName('  mAX   mustERMANN '), 'Max Mustermann');
assert.equal(normalizeProgrammheftName('ANNA-LENA  o\'NEILL'), "Anna-Lena O'Neill");
assert.equal(normalizeProgrammheftCity('  OT   kleinWELKA '), 'OT Kleinwelka');
assert.equal(normalizeProgrammheftCity('oberhonnefeld-GIEREND'), 'Oberhonnefeld-Gierend');
assert.equal(normalizeProgrammheftCity('BAD ELSTER'), 'Bad Elster');

const baseRow = {
  startNumber: '007',
  className: 'Klasse 4 Rennmotorräder',
  driverFirstName: '  hENRIK ',
  driverLastName: ' FANGER',
  driverZip: '01234',
  driverCity: '  OT   kleinWELKA ',
  driverCountry: 'D',
  codriverFirstName: '  iRA ',
  codriverLastName: ' bORN ',
  vehicleMake: 'BMW',
  vehicleModel: 'R 50',
  vehicleYear: 1953,
  vehicleDisplacement: 250
};

assert.deepEqual(NORMAL_CLASS_HEADERS, [
  'Start-Nr.', 'Vorname', 'Nachname', 'PLZ', 'Ort', 'Fahrzeug', 'Modell', 'Baujahr', 'Hubraum', 'Land'
]);
assert.deepEqual(getClassHeaders(baseRow.className), NORMAL_CLASS_HEADERS);
assert.deepEqual(getClassRowValues(baseRow), [
  '007', 'Henrik', 'Fanger', '01234', 'OT Kleinwelka', 'BMW', 'R 50', 1953, 250, 'D'
]);

const classSevenRow = { ...baseRow, className: 'Klasse 7 Seitenwagen offen' };
assert.deepEqual(CLASS_SEVEN_HEADERS, [
  'Start-Nr.', 'Fahrer', '', 'Beifahr.', '', 'PLZ', 'Ort', 'Fahrzeug', 'Modell', 'Baujahr', 'Hubr.', 'Land'
]);
assert.deepEqual(getClassHeaders(classSevenRow.className), CLASS_SEVEN_HEADERS);
assert.deepEqual(getClassRowValues(classSevenRow), [
  '007', 'Henrik', 'Fanger', 'Ira', 'Born', '01234', 'OT Kleinwelka', 'BMW', 'R 50', 1953, 250, 'D'
]);

assert.deepEqual(OVERALL_HEADERS, [
  'Startnummer',
  'Fahrer Vorname',
  'Fahrer Nachname',
  'Fahrer PLZ',
  'Fahrer Ort',
  'Fabrikat',
  'Modell',
  'Baujahr',
  'Hubraum',
  'Fahrer Nationalität',
  'Klasse'
]);
assert.deepEqual(getOverallRowValues(classSevenRow), [
  '007', 'Henrik', 'Fanger', '01234', 'OT Kleinwelka', 'BMW', 'R 50', 1953, 250, 'D', 'Klasse 7 Seitenwagen offen'
]);

console.log('programmheft export tests passed');
