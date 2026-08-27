import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  event,
  marshalAreaAssignment,
  marshalAreaShift,
  marshalDayAssignment,
  marshalEventDay,
  marshalEventParticipation,
  marshalHelperArea,
  marshalImportRun,
  marshalPerson,
  marshalPost,
  marshalQualification,
  marshalSection,
  marshalShiftAssignment,
  marshalTrainingParticipant,
  marshalTrainingSession
} from '../db/schema';

const personInputSchema = z.object({
  helperNumber: z.number().int().positive(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  street: z.string().trim().max(200).nullable().optional(),
  zip: z.string().trim().max(20).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  birthdate: z.string().date().nullable().optional(),
  phone: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  shirtSize: z.string().trim().max(30).nullable().optional(),
  clubMember: z.boolean().optional(),
  licenseNumber: z.string().trim().max(100).nullable().optional(),
  vehicleRegistration: z.string().trim().max(100).nullable().optional(),
  activityAreas: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  note: z.string().trim().max(4000).nullable().optional(),
  isActive: z.boolean().optional(),
  noDeployment: z.boolean().optional()
});

const personPatchSchema = personInputSchema.omit({ helperNumber: true }).partial();
const assignmentInputSchema = z.object({
  eventId: z.string().uuid(),
  contactOwner: z.string().trim().max(100).nullable().optional(),
  wish: z.string().trim().max(1000).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  shirtSizeSnapshot: z.string().trim().max(30).nullable().optional(),
  days: z.array(z.object({
    dayId: z.string().uuid(),
    commitmentStatus: z.enum(['not_asked', 'pending', 'accepted', 'declined', 'tentative']),
    role: z.enum(['marshal', 'section_leader', 'special']).nullable().optional(),
    sectionId: z.string().uuid().nullable().optional(),
    postId: z.string().uuid().nullable().optional(),
    functionCode: z.string().trim().max(100).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional()
  })).max(2)
}).strict().superRefine((input, context) => {
  const dayIds = input.days.map((day) => day.dayId);
  if (new Set(dayIds).size !== dayIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['days'], message: 'Day assignments must be unique' });
  }
});

const areaAssignmentInputSchema = z.object({
  eventId: z.string().uuid(),
  areaId: z.string().uuid(),
  commitmentStatus: z.enum(['not_asked', 'pending', 'accepted', 'declined', 'tentative']),
  note: z.string().trim().max(1000).nullable().optional()
}).strict();

const areaAssignmentDeleteInputSchema = z.object({
  eventId: z.string().uuid(),
  areaId: z.string().uuid()
}).strict();

const shiftAssignmentInputSchema = z.object({
  eventId: z.string().uuid(),
  shiftId: z.string().uuid(),
  commitmentStatus: z.enum(['not_asked', 'pending', 'accepted', 'declined', 'tentative']),
  note: z.string().trim().max(1000).nullable().optional()
}).strict();

const resetAssignmentsInputSchema = z.object({
  scope: z.literal('assignments')
}).strict();

const areaConfigInputSchema = z.object({
  eventId: z.string().uuid(),
  areas: z.array(z.object({
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(100),
    areaType: z.enum(['setup', 'general']),
    dayScope: z.enum(['saturday', 'sunday']).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100),
    responsibleLabel: z.string().trim().max(100).nullable().optional()
  })).max(20),
  shifts: z.array(z.object({
    areaCode: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(100),
    shiftDate: z.string().date(),
    sortOrder: z.number().int().min(0).max(100)
  })).max(50)
}).strict().superRefine((input, context) => {
  const areaByCode = new Map(input.areas.map((area) => [area.code, area]));
  if (areaByCode.size !== input.areas.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['areas'], message: 'Area codes must be unique' });
  }
  const protectedAreas: Record<string, { areaType: 'setup' | 'general'; dayScope: 'saturday' | 'sunday' | null }> = {
    setup_fl1: { areaType: 'setup', dayScope: null },
    setup_fl2: { areaType: 'setup', dayScope: null },
    general_saturday: { areaType: 'general', dayScope: 'saturday' },
    general_sunday: { areaType: 'general', dayScope: 'sunday' }
  };
  input.areas.forEach((area, index) => {
    if ((area.areaType === 'setup' && area.dayScope != null) || (area.areaType === 'general' && area.dayScope == null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['areas', index, 'dayScope'], message: 'Setup areas must not have a day scope and general areas require one' });
    }
    const protectedArea = protectedAreas[area.code];
    if (protectedArea && (area.areaType !== protectedArea.areaType || (area.dayScope ?? null) !== protectedArea.dayScope)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['areas', index], message: 'Default area type and day scope cannot be changed' });
    }
  });
  const shiftKeys = input.shifts.map((shift) => `${shift.areaCode}:${shift.shiftDate}`);
  if (new Set(shiftKeys).size !== shiftKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shifts'], message: 'Shift dates must be unique per area' });
  }
  input.shifts.forEach((shift, index) => {
    const configuredArea = areaByCode.get(shift.areaCode);
    if (configuredArea?.areaType === 'general' || shift.areaCode.startsWith('general_')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['shifts', index, 'areaCode'], message: 'Shifts are only valid for setup areas' });
    }
  });
});

const configPostInputSchema = z.object({
  id: z.string().uuid().optional(), sectionCode: z.string().trim().min(1).max(20), code: z.string().trim().min(1).max(30),
  description: z.string().trim().max(300).nullable().optional(), targetStaff: z.number().int().min(1).max(20),
  emergencyTargetStaff: z.number().int().min(1).max(20).optional(),
  mapX: z.number().int().min(0).max(1000).nullable().optional(),
  mapY: z.number().int().min(0).max(1000).nullable().optional(),
  isActive: z.boolean(), sortOrder: z.number().int().min(0).max(1000)
}).superRefine((post, context) => {
  if (post.emergencyTargetStaff !== undefined && post.emergencyTargetStaff > post.targetStaff) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['emergencyTargetStaff'], message: 'Emergency target staff must not exceed normal target staff' });
  }
  const hasMapX = post.mapX !== undefined;
  const hasMapY = post.mapY !== undefined;
  if (hasMapX !== hasMapY || (hasMapX && ((post.mapX === null) !== (post.mapY === null)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mapX'], message: 'Map coordinates must be provided together or both be null' });
  }
});

const configInputSchema = z.object({
  eventId: z.string().uuid(),
  sections: z.array(z.object({
    id: z.string().uuid().optional(), code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100),
    leaderCode: z.string().trim().min(1).max(20), sortOrder: z.number().int().min(1).max(100)
  })).min(1).max(10),
  posts: z.array(configPostInputSchema).max(200)
});

const trainingInputSchema = z.object({
  eventId: z.string().uuid(), sessionType: z.enum(['training', 'briefing']), title: z.string().trim().min(1).max(200),
  sessionDate: z.string().date(), location: z.string().trim().max(200).nullable().optional(), note: z.string().trim().max(2000).nullable().optional()
});

const trainingParticipantSchema = z.object({
  attendanceStatus: z.enum(['registered', 'attended', 'absent', 'excused']), note: z.string().trim().max(1000).nullable().optional()
});

const importInputSchema = z.object({
  eventId: z.string().uuid(), filename: z.string().trim().min(1).max(255), dataBase64: z.string().min(1).max(3_000_000),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

export const validateMarshalPersonInput = (value: unknown) => personInputSchema.parse(value);
export const validateMarshalPersonPatch = (value: unknown) => personPatchSchema.parse(value);
export const validateMarshalAssignmentInput = (value: unknown) => assignmentInputSchema.parse(value);
export const validateMarshalAreaAssignmentInput = (value: unknown) => areaAssignmentInputSchema.parse(value);
export const validateMarshalAreaAssignmentDeleteInput = (value: unknown) => areaAssignmentDeleteInputSchema.parse(value);
export const validateMarshalShiftAssignmentInput = (value: unknown) => shiftAssignmentInputSchema.parse(value);
export const validateMarshalResetInput = (value: unknown) => resetAssignmentsInputSchema.parse(value);
export const validateMarshalAreaConfigInput = (value: unknown) => areaConfigInputSchema.parse(value);
export const validateMarshalConfigInput = (value: unknown) => configInputSchema.parse(value);
export const validateMarshalTrainingInput = (value: unknown) => trainingInputSchema.parse(value);
export const validateMarshalTrainingParticipantInput = (value: unknown) => trainingParticipantSchema.parse(value);
export const validateMarshalImportInput = (value: unknown) => importInputSchema.parse(value);

export const resolveMarshalEmergencyTargetStaff = (storedEmergencyTargetStaff: number, targetStaff: number, emergencyTargetStaff?: number) =>
  emergencyTargetStaff ?? Math.min(storedEmergencyTargetStaff, targetStaff);

const defaultPostCodes = [
  ...Array.from({ length: 6 }, (_, i) => `1/${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `2/${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `3/${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `4/${i + 1}`),
  ...Array.from({ length: 3 }, (_, i) => `5/${i + 1}`)
];

const defaultMarshalAreas = [
  { code: 'setup_fl1', name: 'Aufbau Fahrerlager 1', areaType: 'setup' as const, dayScope: null, sortOrder: 10 },
  { code: 'setup_fl2', name: 'Aufbau Fahrerlager 2', areaType: 'setup' as const, dayScope: null, sortOrder: 20 },
  { code: 'general_saturday', name: 'Allgemeine Helfer', areaType: 'general' as const, dayScope: 'saturday' as const, sortOrder: 30 },
  { code: 'general_sunday', name: 'Allgemeine Helfer', areaType: 'general' as const, dayScope: 'sunday' as const, sortOrder: 40 }
] as const;

const defaultMarshalAreaCodes = new Set(defaultMarshalAreas.map((area) => area.code));

const toIsoDate = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const raw = cellText(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const record = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }> };
    if (typeof record.text === 'string') return record.text.trim();
    if (record.richText) return record.richText.map((part) => part.text ?? '').join('').trim();
    if (record.result !== undefined) return cellText(record.result);
  }
  return String(value).trim();
};

const splitAreas = (value: string) => value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
const nullable = (value: unknown) => cellText(value) || null;
const zipValue = (value: unknown) => {
  const raw = cellText(value);
  if (!raw) return null;
  return /^\d{4}$/.test(raw) ? `0${raw}` : raw;
};
const normalizeName = (firstName: string, lastName: string) => `${firstName} ${lastName}`
  .normalize('NFKC')
  .toLocaleLowerCase('de-DE')
  .replace(/\s+/g, ' ')
  .trim();

type MarshalNameRecord = { id: string; helperNumber: number; firstName: string; lastName: string };

export const indexMarshalPeopleByNormalizedNameCandidates = <T extends MarshalNameRecord>(people: T[]) => {
  const result = new Map<string, T[]>();
  const sorted = [...people].sort((left, right) => left.helperNumber - right.helperNumber || left.id.localeCompare(right.id));
  for (const person of sorted) {
    const name = normalizeName(person.firstName, person.lastName);
    result.set(name, [...(result.get(name) ?? []), person]);
  }
  return result;
};

export const indexMarshalPeopleByNormalizedName = <T extends MarshalNameRecord>(people: T[]) => {
  const candidates = indexMarshalPeopleByNormalizedNameCandidates(people);
  return new Map([...candidates.entries()].flatMap(([name, matches]) => matches.length === 1 ? [[name, matches[0].id] as const] : []));
};

export const findAmbiguousMarshalNameMatches = <T extends { firstName: string; lastName: string }>(
  people: T[],
  candidates: Map<string, MarshalNameRecord[]>
) => {
  const uniqueIncomingNames = new Map(people.map((person) => [normalizeName(person.firstName, person.lastName), person]));
  return [...uniqueIncomingNames.entries()].flatMap(([normalizedName, person]) => {
    const matches = candidates.get(normalizedName) ?? [];
    return matches.length > 1 ? [{ normalizedName, person, matches }] : [];
  });
};

const appendAmbiguousLauferConflicts = (
  parsed: ParsedWorkbook,
  candidates: Map<string, MarshalNameRecord[]>
) => {
  for (const { person, matches } of findAmbiguousMarshalNameMatches(parsed.lauferPeople, candidates)) {
    parsed.conflicts.push({
      sheet: person.source,
      row: 0,
      message: `Mehrdeutiger Name für FL2-Zuordnung: ${person.firstName} ${person.lastName} (Helfernummern ${matches.map((match) => match.helperNumber).join(', ')})`
    });
  }
};

export const resolveMarshalAssignmentSectionId = (
  sectionId: string | null | undefined,
  postSectionId: string | null
) => {
  if (sectionId && postSectionId && sectionId !== postSectionId) throw new Error('MARSHAL_ASSIGNMENT_SCOPE_INVALID');
  return postSectionId ?? sectionId;
};

type ImportedPerson = z.infer<typeof personInputSchema> & { source: string };
type ImportedParticipation = { helperNumber: number; contactOwner: string | null; wish: string | null; note: string | null; saturday: string; sunday: string };
type ParsedWorkbook = {
  people: ImportedPerson[];
  lauferPeople: ImportedPerson[];
  participations: ImportedParticipation[];
  historicalAssignments: Array<{ year: number; dayKey: 'saturday' | 'sunday'; name: string; firstName: string; lastName: string; shirtSize: string | null; assignment: string; sheet: string; row: number }>;
  trainings: Array<{ type: 'training' | 'briefing'; title: string; date: string; attendees: Array<{ helperNumber?: number; name?: string }> }>;
  conflicts: Array<{ sheet: string; row: number; message: string }>;
};

const parsePersonRow = (row: ExcelJS.Row, offset = 0): ImportedPerson | null => {
  const rawHelperNumber = Number(cellText(row.getCell(1 + offset).value));
  const helperNumber = Number.isFinite(rawHelperNumber) ? Math.round(rawHelperNumber) : Number.NaN;
  const lastName = cellText(row.getCell(2 + offset).value);
  const firstName = cellText(row.getCell(3 + offset).value);
  if (!Number.isInteger(helperNumber) || helperNumber <= 0 || !lastName || !firstName) return null;
  return {
    helperNumber, lastName, firstName,
    street: nullable(row.getCell(4 + offset).value), zip: zipValue(row.getCell(5 + offset).value), city: nullable(row.getCell(6 + offset).value),
    birthdate: toIsoDate(row.getCell(7 + offset).value), phone: nullable(row.getCell(8 + offset).value), email: nullable(row.getCell(9 + offset).value),
    activityAreas: splitAreas(cellText(row.getCell(10 + offset).value)), shirtSize: nullable(row.getCell(12 + offset).value),
    note: nullable(row.getCell(13 + offset).value), clubMember: Boolean(row.getCell(11 + offset).value),
    vehicleRegistration: offset === 0 ? nullable(row.getCell(15).value) : null,
    licenseNumber: offset === 0 ? nullable(row.getCell(16).value) : null,
    isActive: true, source: row.worksheet.name
  };
};

const mergePerson = (current: ImportedPerson | undefined, incoming: ImportedPerson): ImportedPerson => {
  if (!current) return incoming;
  const merged = { ...current } as ImportedPerson;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'helperNumber') continue;
    if (Array.isArray(value)) {
      if (value.length) (merged as unknown as Record<string, unknown>)[key] = value;
    } else if (value !== null && value !== undefined && value !== '') {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
};

const parseWorkbook = async (buffer: Buffer): Promise<ParsedWorkbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const people = new Map<number, ImportedPerson>();
  const participations: ImportedParticipation[] = [];
  const historicalAssignments: ParsedWorkbook['historicalAssignments'] = [];
  const trainings: ParsedWorkbook['trainings'] = [];
  const conflicts: ParsedWorkbook['conflicts'] = [];
  const lauferPeople: ImportedPerson[] = [];

  const base = workbook.getWorksheet('Vorlage Lily 2022');
  base?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const parsed = parsePersonRow(row);
    if (parsed) people.set(parsed.helperNumber, parsed);
  });

  const current = workbook.getWorksheet('Helfernummern gesamt');
  current?.eachRow((row, rowNumber) => {
    if (rowNumber < 5) return;
    const rawHelperNumber = Number(cellText(row.getCell(2).value));
    if (Number.isFinite(rawHelperNumber) && !Number.isInteger(rawHelperNumber)) {
      conflicts.push({ sheet: current.name, row: rowNumber, message: `Helfernummer ${rawHelperNumber} wurde auf ${Math.round(rawHelperNumber)} normalisiert` });
    }
    const parsed = parsePersonRow(row, 1);
    if (!parsed) {
      if (cellText(row.getCell(2).value) || cellText(row.getCell(3).value)) conflicts.push({ sheet: current.name, row: rowNumber, message: 'Ungültige Helfernummer oder unvollständiger Name' });
      return;
    }
    people.set(parsed.helperNumber, mergePerson(people.get(parsed.helperNumber), parsed));
    participations.push({
      helperNumber: parsed.helperNumber, contactOwner: nullable(row.getCell(1).value), note: nullable(row.getCell(13).value),
      saturday: cellText(row.getCell(15).value), sunday: cellText(row.getCell(16).value), wish: nullable(row.getCell(17).value)
    });
  });

  for (const [sheetName, dayKey] of [['Samstag 2024', 'saturday'], ['Sonntag 2024', 'sunday']] as const) {
    const sheet = workbook.getWorksheet(sheetName);
    sheet?.eachRow((row, rowNumber) => {
      if (rowNumber < 3) return;
      const lastName = cellText(row.getCell(1).value);
      const firstName = cellText(row.getCell(2).value);
      const assignment = cellText(row.getCell(5).value);
      if (!firstName || !lastName || !assignment || /^vorname$/i.test(firstName) || /^name$/i.test(lastName)) return;
      historicalAssignments.push({ year: 2024, dayKey, name: normalizeName(firstName, lastName), firstName, lastName, shirtSize: nullable(row.getCell(3).value), assignment, sheet: sheetName, row: rowNumber });
    });
  }

  const licenseSheet = workbook.getWorksheet('Lizenzschulung 29.03.2025');
  if (licenseSheet) {
    const attendees: Array<{ helperNumber?: number; name?: string }> = [];
    licenseSheet.eachRow((row, rowNumber) => {
      if (rowNumber < 7) return;
      const helperNumber = Number(cellText(row.getCell(1).value));
      const lastName = cellText(row.getCell(2).value);
      const firstName = cellText(row.getCell(3).value);
      if (Number.isInteger(helperNumber) && helperNumber > 0) attendees.push({ helperNumber });
      else if (firstName && lastName && !/^vorname$/i.test(firstName) && !/^name$/i.test(lastName)) attendees.push({ name: normalizeName(firstName, lastName) });
    });
    trainings.push({ type: 'training', title: 'Lizenzschulung Streckenposten', date: '2025-03-29', attendees });
  }

  const lauferSheet = workbook.getWorksheet('Team_Laufer_2023');
  if (lauferSheet) {
    lauferSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const lastName = cellText(row.getCell(1).value);
      const firstName = cellText(row.getCell(2).value);
      if (!lastName || !firstName) return;
      const rawBirth = cellText(row.getCell(3).value);
      const birthdate = /^\d{4,}$/.test(rawBirth) ? null : toIsoDate(row.getCell(3).value);
      const rawCity = cellText(row.getCell(6).value);
      const cityClean = /^(verpflegung|gesamt)/i.test(rawCity) ? null : rawCity || null;
      const rawEmail = cellText(row.getCell(8).value);
      const emailClean = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
      lauferPeople.push({
        helperNumber: 0,
        lastName,
        firstName,
        street: nullable(row.getCell(4).value),
        zip: zipValue(row.getCell(5).value),
        city: cityClean,
        birthdate,
        phone: nullable(row.getCell(7).value),
        email: emailClean,
        vehicleRegistration: nullable(row.getCell(9).value),
        shirtSize: nullable(row.getCell(10).value),
        activityAreas: ['Aufbau'],
        note: !cityClean && rawCity ? `Originalfeld: ${rawCity}` : null,
        clubMember: false,
        licenseNumber: null,
        isActive: true,
        source: 'Team_Laufer_2023'
      });
    });
  }

  const briefingSheet = workbook.getWorksheet('Einweisung 11.09.2025');
  if (briefingSheet) {
    const attendees: Array<{ name: string }> = [];
    briefingSheet.eachRow((row, rowNumber) => {
      if (rowNumber < 3) return;
      const lastName = cellText(row.getCell(1).value);
      const firstName = cellText(row.getCell(2).value);
      if (firstName && lastName) attendees.push({ name: normalizeName(firstName, lastName) });
    });
    trainings.push({ type: 'briefing', title: 'Einweisung Streckenposten', date: '2025-09-11', attendees });
  }

  const knownNamesBeforeHistorical = new Set([...people.values()].map((person) => normalizeName(person.firstName, person.lastName)));
  let nextHelperNumber = Math.max(0, ...people.keys()) + 1;
  for (const historical of historicalAssignments) {
    if (knownNamesBeforeHistorical.has(historical.name)) continue;
    const helperNumber = nextHelperNumber++;
    people.set(helperNumber, {
      helperNumber, firstName: historical.firstName, lastName: historical.lastName, shirtSize: historical.shirtSize,
      street: null, zip: null, city: null, birthdate: null, phone: null, email: null, clubMember: false,
      licenseNumber: null, vehicleRegistration: null, activityAreas: ['Strecke'], note: `Automatisch aus ${historical.sheet} übernommen`,
      isActive: true, source: historical.sheet
    });
    knownNamesBeforeHistorical.add(historical.name);
    conflicts.push({ sheet: historical.sheet, row: historical.row, message: `Historischer Helfer ohne Stammsatz erhielt die neue Helfernummer ${helperNumber}: ${historical.firstName} ${historical.lastName}` });
  }
  const knownHelperNumbers = new Set(people.keys());
  const knownNames = new Set([...people.values()].map((person) => normalizeName(person.firstName, person.lastName)));
  for (const session of trainings) {
    for (const attendee of session.attendees) {
      if ((attendee.helperNumber && knownHelperNumbers.has(attendee.helperNumber)) || (attendee.name && knownNames.has(attendee.name))) continue;
      conflicts.push({ sheet: session.title, row: 0, message: `Person nicht eindeutig gefunden: ${attendee.helperNumber ?? attendee.name}` });
    }
  }
  return { people: [...people.values()].sort((a, b) => a.helperNumber - b.helperNumber), lauferPeople, participations, historicalAssignments, trainings, conflicts };
};

const decodeWorkbook = (input: z.infer<typeof importInputSchema>) => {
  const buffer = Buffer.from(input.dataBase64, 'base64');
  if (buffer.length === 0 || buffer.length > 2_000_000) throw new Error('MARSHAL_IMPORT_SIZE_INVALID');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new Error('MARSHAL_IMPORT_CHECKSUM_MISMATCH');
  return { buffer, sha256 };
};

const assignmentFromCell = (value: string) => {
  const normalized = value.trim();
  if (!normalized) return { commitmentStatus: 'not_asked' as const, role: null, code: null, functionCode: null };
  if (/^(nein|no|n)$/i.test(normalized)) return { commitmentStatus: 'declined' as const, role: null, code: null, functionCode: null };
  const tentative = /evtl|vielleicht|vorbehalt/i.test(normalized);
  const post = normalized.match(/([1-5]\s*\/\s*\d{1,2})/);
  const leader = normalized.match(/\bAL\s*([1-5])\b/i);
  const code = post ? post[1].replace(/\s/g, '') : null;
  return {
    commitmentStatus: tentative ? 'tentative' as const : 'accepted' as const,
    role: leader ? 'section_leader' as const : code ? 'marshal' as const : 'special' as const,
    code,
    functionCode: leader ? `AL${Math.min(Number(leader[1]), 4)}` : code ? null : normalized
  };
};

export const parseMarshalWorkbookBuffer = parseWorkbook;
export const parseMarshalAssignmentCell = assignmentFromCell;

type MarshalDb = Awaited<ReturnType<typeof getDb>>;
type MarshalDbWriter = Pick<MarshalDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

const ensureMarshalEventStructureWithDb = async (db: MarshalDbWriter, eventId: string) => {
  const [eventRow] = await db.select({ startsAt: event.startsAt, endsAt: event.endsAt }).from(event).where(eq(event.id, eventId)).limit(1);
  if (!eventRow) throw new Error('EVENT_NOT_FOUND');
  const start = new Date(`${eventRow.startsAt}T12:00:00Z`);
  const end = new Date(`${eventRow.endsAt}T12:00:00Z`);
  const findDay = (weekday: number) => {
    const cursor = new Date(start);
    while (cursor <= end) {
      if (cursor.getUTCDay() === weekday) return cursor.toISOString().slice(0, 10);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return weekday === 6 ? eventRow.startsAt.toString() : eventRow.endsAt.toString();
  };
  await db.insert(marshalEventDay).values([
    { eventId, dayKey: 'saturday', label: 'Samstag', eventDate: findDay(6) },
    { eventId, dayKey: 'sunday', label: 'Sonntag', eventDate: findDay(0) }
  ]).onConflictDoNothing();
  for (let number = 1; number <= 4; number += 1) {
    await db.insert(marshalSection).values({ eventId, code: String(number), name: `Abschnitt ${number}`, leaderCode: `AL${number}`, sortOrder: number }).onConflictDoNothing();
  }
  const sections = await db.select().from(marshalSection).where(eq(marshalSection.eventId, eventId));
  const sectionByCode = new Map(sections.map((section) => [section.code, section]));
  for (const [sortOrder, code] of defaultPostCodes.entries()) {
    const sectionCode = code.startsWith('5/') ? '4' : code.split('/')[0];
    const section = sectionByCode.get(sectionCode);
    if (section) await db.insert(marshalPost).values({ eventId, sectionId: section.id, code, targetStaff: 2, emergencyTargetStaff: 2, sortOrder }).onConflictDoNothing();
  }
  for (const area of defaultMarshalAreas) {
    await db.insert(marshalHelperArea).values({ eventId, ...area }).onConflictDoNothing();
  }
};

export const ensureMarshalEventStructure = async (eventId: string) => {
  const db = await getDb();
  await ensureMarshalEventStructureWithDb(db, eventId);
};

export const listMarshalEvents = async () => {
  const db = await getDb();
  return db.select({ id: event.id, name: event.name, startsAt: event.startsAt, endsAt: event.endsAt, status: event.status, isCurrent: event.isCurrent })
    .from(event).orderBy(sql`${event.startsAt} desc`);
};

export const getMarshalWorkspace = async (eventId: string, search?: string, area?: string) => {
  await ensureMarshalEventStructure(eventId);
  const db = await getDb();
  const filters = [];
  if (search?.trim()) filters.push(or(ilike(marshalPerson.firstName, `%${search.trim()}%`), ilike(marshalPerson.lastName, `%${search.trim()}%`), sql`${marshalPerson.helperNumber}::text ilike ${`%${search.trim()}%`}`)!);
  if (area?.trim()) filters.push(sql`${marshalPerson.activityAreas} @> ${JSON.stringify([area.trim()])}::jsonb`);
  const [personRows, participations, days, sections, posts, trainings, trainingParticipants, qualifications, areas, areaShifts] = await Promise.all([
    db.select().from(marshalPerson).where(filters.length ? and(...filters) : undefined).orderBy(asc(marshalPerson.lastName), asc(marshalPerson.firstName)),
    db.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, eventId)),
    db.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, eventId)).orderBy(asc(marshalEventDay.eventDate)),
    db.select().from(marshalSection).where(eq(marshalSection.eventId, eventId)).orderBy(asc(marshalSection.sortOrder)),
    db.select().from(marshalPost).where(eq(marshalPost.eventId, eventId)).orderBy(asc(marshalPost.sortOrder)),
    db.select().from(marshalTrainingSession).where(eq(marshalTrainingSession.eventId, eventId)).orderBy(asc(marshalTrainingSession.sessionDate)),
    db.select().from(marshalTrainingParticipant).innerJoin(marshalTrainingSession, eq(marshalTrainingParticipant.sessionId, marshalTrainingSession.id)).where(eq(marshalTrainingSession.eventId, eventId)),
    db.select().from(marshalQualification),
    db.select().from(marshalHelperArea).where(eq(marshalHelperArea.eventId, eventId)).orderBy(asc(marshalHelperArea.sortOrder)),
    db.select({ shift: marshalAreaShift }).from(marshalAreaShift)
      .innerJoin(marshalHelperArea, eq(marshalAreaShift.areaId, marshalHelperArea.id))
      .where(eq(marshalHelperArea.eventId, eventId))
      .orderBy(asc(marshalHelperArea.sortOrder), asc(marshalAreaShift.sortOrder), asc(marshalAreaShift.shiftDate))
  ]);
  const participationIds = participations.map((item) => item.id);
  const [assignments, areaAssignmentRows, shiftAssignmentRows] = await Promise.all([
    participationIds.length ? db.select().from(marshalDayAssignment).where(inArray(marshalDayAssignment.participationId, participationIds)) : Promise.resolve([]),
    participationIds.length ? db.select({ assignment: marshalAreaAssignment }).from(marshalAreaAssignment)
      .innerJoin(marshalHelperArea, eq(marshalAreaAssignment.areaId, marshalHelperArea.id))
      .where(and(inArray(marshalAreaAssignment.participationId, participationIds), eq(marshalHelperArea.eventId, eventId))) : Promise.resolve([]),
    participationIds.length ? db.select({ assignment: marshalShiftAssignment }).from(marshalShiftAssignment)
      .innerJoin(marshalAreaShift, eq(marshalShiftAssignment.shiftId, marshalAreaShift.id))
      .innerJoin(marshalHelperArea, eq(marshalAreaShift.areaId, marshalHelperArea.id))
      .where(and(inArray(marshalShiftAssignment.participationId, participationIds), eq(marshalHelperArea.eventId, eventId))) : Promise.resolve([])
  ]);
  const areaAssignments = areaAssignmentRows.map((item) => item.assignment);
  const shiftAssignments = shiftAssignmentRows.map((item) => item.assignment);
  const personIds = new Set(personRows.map((item) => item.id));
  return {
    people: personRows.map((person) => {
      const participation = participations.find((item) => item.personId === person.id) ?? {
        id: '', eventId, personId: person.id, contactOwner: null, wish: null, note: null, shirtSizeSnapshot: person.shirtSize,
        createdAt: person.createdAt, updatedAt: person.updatedAt
      };
      return { ...person, participation, assignments: assignments.filter((assignment) => assignment.participationId === participation.id) };
    }),
    days, sections, posts, trainings, areas, areaShifts: areaShifts.map((item) => item.shift), areaAssignments, shiftAssignments,
    trainingParticipants: trainingParticipants.map((item) => item.marshal_training_participant),
    qualifications: qualifications.filter((item) => personIds.has(item.personId))
  };
};

export const createMarshalPerson = async (input: z.infer<typeof personInputSchema>, actorUserId: string | null) => {
  const db = await getDb();
  const [created] = await db.insert(marshalPerson).values(input).returning();
  await writeAuditLog(db as never, { actorUserId, action: 'marshal_person_created', entityType: 'marshal_person', entityId: created.id });
  return created;
};

export const patchMarshalPerson = async (personId: string, input: z.infer<typeof personPatchSchema>, actorUserId: string | null) => {
  const db = await getDb();
  const [updated] = await db.update(marshalPerson).set({ ...input, updatedAt: new Date() }).where(eq(marshalPerson.id, personId)).returning();
  if (updated) await writeAuditLog(db as never, { actorUserId, action: 'marshal_person_updated', entityType: 'marshal_person', entityId: updated.id });
  return updated ?? null;
};

type MarshalParticipationPatch = Pick<z.infer<typeof assignmentInputSchema>, 'contactOwner' | 'wish' | 'note' | 'shirtSizeSnapshot'>;

export const marshalParticipationUpdateValues = (input: MarshalParticipationPatch) => ({
  ...(input.contactOwner !== undefined ? { contactOwner: input.contactOwner } : {}),
  ...(input.wish !== undefined ? { wish: input.wish } : {}),
  ...(input.note !== undefined ? { note: input.note } : {}),
  ...(input.shirtSizeSnapshot !== undefined ? { shirtSizeSnapshot: input.shirtSizeSnapshot } : {})
});

export const upsertMarshalAssignment = async (personId: string, input: z.infer<typeof assignmentInputSchema>, actorUserId: string | null) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [person] = await tx.select().from(marshalPerson).where(eq(marshalPerson.id, personId)).limit(1);
    if (!person) return null;
    const [eventRow] = await tx.select({ id: event.id }).from(event).where(eq(event.id, input.eventId)).limit(1);
    if (!eventRow) throw new Error('EVENT_NOT_FOUND');
    const dayIds = input.days.map((day) => day.dayId);
    const eventDays = dayIds.length
      ? await tx.select({ id: marshalEventDay.id }).from(marshalEventDay)
        .where(and(eq(marshalEventDay.eventId, input.eventId), inArray(marshalEventDay.id, dayIds)))
      : [];
    const sectionIds = Array.from(new Set(input.days.flatMap((day) => day.sectionId ? [day.sectionId] : [])));
    const postIds = Array.from(new Set(input.days.flatMap((day) => day.postId ? [day.postId] : [])));
    const eventSections = sectionIds.length
      ? await tx.select({ id: marshalSection.id }).from(marshalSection)
        .where(and(eq(marshalSection.eventId, input.eventId), inArray(marshalSection.id, sectionIds)))
      : [];
    const eventPosts = postIds.length
      ? await tx.select({ id: marshalPost.id, sectionId: marshalPost.sectionId }).from(marshalPost)
        .where(and(eq(marshalPost.eventId, input.eventId), inArray(marshalPost.id, postIds)))
      : [];
    const postById = new Map(eventPosts.map((post) => [post.id, post]));
    if (eventDays.length !== dayIds.length || eventSections.length !== sectionIds.length || eventPosts.length !== postIds.length) {
      throw new Error('MARSHAL_ASSIGNMENT_SCOPE_INVALID');
    }
    const normalizedDays = input.days.map((day) => ({
      ...day,
      sectionId: resolveMarshalAssignmentSectionId(day.sectionId, day.postId ? postById.get(day.postId)!.sectionId : null)
    }));
    const [participation] = await tx.insert(marshalEventParticipation).values({
      eventId: input.eventId, personId, contactOwner: input.contactOwner, wish: input.wish, note: input.note,
      shirtSizeSnapshot: input.shirtSizeSnapshot ?? person.shirtSize
    }).onConflictDoUpdate({ target: [marshalEventParticipation.eventId, marshalEventParticipation.personId], set: {
      ...marshalParticipationUpdateValues(input), updatedAt: new Date()
    }}).returning();
    for (const day of normalizedDays) {
      await tx.insert(marshalDayAssignment).values({ participationId: participation.id, ...day }).onConflictDoUpdate({
        target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId], set: { ...day, updatedAt: new Date() }
      });
    }
    await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_assignment_updated', entityType: 'marshal_event_participation', entityId: participation.id });
    return participation;
  });
};

export const upsertMarshalAreaAssignment = async (
  personId: string,
  input: z.infer<typeof areaAssignmentInputSchema>,
  actorUserId: string | null
) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [person] = await tx.select().from(marshalPerson).where(eq(marshalPerson.id, personId)).limit(1);
    if (!person) return null;
    const [area] = await tx.select({ id: marshalHelperArea.id }).from(marshalHelperArea).where(and(
      eq(marshalHelperArea.id, input.areaId),
      eq(marshalHelperArea.eventId, input.eventId)
    )).limit(1);
    if (!area) throw new Error('MARSHAL_AREA_SCOPE_INVALID');
    const [participation] = await tx.insert(marshalEventParticipation).values({
      eventId: input.eventId,
      personId,
      shirtSizeSnapshot: person.shirtSize
    }).onConflictDoUpdate({
      target: [marshalEventParticipation.eventId, marshalEventParticipation.personId],
      set: { updatedAt: new Date() }
    }).returning();
    const [row] = await tx.insert(marshalAreaAssignment).values({
      eventId: input.eventId,
      participationId: participation.id,
      areaId: area.id,
      commitmentStatus: input.commitmentStatus,
      note: input.note ?? null
    }).onConflictDoUpdate({
      target: [marshalAreaAssignment.participationId, marshalAreaAssignment.areaId],
      set: { commitmentStatus: input.commitmentStatus, note: input.note ?? null, updatedAt: new Date() }
    }).returning();
    await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_area_assignment_updated', entityType: 'marshal_area_assignment', entityId: row.id });
    return row;
  });
};

export const upsertMarshalShiftAssignment = async (
  personId: string,
  input: z.infer<typeof shiftAssignmentInputSchema>,
  actorUserId: string | null
) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [person] = await tx.select().from(marshalPerson).where(eq(marshalPerson.id, personId)).limit(1);
    if (!person) return null;
    const [shift] = await tx.select({ id: marshalAreaShift.id }).from(marshalAreaShift)
      .innerJoin(marshalHelperArea, eq(marshalAreaShift.areaId, marshalHelperArea.id))
      .where(and(
        eq(marshalAreaShift.id, input.shiftId),
        eq(marshalHelperArea.eventId, input.eventId),
        eq(marshalHelperArea.areaType, 'setup')
      )).limit(1);
    if (!shift) throw new Error('MARSHAL_SHIFT_SCOPE_INVALID');
    const [participation] = await tx.insert(marshalEventParticipation).values({
      eventId: input.eventId,
      personId,
      shirtSizeSnapshot: person.shirtSize
    }).onConflictDoUpdate({
      target: [marshalEventParticipation.eventId, marshalEventParticipation.personId],
      set: { updatedAt: new Date() }
    }).returning();
    const [row] = await tx.insert(marshalShiftAssignment).values({
      eventId: input.eventId,
      participationId: participation.id,
      shiftId: shift.id,
      commitmentStatus: input.commitmentStatus,
      note: input.note ?? null
    }).onConflictDoUpdate({
      target: [marshalShiftAssignment.participationId, marshalShiftAssignment.shiftId],
      set: { commitmentStatus: input.commitmentStatus, note: input.note ?? null, updatedAt: new Date() }
    }).returning();
    await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_shift_assignment_updated', entityType: 'marshal_shift_assignment', entityId: row.id });
    return row;
  });
};

export const deleteMarshalAreaAssignment = async (
  personId: string,
  input: z.infer<typeof areaAssignmentDeleteInputSchema>,
  actorUserId: string | null
) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [participation] = await tx.select({ id: marshalEventParticipation.id }).from(marshalEventParticipation)
      .where(and(eq(marshalEventParticipation.personId, personId), eq(marshalEventParticipation.eventId, input.eventId))).limit(1);
    if (!participation) return null;
    const [area] = await tx.select({ id: marshalHelperArea.id, areaType: marshalHelperArea.areaType }).from(marshalHelperArea)
      .where(and(eq(marshalHelperArea.id, input.areaId), eq(marshalHelperArea.eventId, input.eventId))).limit(1);
    if (!area) throw new Error('MARSHAL_AREA_SCOPE_INVALID');

    const removedAreas = await tx.delete(marshalAreaAssignment).where(and(
      eq(marshalAreaAssignment.eventId, input.eventId),
      eq(marshalAreaAssignment.participationId, participation.id),
      eq(marshalAreaAssignment.areaId, area.id)
    )).returning({ id: marshalAreaAssignment.id });
    let removedShifts: Array<{ id: string }> = [];
    if (area.areaType === 'setup') {
      const shifts = await tx.select({ id: marshalAreaShift.id }).from(marshalAreaShift)
        .where(and(eq(marshalAreaShift.eventId, input.eventId), eq(marshalAreaShift.areaId, area.id)));
      if (shifts.length) {
        removedShifts = await tx.delete(marshalShiftAssignment).where(and(
          eq(marshalShiftAssignment.eventId, input.eventId),
          eq(marshalShiftAssignment.participationId, participation.id),
          inArray(marshalShiftAssignment.shiftId, shifts.map((shift) => shift.id))
        )).returning({ id: marshalShiftAssignment.id });
      }
    }
    await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_area_assignment_deleted', entityType: 'marshal_helper_area', entityId: area.id });
    return { removed: removedAreas.length > 0 || removedShifts.length > 0 };
  });
};

export const deleteMarshalPerson = async (personId: string, actorUserId: string | null) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [deleted] = await tx.delete(marshalPerson).where(eq(marshalPerson.id, personId)).returning({ id: marshalPerson.id });
    if (deleted) await writeAuditLog(tx as never, { actorUserId, action: 'marshal_person_deleted', entityType: 'marshal_person', entityId: deleted.id });
    return deleted ?? null;
  });
};

export const resetMarshalEventAssignments = async (eventId: string, actorUserId: string | null) => {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [eventRow] = await tx.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
    if (!eventRow) throw new Error('EVENT_NOT_FOUND');
    const participations = await tx.select({ id: marshalEventParticipation.id })
      .from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, eventId));
    const participationIds = participations.map((participation) => participation.id);
    if (participationIds.length) {
      await tx.update(marshalDayAssignment).set({
        commitmentStatus: 'not_asked',
        role: null,
        sectionId: null,
        postId: null,
        functionCode: null,
        updatedAt: new Date()
      }).where(inArray(marshalDayAssignment.participationId, participationIds));
      await tx.delete(marshalAreaAssignment).where(inArray(marshalAreaAssignment.participationId, participationIds));
      await tx.delete(marshalShiftAssignment).where(inArray(marshalShiftAssignment.participationId, participationIds));
    }
    await writeAuditLog(tx as never, { eventId, actorUserId, action: 'marshal_assignments_reset', entityType: 'event', entityId: eventId });
  });
};

export const replaceMarshalAreaConfig = async (
  input: z.infer<typeof areaConfigInputSchema>,
  actorUserId: string | null
) => {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [eventRow] = await tx.select({ id: event.id }).from(event).where(eq(event.id, input.eventId)).limit(1);
    if (!eventRow) throw new Error('EVENT_NOT_FOUND');
    for (const area of defaultMarshalAreas) {
      await tx.insert(marshalHelperArea).values({ eventId: input.eventId, ...area }).onConflictDoNothing();
    }
    for (const area of input.areas) {
      await tx.insert(marshalHelperArea).values({ eventId: input.eventId, ...area }).onConflictDoUpdate({
        target: [marshalHelperArea.eventId, marshalHelperArea.code],
        set: {
          name: area.name,
          areaType: area.areaType,
          dayScope: area.dayScope ?? null,
          sortOrder: area.sortOrder,
          responsibleLabel: area.responsibleLabel ?? null,
          updatedAt: new Date()
        }
      });
    }
    let areas = await tx.select().from(marshalHelperArea).where(eq(marshalHelperArea.eventId, input.eventId));
    const submittedCodes = new Set(input.areas.map((area) => area.code));
    const omittedCustomAreaIds = areas
      .filter((area) => !defaultMarshalAreaCodes.has(area.code as typeof defaultMarshalAreas[number]['code']) && !submittedCodes.has(area.code))
      .map((area) => area.id);
    if (omittedCustomAreaIds.length) {
      await tx.delete(marshalHelperArea).where(inArray(marshalHelperArea.id, omittedCustomAreaIds));
      areas = areas.filter((area) => !omittedCustomAreaIds.includes(area.id));
    }
    const areaByCode = new Map(areas.map((area) => [area.code, area]));
    for (const shift of input.shifts) {
      const area = areaByCode.get(shift.areaCode);
      if (!area || area.areaType !== 'setup') throw new Error('MARSHAL_AREA_CONFIG_SCOPE_INVALID');
    }
    const areaIds = areas.map((area) => area.id);
    const existingShifts = areaIds.length
      ? await tx.select().from(marshalAreaShift).where(inArray(marshalAreaShift.areaId, areaIds))
      : [];
    const desiredShiftKeys = new Set(input.shifts.map((shift) => `${areaByCode.get(shift.areaCode)!.id}:${shift.shiftDate}`));
    const omittedShiftIds = existingShifts
      .filter((shift) => !desiredShiftKeys.has(`${shift.areaId}:${shift.shiftDate}`))
      .map((shift) => shift.id);
    if (omittedShiftIds.length) await tx.delete(marshalAreaShift).where(inArray(marshalAreaShift.id, omittedShiftIds));
    for (const shift of input.shifts) {
      const areaId = areaByCode.get(shift.areaCode)!.id;
      await tx.insert(marshalAreaShift).values({
        eventId: input.eventId,
        areaId,
        label: shift.label,
        shiftDate: shift.shiftDate,
        sortOrder: shift.sortOrder
      }).onConflictDoUpdate({
        target: [marshalAreaShift.areaId, marshalAreaShift.shiftDate],
        set: { label: shift.label, sortOrder: shift.sortOrder }
      });
    }
    await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_area_config_updated', entityType: 'event', entityId: input.eventId });
  });
};

export const replaceMarshalConfig = async (input: z.infer<typeof configInputSchema>, actorUserId: string | null) => {
  const db = await getDb();
  for (const section of input.sections) {
    await db.insert(marshalSection).values({ eventId: input.eventId, code: section.code, name: section.name, leaderCode: section.leaderCode, sortOrder: section.sortOrder })
      .onConflictDoUpdate({ target: [marshalSection.eventId, marshalSection.code], set: { name: section.name, leaderCode: section.leaderCode, sortOrder: section.sortOrder, updatedAt: new Date() } });
  }
  const sections = await db.select().from(marshalSection).where(eq(marshalSection.eventId, input.eventId));
  const sectionByCode = new Map(sections.map((section) => [section.code, section.id]));
  for (const post of input.posts) {
    const sectionId = sectionByCode.get(post.sectionCode);
    if (!sectionId) throw new Error('MARSHAL_SECTION_NOT_FOUND');
    await db.insert(marshalPost).values({
      eventId: input.eventId, sectionId, code: post.code, description: post.description, targetStaff: post.targetStaff,
      emergencyTargetStaff: post.emergencyTargetStaff ?? post.targetStaff, mapX: post.mapX ?? null, mapY: post.mapY ?? null,
      isActive: post.isActive, sortOrder: post.sortOrder
    }).onConflictDoUpdate({ target: [marshalPost.eventId, marshalPost.code], set: {
      sectionId, description: post.description, targetStaff: post.targetStaff,
      emergencyTargetStaff: post.emergencyTargetStaff ?? sql`least(${marshalPost.emergencyTargetStaff}, ${post.targetStaff})`,
      ...(post.mapX !== undefined ? { mapX: post.mapX, mapY: post.mapY! } : {}),
      isActive: post.isActive, sortOrder: post.sortOrder, updatedAt: new Date()
    } });
  }
  await writeAuditLog(db as never, { eventId: input.eventId, actorUserId, action: 'marshal_config_updated', entityType: 'event', entityId: input.eventId });
};

export const createMarshalTraining = async (input: z.infer<typeof trainingInputSchema>, actorUserId: string | null) => {
  const db = await getDb();
  const [created] = await db.insert(marshalTrainingSession).values(input).returning();
  await writeAuditLog(db as never, { eventId: input.eventId, actorUserId, action: 'marshal_training_created', entityType: 'marshal_training_session', entityId: created.id });
  return created;
};

export const upsertMarshalTrainingParticipant = async (sessionId: string, personId: string, input: z.infer<typeof trainingParticipantSchema>, actorUserId: string | null) => {
  const db = await getDb();
  const [row] = await db.insert(marshalTrainingParticipant).values({ sessionId, personId, ...input }).onConflictDoUpdate({
    target: [marshalTrainingParticipant.sessionId, marshalTrainingParticipant.personId], set: { ...input, updatedAt: new Date() }
  }).returning();
  await writeAuditLog(db as never, { actorUserId, action: 'marshal_training_attendance_updated', entityType: 'marshal_training_participant', entityId: row.id });
  return row;
};

export const previewMarshalImport = async (input: z.infer<typeof importInputSchema>) => {
  const { buffer, sha256 } = decodeWorkbook(input);
  const parsed = await parseWorkbook(buffer);
  const db = await getDb();
  const [selectedEvent] = await db.select({ startsAt: event.startsAt }).from(event).where(eq(event.id, input.eventId)).limit(1);
  if (!selectedEvent) throw new Error('EVENT_NOT_FOUND');
  const existing = await db.select({
    id: marshalPerson.id,
    helperNumber: marshalPerson.helperNumber,
    firstName: marshalPerson.firstName,
    lastName: marshalPerson.lastName
  }).from(marshalPerson);
  const existingNumbers = new Set(existing.map((row) => row.helperNumber));
  const previewPeople = new Map(existing.map((person) => [person.helperNumber, person]));
  for (const person of parsed.people) {
    previewPeople.set(person.helperNumber, {
      id: previewPeople.get(person.helperNumber)?.id ?? `import:${person.helperNumber}`,
      helperNumber: person.helperNumber,
      firstName: person.firstName,
      lastName: person.lastName
    });
  }
  const existingNameCandidates = indexMarshalPeopleByNormalizedNameCandidates([...previewPeople.values()]);
  appendAmbiguousLauferConflicts(parsed, existingNameCandidates);
  const uniqueLauferNames = new Set(parsed.lauferPeople.map((person) => normalizeName(person.firstName, person.lastName)));
  const matchedLauferPeople = [...uniqueLauferNames].filter((name) => existingNameCandidates.get(name)?.length === 1).length;
  const ambiguousLauferPeople = [...uniqueLauferNames].filter((name) => (existingNameCandidates.get(name)?.length ?? 0) > 1).length;
  return {
    sha256,
    summary: {
      people: parsed.people.length,
      lauferPeople: parsed.lauferPeople.length,
      newLauferPeople: uniqueLauferNames.size - matchedLauferPeople - ambiguousLauferPeople,
      matchedLauferPeople,
      ambiguousLauferPeople,
      newPeople: parsed.people.filter((person) => !existingNumbers.has(person.helperNumber)).length,
      updatedPeople: parsed.people.filter((person) => existingNumbers.has(person.helperNumber)).length,
      eventParticipations: parsed.participations.length,
      historicalAssignments: parsed.historicalAssignments.length,
      trainings: parsed.trainings.length,
      trainingParticipants: parsed.trainings.reduce((sum, session) => sum + session.attendees.length, 0),
      conflicts: parsed.conflicts.length
    },
    conflicts: parsed.conflicts.slice(0, 200)
  };
};

const ensureFL2Participation = async (db: MarshalDbWriter, personId: string, eventId: string) => {
  const [participation] = await db.insert(marshalEventParticipation).values({ eventId, personId })
    .onConflictDoUpdate({
      target: [marshalEventParticipation.eventId, marshalEventParticipation.personId],
      set: { updatedAt: new Date() }
    })
    .returning();
  const [area] = await db.select().from(marshalHelperArea)
    .where(and(eq(marshalHelperArea.eventId, eventId), eq(marshalHelperArea.code, 'setup_fl2'))).limit(1);
  if (area) {
    await db.insert(marshalAreaAssignment).values({
      eventId,
      participationId: participation.id,
      areaId: area.id,
      commitmentStatus: 'not_asked'
    }).onConflictDoNothing();
  }
};

export const commitMarshalImport = async (input: z.infer<typeof importInputSchema>, actorUserId: string | null) => {
  const { buffer, sha256 } = decodeWorkbook(input);
  if (!input.expectedSha256) throw new Error('MARSHAL_IMPORT_CONFIRMATION_REQUIRED');
  const db = await getDb();
  const parsed = await parseWorkbook(buffer);
  return db.transaction(async (tx) => {
  await tx.execute(sql`LOCK TABLE marshal_person IN SHARE ROW EXCLUSIVE MODE`);
  const [alreadyImported] = await tx.select().from(marshalImportRun).where(and(eq(marshalImportRun.eventId, input.eventId), eq(marshalImportRun.workbookSha256, sha256), eq(marshalImportRun.status, 'completed'))).limit(1);
  if (alreadyImported) return { importRun: alreadyImported, alreadyImported: true };
  const [selectedEvent] = await tx.select({ startsAt: event.startsAt }).from(event).where(eq(event.id, input.eventId)).limit(1);
  if (!selectedEvent) throw new Error('EVENT_NOT_FOUND');
  await ensureMarshalEventStructureWithDb(tx, input.eventId);
  const personValues = parsed.people.map(({ source: _source, ...values }) => values);
  if (personValues.length) await tx.insert(marshalPerson).values(personValues).onConflictDoUpdate({ target: marshalPerson.helperNumber, set: {
    firstName: sql`excluded.first_name`, lastName: sql`excluded.last_name`, street: sql`excluded.street`, zip: sql`excluded.zip`,
    city: sql`excluded.city`, birthdate: sql`excluded.birthdate`, phone: sql`excluded.phone`, email: sql`excluded.email`,
    shirtSize: sql`excluded.shirt_size`, clubMember: sql`excluded.club_member`, licenseNumber: sql`excluded.license_number`,
    vehicleRegistration: sql`excluded.vehicle_registration`, activityAreas: sql`excluded.activity_areas`, note: sql`excluded.note`,
    isActive: sql`excluded.is_active`, updatedAt: new Date()
  }});
  const allPeople = await tx.select().from(marshalPerson);
  const importedHelperNumbers = new Set(parsed.people.map((person) => person.helperNumber));
  const importedPeople = allPeople.filter((person) => importedHelperNumbers.has(person.helperNumber));
  const personIds = new Map(importedPeople.map((row) => [row.helperNumber, row.id]));
  const names = indexMarshalPeopleByNormalizedName(allPeople);
  const personById = new Map(allPeople.map((person) => [person.id, person]));

  if (parsed.lauferPeople.length > 0) {
    const [maxRow] = await tx.select({ max: sql<number>`coalesce(max(helper_number), 0)` }).from(marshalPerson);
    let nextNum = (maxRow?.max ?? 0) + 1;
    const knownNameCandidates = indexMarshalPeopleByNormalizedNameCandidates(allPeople);
    appendAmbiguousLauferConflicts(parsed, knownNameCandidates);
    const sortedLauferPeople = [...parsed.lauferPeople].sort((left, right) =>
      normalizeName(left.firstName, left.lastName).localeCompare(normalizeName(right.firstName, right.lastName), 'de-DE')
    );
    for (const lauferPerson of sortedLauferPeople) {
      const normalizedName = normalizeName(lauferPerson.firstName, lauferPerson.lastName);
      const matches = knownNameCandidates.get(normalizedName) ?? [];
      if (matches.length > 1) continue;
      if (matches.length === 1) {
        const existingId = matches[0].id;
        const existingPerson = personById.get(existingId);
        if (existingPerson && !existingPerson.activityAreas.includes('Aufbau')) {
          await tx.update(marshalPerson).set({
            activityAreas: [...existingPerson.activityAreas, 'Aufbau'],
            updatedAt: new Date()
          }).where(eq(marshalPerson.id, existingId));
          existingPerson.activityAreas.push('Aufbau');
        }
        await ensureFL2Participation(tx, existingId, input.eventId);
      } else {
        lauferPerson.helperNumber = nextNum++;
        const { source: _source, ...values } = lauferPerson;
        const [newPerson] = await tx.insert(marshalPerson).values(values).returning();
        knownNameCandidates.set(normalizedName, [newPerson]);
        names.set(normalizedName, newPerson.id);
        personIds.set(lauferPerson.helperNumber, newPerson.id);
        await ensureFL2Participation(tx, newPerson.id, input.eventId);
      }
    }
  }

  const qualificationValues = importedPeople.filter((row) => row.licenseNumber).map((row) => ({ personId: row.id, qualificationType: 'dmsb_license', number: row.licenseNumber }));
  if (qualificationValues.length) await tx.insert(marshalQualification).values(qualificationValues).onConflictDoUpdate({
    target: [marshalQualification.personId, marshalQualification.qualificationType], set: { number: sql`excluded.number`, updatedAt: new Date() }
  });
  const days = await tx.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, input.eventId));
  const dayByKey = new Map(days.map((day) => [day.dayKey, day]));
  const sections = await tx.select().from(marshalSection).where(eq(marshalSection.eventId, input.eventId));
  const sectionByCode = new Map(sections.map((section) => [section.code, section]));
  const posts = await tx.select().from(marshalPost).where(eq(marshalPost.eventId, input.eventId));
  const postByCode = new Map(posts.map((post) => [post.code, post]));
  const importedByHelperNumber = new Map(parsed.people.map((person) => [person.helperNumber, person]));
  const participationValues = parsed.participations.flatMap((imported) => {
    const personId = personIds.get(imported.helperNumber);
    if (!personId) return [];
    return [{ eventId: input.eventId, personId, contactOwner: imported.contactOwner, wish: imported.wish, note: imported.note, shirtSizeSnapshot: importedByHelperNumber.get(imported.helperNumber)?.shirtSize }];
  });
  if (participationValues.length) await tx.insert(marshalEventParticipation).values(participationValues).onConflictDoUpdate({
    target: [marshalEventParticipation.eventId, marshalEventParticipation.personId], set: {
      contactOwner: sql`excluded.contact_owner`, wish: sql`excluded.wish`, note: sql`excluded.note`, shirtSizeSnapshot: sql`excluded.shirt_size_snapshot`, updatedAt: new Date()
    }
  });
  const importedParticipations = await tx.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, input.eventId));
  const participationByPersonId = new Map(importedParticipations.map((row) => [row.personId, row]));
  const assignmentValues = parsed.participations.flatMap((imported) => {
    const personId = personIds.get(imported.helperNumber);
    const participation = personId ? participationByPersonId.get(personId) : undefined;
    if (!participation) return [];
    return ([['saturday', imported.saturday], ['sunday', imported.sunday]] as const).flatMap(([dayKey, raw]) => {
      const day = dayByKey.get(dayKey);
      if (!day) return [];
      const assignment = assignmentFromCell(raw);
      const post = assignment.code ? postByCode.get(assignment.code) : undefined;
      const rawSection = assignment.code?.split('/')[0] ?? assignment.functionCode?.replace(/^AL/i, '');
      const section = rawSection ? sectionByCode.get(rawSection === '5' ? '4' : rawSection) : undefined;
      return [{ participationId: participation.id, dayId: day.id, commitmentStatus: assignment.commitmentStatus, role: assignment.role, sectionId: section?.id, postId: post?.id, functionCode: assignment.functionCode }];
    });
  });
  if (assignmentValues.length) await tx.insert(marshalDayAssignment).values(assignmentValues).onConflictDoUpdate({
    target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId], set: {
      commitmentStatus: sql`excluded.commitment_status`, role: sql`excluded.role`, sectionId: sql`excluded.section_id`,
      postId: sql`excluded.post_id`, functionCode: sql`excluded.function_code`, updatedAt: new Date()
    }
  });
  const historicalEvents = await tx.select({ id: event.id }).from(event)
    .where(and(sql`extract(year from ${event.startsAt}) = 2024`, ilike(event.name, '%Dreieck%'))).orderBy(sql`${event.startsAt} desc`).limit(2);
  if (historicalEvents.length === 1) {
    const historicalEventId = historicalEvents[0].id;
    await ensureMarshalEventStructureWithDb(tx, historicalEventId);
    const historicalPersonIds = Array.from(new Set(parsed.historicalAssignments.map((item) => names.get(item.name)).filter((value): value is string => Boolean(value))));
    if (historicalPersonIds.length) {
      const historicalParticipationValues = historicalPersonIds.map((personId) => ({
        eventId: historicalEventId, personId,
        shirtSizeSnapshot: parsed.historicalAssignments.find((item) => names.get(item.name) === personId)?.shirtSize ?? null
      }));
      await tx.insert(marshalEventParticipation).values(historicalParticipationValues).onConflictDoUpdate({
        target: [marshalEventParticipation.eventId, marshalEventParticipation.personId],
        set: { shirtSizeSnapshot: sql`coalesce(excluded.shirt_size_snapshot, ${marshalEventParticipation.shirtSizeSnapshot})`, updatedAt: new Date() }
      });
      const [historicalDays, historicalSections, historicalPosts, historicalParticipations] = await Promise.all([
        tx.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, historicalEventId)),
        tx.select().from(marshalSection).where(eq(marshalSection.eventId, historicalEventId)),
        tx.select().from(marshalPost).where(eq(marshalPost.eventId, historicalEventId)),
        tx.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, historicalEventId))
      ]);
      const historicalDayByKey = new Map(historicalDays.map((item) => [item.dayKey, item]));
      const historicalSectionByCode = new Map(historicalSections.map((item) => [item.code, item]));
      const historicalPostByCode = new Map(historicalPosts.map((item) => [item.code, item]));
      const historicalParticipationByPersonId = new Map(historicalParticipations.map((item) => [item.personId, item]));
      const historicalValues = parsed.historicalAssignments.flatMap((item) => {
        const personId = names.get(item.name);
        const participation = personId ? historicalParticipationByPersonId.get(personId) : undefined;
        const day = historicalDayByKey.get(item.dayKey);
        if (!participation || !day) return [];
        const parsedAssignment = assignmentFromCell(item.assignment);
        const post = parsedAssignment.code ? historicalPostByCode.get(parsedAssignment.code) : undefined;
        const rawSection = parsedAssignment.code?.split('/')[0] ?? parsedAssignment.functionCode?.replace(/^AL/i, '');
        const section = rawSection ? historicalSectionByCode.get(rawSection === '5' ? '4' : rawSection) : undefined;
        return [{ participationId: participation.id, dayId: day.id, commitmentStatus: 'accepted' as const, role: parsedAssignment.role, sectionId: section?.id, postId: post?.id, functionCode: parsedAssignment.functionCode }];
      });
      const historicalUniqueValues = Array.from(new Map(historicalValues.map((item) => [`${item.participationId}:${item.dayId}`, item])).values());
      if (historicalUniqueValues.length) await tx.insert(marshalDayAssignment).values(historicalUniqueValues).onConflictDoUpdate({
        target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId],
        set: { commitmentStatus: sql`excluded.commitment_status`, role: sql`excluded.role`, sectionId: sql`excluded.section_id`, postId: sql`excluded.post_id`, functionCode: sql`excluded.function_code`, updatedAt: new Date() }
      });
    }
  } else if (parsed.historicalAssignments.length) {
    parsed.conflicts.push({ sheet: 'Samstag/Sonntag 2024', row: 0, message: historicalEvents.length === 0 ? 'Kein Event für 2024 gefunden; historische Einsätze wurden nicht importiert' : 'Mehrere Events für 2024 gefunden; historische Einsätze wurden nicht eindeutig zugeordnet' });
  }
  for (const importedSession of parsed.trainings) {
    const [session] = await tx.insert(marshalTrainingSession).values({ eventId: input.eventId, sessionType: importedSession.type, title: importedSession.title, sessionDate: importedSession.date }).returning();
    const participantValues: Array<{ sessionId: string; personId: string; attendanceStatus: 'registered' }> = [];
    for (const attendee of importedSession.attendees) {
      const personId = attendee.helperNumber ? personIds.get(attendee.helperNumber) : attendee.name ? names.get(attendee.name) : undefined;
      if (personId) participantValues.push({ sessionId: session.id, personId, attendanceStatus: 'registered' });
    }
    if (participantValues.length) await tx.insert(marshalTrainingParticipant).values(participantValues).onConflictDoNothing();
  }
  const summary = { people: parsed.people.length, lauferPeople: parsed.lauferPeople.length, eventParticipations: parsed.participations.length, historicalAssignments: parsed.historicalAssignments.length, trainings: parsed.trainings.length, conflicts: parsed.conflicts.length };
  const [importRun] = await tx.insert(marshalImportRun).values({ eventId: input.eventId, workbookSha256: sha256, filename: input.filename, status: 'completed', summary, conflicts: parsed.conflicts, createdBy: actorUserId, completedAt: new Date() }).returning();
  await writeAuditLog(tx as never, { eventId: input.eventId, actorUserId, action: 'marshal_import_completed', entityType: 'marshal_import_run', entityId: importRun.id });
  return { importRun, alreadyImported: false };
  });
};

const renderPdf = (title: string, headers: string[], rows: string[][], widths: number[]) => new Promise<Buffer>((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  doc.fontSize(16).text(title).moveDown(0.7);
  const drawRow = (values: string[], bold = false) => {
    const y = doc.y;
    if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    values.forEach((value, index) => doc.fontSize(9).text(value || '', 32 + widths.slice(0, index).reduce((sum, width) => sum + width, 0), y, { width: widths[index] - 6, height: 22 }));
    doc.moveTo(32, y + 21).lineTo(32 + widths.reduce((sum, width) => sum + width, 0), y + 21).strokeColor('#cccccc').stroke();
    doc.y = y + 24;
    if (doc.y > 540) { doc.addPage(); doc.y = 32; }
  };
  drawRow(headers, true);
  rows.forEach((row) => drawRow(row));
  doc.end();
});

const printStatusLabel = (status: string) => ({ not_asked: 'Nicht angefragt', pending: 'Offen', accepted: 'Zugesagt', declined: 'Abgesagt', tentative: 'Vielleicht' }[status] ?? status);

export const createMarshalPrintPdf = async (input: { eventId: string; dayId?: string; sectionId?: string; trainingId?: string; areaId?: string; shiftId?: string; type: 'attendance' | 'section' | 'training' | 'area' }) => {
  const db = await getDb();
  if (input.type === 'training' && input.trainingId) {
    const [session] = await db.select().from(marshalTrainingSession).where(and(eq(marshalTrainingSession.id, input.trainingId), eq(marshalTrainingSession.eventId, input.eventId))).limit(1);
    if (!session) return null;
    const rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, zip: marshalPerson.zip, city: marshalPerson.city, status: marshalTrainingParticipant.attendanceStatus })
      .from(marshalTrainingParticipant).innerJoin(marshalPerson, eq(marshalTrainingParticipant.personId, marshalPerson.id)).where(eq(marshalTrainingParticipant.sessionId, session.id)).orderBy(asc(marshalPerson.lastName));
    return { filename: `Teilnehmerliste-${session.sessionDate}.pdf`, buffer: await renderPdf(session.title, ['Vorname', 'Nachname', 'PLZ', 'Wohnort', 'Status', 'Unterschrift'], rows.map((row) => [row.firstName, row.lastName, row.zip ?? '', row.city ?? '', row.status, '']), [100, 120, 70, 130, 90, 250]) };
  }
  if (input.type === 'area') {
    if (!input.areaId) throw new Error('MARSHAL_AREA_REQUIRED');
    const [area] = await db.select().from(marshalHelperArea).where(and(eq(marshalHelperArea.id, input.areaId), eq(marshalHelperArea.eventId, input.eventId))).limit(1);
    if (!area) throw new Error('MARSHAL_AREA_SCOPE_INVALID');
    let title = area.name;
    let rows: Array<{ firstName: string; lastName: string; helperNumber: number; status: string; note: string | null }>;
    if (input.shiftId) {
      if (area.areaType !== 'setup') throw new Error('MARSHAL_SHIFT_SCOPE_INVALID');
      const [shift] = await db.select().from(marshalAreaShift).where(and(eq(marshalAreaShift.id, input.shiftId), eq(marshalAreaShift.eventId, input.eventId), eq(marshalAreaShift.areaId, area.id))).limit(1);
      if (!shift) throw new Error('MARSHAL_SHIFT_SCOPE_INVALID');
      title = `${area.name} – ${shift.label}`;
      rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, helperNumber: marshalPerson.helperNumber, status: marshalShiftAssignment.commitmentStatus, note: marshalShiftAssignment.note })
        .from(marshalShiftAssignment)
        .innerJoin(marshalEventParticipation, eq(marshalShiftAssignment.participationId, marshalEventParticipation.id))
        .innerJoin(marshalPerson, eq(marshalEventParticipation.personId, marshalPerson.id))
        .where(and(eq(marshalShiftAssignment.shiftId, shift.id), eq(marshalEventParticipation.eventId, input.eventId), eq(marshalPerson.noDeployment, false)))
        .orderBy(asc(marshalPerson.lastName), asc(marshalPerson.firstName));
    } else {
      rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, helperNumber: marshalPerson.helperNumber, status: marshalAreaAssignment.commitmentStatus, note: marshalAreaAssignment.note })
        .from(marshalAreaAssignment)
        .innerJoin(marshalEventParticipation, eq(marshalAreaAssignment.participationId, marshalEventParticipation.id))
        .innerJoin(marshalPerson, eq(marshalEventParticipation.personId, marshalPerson.id))
        .where(and(eq(marshalAreaAssignment.areaId, area.id), eq(marshalEventParticipation.eventId, input.eventId), eq(marshalPerson.noDeployment, false)))
        .orderBy(asc(marshalPerson.lastName), asc(marshalPerson.firstName));
    }
    const safeName = title.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'Bereich';
    return { filename: `Helferliste-${safeName}.pdf`, buffer: await renderPdf(title, ['Nr.', 'Vorname', 'Nachname', 'Status', 'Bemerkung', 'Anwesend'], rows.map((row) => [String(row.helperNumber), row.firstName, row.lastName, printStatusLabel(row.status), row.note ?? '', '']), [60, 120, 140, 90, 240, 90]) };
  }
  if (!input.dayId) throw new Error('MARSHAL_DAY_REQUIRED');
  const [day] = await db.select({ id: marshalEventDay.id }).from(marshalEventDay)
    .where(and(eq(marshalEventDay.id, input.dayId), eq(marshalEventDay.eventId, input.eventId))).limit(1);
  if (!day) throw new Error('MARSHAL_DAY_SCOPE_INVALID');
  if (input.sectionId) {
    const [section] = await db.select({ id: marshalSection.id }).from(marshalSection)
      .where(and(eq(marshalSection.id, input.sectionId), eq(marshalSection.eventId, input.eventId))).limit(1);
    if (!section) throw new Error('MARSHAL_SECTION_SCOPE_INVALID');
  }
  const filters = [eq(marshalEventParticipation.eventId, input.eventId), eq(marshalDayAssignment.dayId, input.dayId), eq(marshalDayAssignment.commitmentStatus, 'accepted'), eq(marshalPerson.noDeployment, false)];
  if (input.sectionId) filters.push(eq(marshalDayAssignment.sectionId, input.sectionId));
  const orderBy = input.type === 'section'
    ? [sql`${marshalPost.sortOrder} asc nulls first`, asc(marshalPerson.lastName), asc(marshalPerson.firstName)]
    : [asc(marshalPerson.lastName), asc(marshalPerson.firstName)];
  const rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, zip: marshalPerson.zip, city: marshalPerson.city, shirt: marshalEventParticipation.shirtSizeSnapshot, post: marshalPost.code, functionCode: marshalDayAssignment.functionCode })
    .from(marshalDayAssignment).innerJoin(marshalEventParticipation, eq(marshalDayAssignment.participationId, marshalEventParticipation.id)).innerJoin(marshalPerson, eq(marshalEventParticipation.personId, marshalPerson.id)).leftJoin(marshalPost, eq(marshalDayAssignment.postId, marshalPost.id)).where(and(...filters)).orderBy(...orderBy);
  if (input.type === 'section') return { filename: 'Abschnittsliste.pdf', buffer: await renderPdf('Abschnittsliste', ['Vorname', 'Nachname', 'Posten/Funktion', 'Änderung'], rows.map((row) => [row.firstName, row.lastName, row.post ?? row.functionCode ?? '', '']), [140, 160, 150, 290]) };
  return { filename: 'Anwesenheitsliste.pdf', buffer: await renderPdf('Anwesenheitsliste', ['Vorname', 'Nachname', 'PLZ', 'Wohnort', 'Shirt', 'Posten', 'Unterschrift'], rows.map((row) => [row.firstName, row.lastName, row.zip ?? '', row.city ?? '', row.shirt ?? '', row.post ?? row.functionCode ?? '', '']), [95, 115, 55, 115, 60, 85, 215]) };
};
