import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, entryCharityCodriver, event, eventClass, exportJob, exportJobPerson, person } from '../db/schema';
import { buildQrCodeMatrix, type QrCodeMatrix } from '../docs/girocode';
import { deleteDocumentObject, getAssetObjectBuffer, getPresignedDownloadUrl, uploadPdf } from '../docs/storage';
import { standardPersonIdentity } from '../domain/personIdentity';

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
export type StampCard = {
  key: string;
  kind: 'driver' | 'regular_codriver' | 'charity_codriver';
  personName: string;
  driverNames?: string[];
  personId?: string;
  publicationNameVersion?: number;
  relatedPersonSnapshots?: Array<{ personId: string; publicationNameVersion: number }>;
  registrationId?: string;
  starts: CardStart[];
};

const CARD_WIDTH = 4876 / 20;
const CARD_HEIGHT = 3113 / 20;
const PAGE_LEFT = 1077 / 20;
const PAGE_TOP = 624 / 20;
const POINTS_PER_MM = 72 / 25.4;
const QR_QUIET_MODULES = 4;
const STAMP_BOX_STROKE_WIDTH = 0.8;
const BOTTOM_EDGE_COMPENSATION = STAMP_BOX_STROKE_WIDTH / 2;
const STAMP_CARD_ASSET_KEYS = {
  cornerLogo: 'public/stamp-cards/msc-logo-clean-transparent.png',
  displayFont: 'public/stamp-cards/fonts/oswald-700.ttf',
  textFont: 'public/stamp-cards/fonts/barlow-500.ttf',
  boldFont: 'public/stamp-cards/fonts/barlow-700.ttf'
} as const;
const FONT_NAMES = {
  display: 'StampCardOswald',
  text: 'StampCardBarlow',
  bold: 'StampCardBarlowBold'
} as const;

export type StampCardRenderAssets = {
  cornerLogo: Buffer | null;
  displayFont: Buffer | null;
  textFont: Buffer | null;
  boldFont: Buffer | null;
};

let cachedStampCardAssets: StampCardRenderAssets | null = null;

const loadStampCardAssets = async (): Promise<StampCardRenderAssets> => {
  if (cachedStampCardAssets) return cachedStampCardAssets;
  const [cornerLogo, displayFont, textFont, boldFont] = await Promise.all([
    getAssetObjectBuffer(STAMP_CARD_ASSET_KEYS.cornerLogo),
    getAssetObjectBuffer(STAMP_CARD_ASSET_KEYS.displayFont),
    getAssetObjectBuffer(STAMP_CARD_ASSET_KEYS.textFont),
    getAssetObjectBuffer(STAMP_CARD_ASSET_KEYS.boldFont)
  ]);
  const resolved = { cornerLogo, displayFont, textFont, boldFont };
  const missing = Object.entries(resolved)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) console.warn('stamp_card_assets_missing', { missing });
  else cachedStampCardAssets = resolved;
  return resolved;
};

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

const mergeStart = (card: StampCard, start: CardStart) => {
  if (!card.starts.some((item) => item.className === start.className && item.startNumber === start.startNumber)) {
    card.starts.push(start);
  }
};

const mergeDriverName = (card: StampCard, driverName: string) => {
  card.driverNames ??= [];
  if (!card.driverNames.includes(driverName)) card.driverNames.push(driverName);
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
      driverPublicationName: person.publicationName,
      driverPublicationNameVersion: person.publicationNameVersion,
      codriverPersonId: entry.codriverPersonId,
      codriverFirstName: codriverPerson.firstName,
      codriverLastName: codriverPerson.lastName,
      codriverPublicationName: codriverPerson.publicationName,
      codriverPublicationNameVersion: codriverPerson.publicationNameVersion,
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
      personName: standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName }).displayName,
      publicationNameVersion: row.driverPublicationNameVersion,
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
        personName: standardPersonIdentity({ firstName: row.codriverFirstName, lastName: row.codriverLastName, publicationName: row.codriverPublicationName }).displayName,
        publicationNameVersion: row.codriverPublicationNameVersion ?? 0,
        relatedPersonSnapshots: [{ personId: row.driverPersonId, publicationNameVersion: row.driverPublicationNameVersion }],
        driverNames: [],
        starts: []
      };
      mergeStart(codriver, start);
      mergeDriverName(codriver, standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName }).displayName);
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
            personId: entryCharityCodriver.personId,
            personFirstName: charityPerson.firstName,
            personLastName: charityPerson.lastName,
            personPublicationName: charityPerson.publicationName,
            personPublicationNameVersion: charityPerson.publicationNameVersion,
            driverFirstName: driverPerson.firstName,
            driverLastName: driverPerson.lastName,
            driverPublicationName: driverPerson.publicationName,
            driverPersonId: driverPerson.id,
            driverPublicationNameVersion: driverPerson.publicationNameVersion,
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
      personId: row.personId,
      publicationNameVersion: row.personPublicationNameVersion,
      relatedPersonSnapshots: [{ personId: row.driverPersonId, publicationNameVersion: row.driverPublicationNameVersion }],
      personName: standardPersonIdentity({ firstName: row.personFirstName, lastName: row.personLastName, publicationName: row.personPublicationName }).displayName,
      driverNames: [standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName }).displayName],
      starts: [{ className: row.className, startNumber: row.startNumber ?? '-' }]
    }]));
    resolved = subjects.flatMap((subject) => {
      if (subject.cardType === 'driver') return cards.get(`driver:${subject.personId}`) ?? [];
      if (subject.cardType === 'regular_codriver') return cards.get(`regular:${subject.personId}`) ?? [];
      return charityById.get(subject.registrationId) ?? [];
    });
    resolved = Array.from(new Map(resolved.map((card) => [card.key, card])).values());
  }

  resolved.forEach((card) => {
    card.starts.sort((a, b) => naturalCompare(`${a.className}:${a.startNumber}`, `${b.className}:${b.startNumber}`));
    card.driverNames?.sort(naturalCompare);
  });
  resolved.sort((a, b) => naturalCompare(`${a.starts[0]?.className}:${a.starts[0]?.startNumber}:${a.personName}`, `${b.starts[0]?.className}:${b.starts[0]?.startNumber}:${b.personName}`));
  return { cards: resolved, year: String(eventRow.startsAt).slice(0, 4), accentColor: eventRow.accentColor };
};

type StampCardFonts = { display: string; text: string; bold: string };

const mm = (value: number) => value * POINTS_PER_MM;

const registerStampCardFonts = (doc: any, assets: StampCardRenderAssets): StampCardFonts => {
  const fonts: StampCardFonts = { display: 'Helvetica-Bold', text: 'Helvetica', bold: 'Helvetica-Bold' };
  const register = (buffer: Buffer | null, name: string, key: keyof StampCardFonts) => {
    if (!buffer) return;
    try {
      doc.registerFont(name, buffer);
      fonts[key] = name;
    } catch (error) {
      console.warn('stamp_card_font_registration_failed', {
        font: key,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };
  register(assets.displayFont, FONT_NAMES.display, 'display');
  register(assets.textFont, FONT_NAMES.text, 'text');
  register(assets.boldFont, FONT_NAMES.bold, 'bold');
  return fonts;
};

const openCornerLogo = (doc: any, buffer: Buffer | null) => {
  if (!buffer) return null;
  try {
    return doc.openImage(`data:image/png;base64,${buffer.toString('base64')}`);
  } catch (error) {
    console.warn('stamp_card_corner_logo_open_failed', {
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

const drawCornerLogo = (doc: any, image: any | null, right: number, top: number) => {
  if (!image) return;
  const size = mm(11.5);
  const sourceSize = 1254;
  const visibleTop = 47;
  const visibleRight = 1127;
  const scale = size / sourceSize;
  const drawX = right - visibleRight * scale;
  const drawY = top - visibleTop * scale;
  doc.save().image(image, drawX, drawY, { width: size, height: size }).restore();
};

const drawQr = (
  doc: any,
  matrix: QrCodeMatrix,
  x: number,
  y: number,
  size: number,
  year: string,
  accentColor: string,
  fonts: StampCardFonts
) => {
  const innerX = x;
  const innerY = y;
  const innerSize = size;
  const quiet = QR_QUIET_MODULES;
  const module = innerSize / (matrix.size + quiet * 2);
  const clearSize = mm(8);
  const clearX = x + (size - clearSize) / 2;
  const clearY = y + (size - clearSize) / 2;
  doc.save().fillColor('#FFFFFF').rect(innerX, innerY, innerSize, innerSize).fill();
  doc.fillColor('#000000');
  // Merge adjacent modules into horizontal runs. Bulk sheets otherwise emit
  // enough PDF commands to exceed the synchronous API Lambda timeout.
  for (let row = 0; row < matrix.size; row += 1) {
    let runStart: number | null = null;
    for (let column = 0; column <= matrix.size; column += 1) {
      const moduleX = innerX + (column + quiet) * module;
      const moduleY = innerY + (row + quiet) * module;
      const intersectsCenter =
        moduleX < clearX + clearSize && moduleX + module > clearX && moduleY < clearY + clearSize && moduleY + module > clearY;
      const filled = column < matrix.size && matrix.modules[row * matrix.size + column] && !intersectsCenter;
      if (filled && runStart === null) {
        runStart = column;
      } else if (!filled && runStart !== null) {
        doc.rect(
          innerX + (runStart + quiet) * module,
          innerY + (row + quiet) * module,
          (column - runStart) * module + 0.08,
          module + 0.08
        );
        runStart = null;
      }
    }
  }
  doc.fill();
  const badge = mm(6.5);
  const bx = x + (size - badge) / 2;
  const by = y + (size - badge) / 2;
  const shortYear = year.slice(-2);
  doc.fillColor('#FFFFFF').rect(clearX, clearY, clearSize, clearSize).fill();
  doc.fillColor(accentColor).roundedRect(bx, by, badge, badge, 2).fill();
  doc.fillColor('#FFFFFF').font(fonts.bold).fontSize(9);
  const yearHeight = doc.heightOfString(shortYear, { width: badge, lineBreak: false });
  doc.text(shortYear, bx, by + (badge - yearHeight) / 2 - 0.35, {
    width: badge,
    align: 'center',
    lineBreak: false
  });
  doc.restore();
};

const fitText = (doc: any, text: string, maxWidth: number, initial: number, minimum: number) => {
  let size = initial;
  while (size > minimum && doc.fontSize(size).widthOfString(text) > maxWidth) size -= 0.5;
  return size;
};

const drawRoleMeta = (
  doc: any,
  card: StampCard,
  y: number,
  right: number,
  year: string,
  accentColor: string,
  fonts: StampCardFonts
) => {
  if (card.kind === 'driver') return;
  const yearWidth = mm(12);
  const height = mm(5);
  const yearX = right - yearWidth;
  const role = card.kind === 'regular_codriver' ? 'BEIFAHRER' : 'CHARITY-BEIFAHRER';
  const roleWidth = card.kind === 'regular_codriver' ? mm(24) : mm(38);
  const roleX = yearX - mm(1) - roleWidth;
  doc.fillColor(accentColor).rect(roleX, y, roleWidth, height).fill();
  doc.fillColor('#FFFFFF').font(fonts.bold).fontSize(card.kind === 'regular_codriver' ? 7.3 : 6.7);
  const roleHeight = doc.heightOfString(role, { width: roleWidth, lineBreak: false });
  doc.text(role, roleX, y + (height - roleHeight) / 2 - 0.2, {
    width: roleWidth,
    align: 'center',
    characterSpacing: 0.2,
    lineBreak: false
  });
  doc.lineWidth(0.85).strokeColor(accentColor).rect(yearX, y, yearWidth, height).stroke();
  doc.fillColor(accentColor).font(fonts.display).fontSize(8.4);
  const yearHeight = doc.heightOfString(year, { width: yearWidth, lineBreak: false });
  doc.text(year, yearX, y + (height - yearHeight) / 2 - 0.25, {
    width: yearWidth,
    align: 'center',
    lineBreak: false
  });
};

const drawDriverBanner = (
  doc: any,
  x: number,
  y: number,
  width: number,
  accentColor: string,
  fonts: StampCardFonts
) => {
  const height = mm(5);
  doc.fillColor(accentColor).rect(x, y, width, height).fill();
  doc.fillColor('#FFFFFF').font(fonts.bold).fontSize(8);
  const roleHeight = doc.heightOfString('FAHRER', { width, lineBreak: false });
  doc.text('FAHRER', x, y + (height - roleHeight) / 2 - 0.2, {
    width,
    align: 'center',
    characterSpacing: 0.5,
    lineBreak: false
  });
};

const startsForCard = (card: StampCard) => {
  const maxStarts = card.kind === 'driver' ? 4 : 5;
  const starts = card.starts.slice(0, maxStarts).map((item) => ({ ...item }));
  if (card.starts.length > maxStarts && starts.length > 0) {
    const last = starts[starts.length - 1];
    last.className = `${last.className} +${card.starts.length - maxStarts}`;
  }
  return starts;
};

const drawStartRows = (
  doc: any,
  starts: CardStart[],
  left: number,
  top: number,
  width: number,
  bottom: number,
  accentColor: string,
  fonts: StampCardFonts
) => {
  if (starts.length === 0) return;
  const rowHeight = (bottom - top) / starts.length;
  const labelSize = starts.length === 1 ? 9.5 : starts.length === 2 ? 8.7 : starts.length === 3 ? 7.8 : 7;
  const numberSize = starts.length === 1 ? 16 : starts.length === 2 ? 14 : starts.length === 3 ? 12 : 11;
  const numberWidth = mm(11);
  starts.forEach((start, index) => {
    const rowTop = top + rowHeight * index;
    const numberText = `#${start.startNumber}`;
    doc.lineWidth(0.55).strokeColor('#D9DEE5').moveTo(left, rowTop).lineTo(left + width, rowTop).stroke();
    doc.fillColor('#475569').font(fonts.text).fontSize(labelSize).text(start.className, left, rowTop + mm(1.1), {
      width: width - numberWidth - mm(1.5),
      height: Math.max(mm(3.2), rowHeight - mm(1.2)),
      lineGap: 0,
      ellipsis: true
    });
    const fittedNumberSize = fitText(doc.font(fonts.display), numberText, numberWidth, numberSize, 7.5);
    doc.fillColor(accentColor).font(fonts.display).fontSize(fittedNumberSize);
    const numberX = left + width - doc.widthOfString(numberText);
    doc.text(numberText, numberX, rowTop + mm(0.55), {
      lineBreak: false
    });
  });
};

const drawStampBoxes = (
  doc: any,
  labels: string[],
  left: number,
  top: number,
  availableWidth: number,
  fonts: StampCardFonts
) => {
  const gap = mm(2.5);
  const boxWidth = labels.length === 3
    ? (availableWidth - gap * (labels.length - 1)) / labels.length
    : Math.min(mm(15), (availableWidth - gap * (labels.length - 1)) / labels.length);
  const boxHeight = mm(10.5);
  labels.forEach((label, index) => {
    const boxX = left + index * (boxWidth + gap);
    doc.lineWidth(STAMP_BOX_STROKE_WIDTH).strokeColor('#9CA3AF').rect(boxX, top, boxWidth, boxHeight).stroke();
    doc.fillColor('#475569').font(fonts.bold).fontSize(8);
    const labelHeight = doc.heightOfString(label, { width: boxWidth, lineBreak: false });
    doc.text(label, boxX, top + (boxHeight - labelHeight) / 2 - 0.3, {
      width: boxWidth,
      align: 'center',
      lineBreak: false
    });
  });
};

const drawCard = (
  doc: any,
  card: StampCard,
  x: number,
  y: number,
  logoRight: number,
  year: string,
  accentColor: string,
  cornerLogoImage: any | null,
  fonts: StampCardFonts
) => {
  const stripeX = x + mm(3.4);
  const contentLeft = stripeX + mm(3.1);
  const contentRight = x + CARD_WIDTH - mm(3.6);
  const stampHeight = mm(10.5);
  const stampTop = y + CARD_HEIGHT - mm(4) - stampHeight;
  const qrSize = mm(29.5);
  const qrX = contentRight - qrSize;
  const logoVisibleWidth = mm(9.2);
  const logoLeft = logoRight - logoVisibleWidth;
  const isDriver = card.kind === 'driver';
  const textRight = isDriver ? qrX - mm(3) : contentRight;
  const textWidth = textRight - contentLeft;
  const nameWidth = logoLeft - contentLeft - mm(2);
  const displayName = card.personName.toLocaleUpperCase('de-DE');

  doc.save();
  doc.fillColor('#FFFFFF').rect(x, y, CARD_WIDTH, CARD_HEIGHT).fill();
  doc.fillColor(accentColor).rect(
    stripeX,
    y + mm(5),
    2.2,
    CARD_HEIGHT - mm(9) + BOTTOM_EDGE_COMPENSATION
  ).fill();
  drawCornerLogo(doc, cornerLogoImage, logoRight, y + mm(5));

  const nameY = y + mm(4);
  const nameSize = fitText(doc.font(fonts.display), displayName, nameWidth, 16.5, 9.5);
  doc.fillColor('#0F172A').font(fonts.display).fontSize(nameSize).text(displayName, contentLeft, nameY, {
    width: nameWidth,
    lineBreak: false
  });

  if (card.kind !== 'driver' && card.driverNames?.length) {
    const driverLine = `BEI ${card.driverNames.map((name) => name.toLocaleUpperCase('de-DE')).join(' · ')}`;
    const driverWidth = contentRight - contentLeft;
    const driverSize = fitText(doc.font(fonts.text), driverLine, driverWidth, 8.5, 7.2);
    doc.fillColor('#475569').font(fonts.text).fontSize(driverSize).text(driverLine, contentLeft, y + mm(14.8), {
      width: driverWidth,
      lineBreak: false
    });
  }

  const startsTop = card.kind === 'driver' ? y + mm(11.8) : y + mm(21.5);
  const footerY = stampTop + (stampHeight - mm(5)) / 2;
  const startsBottom = card.kind === 'charity_codriver' ? footerY - mm(2.2) : stampTop - mm(2.2);
  drawStartRows(doc, startsForCard(card), contentLeft, startsTop, textWidth, startsBottom, accentColor, fonts);

  if (card.kind === 'driver') drawStampBoxes(doc, ['TA', 'FB', 'FB'], contentLeft, stampTop, textWidth, fonts);
  if (card.kind === 'regular_codriver') drawStampBoxes(doc, ['FB', 'FB'], contentLeft, stampTop, mm(32.5), fonts);
  drawRoleMeta(doc, card, footerY, contentRight, year, accentColor, fonts);
  doc.restore();
};

type StampCardRenderInput = {
  cards: StampCard[];
  eventId: string;
  startSlot: number;
  year: string;
  accentColor: string;
  assets: StampCardRenderAssets;
};

export const renderStampCardPdf = ({ cards, eventId, startSlot, year, accentColor, assets }: StampCardRenderInput) =>
  new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, info: { Title: `Stempelkarten ${year}` } });
    const fonts = registerStampCardFonts(doc, assets);
    const cornerLogoImage = openCornerLogo(doc, assets.cornerLogo);
    const qrSize = mm(29.5);
    const qrMatrices = new Map<string, QrCodeMatrix>();
    cards.forEach((card) => {
      if (card.kind === 'driver' && card.personId) {
        qrMatrices.set(card.personId, buildQrCodeMatrix(inspectionUrl(eventId, card.personId), 'H'));
      }
    });
    const alignmentMatrix = qrMatrices.values().next().value as QrCodeMatrix | undefined;
    const logoQuietInset = alignmentMatrix
      ? QR_QUIET_MODULES * (qrSize / (alignmentMatrix.size + QR_QUIET_MODULES * 2))
      : mm(1.8);
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    cards.forEach((card, index) => {
      const absolute = startSlot - 1 + index;
      if (index > 0 && absolute % 10 === 0) doc.addPage();
      const slot = absolute % 10;
      const x = PAGE_LEFT + (slot % 2) * CARD_WIDTH;
      const y = PAGE_TOP + Math.floor(slot / 2) * CARD_HEIGHT;
      const logoRight = x + CARD_WIDTH - mm(3.6) - logoQuietInset;
      drawCard(doc, card, x, y, logoRight, year, accentColor, cornerLogoImage, fonts);
      if (card.kind === 'driver' && card.personId) {
        const qrX = x + CARD_WIDTH - mm(3.6) - qrSize;
        const matrix = qrMatrices.get(card.personId)!;
        const module = qrSize / (matrix.size + QR_QUIET_MODULES * 2);
        const quietInset = QR_QUIET_MODULES * module;
        const visibleQrBottom = y + CARD_HEIGHT - mm(4) + BOTTOM_EDGE_COMPENSATION;
        const qrY = visibleQrBottom - qrSize + quietInset;
        const visibleQrX = qrX + QR_QUIET_MODULES * module;
        const visibleQrWidth = matrix.size * module;
        drawDriverBanner(doc, visibleQrX, qrY - mm(6), visibleQrWidth, accentColor, fonts);
        drawQr(doc, matrix, qrX, qrY, qrSize, year, accentColor, fonts);
      }
    });
    doc.end();
  });

export const createStampCardExport = async (input: StampCardExportInput, actorUserId: string | null) => {
  const resolved = await resolveCards(input);
  if (resolved.cards.length === 0) throw new Error('STAMP_CARD_NO_SUBJECTS');
  const db = await getDb();
  const [job] = await db.insert(exportJob).values({
    eventId: input.eventId,
    type: 'stamp_cards_pdf',
    filters: input,
    status: 'processing',
    createdBy: actorUserId,
    createdAt: new Date()
  }).returning();
  if (!job) throw new Error('EXPORT_JOB_CREATE_FAILED');
  let unfinalizedS3Key: string | null = null;
  try {
    const people = Array.from(new Map(resolved.cards.flatMap((card) => [
      ...(card.personId && card.publicationNameVersion !== undefined
        ? [{ personId: card.personId, publicationNameVersion: card.publicationNameVersion }]
        : []),
      ...(card.relatedPersonSnapshots ?? [])
    ]).map((snapshot) => [snapshot.personId, { exportJobId: job.id, ...snapshot }])).values());
    if (people.length > 0) await db.insert(exportJobPerson).values(people).onConflictDoNothing();
    const assets = await loadStampCardAssets();
    const data = await renderStampCardPdf({
      cards: resolved.cards,
      eventId: input.eventId,
      startSlot: input.startSlot,
      year: resolved.year,
      accentColor: resolved.accentColor,
      assets
    });
    const pageCount = Math.ceil((input.startSlot - 1 + resolved.cards.length) / 10);
    const filename = `stempelkarten-${resolved.year}.pdf`;
    const s3Key = `exports/${input.eventId}/stamp-cards/v2/${randomUUID()}.pdf`;
    await uploadPdf(s3Key, data);
    unfinalizedS3Key = s3Key;
    const finalized = await db.transaction(async (tx) => {
      const snapshots = await tx.select({ expected: exportJobPerson.publicationNameVersion, current: person.publicationNameVersion })
        .from(exportJobPerson)
        .innerJoin(person, eq(exportJobPerson.personId, person.id))
        .where(eq(exportJobPerson.exportJobId, job.id))
        .for('update');
      if (snapshots.some((item) => item.expected !== item.current)) return null;
      const [updated] = await tx.update(exportJob)
        .set({ status: 'succeeded', s3Key, completedAt: new Date() })
        .where(and(eq(exportJob.id, job.id), eq(exportJob.status, 'processing')))
        .returning();
      return updated ?? null;
    });
    if (!finalized) throw new Error('EXPORT_INVALIDATED');
    unfinalizedS3Key = null;
    const downloadUrl = await getPresignedDownloadUrl(s3Key, 300, filename);
    await writeAuditLog(db as never, {
      eventId: input.eventId,
      actorUserId,
      action: 'stamp_cards_exported',
      entityType: 'event',
      entityId: input.eventId,
      payload: { cardCount: resolved.cards.length, pageCount, startSlot: input.startSlot, selectionType: input.selection.type }
    });
    return { downloadUrl, filename, cardCount: resolved.cards.length, pageCount, year: resolved.year };
  } catch (error) {
    if (unfinalizedS3Key) {
      await deleteDocumentObject(unfinalizedS3Key).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : 'Stamp-card export failed';
    await db.update(exportJob).set({
      status: message === 'EXPORT_INVALIDATED' ? 'invalidated' : 'failed',
      errorLast: message,
      completedAt: new Date()
    }).where(and(eq(exportJob.id, job.id), eq(exportJob.status, 'processing')));
    throw error;
  }
};

export const validateStampCardExportInput = (payload: unknown) => exportSchema.parse(payload);
