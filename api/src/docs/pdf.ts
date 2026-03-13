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

    if (payload.logoImage && payload.logoImage.length > 0) {
      try {
        doc.image(payload.logoImage, 46, 40, { fit: [44, 44], align: 'left', valign: 'top' });
      } catch {
        // Logo is optional. If image parsing fails, continue without visual logo.
      }
    }

    doc.fillColor('#0B1F4D').font('Helvetica-Bold').fontSize(20).text('Nennbestätigung', payload.logoImage ? 98 : 46, 46);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#4B5563')
      .text(payload.organizer, payload.logoImage ? 98 : 46, 72)
      .text(payload.eventDateText, payload.logoImage ? 98 : 46, 86);

    doc.y = payload.logoImage ? 112 : 104;
    doc
      .save()
      .lineWidth(1)
      .strokeColor('#D1D5DB')
      .moveTo(46, doc.y)
      .lineTo(doc.page.width - 46, doc.y)
      .stroke()
      .restore();
    doc.moveDown(1.1);

    drawSectionTitle(doc, 'Event');
    drawKeyValue(doc, 'Event', normalizeText(payload.eventName));
    drawKeyValue(doc, 'Datum', normalizeText(payload.eventDateText));
    drawKeyValue(doc, 'Klasse', normalizeText(payload.className));
    drawKeyValue(doc, 'Startnummer', normalizeText(payload.startNumber));

    drawSectionTitle(doc, 'Fahrer');
    drawKeyValue(doc, 'Name', normalizeText(payload.driver.fullName));
    drawKeyValue(
      doc,
      'Adresse',
      [normalizeText(payload.driver.street, ''), normalizeText(payload.driver.zip, ''), normalizeText(payload.driver.city, '')]
        .filter((item) => item.length > 0)
        .join(' ')
        .trim() || '-'
    );
    drawKeyValue(doc, 'E-Mail', normalizeText(payload.driver.email));
    drawKeyValue(doc, 'Telefon', normalizeText(payload.driver.phone));

    if (payload.codriver) {
      drawSectionTitle(doc, 'Beifahrer (optional)');
      drawKeyValue(doc, 'Name', normalizeText(payload.codriver.fullName));
      drawKeyValue(doc, 'Geburtsdatum', normalizeText(payload.codriver.birthdate));
    }

    renderVehicleBlock(doc, 'Fahrzeug', payload.vehicle);
    if (payload.backupVehicle) {
      renderVehicleBlock(doc, 'Ersatzfahrzeug', payload.backupVehicle);
    }

    drawSectionTitle(doc, 'Zahlung');
    drawKeyValue(doc, 'Nenngeld gesamt', normalizeText(payload.payment.totalFee));
    drawKeyValue(doc, 'Bereits bezahlt', normalizeText(payload.payment.paidAmount));
    drawKeyValue(doc, 'Offen', normalizeText(payload.payment.openAmount));
    drawKeyValue(doc, 'Zahlungsfrist', normalizeText(payload.payment.paymentDeadline));
    drawKeyValue(doc, 'Empfänger', normalizeText(payload.payment.paymentRecipient));
    drawKeyValue(doc, 'IBAN', normalizeText(payload.payment.paymentIban));
    drawKeyValue(doc, 'BIC', normalizeText(payload.payment.paymentBic));

    drawSectionTitle(doc, 'Hinweis');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#111827')
      .text(payload.legalHint, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'left',
        lineGap: 2
      });

    const footerY = doc.page.height - doc.page.margins.bottom - 28;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6B7280')
      .text('Dokument automatisch generiert. Bitte im Fahrerlager bereithalten.', 46, footerY, {
        width: doc.page.width - 92,
        align: 'left'
      });

    doc.end();
  });
