const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  indexMarshalPeopleByNormalizedName,
  parseMarshalAssignmentCell,
  parseMarshalWorkbookBuffer,
  resolveMarshalEmergencyTargetStaff,
  validateMarshalAreaAssignmentInput,
  validateMarshalAreaConfigInput,
  validateMarshalAssignmentInput,
  validateMarshalConfigInput,
  validateMarshalPersonPatch,
  validateMarshalResetInput,
  validateMarshalShiftAssignmentInput
} = require('../dist/routes/adminMarshals');
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
  const editor = getAuthContext(eventWithClaims({ sub: 'editor', 'cognito:groups': '["editor"]' }));
  assert.equal(hasPermission(editor, 'marshals.read'), false);

  const normalizedPeople = indexMarshalPeopleByNormalizedName([
    { id: 'higher', helperNumber: 20, firstName: ' Lina ', lastName: 'Läufer' },
    { id: 'lower', helperNumber: 10, firstName: 'Lina', lastName: 'Läufer' }
  ]);
  assert.equal(normalizedPeople.get('lina läufer'), 'lower', 'duplicate normalized names resolve deterministically');

  assert.deepEqual(validateMarshalPersonPatch({ noDeployment: true }), { noDeployment: true });
  assert.throws(() => validateMarshalPersonPatch({ noDeployment: 'yes' }));

  const eventId = '11111111-1111-4111-8111-111111111111';
  const areaId = '33333333-3333-4333-8333-333333333333';
  const shiftId = '44444444-4444-4444-8444-444444444444';
  const dayId = '55555555-5555-4555-8555-555555555555';
  const areaAssignment = { eventId, areaId, commitmentStatus: 'accepted', note: 'Samstag' };
  const shiftAssignment = { eventId, shiftId, commitmentStatus: 'tentative' };
  assert.deepEqual(validateMarshalAreaAssignmentInput(areaAssignment), areaAssignment);
  assert.deepEqual(validateMarshalShiftAssignmentInput(shiftAssignment), shiftAssignment);
  assert.throws(() => validateMarshalAreaAssignmentInput({ ...areaAssignment, eventId: 'invalid' }));
  assert.throws(() => validateMarshalShiftAssignmentInput({ ...shiftAssignment, commitmentStatus: 'unknown' }));
  assert.deepEqual(validateMarshalResetInput({ scope: 'assignments' }), { scope: 'assignments' });
  assert.throws(() => validateMarshalResetInput({ scope: 'people' }));
  assert.throws(() => validateMarshalResetInput({ scope: 'assignments', extra: true }));
  assert.deepEqual(validateMarshalAssignmentInput({
    eventId,
    days: [{ dayId, commitmentStatus: 'accepted' }]
  }).days[0].dayId, dayId);
  assert.throws(() => validateMarshalAssignmentInput({
    eventId,
    days: [{ dayId, commitmentStatus: 'accepted' }, { dayId, commitmentStatus: 'declined' }]
  }), /Day assignments must be unique/);

  assert.deepEqual(parseMarshalAssignmentCell(' 5/2'), {
    commitmentStatus: 'accepted', role: 'marshal', code: '5/2', functionCode: null
  });
  assert.deepEqual(parseMarshalAssignmentCell('AL 5'), {
    commitmentStatus: 'accepted', role: 'section_leader', code: null, functionCode: 'AL4'
  });
  assert.equal(parseMarshalAssignmentCell('evtl 2/3').commitmentStatus, 'tentative');
  assert.equal(parseMarshalAssignmentCell('nein').commitmentStatus, 'declined');

  const config = {
    eventId,
    sections: [{ code: '1', name: 'Abschnitt 1', leaderCode: 'AL1', sortOrder: 1 }],
    posts: [{ sectionCode: '1', code: '1/1', targetStaff: 3, emergencyTargetStaff: 2, mapX: 0, mapY: 1000, isActive: true, sortOrder: 1 }]
  };
  assert.deepEqual(validateMarshalConfigInput(config), config);
  assert.throws(() => validateMarshalConfigInput({
    ...config, posts: [{ ...config.posts[0], targetStaff: 2, emergencyTargetStaff: 3 }]
  }), /Emergency target staff must not exceed normal target staff/);
  assert.throws(() => validateMarshalConfigInput({
    ...config, posts: [{ ...config.posts[0], mapY: undefined }]
  }), /Map coordinates must be provided together/);
  assert.throws(() => validateMarshalConfigInput({
    ...config, posts: [{ ...config.posts[0], mapX: null }]
  }), /Map coordinates must be provided together/);
  assert.throws(() => validateMarshalConfigInput({
    ...config, posts: [{ ...config.posts[0], mapX: -1 }]
  }));
  assert.throws(() => validateMarshalConfigInput({
    ...config, posts: [{ ...config.posts[0], mapY: 1001 }]
  }));
  const legacyConfig = {
    ...config,
    posts: [{ sectionCode: '1', code: '1/1', targetStaff: 3, isActive: true, sortOrder: 1 }]
  };
  assert.deepEqual(validateMarshalConfigInput(legacyConfig), legacyConfig);
  assert.equal(resolveMarshalEmergencyTargetStaff(3, 2), 2);
  assert.equal(resolveMarshalEmergencyTargetStaff(2, 2), 2);
  assert.equal(resolveMarshalEmergencyTargetStaff(2, 4), 2);
  assert.equal(resolveMarshalEmergencyTargetStaff(2, 4, 3), 3);

  const areaConfig = {
    eventId,
    areas: [
      { code: 'setup_fl1', name: 'Aufbau Fahrerlager 1', areaType: 'setup', dayScope: null, sortOrder: 10 },
      { code: 'general_saturday', name: 'Allgemeine Helfer', areaType: 'general', dayScope: 'saturday', sortOrder: 30 }
    ],
    shifts: [{ areaCode: 'setup_fl1', label: 'Montag', shiftDate: '2026-08-24', sortOrder: 10 }]
  };
  assert.deepEqual(validateMarshalAreaConfigInput(areaConfig), areaConfig);
  assert.throws(() => validateMarshalAreaConfigInput({
    ...areaConfig,
    areas: [...areaConfig.areas, areaConfig.areas[0]]
  }), /Area codes must be unique/);
  assert.throws(() => validateMarshalAreaConfigInput({
    ...areaConfig,
    shifts: [{ areaCode: 'general_saturday', label: 'Samstag', shiftDate: '2026-08-29', sortOrder: 10 }]
  }), /Shifts are only valid for setup areas/);
  assert.throws(() => validateMarshalAreaConfigInput({
    ...areaConfig,
    areas: [{ ...areaConfig.areas[0], areaType: 'general', dayScope: 'saturday' }]
  }), /Default area type and day scope cannot be changed/);

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
  const laufer = workbook.addWorksheet('Team_Laufer_2023');
  laufer.addRow(['Name', 'Vorname', 'Geburtsdatum', 'Straße', 'PLZ', 'Ort', 'Telefon', 'E-Mail', 'Kennzeichen', 'Shirt']);
  laufer.addRow(['Läufer', 'Lina', 'Kind 12', 'Weg 4', 2763, 'Gesamt Helfer', '0123', 'keine Mail', 'ZI-L 1', 'M']);
  laufer.addRow(['Team', 'Tom', new Date('1990-01-02'), 'Weg 5', '02763', 'Zittau', '0456', 'tom@example.org', 'ZI-T 2', 'L']);
  const briefing = workbook.addWorksheet('Einweisung 11.09.2025');
  briefing.addRow([]); briefing.addRow(['Name', 'Vorname']); briefing.addRow(['Baldt', 'Fabian']);

  const parsed = await parseMarshalWorkbookBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(parsed.people.length, 2);
  assert.equal(parsed.participations.length, 2);
  assert.equal(parsed.historicalAssignments.length, 1);
  assert.equal(parsed.trainings.length, 2);
  assert.equal(parsed.lauferPeople.length, 2);
  assert.equal(parsed.lauferPeople[0].helperNumber, 0);
  assert.equal(parsed.lauferPeople[0].birthdate, null);
  assert.equal(parsed.lauferPeople[0].city, null);
  assert.equal(parsed.lauferPeople[0].email, null);
  assert.equal(parsed.lauferPeople[0].note, 'Originalfeld: Gesamt Helfer');
  assert.equal(parsed.lauferPeople[1].birthdate, '1990-01-02');
  assert.equal(parsed.lauferPeople[1].city, 'Zittau');
  assert.equal(parsed.lauferPeople[1].email, 'tom@example.org');
  assert.equal(parsed.people.find((person) => person.helperNumber === 67).street, 'Neu 2');
  assert.equal(parsed.people.find((person) => person.helperNumber === 67).licenseNumber, 'SP-67');
  assert.equal(parsed.conflicts.length, 0);

  const teamOnlyWorkbook = new ExcelJS.Workbook();
  const teamOnly = teamOnlyWorkbook.addWorksheet('Team_Laufer_2023');
  teamOnly.addRow(['Name', 'Vorname', 'Geburtsdatum', 'Straße', 'PLZ', 'Ort', 'Telefon', 'E-Mail', 'Kennzeichen', 'Shirt']);
  teamOnly.addRow(['Solo', 'Sina', 'Kind unter 10', '', '', 'Verpflegung FL 2', '', '', '', 'S']);
  const parsedTeamOnly = await parseMarshalWorkbookBuffer(Buffer.from(await teamOnlyWorkbook.xlsx.writeBuffer()));
  assert.equal(parsedTeamOnly.people.length, 0);
  assert.equal(parsedTeamOnly.lauferPeople.length, 1);
  assert.equal(parsedTeamOnly.lauferPeople[0].birthdate, null);
  assert.equal(parsedTeamOnly.lauferPeople[0].city, null);
  assert.equal(parsedTeamOnly.lauferPeople[0].note, 'Originalfeld: Verpflegung FL 2');

  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminMarshals.ts'), 'utf8');
  const handlerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'handler.ts'), 'utf8');
  const infraSource = fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'lib', 'stacks', 'api-stack.ts'), 'utf8');
  const schemaSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.ts'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0068_helper_areas.sql'), 'utf8');

  for (const route of [
    '/admin/marshals/area-assignments/{personId}',
    '/admin/marshals/shift-assignments/{personId}',
    '/admin/marshals/events/{eventId}/reset',
    '/admin/marshals/config/areas'
  ]) {
    assert.ok(infraSource.includes(`path: '${route}'`), `API Gateway route missing: ${route}`);
  }
  assert.match(infraSource, /area-assignments\/\{personId\}'[\s\S]*methods: \[apigwv2\.HttpMethod\.PUT\]/);
  assert.match(infraSource, /shift-assignments\/\{personId\}'[\s\S]*methods: \[apigwv2\.HttpMethod\.PUT\]/);
  assert.match(infraSource, /events\/\{eventId\}\/reset'[\s\S]*methods: \[apigwv2\.HttpMethod\.POST\]/);
  assert.match(infraSource, /config\/areas'[\s\S]*methods: \[apigwv2\.HttpMethod\.PUT\]/);
  assert.match(infraSource, /persons\/\{id\}'[\s\S]*HttpMethod\.PATCH, apigwv2\.HttpMethod\.DELETE/);
  assert.match(handlerSource, /DELETE'[\s\S]*marshalPersonMatch[\s\S]*marshals\.write/);
  assert.match(handlerSource, /marshalEventResetMatch[\s\S]*validateMarshalResetInput\(parseJsonBody\(event\)\)/);
  assert.match(handlerSource, /MARSHAL_AREA_SCOPE_INVALID/);
  assert.match(handlerSource, /MARSHAL_SHIFT_SCOPE_INVALID/);

  assert.match(routeSource, /export const upsertMarshalAssignment[\s\S]*db\.transaction\(async \(tx\)/);
  assert.match(routeSource, /marshalEventDay\.eventId, input\.eventId/);
  assert.match(routeSource, /marshalHelperArea\.id, input\.areaId[\s\S]*marshalHelperArea\.eventId, input\.eventId/);
  assert.match(routeSource, /marshalAreaShift\.id, input\.shiftId[\s\S]*marshalHelperArea\.eventId, input\.eventId[\s\S]*marshalHelperArea\.areaType, 'setup'/);
  assert.match(routeSource, /export const resetMarshalEventAssignments[\s\S]*marshalDayAssignment[\s\S]*marshalAreaAssignment[\s\S]*marshalShiftAssignment/);
  assert.match(routeSource, /export const resetMarshalEventAssignments[\s\S]*commitmentStatus: 'not_asked',[\s\S]*role: null,[\s\S]*sectionId: null,[\s\S]*postId: null,[\s\S]*functionCode: null/);
  assert.match(routeSource, /export const replaceMarshalAreaConfig[\s\S]*db\.transaction/);
  assert.match(routeSource, /omittedCustomAreaIds/);
  assert.match(routeSource, /omittedShiftIds/);
  assert.match(routeSource, /LOCK TABLE marshal_person IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(routeSource, /const allPeople = await tx\.select\(\)\.from\(marshalPerson\)/);
  assert.match(routeSource, /knownNamesNow = indexMarshalPeopleByNormalizedName\(allPeople\)/);
  assert.match(routeSource, /const orderBy = input\.type === 'section'\s*\? \[sql`\$\{marshalPost\.sortOrder\} asc nulls first`, asc\(marshalPerson\.lastName\), asc\(marshalPerson\.firstName\)\]\s*: \[asc\(marshalPerson\.lastName\), asc\(marshalPerson\.firstName\)\]/);
  assert.match(routeSource, /\.where\(and\(\.\.\.filters\)\)\.orderBy\(\.\.\.orderBy\)/);
  assert.match(routeSource, /areas, areaShifts: areaShifts\.map[\s\S]*areaAssignments, shiftAssignments/);

  assert.match(schemaSource, /noDeployment: boolean\('no_deployment'\)/);
  for (const table of ['marshal_helper_area', 'marshal_area_shift', 'marshal_shift_assignment', 'marshal_area_assignment']) {
    assert.ok(schemaSource.includes(`'${table}'`), `Drizzle schema missing ${table}`);
    assert.ok(migrationSource.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Migration missing ${table}`);
  }
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS no_deployment/);
  assert.match(migrationSource, /COMMENT ON COLUMN marshal_person\.no_deployment/);
  assert.match(migrationSource, /marshal_helper_area_event_sort_idx/);
  assert.match(migrationSource, /marshal_area_shift_area_sort_idx/);
  assert.match(migrationSource, /marshal_shift_assignment_shift_idx/);
  assert.match(migrationSource, /marshal_area_assignment_area_idx/);

  console.log('marshal management tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
