import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  event,
  marshalDayAssignment,
  marshalEventDay,
  marshalEventParticipation,
  marshalImportRun,
  marshalPerson,
  marshalPost,
  marshalQualification,
  marshalSection,
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
  isActive: z.boolean().optional()
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
});

const configInputSchema = z.object({
  eventId: z.string().uuid(),
  sections: z.array(z.object({
    id: z.string().uuid().optional(), code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100),
    leaderCode: z.string().trim().min(1).max(20), sortOrder: z.number().int().min(1).max(100)
  })).min(1).max(10),
  posts: z.array(z.object({
    id: z.string().uuid().optional(), sectionCode: z.string().trim().min(1).max(20), code: z.string().trim().min(1).max(30),
    description: z.string().trim().max(300).nullable().optional(), targetStaff: z.number().int().min(1).max(20),
    isActive: z.boolean(), sortOrder: z.number().int().min(0).max(1000)
  })).max(200)
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
export const validateMarshalConfigInput = (value: unknown) => configInputSchema.parse(value);
export const validateMarshalTrainingInput = (value: unknown) => trainingInputSchema.parse(value);
export const validateMarshalTrainingParticipantInput = (value: unknown) => trainingParticipantSchema.parse(value);
export const validateMarshalImportInput = (value: unknown) => importInputSchema.parse(value);

const defaultPostCodes = [
  ...Array.from({ length: 6 }, (_, i) => `1/${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `2/${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `3/${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `4/${i + 1}`),
  ...Array.from({ length: 3 }, (_, i) => `5/${i + 1}`)
];

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
const normalizeName = (firstName: string, lastName: string) => `${firstName} ${lastName}`.toLocaleLowerCase('de-DE').replace(/\s+/g, ' ').trim();

type ImportedPerson = z.infer<typeof personInputSchema> & { source: string };
type ImportedParticipation = { helperNumber: number; contactOwner: string | null; wish: string | null; note: string | null; saturday: string; sunday: string };
type ParsedWorkbook = {
  people: ImportedPerson[];
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
  let nextHelperNumber = Math.max(...people.keys()) + 1;
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
  return { people: [...people.values()].sort((a, b) => a.helperNumber - b.helperNumber), participations, historicalAssignments, trainings, conflicts };
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

export const ensureMarshalEventStructure = async (eventId: string) => {
  const db = await getDb();
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
    if (section) await db.insert(marshalPost).values({ eventId, sectionId: section.id, code, targetStaff: 2, sortOrder }).onConflictDoNothing();
  }
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
  const [personRows, participations, days, sections, posts, trainings, trainingParticipants, qualifications] = await Promise.all([
    db.select().from(marshalPerson).where(filters.length ? and(...filters) : undefined).orderBy(asc(marshalPerson.lastName), asc(marshalPerson.firstName)),
    db.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, eventId)),
    db.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, eventId)).orderBy(asc(marshalEventDay.eventDate)),
    db.select().from(marshalSection).where(eq(marshalSection.eventId, eventId)).orderBy(asc(marshalSection.sortOrder)),
    db.select().from(marshalPost).where(eq(marshalPost.eventId, eventId)).orderBy(asc(marshalPost.sortOrder)),
    db.select().from(marshalTrainingSession).where(eq(marshalTrainingSession.eventId, eventId)).orderBy(asc(marshalTrainingSession.sessionDate)),
    db.select().from(marshalTrainingParticipant).innerJoin(marshalTrainingSession, eq(marshalTrainingParticipant.sessionId, marshalTrainingSession.id)).where(eq(marshalTrainingSession.eventId, eventId)),
    db.select().from(marshalQualification)
  ]);
  const participationIds = participations.map((item) => item.id);
  const assignments = participationIds.length ? await db.select().from(marshalDayAssignment).where(inArray(marshalDayAssignment.participationId, participationIds)) : [];
  const personIds = new Set(personRows.map((item) => item.id));
  return {
    people: personRows.map((person) => {
      const participation = participations.find((item) => item.personId === person.id) ?? {
        id: '', eventId, personId: person.id, contactOwner: null, wish: null, note: null, shirtSizeSnapshot: person.shirtSize,
        createdAt: person.createdAt, updatedAt: person.updatedAt
      };
      return { ...person, participation, assignments: assignments.filter((assignment) => assignment.participationId === participation.id) };
    }),
    days, sections, posts, trainings,
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

export const upsertMarshalAssignment = async (personId: string, input: z.infer<typeof assignmentInputSchema>, actorUserId: string | null) => {
  const db = await getDb();
  const [person] = await db.select().from(marshalPerson).where(eq(marshalPerson.id, personId)).limit(1);
  if (!person) return null;
  const [participation] = await db.insert(marshalEventParticipation).values({
    eventId: input.eventId, personId, contactOwner: input.contactOwner, wish: input.wish, note: input.note,
    shirtSizeSnapshot: input.shirtSizeSnapshot ?? person.shirtSize
  }).onConflictDoUpdate({ target: [marshalEventParticipation.eventId, marshalEventParticipation.personId], set: {
    contactOwner: input.contactOwner, wish: input.wish, note: input.note, shirtSizeSnapshot: input.shirtSizeSnapshot ?? person.shirtSize, updatedAt: new Date()
  }}).returning();
  for (const day of input.days) {
    await db.insert(marshalDayAssignment).values({ participationId: participation.id, ...day }).onConflictDoUpdate({
      target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId], set: { ...day, updatedAt: new Date() }
    });
  }
  await writeAuditLog(db as never, { eventId: input.eventId, actorUserId, action: 'marshal_assignment_updated', entityType: 'marshal_event_participation', entityId: participation.id });
  return participation;
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
    await db.insert(marshalPost).values({ eventId: input.eventId, sectionId, code: post.code, description: post.description, targetStaff: post.targetStaff, isActive: post.isActive, sortOrder: post.sortOrder })
      .onConflictDoUpdate({ target: [marshalPost.eventId, marshalPost.code], set: { sectionId, description: post.description, targetStaff: post.targetStaff, isActive: post.isActive, sortOrder: post.sortOrder, updatedAt: new Date() } });
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
  if (String(selectedEvent.startsAt).slice(0, 4) !== '2025') throw new Error('MARSHAL_IMPORT_EVENT_YEAR_MISMATCH');
  const existing = await db.select({ helperNumber: marshalPerson.helperNumber }).from(marshalPerson);
  const existingNumbers = new Set(existing.map((row) => row.helperNumber));
  return {
    sha256,
    summary: {
      people: parsed.people.length,
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

export const commitMarshalImport = async (input: z.infer<typeof importInputSchema>, actorUserId: string | null) => {
  const { buffer, sha256 } = decodeWorkbook(input);
  if (!input.expectedSha256) throw new Error('MARSHAL_IMPORT_CONFIRMATION_REQUIRED');
  const db = await getDb();
  const [alreadyImported] = await db.select().from(marshalImportRun).where(and(eq(marshalImportRun.eventId, input.eventId), eq(marshalImportRun.workbookSha256, sha256), eq(marshalImportRun.status, 'completed'))).limit(1);
  if (alreadyImported) return { importRun: alreadyImported, alreadyImported: true };
  const [selectedEvent] = await db.select({ startsAt: event.startsAt }).from(event).where(eq(event.id, input.eventId)).limit(1);
  if (!selectedEvent) throw new Error('EVENT_NOT_FOUND');
  if (String(selectedEvent.startsAt).slice(0, 4) !== '2025') throw new Error('MARSHAL_IMPORT_EVENT_YEAR_MISMATCH');
  await ensureMarshalEventStructure(input.eventId);
  const parsed = await parseWorkbook(buffer);
  const personValues = parsed.people.map(({ source: _source, ...values }) => values);
  await db.insert(marshalPerson).values(personValues).onConflictDoUpdate({ target: marshalPerson.helperNumber, set: {
    firstName: sql`excluded.first_name`, lastName: sql`excluded.last_name`, street: sql`excluded.street`, zip: sql`excluded.zip`,
    city: sql`excluded.city`, birthdate: sql`excluded.birthdate`, phone: sql`excluded.phone`, email: sql`excluded.email`,
    shirtSize: sql`excluded.shirt_size`, clubMember: sql`excluded.club_member`, licenseNumber: sql`excluded.license_number`,
    vehicleRegistration: sql`excluded.vehicle_registration`, activityAreas: sql`excluded.activity_areas`, note: sql`excluded.note`,
    isActive: sql`excluded.is_active`, updatedAt: new Date()
  }});
  const importedPeople = await db.select().from(marshalPerson).where(inArray(marshalPerson.helperNumber, parsed.people.map((person) => person.helperNumber)));
  const personIds = new Map(importedPeople.map((row) => [row.helperNumber, row.id]));
  const names = new Map(importedPeople.map((row) => [normalizeName(row.firstName, row.lastName), row.id]));
  const qualificationValues = importedPeople.filter((row) => row.licenseNumber).map((row) => ({ personId: row.id, qualificationType: 'dmsb_license', number: row.licenseNumber }));
  if (qualificationValues.length) await db.insert(marshalQualification).values(qualificationValues).onConflictDoUpdate({
    target: [marshalQualification.personId, marshalQualification.qualificationType], set: { number: sql`excluded.number`, updatedAt: new Date() }
  });
  const days = await db.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, input.eventId));
  const dayByKey = new Map(days.map((day) => [day.dayKey, day]));
  const sections = await db.select().from(marshalSection).where(eq(marshalSection.eventId, input.eventId));
  const sectionByCode = new Map(sections.map((section) => [section.code, section]));
  const posts = await db.select().from(marshalPost).where(eq(marshalPost.eventId, input.eventId));
  const postByCode = new Map(posts.map((post) => [post.code, post]));
  const importedByHelperNumber = new Map(parsed.people.map((person) => [person.helperNumber, person]));
  const participationValues = parsed.participations.flatMap((imported) => {
    const personId = personIds.get(imported.helperNumber);
    if (!personId) return [];
    return [{ eventId: input.eventId, personId, contactOwner: imported.contactOwner, wish: imported.wish, note: imported.note, shirtSizeSnapshot: importedByHelperNumber.get(imported.helperNumber)?.shirtSize }];
  });
  if (participationValues.length) await db.insert(marshalEventParticipation).values(participationValues).onConflictDoUpdate({
    target: [marshalEventParticipation.eventId, marshalEventParticipation.personId], set: {
      contactOwner: sql`excluded.contact_owner`, wish: sql`excluded.wish`, note: sql`excluded.note`, shirtSizeSnapshot: sql`excluded.shirt_size_snapshot`, updatedAt: new Date()
    }
  });
  const importedParticipations = await db.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, input.eventId));
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
  if (assignmentValues.length) await db.insert(marshalDayAssignment).values(assignmentValues).onConflictDoUpdate({
    target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId], set: {
      commitmentStatus: sql`excluded.commitment_status`, role: sql`excluded.role`, sectionId: sql`excluded.section_id`,
      postId: sql`excluded.post_id`, functionCode: sql`excluded.function_code`, updatedAt: new Date()
    }
  });
  const historicalEvents = await db.select({ id: event.id }).from(event)
    .where(and(sql`extract(year from ${event.startsAt}) = 2024`, ilike(event.name, '%Dreieck%'))).orderBy(sql`${event.startsAt} desc`).limit(2);
  if (historicalEvents.length === 1) {
    const historicalEventId = historicalEvents[0].id;
    await ensureMarshalEventStructure(historicalEventId);
    const historicalPersonIds = Array.from(new Set(parsed.historicalAssignments.map((item) => names.get(item.name)).filter((value): value is string => Boolean(value))));
    if (historicalPersonIds.length) {
      const historicalParticipationValues = historicalPersonIds.map((personId) => ({
        eventId: historicalEventId, personId,
        shirtSizeSnapshot: parsed.historicalAssignments.find((item) => names.get(item.name) === personId)?.shirtSize ?? null
      }));
      await db.insert(marshalEventParticipation).values(historicalParticipationValues).onConflictDoUpdate({
        target: [marshalEventParticipation.eventId, marshalEventParticipation.personId],
        set: { shirtSizeSnapshot: sql`coalesce(excluded.shirt_size_snapshot, ${marshalEventParticipation.shirtSizeSnapshot})`, updatedAt: new Date() }
      });
      const [historicalDays, historicalSections, historicalPosts, historicalParticipations] = await Promise.all([
        db.select().from(marshalEventDay).where(eq(marshalEventDay.eventId, historicalEventId)),
        db.select().from(marshalSection).where(eq(marshalSection.eventId, historicalEventId)),
        db.select().from(marshalPost).where(eq(marshalPost.eventId, historicalEventId)),
        db.select().from(marshalEventParticipation).where(eq(marshalEventParticipation.eventId, historicalEventId))
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
      if (historicalUniqueValues.length) await db.insert(marshalDayAssignment).values(historicalUniqueValues).onConflictDoUpdate({
        target: [marshalDayAssignment.participationId, marshalDayAssignment.dayId],
        set: { commitmentStatus: sql`excluded.commitment_status`, role: sql`excluded.role`, sectionId: sql`excluded.section_id`, postId: sql`excluded.post_id`, functionCode: sql`excluded.function_code`, updatedAt: new Date() }
      });
    }
  } else {
    parsed.conflicts.push({ sheet: 'Samstag/Sonntag 2024', row: 0, message: historicalEvents.length === 0 ? 'Kein Event für 2024 gefunden; historische Einsätze wurden nicht importiert' : 'Mehrere Events für 2024 gefunden; historische Einsätze wurden nicht eindeutig zugeordnet' });
  }
  for (const importedSession of parsed.trainings) {
    const [session] = await db.insert(marshalTrainingSession).values({ eventId: input.eventId, sessionType: importedSession.type, title: importedSession.title, sessionDate: importedSession.date }).returning();
    const participantValues: Array<{ sessionId: string; personId: string; attendanceStatus: 'registered' }> = [];
    for (const attendee of importedSession.attendees) {
      const personId = attendee.helperNumber ? personIds.get(attendee.helperNumber) : attendee.name ? names.get(attendee.name) : undefined;
      if (personId) participantValues.push({ sessionId: session.id, personId, attendanceStatus: 'registered' });
    }
    if (participantValues.length) await db.insert(marshalTrainingParticipant).values(participantValues).onConflictDoNothing();
  }
  const summary = { people: parsed.people.length, eventParticipations: parsed.participations.length, historicalAssignments: parsed.historicalAssignments.length, trainings: parsed.trainings.length, conflicts: parsed.conflicts.length };
  const [importRun] = await db.insert(marshalImportRun).values({ eventId: input.eventId, workbookSha256: sha256, filename: input.filename, status: 'completed', summary, conflicts: parsed.conflicts, createdBy: actorUserId, completedAt: new Date() }).returning();
  await writeAuditLog(db as never, { eventId: input.eventId, actorUserId, action: 'marshal_import_completed', entityType: 'marshal_import_run', entityId: importRun.id });
  return { importRun, alreadyImported: false };
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

export const createMarshalPrintPdf = async (input: { eventId: string; dayId?: string; sectionId?: string; trainingId?: string; type: 'attendance' | 'section' | 'training' }) => {
  const db = await getDb();
  if (input.type === 'training' && input.trainingId) {
    const [session] = await db.select().from(marshalTrainingSession).where(and(eq(marshalTrainingSession.id, input.trainingId), eq(marshalTrainingSession.eventId, input.eventId))).limit(1);
    if (!session) return null;
    const rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, zip: marshalPerson.zip, city: marshalPerson.city, status: marshalTrainingParticipant.attendanceStatus })
      .from(marshalTrainingParticipant).innerJoin(marshalPerson, eq(marshalTrainingParticipant.personId, marshalPerson.id)).where(eq(marshalTrainingParticipant.sessionId, session.id)).orderBy(asc(marshalPerson.lastName));
    return { filename: `Teilnehmerliste-${session.sessionDate}.pdf`, buffer: await renderPdf(session.title, ['Vorname', 'Nachname', 'PLZ', 'Wohnort', 'Status', 'Unterschrift'], rows.map((row) => [row.firstName, row.lastName, row.zip ?? '', row.city ?? '', row.status, '']), [100, 120, 70, 130, 90, 250]) };
  }
  if (!input.dayId) throw new Error('MARSHAL_DAY_REQUIRED');
  const filters = [eq(marshalEventParticipation.eventId, input.eventId), eq(marshalDayAssignment.dayId, input.dayId), eq(marshalDayAssignment.commitmentStatus, 'accepted')];
  if (input.sectionId) filters.push(eq(marshalDayAssignment.sectionId, input.sectionId));
  const rows = await db.select({ firstName: marshalPerson.firstName, lastName: marshalPerson.lastName, zip: marshalPerson.zip, city: marshalPerson.city, shirt: marshalEventParticipation.shirtSizeSnapshot, post: marshalPost.code, functionCode: marshalDayAssignment.functionCode })
    .from(marshalDayAssignment).innerJoin(marshalEventParticipation, eq(marshalDayAssignment.participationId, marshalEventParticipation.id)).innerJoin(marshalPerson, eq(marshalEventParticipation.personId, marshalPerson.id)).leftJoin(marshalPost, eq(marshalDayAssignment.postId, marshalPost.id)).where(and(...filters)).orderBy(asc(marshalPerson.lastName));
  if (input.type === 'section') return { filename: 'Abschnittsliste.pdf', buffer: await renderPdf('Abschnittsliste', ['Vorname', 'Nachname', 'Posten/Funktion', 'Änderung'], rows.map((row) => [row.firstName, row.lastName, row.post ?? row.functionCode ?? '', '']), [140, 160, 150, 290]) };
  return { filename: 'Anwesenheitsliste.pdf', buffer: await renderPdf('Anwesenheitsliste', ['Vorname', 'Nachname', 'PLZ', 'Wohnort', 'Shirt', 'Posten', 'Unterschrift'], rows.map((row) => [row.firstName, row.lastName, row.zip ?? '', row.city ?? '', row.shirt ?? '', row.post ?? row.functionCode ?? '', '']), [95, 115, 55, 115, 60, 85, 215]) };
};
