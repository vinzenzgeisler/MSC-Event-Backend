// Use standalone build so Lambda bundling does not depend on external AFM font files.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit/js/pdfkit.standalone');
import { format } from 'node:util';
import { renderAutoChecklistV1 } from './templates/tech-check/auto/v1';
import { renderMotoChecklistV1 } from './templates/tech-check/moto/v1';

type PersonInfo = {
  fullName: string;
  birthdate?: string | null;
  nationality?: string | null;
  address?: string | null;
  phone?: string | null;
};

type VehicleInfo = {
  vehicleType: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  startNumber?: string | null;
};

type EventInfo = {
  name: string;
  startsAt: string;
  endsAt: string;
  className: string;
};

type WaiverPayload = {
  event: EventInfo;
  driver: PersonInfo;
  codriver?: PersonInfo | null;
  vehicle: VehicleInfo;
};

type TechCheckPayload = {
  event: EventInfo;
  driver: PersonInfo;
  vehicle: VehicleInfo;
  templateVariant: 'auto' | 'moto';
};

type BatchDocumentItem = {
  entryId: string;
  className: string;
  driverName: string;
  vehicleSummary: string;
  startNumber: string | null;
};

type EntryConfirmationVehicleInfo = {
  vehicleType: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  displacementCcm?: number | null;
};

type EntryConfirmationPaymentInfo = {
  totalFee: string;
  paidAmount: string;
  openAmount: string;
  paymentDeadline?: string | null;
  paymentRecipient?: string | null;
  paymentIban?: string | null;
  paymentBic?: string | null;
};

export type EntryConfirmationPdfPayload = {
  eventName: string;
  eventDateText: string;
  organizer: string;
  className: string;
  startNumber: string | null;
  driver: {
    fullName: string;
    street: string | null;
    zip: string | null;
    city: string | null;
    email: string | null;
    phone: string | null;
  };
  codriver?: {
    fullName: string;
    birthdate: string | null;
  } | null;
  vehicle: EntryConfirmationVehicleInfo;
  backupVehicle?: EntryConfirmationVehicleInfo | null;
  payment: EntryConfirmationPaymentInfo;
  legalHint: string;
  logoImage?: Buffer | null;
};

const renderPdf = (title: string, bodyLines: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown();

    doc.fontSize(11);
    bodyLines.forEach((line) => {
      doc.text(line);
      doc.moveDown(0.4);
    });

    doc.end();
  });

const formatPerson = (person: PersonInfo): string[] => [
  format('Name: %s', person.fullName),
  format('Geburtsdatum: %s', person.birthdate ?? '-'),
  format('Nationalität: %s', person.nationality ?? '-'),
  format('Adresse: %s', person.address ?? '-'),
  format('Telefon: %s', person.phone ?? '-')
];

const formatVehicle = (vehicle: VehicleInfo): string[] => [
  format('Fahrzeugtyp: %s', vehicle.vehicleType),
  format('Hersteller/Modell: %s %s', vehicle.make ?? '-', vehicle.model ?? '-'),
  format('Baujahr: %s', vehicle.year ?? '-'),
  format('Startnummer: %s', vehicle.startNumber ?? '-')
];

export const renderWaiverPdf = async (payload: WaiverPayload): Promise<Buffer> => {
  const lines: string[] = [
    format('Event: %s', payload.event.name),
    format('Datum: %s bis %s', payload.event.startsAt, payload.event.endsAt),
    format('Klasse: %s', payload.event.className),
    '',
    'Fahrer',
    ...formatPerson(payload.driver),
    ''
  ];

  if (payload.codriver) {
    lines.push('Beifahrer', ...formatPerson(payload.codriver), '');
  } else {
    lines.push('Beifahrer: -', '');
  }

  lines.push('Fahrzeug', ...formatVehicle(payload.vehicle), '');
  lines.push('Haftverzichtserklaerung');
  lines.push(
    'Hiermit bestätige ich, dass ich die Teilnahmebedingungen gelesen habe und auf eigene Gefahr teilnehme.'
  );
  lines.push('Unterschrift: ________________________________');

  return renderPdf('Haftverzicht', lines);
};

export const renderTechCheckPdf = async (payload: TechCheckPayload): Promise<Buffer> => {
  const baseData = {
    eventName: payload.event.name,
    eventStartsAt: payload.event.startsAt,
    eventEndsAt: payload.event.endsAt,
    className: payload.event.className,
    driverName: payload.driver.fullName,
    vehicleMake: payload.vehicle.make ?? null,
    vehicleModel: payload.vehicle.model ?? null,
    vehicleYear: payload.vehicle.year ?? null,
    startNumber: payload.vehicle.startNumber ?? null
  };
  const lines: string[] =
    payload.templateVariant === 'auto' ? renderAutoChecklistV1(baseData) : renderMotoChecklistV1(baseData);

  return renderPdf('Technische Abnahme', lines);
};

export const renderBatchDocumentPdf = async (
  title: string,
  subtitle: string,
  items: BatchDocumentItem[]
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).text(subtitle);
    doc.moveDown();

    items.forEach((item, idx) => {
      doc.fontSize(12).text(`${idx + 1}. ${item.driverName}`);
      doc.fontSize(10).text(`Entry: ${item.entryId}`);
      doc.text(`Klasse: ${item.className}`);
      doc.text(`Fahrzeug: ${item.vehicleSummary}`);
      doc.text(`Startnummer: ${item.startNumber ?? '-'}`);
      doc.moveDown();
    });

    doc.end();
  });

const normalizeText = (value: string | null | undefined, fallback = '-'): string => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const normalizeNumber = (value: number | null | undefined, fallback = '-'): string =>
  Number.isFinite(value ?? NaN) ? String(value) : fallback;

const ensureSectionGap = (doc: typeof PDFDocument.prototype, minBottom = 120) => {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < minBottom) {
    doc.addPage();
  }
};

const drawSectionTitle = (doc: typeof PDFDocument.prototype, title: string) => {
  ensureSectionGap(doc, 80);
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#0B1F4D').text(title.toUpperCase(), { lineGap: 2 });
  doc.moveDown(0.15);
  const startX = doc.x;
  const startY = doc.y;
  doc
    .save()
    .lineWidth(1)
    .strokeColor('#F4C406')
    .moveTo(startX, startY)
    .lineTo(startX + 84, startY)
    .stroke()
    .restore();
  doc.moveDown(0.4);
  doc.fillColor('#111827');
};

const drawKeyValue = (doc: typeof PDFDocument.prototype, label: string, value: string) => {
  ensureSectionGap(doc, 40);
  doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
  doc.font('Helvetica').fontSize(10).text(value);
  doc.moveDown(0.2);
};

const renderVehicleBlock = (
  doc: typeof PDFDocument.prototype,
  title: string,
  vehicle: EntryConfirmationVehicleInfo | null | undefined
) => {
  if (!vehicle) {
    return;
  }
  drawSectionTitle(doc, title);
  drawKeyValue(doc, 'Fahrzeugtyp', normalizeText(vehicle.vehicleType));
  drawKeyValue(
    doc,
    'Hersteller/Modell',
    `${normalizeText(vehicle.make)} ${normalizeText(vehicle.model)}`
      .replace(/\s+/g, ' ')
      .trim()
  );
  drawKeyValue(doc, 'Baujahr', normalizeNumber(vehicle.year));
  drawKeyValue(doc, 'Hubraum', normalizeNumber(vehicle.displacementCcm, '-') === '-' ? '-' : `${vehicle.displacementCcm} ccm`);
};

export const renderEntryConfirmationPdf = async (payload: EntryConfirmationPdfPayload): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 46,
      compress: false,
      info: {
        Title: 'Nennbestätigung',
        Author: payload.organizer,
        Subject: payload.eventName,
        Keywords: 'Nennbestätigung, Motorsport',
        CreationDate: new Date('2026-01-01T00:00:00.000Z'),
        ModDate: new Date('2026-01-01T00:00:00.000Z')
      }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const leftX = 46;
    const contentWidth = doc.page.width - 92;
    const rightLogoX = doc.page.width - 140;

    if (payload.logoImage && payload.logoImage.length > 0) {
      try {
        doc.image(payload.logoImage, rightLogoX, 34, { fit: [94, 94], align: 'right', valign: 'top' });
      } catch {
        // Logo is optional. If image parsing fails, continue without visual logo.
      }
    }

    const gateNote = (process.env.ENTRY_CONFIRMATION_GATE_NOTE ?? 'Bei Einfahrt in das Fahrerlager vorzeigen.').trim();
    const addressPrefix = (process.env.ENTRY_CONFIRMATION_ORGANIZER_ADDRESS_PREFIX ?? payload.organizer).trim();
    const venueAddress = (process.env.ENTRY_CONFIRMATION_VENUE_ADDRESS ?? '').trim();
    const venueGps = (process.env.ENTRY_CONFIRMATION_VENUE_GPS ?? '').trim();
    const termsLine1 = (process.env.ENTRY_CONFIRMATION_TERMS_LINE1 ?? '').trim();
    const termsLine2 = (process.env.ENTRY_CONFIRMATION_TERMS_LINE2 ?? '').trim();
    const warningRed1 = (
      process.env.ENTRY_CONFIRMATION_WARNING_RED_1 ??
      'Bitte beachte, dass die Ölablassschrauben und die Ölfilterpatronen zu sichern sind!'
    ).trim();
    const warningBlack = (
      process.env.ENTRY_CONFIRMATION_WARNING_BLACK ??
      'Wir weisen darauf hin, dass die Abreise erst nach Ende der Veranstaltung möglich ist.'
    ).trim();
    const scheduleLines = (
      process.env.ENTRY_CONFIRMATION_SCHEDULE_LINES ??
      `Anmeldung: Veranstaltungstag\nTechnische Abnahme: Veranstaltungstag\nFahrerbesprechung: Veranstaltungstag\nStart: Veranstaltungstag`
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const firstName = normalizeText(payload.driver.fullName, 'Fahrer').split(/\s+/)[0] ?? 'Fahrer';
    const driverAddressLines = [
      normalizeText(payload.driver.fullName, ''),
      normalizeText(payload.driver.street, ''),
      [normalizeText(payload.driver.zip, ''), normalizeText(payload.driver.city, '')].filter(Boolean).join(' ').trim()
    ].filter((line) => line.length > 0);

    const primaryVehicleLine = [
      normalizeText(payload.vehicle.vehicleType, ''),
      normalizeText(payload.vehicle.make, ''),
      normalizeText(payload.vehicle.model, '')
    ]
      .filter((item) => item.length > 0)
      .join(' ')
      .trim();

    const backupVehicleLine = payload.backupVehicle
      ? [normalizeText(payload.backupVehicle.vehicleType, ''), normalizeText(payload.backupVehicle.make, ''), normalizeText(payload.backupVehicle.model, '')]
          .filter((item) => item.length > 0)
          .join(' ')
          .trim()
      : null;
    const paymentReference = `Kliv_${normalizeText(payload.driver.fullName)
      .replace(/\s+/g, '')}_${normalizeText(payload.className)
      .replace(/\s+/g, '')}_${normalizeText(payload.startNumber)
      .replace(/\s+/g, '')}`;

    const leftColumnWidth = 248;
    const rightColumnWidth = 228;
    const rightColumnX = leftX + leftColumnWidth + 18;

    doc.font('Helvetica-Bold').fontSize(22).fillColor('#D81E05').text(gateNote, leftX, 86, { width: 310 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#4B5563').text(addressPrefix, leftX, 132, { width: 320 });

    let y = 152;
    doc.font('Helvetica').fontSize(16).fillColor('#111111');
    driverAddressLines.forEach((line) => {
      doc.text(line, leftX, y, { width: 240 });
      y += 18;
    });

    const titleY = 318;
    doc
      .font('Helvetica-Bold')
      .fontSize(26)
      .fillColor('#111111')
      .text('Nennbestätigung (entry confirmation)', leftX, titleY, { width: contentWidth });
    doc
      .font('Helvetica-Bold')
      .fontSize(17)
      .text(`für ${payload.eventName} vom ${payload.eventDateText}`, leftX, titleY + 34, { width: contentWidth });

    let textY = titleY + 86;
    doc.font('Helvetica').fontSize(13.5).fillColor('#111111').text(`Lieber ${firstName},`, leftX, textY);
    textY += 34;
    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor('#111111')
      .text(
        `wir bedanken uns für Deine Nennung zum ${payload.eventName} und möchten hiermit die Nennung, vorbehaltlich des Nenngeldeingangs, bestätigen.`,
        leftX,
        textY,
        { width: contentWidth, lineGap: 1.8 }
      );
    textY += 70;

    doc.font('Helvetica-Bold').fontSize(12).text('Genannte Fahrzeuge:', leftX, textY, { width: leftColumnWidth });
    let leftY = textY + 24;
    doc.font('Helvetica').fontSize(11.5);
    doc.text(`Klasse ${normalizeText(payload.className)}`, leftX, leftY, { width: leftColumnWidth, lineGap: 1.8 });
    leftY += 19;
    doc.text(`Startnummer ${normalizeText(payload.startNumber)}`, leftX, leftY, { width: leftColumnWidth, lineGap: 1.8 });
    leftY += 19;
    doc.text(`Fahrzeug ${normalizeText(primaryVehicleLine)}`, leftX, leftY, { width: leftColumnWidth, lineGap: 1.8 });
    leftY += 19;
    if (backupVehicleLine) {
      doc.text(`Ersatzfahrzeug ${normalizeText(backupVehicleLine)}`, leftX, leftY, { width: leftColumnWidth, lineGap: 1.8 });
      leftY += 19;
    }
    if (payload.codriver?.fullName) {
      doc.text(`Beifahrer ${normalizeText(payload.codriver.fullName)}`, leftX, leftY, { width: leftColumnWidth, lineGap: 1.8 });
      leftY += 19;
    }

    leftY += 8;
    doc.font('Helvetica-Bold').fontSize(12).text('Zahlung:', leftX, leftY, { width: leftColumnWidth });
    leftY += 22;
    doc
      .font('Helvetica')
      .fontSize(11.5)
      .text(
        `Überweise bitte den Nennbetrag in Höhe von ${normalizeText(payload.payment.openAmount)} spätestens bis ${normalizeText(payload.payment.paymentDeadline)} mit dem Verwendungszweck`,
        leftX,
        leftY,
        { width: leftColumnWidth, lineGap: 1.6 }
      );
    leftY += 52;
    doc.font('Helvetica-Bold').fontSize(11.5).text(paymentReference, leftX, leftY, {
      width: leftColumnWidth
    });
    leftY += 20;
    doc.font('Helvetica').fontSize(11.5).text(`${normalizeText(payload.payment.paymentRecipient)}\nIBAN: ${normalizeText(payload.payment.paymentIban)}\nBIC: ${normalizeText(payload.payment.paymentBic)}`, leftX, leftY, {
      width: leftColumnWidth,
      lineGap: 1.6
    });
    leftY += 70;

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#D81E05').text(warningRed1, leftX, leftY, {
      width: leftColumnWidth,
      lineGap: 1.8
    });
    leftY += 46;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(warningBlack, leftX, leftY, {
      width: leftColumnWidth,
      lineGap: 1.8
    });

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111').text('Veranstaltungsinfos:', rightColumnX, textY, {
      width: rightColumnWidth
    });
    let rightY = textY + 24;
    doc.font('Helvetica').fontSize(11.5).text(
      `Das Fahrerlager ist ${payload.eventDateText} geöffnet.\nFür Anreisende aus der Ferne, bieten wir den Zugang bereits am Vortag an.`,
      rightColumnX,
      rightY,
      { width: rightColumnWidth, lineGap: 1.8 }
    );
    rightY += 65;

    doc.font('Helvetica-Bold').fontSize(12).text('Adresse:', rightColumnX, rightY, { width: rightColumnWidth });
    rightY += 22;
    const rightAddressLines = [venueAddress, venueGps].filter((line) => line.length > 0).join('\n');
    doc.font('Helvetica').fontSize(11.5).text(rightAddressLines || '-', rightColumnX, rightY, {
      width: rightColumnWidth,
      lineGap: 1.8
    });
    rightY += rightAddressLines ? 62 : 22;

    doc.font('Helvetica-Bold').fontSize(12).text('Termine:', rightColumnX, rightY, { width: rightColumnWidth });
    rightY += 22;
    const termLines = [termsLine1, termsLine2, ...scheduleLines].filter((line) => line.length > 0).join('\n');
    doc.font('Helvetica').fontSize(11.5).text(termLines, rightColumnX, rightY, {
      width: rightColumnWidth,
      lineGap: 1.8
    });

    const contentBottomY = Math.max(leftY + 58, rightY + 108);
    doc
      .font('Helvetica')
      .fontSize(11.5)
      .fillColor('#111111')
      .text(
        `${payload.legalHint}\n\nDie Eintrittsbändchen erhaltet Ihr vor Ort bei der Anmeldung.\n\nMotorsportliche Grüße die Fahrtleitung`,
        leftX,
        contentBottomY,
        { width: contentWidth, lineGap: 1.8 }
      );

    const footerY = doc.page.height - 42;
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280').text(payload.organizer, leftX, footerY, {
      width: contentWidth - 42
    });
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280').text('1 / 1', doc.page.width - 72, footerY, {
      width: 26,
      align: 'right'
    });

    doc.end();
  });
