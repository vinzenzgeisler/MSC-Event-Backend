// Use the Node build because signed waiver PDFs embed the captured PNG signature.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');
import { format } from 'node:util';
import type { QrCodeMatrix } from './girocode';
import { renderAutoChecklistV1 } from './templates/tech-check/auto/v1';
import { renderMotoChecklistV1 } from './templates/tech-check/moto/v1';

type PersonInfo = {
  fullName: string;
  birthdate?: string | null;
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

type EntryConfirmationKeyValue = {
  label: string;
  value: string;
};

export type EntryConfirmationPdfPayload = {
  fonts?: {
    regular?: Buffer | null;
    bold?: Buffer | null;
  };
  organizer: {
    name: string;
    addressLine?: string | null;
    websiteUrl?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    logoImage?: Buffer | null;
  };
  event: {
    title: string;
    name: string;
    dateText: string;
    issueDateText: string;
    gateHeadline?: string | null;
    locale?: string | null;
  };
  recipient: {
    lines: string[];
  };
  intro: {
    greeting: string;
    paragraphs: string[];
  };
  sections?: {
    entryDetails: string;
    additionalEntries: string;
    pendingEntries: string;
    payment: string;
    eventInfo: string;
    schedule: string;
    importantNotes: string;
    closing: string;
  };
  focusedEntrySummary?: string | null;
  additionalEntries?: string[] | null;
  pendingEntries?: string[] | null;
  translation?: {
    primaryLocale: string;
    secondaryLocale?: string | null;
    authorityHint?: string | null;
  } | null;
  translatedPage?: {
    title: string;
    issueDateLabel?: string | null;
    greeting: string;
    paragraphs: string[];
    sectionTitles: {
      entryDetails: string;
      additionalEntries: string;
      pendingEntries: string;
      payment: string;
      eventInfo: string;
      schedule: string;
      importantNotes: string;
      closing: string;
    };
    focusedEntrySummary?: string | null;
    additionalEntries?: string[] | null;
    pendingEntries?: string[] | null;
    paymentIntro?: string | null;
    paymentDetails?: EntryConfirmationKeyValue[] | null;
    eventInfo?: EntryConfirmationKeyValue[] | null;
    schedule?: string[] | null;
    importantNotes?: string[] | null;
    closingHint?: string | null;
    authorityHint?: string | null;
    footerSectionTitles?: {
      organizer: string;
      contact: string;
      online: string;
    } | null;
  } | null;
  entryData: EntryConfirmationKeyValue[];
  payment?: {
    intro: string;
    details: EntryConfirmationKeyValue[];
    qrCode?: QrCodeMatrix | null;
    qrCaption?: string | null;
  } | null;
  eventInfo?: EntryConfirmationKeyValue[] | null;
  schedule?: string[] | null;
  importantNotes?: string[] | null;
  footer: {
    legalHint?: string | null;
    lines: string[];
  };
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
  lines.push('Haftverzichtserklärung');
  lines.push(
    'Hiermit bestätige ich, dass ich die Teilnahmebedingungen gelesen habe und auf eigene Gefahr teilnehme.'
  );
  lines.push('Unterschrift: ________________________________');

  return renderPdf('Haftverzicht', lines);
};

type SignedWaiverEvidencePdfPayload = {
  sessionId: string;
  payload: {
    event: { name: string; startsAt: string; endsAt: string; location: string };
    driver: { firstName: string; lastName: string; birthdate: string | null };
    signer?: { role: 'driver' | 'codriver'; firstName: string; lastName: string; birthdate: string | null; label: string };
    isMinor: boolean;
    requiresMedicalCertificate: boolean;
    contract: { locale: string; version: string; textHash: string; title: string; fullText: string };
    entries: Array<{
      className: string;
      orgaCode: string | null;
      startNumber: string | null;
      codriver: { firstName: string; lastName: string } | null;
      vehicles: Array<{ role: 'primary' | 'backup'; make: string; model: string; year: number | null; startNumber: string | null; ownerName: string | null }>;
    }>;
  };
  signer: { type: 'driver' | 'codriver' | 'guardian'; guardianName: string | null; guardianRelationship: string | null };
  precheckTimestamps: {
    identityCheckedAt?: string | null;
    signerPresentAt?: string | null;
    medicalCertificateCheckedAt?: string | null;
    guardianPresentAt?: string | null;
    guardianAuthorityCheckedAt?: string | null;
  };
  operatorDisplay: string | null;
  displayedAt: string;
  waiverAcceptedAt: string;
  signedAt: string;
  signatureDataUrl: string;
};

const dataUrlToBuffer = (dataUrl: string): Buffer | null => {
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  return match ? Buffer.from(match[1], 'base64') : null;
};

export const renderSignedWaiverEvidencePdf = async (payload: SignedWaiverEvidencePdfPayload): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 40, right: 40 },
      info: {
        Title: 'Persönliche Haftverzichtserklärung',
        Author: 'MSC Oberlausitzer Dreiländereck e.V.',
        Subject: payload.payload.event.name
      }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── design constants ──────────────────────────────────────────────────
    const LEFT = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const TOP = doc.page.margins.top;
    const BLUE = '#163A70';
    const YELLOW = '#E6B800';
    const LABEL = '#334155';
    const BODY = '#0F172A';
    const DIM = '#475569';
    const RULE = '#D8DEE9';
    const LW = Math.floor(W * 0.37);

    // ── helpers ───────────────────────────────────────────────────────────
    const rule = (color = RULE) => {
      doc.save()
        .lineWidth(0.8).strokeColor(color)
        .moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y)
        .stroke().restore();
    };

    const sectionHeader = (title: string) => {
      doc.y += 4;
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(BLUE)
        .text(title.toUpperCase(), LEFT, doc.y, { width: W, characterSpacing: 0.7 });
      const lineY = doc.y + 1;
      doc.save().lineWidth(1).strokeColor(YELLOW)
        .moveTo(LEFT, lineY).lineTo(LEFT + W, lineY).stroke().restore();
      doc.y = lineY + 7;
    };

    const kv = (label: string, value: string) => {
      const startY = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.3).fillColor(LABEL)
        .text(label, LEFT, startY, { width: LW });
      const afterLabel = doc.y;
      doc.font('Helvetica').fontSize(8.8).fillColor(BODY)
        .text(value || '—', LEFT + LW, startY, { width: W - LW, lineGap: 0.5 });
      doc.y = Math.max(doc.y, afterLabel) + 2;
    };

    const checkRow = (label: string, ts: string | null | undefined, required: boolean) => {
      const mark = ts ? '✓' : (required ? '—' : 'n/a');
      const markColor = ts ? '#16A34A' : (required ? '#DC2626' : DIM);
      const startY = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(LABEL)
        .text(label, LEFT + 8, startY, { width: LW - 8 });
      const afterText = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(markColor)
        .text(mark, LEFT + LW, startY, { width: 16 });
      if (ts) {
        doc.font('Helvetica').fontSize(7.8).fillColor(DIM)
          .text(ts, LEFT + LW + 20, startY, { width: W - LW - 20, lineGap: 0.3 });
      }
      doc.y = Math.max(doc.y, afterText) + 2;
    };

    const signature = dataUrlToBuffer(payload.signatureDataUrl);

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1 — evidence summary
    // ════════════════════════════════════════════════════════════════════════
    doc.y = TOP;

    // title bar
    doc.font('Helvetica-Bold').fontSize(13).fillColor(BLUE)
      .text('Persönliche Haftverzichtserklärung', LEFT, doc.y, { width: W });
    doc.font('Helvetica').fontSize(8.5).fillColor(DIM)
      .text('Vor-Ort-Unterzeichnung · MSC Oberlausitzer Dreiländereck e.V.', LEFT, doc.y, { width: W });
    doc.y += 4;
    doc.save().lineWidth(1.5).strokeColor(BLUE)
      .moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 8;

    // VERANSTALTUNG
    sectionHeader('Veranstaltung');
    kv('Veranstaltung', payload.payload.event.name);
    kv('Datum', `${payload.payload.event.startsAt} – ${payload.payload.event.endsAt}`);
    kv('Ort', payload.payload.event.location || '—');

    // TEILNEHMER
    sectionHeader('Teilnehmer');
    const driver = payload.payload.driver;
    kv('Fahrer', `${driver.firstName} ${driver.lastName}${driver.birthdate ? `, geb. ${driver.birthdate}` : ''}`);
    const signer = payload.payload.signer;
    if (signer) {
      kv('Unterzeichner', `${signer.firstName} ${signer.lastName}${signer.birthdate ? `, geb. ${signer.birthdate}` : ''}`);
      kv('Rolle', signer.label);
    }
    if (payload.signer.type === 'guardian' && payload.signer.guardianName) {
      kv('Erziehungsberechtigte/r', `${payload.signer.guardianName} (${payload.signer.guardianRelationship ?? '—'})`);
    }
    const flags: string[] = [];
    if (payload.payload.isMinor) flags.push('Minderjährig');
    if (payload.payload.requiresMedicalCertificate) flags.push('Attest ab 70 J. erforderlich');
    if (flags.length > 0) kv('Hinweise', flags.join(' · '));

    // FAHRZEUGE
    sectionHeader('Fahrzeuge & Nennungen');
    payload.payload.entries.forEach((entry, idx) => {
      const entryVal = [
        entry.className,
        entry.startNumber ? `#${entry.startNumber}` : null,
        entry.orgaCode ? `Orga: ${entry.orgaCode}` : null
      ].filter(Boolean).join(' · ');
      kv(`Nennung ${idx + 1}`, entryVal);
      if (entry.codriver) {
        kv('  Beifahrer', `${entry.codriver.firstName} ${entry.codriver.lastName}`);
      }
      entry.vehicles.forEach((v) => {
        const vLabel = v.role === 'backup' ? '  Ersatzfahrzeug' : '  Fahrzeug';
        const vVal = [v.make, v.model, v.year ? String(v.year) : null, v.startNumber ? `#${v.startNumber}` : null]
          .filter(Boolean).join(' ');
        kv(vLabel, vVal);
      });
    });

    // VORPRÜFUNGEN
    sectionHeader('Vorprüfungen (Operator)');
    checkRow('Identität / Ausweis geprüft', payload.precheckTimestamps.identityCheckedAt, true);
    checkRow('Person persönlich anwesend', payload.precheckTimestamps.signerPresentAt, true);
    checkRow('Ärztliches Attest geprüft', payload.precheckTimestamps.medicalCertificateCheckedAt, payload.payload.requiresMedicalCertificate);
    checkRow('Erziehungsberechtigte/r anwesend', payload.precheckTimestamps.guardianPresentAt, payload.payload.isMinor);
    checkRow('Berechtigung Erziehungsberechtigte/r', payload.precheckTimestamps.guardianAuthorityCheckedAt, payload.payload.isMinor);

    // UNTERZEICHNUNG
    sectionHeader('Unterzeichnung');
    kv('Haftverzicht angezeigt', payload.displayedAt);
    kv('Gelesen und bestätigt', payload.waiverAcceptedAt);
    kv('Unterschrift gesetzt', payload.signedAt);
    kv('Operator', payload.operatorDisplay ?? '—');
    kv('Session-ID', payload.sessionId);
    kv('Version / Sprache', `${payload.payload.contract.version} / ${payload.payload.contract.locale}`);
    doc.y += 8;

    // Signature image
    rule();
    doc.y += 5;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(LABEL)
      .text('Unterschrift:', LEFT, doc.y);
    doc.y += 4;
    if (signature) {
      doc.image(signature, LEFT, doc.y, { fit: [260, 72], align: 'left' });
      doc.y += 80;
    } else {
      doc.font('Helvetica').fontSize(8).fillColor('#DC2626')
        .text('Unterschriftsbild konnte nicht eingebettet werden.', LEFT, doc.y, { width: W });
      doc.y += 14;
    }
    rule();
    doc.y += 4;

    // footer page 1
    doc.font('Helvetica').fontSize(6.5).fillColor(DIM)
      .text(
        `Text-Hash: ${payload.payload.contract.textHash}  ·  Session: ${payload.sessionId}`,
        LEFT, doc.y, { width: W }
      );

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 2 — full waiver text
    // ════════════════════════════════════════════════════════════════════════
    doc.addPage();
    doc.y = TOP;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE)
      .text(payload.payload.contract.title, LEFT, doc.y, { width: W });
    doc.y += 2;
    doc.save().lineWidth(1).strokeColor(YELLOW)
      .moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 10;

    doc.font('Helvetica').fontSize(9.4).fillColor(BODY)
      .text(payload.payload.contract.fullText, LEFT, doc.y, { width: W, lineGap: 1.5 });
    doc.y += 14;

    rule(RULE);
    doc.y += 4;
    const signerDisplay = signer
      ? `${signer.firstName} ${signer.lastName}`
      : `${driver.firstName} ${driver.lastName}`;
    doc.font('Helvetica').fontSize(7).fillColor(DIM)
      .text(
        `Diese Erklärung wurde am ${payload.signedAt} durch ${signerDisplay} digital unterzeichnet.  ` +
        `Text-Hash: ${payload.payload.contract.textHash}  ·  Version: ${payload.payload.contract.version}  ·  Audit-JSON: privat in S3 gespeichert.`,
        LEFT, doc.y, { width: W, lineGap: 0.5 }
      );

    doc.end();
  });

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

const drawRule = (doc: typeof PDFDocument.prototype, color = '#D8DEE9') => {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  doc.save().lineWidth(1).strokeColor(color).moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + width, y).stroke().restore();
  doc.moveDown(0.5);
};

type TextMetricsOptions = {
  font: 'regular' | 'bold';
  fontSize: number;
  width: number;
  lineGap?: number;
};

const REGULAR_FONT_NAME = 'EntryConfirmationRegular';
const BOLD_FONT_NAME = 'EntryConfirmationBold';

const resolveFontName = (
  doc: typeof PDFDocument.prototype,
  payload: EntryConfirmationPdfPayload,
  weight: 'regular' | 'bold'
): string => {
  if (weight === 'bold' && payload.fonts?.bold) {
    return BOLD_FONT_NAME;
  }
  if (weight === 'regular' && payload.fonts?.regular) {
    return REGULAR_FONT_NAME;
  }
  return weight === 'bold' ? 'Helvetica-Bold' : 'Helvetica';
};

const registerEntryConfirmationFonts = (doc: typeof PDFDocument.prototype, payload: EntryConfirmationPdfPayload) => {
  if (payload.fonts?.regular) {
    doc.registerFont(REGULAR_FONT_NAME, payload.fonts.regular);
  }
  if (payload.fonts?.bold) {
    doc.registerFont(BOLD_FONT_NAME, payload.fonts.bold);
  }
};

const measureText = (doc: typeof PDFDocument.prototype, text: string, options: TextMetricsOptions): number => {
  const fontName = options.font === 'bold' ? BOLD_FONT_NAME : REGULAR_FONT_NAME;
  const fallbackFontName = options.font === 'bold' ? 'Helvetica-Bold' : 'Helvetica';
  doc.font(doc._registeredFonts?.[fontName] ? fontName : fallbackFontName).fontSize(options.fontSize);
  return doc.heightOfString(text, {
    width: options.width,
    lineGap: options.lineGap ?? 1
  });
};

const measureKeyValueRows = (
  doc: typeof PDFDocument.prototype,
  rows: EntryConfirmationKeyValue[],
  width: number,
  options?: { valueWidth?: number; fontSize?: number; lineGap?: number }
): number => {
  const labelWidth = Math.min(94, Math.max(72, Math.round(width * 0.34)));
  const valueWidth = options?.valueWidth ?? width - labelWidth;
  const fontSize = options?.fontSize ?? 9.2;
  const lineGap = options?.lineGap ?? 1;
  let total = 0;
  rows.forEach((row) => {
    const labelHeight = measureText(doc, row.label, { font: 'bold', fontSize: 8.7, width: labelWidth, lineGap });
    const valueHeight = measureText(doc, row.value, { font: 'regular', fontSize, width: valueWidth, lineGap });
    total += Math.max(labelHeight, valueHeight) + 3;
  });
  return total;
};

const drawSectionHeaderAt = (
  doc: typeof PDFDocument.prototype,
  payload: EntryConfirmationPdfPayload,
  x: number,
  y: number,
  width: number,
  title: string
): number => {
  doc.font(resolveFontName(doc, payload, 'bold')).fontSize(8.3).fillColor('#163A70').text(title.toUpperCase(), x, y, {
    width,
    align: 'left',
    characterSpacing: 0.6
  });
  const textHeight = doc.heightOfString(title.toUpperCase(), { width, characterSpacing: 0.6 });
  const lineY = y + textHeight + 2;
  doc.save().lineWidth(0.7).strokeColor('#E6B800').moveTo(x, lineY).lineTo(x + width, lineY).stroke().restore();
  doc.fillColor('#0F172A');
  return lineY + 8;
};

const drawParagraphsAt = (
  payload: EntryConfirmationPdfPayload,
  doc: typeof PDFDocument.prototype,
  x: number,
  y: number,
  width: number,
  paragraphs: string[],
  options?: { fontSize?: number; lineGap?: number; paragraphGap?: number }
): number => {
  let cursorY = y;
  const fontSize = options?.fontSize ?? 9.2;
  const lineGap = options?.lineGap ?? 1;
  const paragraphGap = options?.paragraphGap ?? 3;
  paragraphs.forEach((paragraph) => {
    doc.font(resolveFontName(doc, payload, 'regular')).fontSize(fontSize).fillColor('#0F172A').text(paragraph, x, cursorY, {
      width,
      lineGap
    });
    cursorY += measureText(doc, paragraph, { font: 'regular', fontSize, width, lineGap }) + paragraphGap;
  });
  return cursorY;
};

const drawKeyValueRowsAt = (
  payload: EntryConfirmationPdfPayload,
  doc: typeof PDFDocument.prototype,
  x: number,
  y: number,
  width: number,
  rows: EntryConfirmationKeyValue[],
  options?: { valueWidth?: number; fontSize?: number; lineGap?: number }
): number => {
  const labelWidth = Math.min(94, Math.max(72, Math.round(width * 0.34)));
  const valueWidth = options?.valueWidth ?? width - labelWidth;
  const fontSize = options?.fontSize ?? 9.2;
  const lineGap = options?.lineGap ?? 1;
  let cursorY = y;
  rows.forEach((row) => {
    const labelHeight = measureText(doc, row.label, { font: 'bold', fontSize: 8.7, width: labelWidth, lineGap });
    const valueHeight = measureText(doc, row.value, { font: 'regular', fontSize, width: valueWidth, lineGap });
    const rowHeight = Math.max(labelHeight, valueHeight);
    doc.font(resolveFontName(doc, payload, 'bold')).fontSize(8.7).fillColor('#334155').text(row.label, x, cursorY, {
      width: labelWidth
    });
    doc.font(resolveFontName(doc, payload, 'regular')).fontSize(fontSize).fillColor('#0F172A').text(row.value, x + labelWidth, cursorY, {
      width: valueWidth,
      lineGap
    });
    cursorY += rowHeight + 4;
  });
  return cursorY;
};

const measureBulletList = (doc: typeof PDFDocument.prototype, items: string[], width: number): number => {
  let total = 0;
  const textWidth = width - 10;
  items.forEach((item) => {
    total += measureText(doc, item, { font: 'regular', fontSize: 9.1, width: textWidth, lineGap: 1 }) + 2;
  });
  return total;
};

const drawBulletListAt = (
  payload: EntryConfirmationPdfPayload,
  doc: typeof PDFDocument.prototype,
  x: number,
  y: number,
  width: number,
  items: string[]
): number => {
  let cursorY = y;
  const textWidth = width - 10;
  items.forEach((item) => {
    const itemHeight = measureText(doc, item, { font: 'regular', fontSize: 9.1, width: textWidth, lineGap: 1 });
    doc.font(resolveFontName(doc, payload, 'bold')).fontSize(9.4).fillColor('#163A70').text('•', x, cursorY);
    doc.font(resolveFontName(doc, payload, 'regular')).fontSize(9.1).fillColor('#0F172A').text(item, x + 10, cursorY, {
      width: textWidth,
      lineGap: 1
    });
    cursorY += itemHeight + 3;
  });
  return cursorY;
};

const measureQrCodeHeight = (qrCode: QrCodeMatrix | null | undefined, caption: string | null | undefined): number => {
  if (!qrCode) {
    return 0;
  }
  return 72 + (caption ? 12 : 0);
};

const drawQrCodeAt = (
  payload: EntryConfirmationPdfPayload,
  doc: typeof PDFDocument.prototype,
  x: number,
  y: number,
  qrCode: QrCodeMatrix,
  caption?: string | null
): number => {
  const size = 72;
  const padding = 4;
  const cell = size / qrCode.size;

  doc.save().roundedRect(x - padding, y - padding, size + padding * 2, size + padding * 2, 6).lineWidth(0.8).strokeColor('#CBD5E1').stroke().restore();
  doc.save().fillColor('#000000');
  for (let row = 0; row < qrCode.size; row += 1) {
    for (let column = 0; column < qrCode.size; column += 1) {
      if (!qrCode.modules[row * qrCode.size + column]) {
        continue;
      }
      doc.rect(x + column * cell, y + row * cell, cell + 0.08, cell + 0.08).fill();
    }
  }
  doc.restore();

  let bottomY = y + size;
  if (caption) {
    doc.font(resolveFontName(doc, payload, 'regular')).fontSize(7.5).fillColor('#475569').text(caption, x - 2, bottomY + 3, {
      width: size + 4,
      align: 'center'
    });
    bottomY += 12;
  }
  return bottomY;
};

const drawSectionBlock = (
  payload: EntryConfirmationPdfPayload,
  doc: typeof PDFDocument.prototype,
  x: number,
  y: number,
  width: number,
  title: string,
  body: (bodyY: number) => number
): number => {
  const bodyY = drawSectionHeaderAt(doc, payload, x, y, width, title);
  return body(bodyY);
};

const drawTranslatedSummaryPage = (
  doc: typeof PDFDocument.prototype,
  payload: EntryConfirmationPdfPayload,
  contentX: number,
  contentWidth: number,
  addPageBefore = true
) => {
  const translated = payload.translatedPage;
  if (!translated) {
    return;
  }

  if (addPageBefore) {
    doc.addPage();
  }
  let y = 40;
  doc.font(resolveFontName(doc, payload, 'bold')).fontSize(18).fillColor('#0F172A').text(translated.title, contentX, y, { width: contentWidth });
  y += 22;
  doc.font(resolveFontName(doc, payload, 'bold')).fontSize(11).fillColor('#163A70').text(`${payload.event.name} · ${payload.event.dateText}`, contentX, y, { width: contentWidth });
  y += 16;
  doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text(
    `${translated.issueDateLabel ?? 'Issued on'} ${payload.event.issueDateText}`,
    contentX,
    y,
    { width: contentWidth }
  );
  y += 18;
  doc.save().lineWidth(0.8).strokeColor('#D8DEE9').moveTo(contentX, y).lineTo(contentX + contentWidth, y).stroke().restore();
  y += 12;

  doc.font(resolveFontName(doc, payload, 'bold')).fontSize(9.8).fillColor('#0F172A').text(translated.greeting, contentX, y, { width: contentWidth });
  y += 15;
  y = drawParagraphsAt(payload, doc, contentX, y, contentWidth, translated.paragraphs, {
    fontSize: 9,
    lineGap: 1,
    paragraphGap: 3
  });
  y += 6;

  y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.entryDetails, (bodyY) => {
    let nextY = bodyY;
    if (translated.focusedEntrySummary) {
      nextY = drawParagraphsAt(payload, doc, contentX, nextY, contentWidth, [translated.focusedEntrySummary], {
        fontSize: 9,
        lineGap: 1,
        paragraphGap: 0
      });
    }
    return nextY;
  });

  if (translated.additionalEntries && translated.additionalEntries.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.additionalEntries, (bodyY) =>
      drawBulletListAt(payload, doc, contentX, bodyY, contentWidth, translated.additionalEntries ?? [])
    );
  }

  if (translated.pendingEntries && translated.pendingEntries.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.pendingEntries, (bodyY) =>
      drawBulletListAt(payload, doc, contentX, bodyY, contentWidth, translated.pendingEntries ?? [])
    );
  }

  if (translated.paymentDetails && translated.paymentDetails.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.payment, (bodyY) => {
      let nextY = bodyY;
      if (translated.paymentIntro) {
        nextY = drawParagraphsAt(payload, doc, contentX, nextY, contentWidth, [translated.paymentIntro], {
          fontSize: 8.9,
          lineGap: 1,
          paragraphGap: 3
        });
      }
      return drawKeyValueRowsAt(payload, doc, contentX, nextY, contentWidth, translated.paymentDetails ?? [], {
        fontSize: 8.9,
        lineGap: 1
      });
    });
  }

  if (translated.eventInfo && translated.eventInfo.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.eventInfo, (bodyY) =>
      drawKeyValueRowsAt(payload, doc, contentX, bodyY, contentWidth, translated.eventInfo ?? [], { fontSize: 8.9, lineGap: 1 })
    );
  }

  if (translated.schedule && translated.schedule.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.schedule, (bodyY) =>
      drawBulletListAt(payload, doc, contentX, bodyY, contentWidth, translated.schedule ?? [])
    );
  }

  if (translated.importantNotes && translated.importantNotes.length > 0) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.importantNotes, (bodyY) =>
      drawBulletListAt(payload, doc, contentX, bodyY, contentWidth, translated.importantNotes ?? [])
    );
  }

  if (translated.closingHint) {
    y += 8;
    y = drawSectionBlock(payload, doc, contentX, y, contentWidth, translated.sectionTitles.closing, (bodyY) =>
      drawParagraphsAt(payload, doc, contentX, bodyY, contentWidth, [translated.closingHint ?? ''], {
        fontSize: 8.8,
        lineGap: 1,
        paragraphGap: 0
      })
    );
  }

  if (translated.authorityHint) {
    y += 8;
    doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text(translated.authorityHint, contentX, y, { width: contentWidth });
  }
};

export const renderEntryConfirmationPdf = async (payload: EntryConfirmationPdfPayload): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 34,
      compress: false,
      info: {
        Title: 'Nennbestätigung',
        Author: payload.organizer.name,
        Subject: payload.event.name,
        Keywords: 'Nennbestätigung, Motorsport',
        CreationDate: new Date('2026-01-01T00:00:00.000Z'),
        ModDate: new Date('2026-01-01T00:00:00.000Z')
      }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    registerEntryConfirmationFonts(doc, payload);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const contentX = doc.page.margins.left;
    const rightLogoX = doc.page.width - doc.page.margins.right - 74;
    const footerHeight = 74;
    const footerTopY = doc.page.height - doc.page.margins.bottom - footerHeight;
    const sectionTitles = payload.sections ?? {
      entryDetails: 'Nennungsdaten',
      additionalEntries: 'Weitere zugelassene Nennungen',
      pendingEntries: 'Weitere gemeldete Nennungen',
      payment: 'Zahlung',
      eventInfo: 'Veranstaltungsinfos',
      schedule: 'Termine',
      importantNotes: 'Wichtige Hinweise',
      closing: 'Abschluss'
    };

    const drawPrimaryGermanPage = () => {
      if (payload.organizer.logoImage && payload.organizer.logoImage.length > 0) {
        try {
          doc.image(payload.organizer.logoImage, rightLogoX, 28, { fit: [74, 74], align: 'right', valign: 'top' });
        } catch {
          // Logo is optional.
        }
      }

      let currentY = 36;
      if (payload.event.gateHeadline) {
        doc.font(resolveFontName(doc, payload, 'bold')).fontSize(11.5).fillColor('#8B1E3F').text(payload.event.gateHeadline, contentX, currentY, {
          width: contentWidth - 92
        });
        currentY += measureText(doc, payload.event.gateHeadline, {
          font: 'bold',
          fontSize: 11.5,
          width: contentWidth - 92,
          lineGap: 1
        }) + 4;
      }

      const organizerLine = [payload.organizer.name, payload.organizer.addressLine].filter(Boolean).join(' · ');
      doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#475569').text(organizerLine, contentX, currentY, {
        width: contentWidth - 92
      });
      currentY += measureText(doc, organizerLine, {
        font: 'regular',
        fontSize: 8.2,
        width: contentWidth - 92,
        lineGap: 1
      }) + 15;

      payload.recipient.lines.forEach((line) => {
        doc.font(resolveFontName(doc, payload, 'regular')).fontSize(9.6).fillColor('#0F172A').text(line, contentX, currentY, { width: 220 });
        currentY += measureText(doc, line, { font: 'regular', fontSize: 9.6, width: 220, lineGap: 1 }) + 1.5;
      });
      currentY += 24;

      doc.font(resolveFontName(doc, payload, 'bold')).fontSize(18).fillColor('#0F172A').text(payload.event.title, contentX, currentY, { width: contentWidth });
      currentY += 22;
      doc.font(resolveFontName(doc, payload, 'bold')).fontSize(11).fillColor('#163A70').text(`${payload.event.name} · ${payload.event.dateText}`, contentX, currentY, {
        width: contentWidth
      });
      currentY += 16;
      doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text(`Ausgestellt am ${payload.event.issueDateText}`, contentX, currentY, {
        width: contentWidth
      });
      currentY += 16;
      doc.save().lineWidth(0.8).strokeColor('#D8DEE9').moveTo(contentX, currentY).lineTo(contentX + contentWidth, currentY).stroke().restore();
      currentY += 11;

      doc.font(resolveFontName(doc, payload, 'bold')).fontSize(9.8).fillColor('#0F172A').text(payload.intro.greeting, contentX, currentY, {
        width: contentWidth
      });
      currentY += 15;
      currentY = drawParagraphsAt(payload, doc, contentX, currentY, contentWidth, payload.intro.paragraphs, {
        fontSize: 9,
        lineGap: 1,
        paragraphGap: 3
      });
      currentY += 5;

      const colGap = 18;
      const colWidth = (contentWidth - colGap) / 2;
      const leftX = contentX;
      const rightX = contentX + colWidth + colGap;
      let leftY = currentY;
      let rightY = currentY;

      leftY = drawSectionBlock(payload, doc, leftX, leftY, colWidth, sectionTitles.entryDetails, (bodyY) =>
        drawKeyValueRowsAt(payload, doc, leftX, bodyY, colWidth, payload.entryData, { fontSize: 9, lineGap: 1 })
      );

      if (payload.additionalEntries && payload.additionalEntries.length > 0) {
        leftY += 10;
        leftY = drawSectionBlock(payload, doc, leftX, leftY, colWidth, sectionTitles.additionalEntries, (bodyY) =>
          drawBulletListAt(payload, doc, leftX, bodyY, colWidth, payload.additionalEntries ?? [])
        );
      }

      if (payload.pendingEntries && payload.pendingEntries.length > 0) {
        leftY += 10;
        leftY = drawSectionBlock(payload, doc, leftX, leftY, colWidth, sectionTitles.pendingEntries, (bodyY) =>
          drawBulletListAt(payload, doc, leftX, bodyY, colWidth, payload.pendingEntries ?? [])
        );
      }

      if (payload.eventInfo && payload.eventInfo.length > 0) {
        leftY += 10;
        leftY = drawSectionBlock(payload, doc, leftX, leftY, colWidth, sectionTitles.eventInfo, (bodyY) =>
          drawKeyValueRowsAt(payload, doc, leftX, bodyY, colWidth, payload.eventInfo ?? [], { fontSize: 8.9, lineGap: 1 })
        );
      }

      if (payload.payment) {
        rightY = drawSectionBlock(payload, doc, rightX, rightY, colWidth, sectionTitles.payment, (bodyY) => {
          let paymentY = drawParagraphsAt(payload, doc, rightX, bodyY, colWidth, [payload.payment?.intro ?? ''], {
            fontSize: 8.9,
            lineGap: 1,
            paragraphGap: 3
          });
          const qrHeight = measureQrCodeHeight(payload.payment?.qrCode, payload.payment?.qrCaption);
          const detailsWidth = payload.payment?.qrCode ? colWidth - 84 : colWidth;
          paymentY = drawKeyValueRowsAt(payload, doc, rightX, paymentY, detailsWidth, payload.payment?.details ?? [], {
            fontSize: 8.9,
            lineGap: 1
          });
          if (payload.payment?.qrCode) {
            const qrX = rightX + colWidth - 72;
            const qrY = Math.max(bodyY + 2, paymentY - qrHeight);
            paymentY = Math.max(paymentY, drawQrCodeAt(payload, doc, qrX, qrY, payload.payment.qrCode, payload.payment.qrCaption));
          }
          return paymentY;
        });
      }

      if (payload.schedule && payload.schedule.length > 0) {
        rightY += 10;
        rightY = drawSectionBlock(payload, doc, rightX, rightY, colWidth, sectionTitles.schedule, (bodyY) =>
          drawBulletListAt(payload, doc, rightX, bodyY, colWidth, payload.schedule ?? [])
        );
      }

      let bottomY = Math.max(leftY, rightY) + 10;
      if (payload.importantNotes && payload.importantNotes.length > 0) {
        bottomY = drawSectionBlock(payload, doc, contentX, bottomY, contentWidth, sectionTitles.importantNotes, (bodyY) =>
          drawBulletListAt(payload, doc, contentX, bodyY, contentWidth, payload.importantNotes ?? [])
        );
      }

      if (payload.footer.legalHint) {
        bottomY += 10;
        bottomY = drawSectionBlock(payload, doc, contentX, bottomY, contentWidth, sectionTitles.closing, (bodyY) =>
          drawParagraphsAt(payload, doc, contentX, bodyY, contentWidth, [payload.footer.legalHint ?? ''], {
            fontSize: 8.8,
            lineGap: 1,
            paragraphGap: 0
          })
        );
      }

      if (bottomY > footerTopY - 10) {
        doc.addPage();
      }

      const footerY = doc.page.height - doc.page.margins.bottom - footerHeight;
      doc.save().lineWidth(0.8).strokeColor('#D8DEE9').moveTo(contentX, footerY).lineTo(contentX + contentWidth, footerY).stroke().restore();
      const footerColGap = 16;
      const footerColWidth = (contentWidth - footerColGap * 2) / 3;
      const footerBodyY = footerY + 8;
      const onlineLines = [payload.organizer.websiteUrl].filter((value): value is string => Boolean(value));
      const contactLines = [payload.organizer.contactEmail, payload.organizer.contactPhone, ...payload.footer.lines.filter((line) => line !== payload.organizer.name && line !== payload.organizer.contactEmail && line !== payload.organizer.websiteUrl)].filter(
        (value): value is string => Boolean(value)
      );

      let footerCursorY = drawSectionHeaderAt(doc, payload, contentX, footerBodyY, footerColWidth, 'Veranstalter');
      doc.font(resolveFontName(doc, payload, 'bold')).fontSize(8.4).fillColor('#334155').text(payload.organizer.name, contentX, footerCursorY, { width: footerColWidth });
      footerCursorY += measureText(doc, payload.organizer.name, { font: 'bold', fontSize: 8.8, width: footerColWidth, lineGap: 1 }) + 2;
      if (payload.organizer.addressLine) {
        doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text(payload.organizer.addressLine, contentX, footerCursorY, { width: footerColWidth, lineGap: 1 });
      }

      footerCursorY = drawSectionHeaderAt(doc, payload, contentX + footerColWidth + footerColGap, footerBodyY, footerColWidth, 'Kontakt');
      if (contactLines.length > 0) {
        drawParagraphsAt(payload, doc, contentX + footerColWidth + footerColGap, footerCursorY, footerColWidth, contactLines, {
          fontSize: 8.2,
          lineGap: 1,
          paragraphGap: 1
        });
      } else {
        doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text('Rückfragen beantwortet das Veranstaltungsteam.', contentX + footerColWidth + footerColGap, footerCursorY, { width: footerColWidth });
      }

      footerCursorY = drawSectionHeaderAt(doc, payload, contentX + (footerColWidth + footerColGap) * 2, footerBodyY, footerColWidth, 'Online');
      if (onlineLines.length > 0) {
        drawParagraphsAt(payload, doc, contentX + (footerColWidth + footerColGap) * 2, footerCursorY, footerColWidth, onlineLines, {
          fontSize: 8.2,
          lineGap: 1,
          paragraphGap: 1
        });
      } else {
        doc.font(resolveFontName(doc, payload, 'regular')).fontSize(8.2).fillColor('#64748B').text('Weitere Informationen folgen über die bekannten Vereinskanäle.', contentX + (footerColWidth + footerColGap) * 2, footerCursorY, { width: footerColWidth });
      }
    };

    if (payload.translatedPage && payload.event.locale && payload.event.locale !== 'de') {
      drawTranslatedSummaryPage(doc, payload, contentX, contentWidth, false);
      doc.addPage();
      drawPrimaryGermanPage();
    } else {
      drawPrimaryGermanPage();
      drawTranslatedSummaryPage(doc, payload, contentX, contentWidth, true);
    }
    doc.end();
  });
