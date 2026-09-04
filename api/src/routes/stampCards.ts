import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, entryCharityCodriver, event, eventClass, person } from '../db/schema';
import { buildQrCodeMatrix, type QrCodeMatrix } from '../docs/girocode';
import { getPresignedDownloadUrl, uploadPdf } from '../docs/storage';

// Lambda uses the standalone build so rendering never depends on host fonts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit/js/pdfkit.standalone');

const subjectSchema = z.discriminatedUnion('cardType', [
  z.object({ cardType: z.literal('driver'), personId: z.string().uuid() }),
  z.object({ cardType: z.literal('regular_codriver'), personId: z.string().uuid() }),
  z.object({ cardType: z.literal('charity_codriver'), registrationId: z.string().uuid() })
]);

const exportSchema = z.object({
  eventId: z.string().uuid(),
  startSlot: z.number().int().min(1).max(10).default(1),
  selection: z.discriminatedUnion('type', [
    z.object({ type: z.literal('accepted_regular') }),
    z.object({ type: z.literal('subjects'), subjects: z.array(subjectSchema).min(1).max(250) })
  ])
});

export type StampCardExportInput = z.infer<typeof exportSchema>;
type CardStart = { className: string; startNumber: string };
type StampCard = {
  key: string;
  kind: 'driver' | 'regular_codriver' | 'charity_codriver';
  personName: string;
  driverName?: string;
  personId?: string;
  registrationId?: string;
  starts: CardStart[];
};

const CARD_WIDTH = 4876 / 20;
const CARD_HEIGHT = 3113 / 20;
const PAGE_LEFT = 1077 / 20;
const PAGE_TOP = 624 / 20;

const nameOf = (firstName: string | null, lastName: string | null) =>
  `${firstName ?? ''} ${lastName ?? ''}`.trim() || 'Unbekannt';

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

const mergeStart = (card: StampCard, start: CardStart) => {
  if (!card.starts.some((item) => item.className === start.className && item.startNumber === start.startNumber)) {
    card.starts.push(start);
  }
};

const inspectionUrl = (eventId: string, personId: string) => {
  const baseUrl = (process.env.MAIL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('INSPECTION_PUBLIC_URL_NOT_CONFIGURED');
  return `${baseUrl}/inspection/participant/${encodeURIComponent(eventId)}/${encodeURIComponent(personId)}`;
};

const resolveCards = async (input: StampCardExportInput): Promise<{ cards: StampCard[]; year: string; accentColor: string }> => {
  const db = await getDb();
  const [eventRow] = await db
    .select({ id: event.id, startsAt: event.startsAt, accentColor: event.stampCardAccentColor })
    .from(event)
    .where(eq(event.id, input.eventId))
    .limit(1);
  if (!eventRow) throw new Error('EVENT_NOT_FOUND');

  const codriverPerson = alias(person, 'stamp_card_codriver_person');
  const entryRows = await db
    .select({
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      codriverPersonId: entry.codriverPersonId,
      codriverFirstName: codriverPerson.firstName,
      codriverLastName: codriverPerson.lastName,
      className: eventClass.name,
      startNumber: entry.startNumberNorm
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(codriverPerson, eq(entry.codriverPersonId, codriverPerson.id))
    .where(and(eq(entry.eventId, input.eventId), eq(entry.acceptanceStatus, 'accepted'), sql`${entry.deletedAt} is null`))
    .orderBy(asc(eventClass.name), asc(entry.startNumberNorm), asc(person.lastName), asc(person.firstName));

  const cards = new Map<string, StampCard>();
  for (const row of entryRows) {
    const start = { className: row.className, startNumber: row.startNumber ?? '-' };
    const driverKey = `driver:${row.driverPersonId}`;
    const driver = cards.get(driverKey) ?? {
      key: driverKey,
      kind: 'driver' as const,
      personId: row.driverPersonId,
      personName: nameOf(row.driverFirstName, row.driverLastName),
      starts: []
    };
    mergeStart(driver, start);
    cards.set(driverKey, driver);

    if (row.codriverPersonId) {
      const key = `regular:${row.codriverPersonId}`;
      const codriver = cards.get(key) ?? {
        key,
        kind: 'regular_codriver' as const,
        personId: row.codriverPersonId,
        personName: nameOf(row.codriverFirstName, row.codriverLastName),
        starts: []
      };
      mergeStart(codriver, start);
      cards.set(key, codriver);
    }
  }

  let resolved: StampCard[];
  if (input.selection.type === 'accepted_regular') {
    resolved = Array.from(cards.values());
  } else {
    const subjects = input.selection.subjects;
    const charityIds = subjects
      .filter((subject): subject is Extract<(typeof subjects)[number], { cardType: 'charity_codriver' }> => subject.cardType === 'charity_codriver')
      .map((subject) => subject.registrationId);
    const charityPerson = alias(person, 'stamp_card_charity_person');
    const driverPerson = alias(person, 'stamp_card_charity_driver');
    const charityRows = charityIds.length
      ? await db
          .select({
            registrationId: entryCharityCodriver.id,
            personFirstName: charityPerson.firstName,
            personLastName: charityPerson.lastName,
            driverFirstName: driverPerson.firstName,
            driverLastName: driverPerson.lastName,
            className: eventClass.name,
            startNumber: entry.startNumberNorm
          })
          .from(entryCharityCodriver)
          .innerJoin(entry, eq(entryCharityCodriver.entryId, entry.id))
          .innerJoin(charityPerson, eq(entryCharityCodriver.personId, charityPerson.id))
          .innerJoin(driverPerson, eq(entry.driverPersonId, driverPerson.id))
          .innerJoin(eventClass, eq(entry.classId, eventClass.id))
          .where(and(
            eq(entryCharityCodriver.eventId, input.eventId),
            eq(entryCharityCodriver.status, 'active'),
            eq(entry.acceptanceStatus, 'accepted'),
            inArray(entryCharityCodriver.id, charityIds)
          ))
      : [];
    const charityById = new Map<string, StampCard>(charityRows.map((row) => [row.registrationId, {
      key: `charity:${row.registrationId}`,
      kind: 'charity_codriver',
      registrationId: row.registrationId,
      personName: nameOf(row.personFirstName, row.personLastName),
      driverName: nameOf(row.driverFirstName, row.driverLastName),
      starts: [{ className: row.className, startNumber: row.startNumber ?? '-' }]
    }]));
    resolved = subjects.flatMap((subject) => {
      if (subject.cardType === 'driver') return cards.get(`driver:${subject.personId}`) ?? [];
      if (subject.cardType === 'regular_codriver') return cards.get(`regular:${subject.personId}`) ?? [];
      return charityById.get(subject.registrationId) ?? [];
    });
    resolved = Array.from(new Map(resolved.map((card) => [card.key, card])).values());
  }

  resolved.forEach((card) => card.starts.sort((a, b) => naturalCompare(`${a.className}:${a.startNumber}`, `${b.className}:${b.startNumber}`)));
  resolved.sort((a, b) => naturalCompare(`${a.starts[0]?.className}:${a.starts[0]?.startNumber}:${a.personName}`, `${b.starts[0]?.className}:${b.starts[0]?.startNumber}:${b.personName}`));
  return { cards: resolved, year: String(eventRow.startsAt).slice(0, 4), accentColor: eventRow.accentColor };
};

const drawQr = (doc: any, matrix: QrCodeMatrix, x: number, y: number, size: number, year: string, accentColor: string) => {
  const quiet = 4;
  const module = size / (matrix.size + quiet * 2);
  doc.save().fillColor('#FFFFFF').rect(x, y, size, size).fill();
  doc.fillColor('#000000');
  matrix.modules.forEach((filled, index) => {
    if (!filled) return;
    const column = index % matrix.size;
    const row = Math.floor(index / matrix.size);
    doc.rect(x + (column + quiet) * module, y + (row + quiet) * module, module + 0.08, module + 0.08).fill();
  });
  const badge = 18;
  const bx = x + (size - badge) / 2;
  const by = y + (size - badge) / 2;
  doc.fillColor('#FFFFFF').roundedRect(bx, by, badge, badge, 2).fill();
  doc.lineWidth(1).strokeColor(accentColor).roundedRect(bx, by, badge, badge, 2).stroke();
  doc.fillColor(accentColor).font('Helvetica-Bold').fontSize(6.5).text(year, bx, by + 5.2, { width: badge, align: 'center' });
  doc.lineWidth(1.5).strokeColor(accentColor).roundedRect(x + 0.75, y + 0.75, size - 1.5, size - 1.5, 2).stroke();
  doc.restore();
};

const fitText = (doc: any, text: string, maxWidth: number, initial: number, minimum: number) => {
  let size = initial;
  while (size > minimum && doc.fontSize(size).widthOfString(text) > maxWidth) size -= 0.5;
  return size;
};

const drawCard = (doc: any, card: StampCard, x: number, y: number, year: string, accentColor: string) => {
  const inset = 3;
  const qrSize = card.kind === 'driver' ? 78 : 0;
  const textWidth = card.kind === 'driver' ? CARD_WIDTH - qrSize - 23 : CARD_WIDTH - 24;
  doc.save().lineWidth(1).strokeColor(accentColor).roundedRect(x + inset, y + inset, CARD_WIDTH - inset * 2, CARD_HEIGHT - inset * 2, 5).stroke();
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(7).text('MSC OLD', x + 11, y + 10, { characterSpacing: 0.7 });
  doc.fillColor(accentColor).fontSize(7).text(year, x + CARD_WIDTH - 44, y + 10, { width: 32, align: 'right' });
  const nameSize = fitText(doc, card.personName, textWidth, 13, 8);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(nameSize).text(card.personName, x + 11, y + 28, { width: textWidth, lineBreak: false });
  if (card.kind === 'charity_codriver' && card.driverName) {
    doc.fillColor('#4B5563').font('Helvetica').fontSize(7.5).text(`bei ${card.driverName}`, x + 11, y + 46, { width: textWidth, ellipsis: true, lineBreak: false });
  }
  const startsY = card.kind === 'charity_codriver' ? y + 62 : y + 51;
  const maxStarts = card.kind === 'driver' ? 4 : 5;
  const starts = card.starts.slice(0, maxStarts).map((item) => `${item.className} · #${item.startNumber}`);
  if (card.starts.length > maxStarts) starts[maxStarts - 1] = `${starts[maxStarts - 1]} +${card.starts.length - maxStarts}`;
  doc.fillColor('#1F2937').font('Helvetica').fontSize(starts.length > 2 ? 7 : 8).text(starts.join('\n'), x + 11, startsY, {
    width: textWidth,
    lineGap: 1,
    height: card.kind === 'charity_codriver' ? 54 : 48,
    ellipsis: true
  });

  const labels = card.kind === 'driver' ? ['TA', 'FB', 'FB'] : card.kind === 'regular_codriver' ? ['FB', 'FB'] : [];
  if (labels.length) {
    const gap = 5;
    const left = x + 11;
    const available = CARD_WIDTH - 22;
    const width = (available - gap * (labels.length - 1)) / labels.length;
    const top = y + CARD_HEIGHT - 35;
    labels.forEach((label, index) => {
      const boxX = left + index * (width + gap);
      doc.lineWidth(0.6).strokeColor('#6B7280').roundedRect(boxX, top, width, 23, 3).stroke();
      doc.fillColor(accentColor).font('Helvetica-Bold').fontSize(7).text(label, boxX, top + 8, { width, align: 'center' });
    });
  }
  doc.restore();
};

export const createStampCardExport = async (input: StampCardExportInput, actorUserId: string | null) => {
  const resolved = await resolveCards(input);
  if (resolved.cards.length === 0) throw new Error('STAMP_CARD_NO_SUBJECTS');
  const data = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, info: { Title: `Stempelkarten ${resolved.year}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    resolved.cards.forEach((card, index) => {
      const absolute = input.startSlot - 1 + index;
      if (index > 0 && absolute % 10 === 0) doc.addPage();
      const slot = absolute % 10;
      const x = PAGE_LEFT + (slot % 2) * CARD_WIDTH;
      const y = PAGE_TOP + Math.floor(slot / 2) * CARD_HEIGHT;
      if (card.kind === 'driver' && card.personId) {
        const matrix = buildQrCodeMatrix(inspectionUrl(input.eventId, card.personId), 'H');
        drawCard(doc, card, x, y, resolved.year, resolved.accentColor);
        drawQr(doc, matrix, x + CARD_WIDTH - 89, y + 27, 78, resolved.year, resolved.accentColor);
      } else {
        drawCard(doc, card, x, y, resolved.year, resolved.accentColor);
      }
    });
    doc.end();
  });
  const pageCount = Math.ceil((input.startSlot - 1 + resolved.cards.length) / 10);
  const filename = `stempelkarten-${resolved.year}.pdf`;
  const s3Key = `exports/${input.eventId}/stamp-cards/${randomUUID()}.pdf`;
  await uploadPdf(s3Key, data);
  const downloadUrl = await getPresignedDownloadUrl(s3Key, 300, filename);
  const db = await getDb();
  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'stamp_cards_exported',
    entityType: 'event',
    entityId: input.eventId,
    payload: { cardCount: resolved.cards.length, pageCount, startSlot: input.startSlot, selectionType: input.selection.type }
  });
  return { downloadUrl, filename, cardCount: resolved.cards.length, pageCount, year: resolved.year };
};

export const validateStampCardExportInput = (payload: unknown) => exportSchema.parse(payload);
