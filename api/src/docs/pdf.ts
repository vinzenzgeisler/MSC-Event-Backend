// Use the Node build because signed waiver PDFs embed the captured PNG signature.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');
import { format } from 'node:util';
import type { QrCodeMatrix } from './girocode';
import { renderAutoChecklistV1 } from './templates/tech-check/auto/v1';
import { renderMotoChecklistV1 } from './templates/tech-check/moto/v1';
import { buildPaperWaiverContract } from '../legal/paperWaiverContract';
import type { WaiverLocale } from '../legal/waiverContract';

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

type WaiverBodySection = { title: string; paragraphs?: string[]; bullets?: string[] };
type WaiverBodyDocument = { intro?: string[]; sections: WaiverBodySection[] };

type WaiverBodyRenderContext = {
  LEFT: number;
  W: number;
  /** Y where the first column starts (below any full-width header already drawn on this page). */
  TOP: number;
  /**
   * Y where a genuinely NEW page (added because even the last column overflowed) should start,
   * before onNewPage draws its own small continuation header. Defaults to TOP. Pass the actual
   * page margin top explicitly whenever TOP is a large value (e.g. below a big one-page header
   * on page 1) — otherwise every overflow page wastes that same amount of space at its top too,
   * which can cascade into far more pages than the overflowing content actually needs.
   */
  pageTop?: number;
  bottomMargin: number;
  regularFont: string;
  boldFont: string;
  bodyColor: string;
  headingColor: string;
  /** Number of side-by-side columns the text flows through before adding a new page. Default 1. */
  columns?: number;
  columnGap?: number;
  fontSize?: number;
  headingFontSize?: number;
  lineGap?: number;
  paragraphGap?: number;
  bulletGap?: number;
  sectionGapBefore?: number;
  onNewPage?: () => void;
};

type WaiverBodyBlock = {
  kind: 'paragraph' | 'bullet' | 'heading';
  text: string;
  textHeight: number;
  gapBefore: number;
  gapAfter: number;
  height: number;
};

// Renders a structured waiver document (title/intro/sections, each with paragraphs and/or
// bullets) as properly separated headings, paragraphs and hanging-indent bullet lists —
// instead of one flattened block of text — flowing through one or more columns and adding a
// new page only once every column is full. Purely a rendering concern: the legal wording
// itself is untouched, and the hashed/versioned flat text used for audit/legal purposes is
// computed separately and never derived from this output.
//
// Columns are balanced by height (not just filled sequentially). All positioning uses an
// explicit cursor: PDFKit mutates doc.y after text(), so combining doc.y with measured block
// heights would otherwise count every line twice and force unreadably small type.
const drawWaiverContractBody = (doc: PDFKit.PDFDocument, contractDoc: WaiverBodyDocument, ctx: WaiverBodyRenderContext): void => {
  const columns = ctx.columns ?? 1;
  const columnGap = ctx.columnGap ?? 16;
  const columnWidth = columns > 1 ? (ctx.W - columnGap * (columns - 1)) / columns : ctx.W;
  const fontSize = ctx.fontSize ?? 9.4;
  const headingFontSize = ctx.headingFontSize ?? 10.3;
  const lineGap = ctx.lineGap ?? 2;
  const paragraphGap = ctx.paragraphGap ?? 8;
  const bulletGap = ctx.bulletGap ?? 5;
  const sectionGapBefore = ctx.sectionGapBefore ?? 12;
  const bulletIndent = Math.max(7, fontSize * 1.35);

  // ── pass 1: measure every block at this column width, so columns can be balanced ──────
  const blocks: WaiverBodyBlock[] = [];
  (contractDoc.intro ?? []).forEach((text) => {
    doc.font(ctx.regularFont).fontSize(fontSize);
    const textHeight = doc.heightOfString(text, { width: columnWidth, lineGap });
    blocks.push({ kind: 'paragraph', text, textHeight, gapBefore: 0, gapAfter: paragraphGap, height: textHeight + paragraphGap });
  });
  contractDoc.sections.forEach((section) => {
    if (section.title) {
      doc.font(ctx.boldFont).fontSize(headingFontSize);
      const textHeight = doc.heightOfString(section.title, { width: columnWidth });
      const gapAfter = Math.min(3, paragraphGap);
      blocks.push({ kind: 'heading', text: section.title, textHeight, gapBefore: sectionGapBefore, gapAfter, height: sectionGapBefore + textHeight + gapAfter });
    }
    (section.paragraphs ?? []).forEach((text) => {
      doc.font(ctx.regularFont).fontSize(fontSize);
      const textHeight = doc.heightOfString(text, { width: columnWidth, lineGap });
      blocks.push({ kind: 'paragraph', text, textHeight, gapBefore: 0, gapAfter: paragraphGap, height: textHeight + paragraphGap });
    });
    (section.bullets ?? []).forEach((text) => {
      doc.font(ctx.regularFont).fontSize(fontSize);
      const textHeight = doc.heightOfString(text, { width: columnWidth - bulletIndent, lineGap });
      blocks.push({ kind: 'bullet', text, textHeight, gapBefore: 0, gapAfter: bulletGap, height: textHeight + bulletGap });
    });
  });
  const totalHeight = blocks.reduce((sum, block) => sum + block.height, 0);
  // A small packing allowance absorbs keep-with-next decisions for headings. Without it,
  // mathematically equal columns can leave enough unused space in the first columns to push
  // the final paragraph onto an otherwise unnecessary extra page.
  const columnCapacity = doc.page.height - ctx.bottomMargin - ctx.TOP;
  const packingAllowance = Math.min(20, columnCapacity * 0.03);
  const targetPerColumn = columns > 1 ? Math.min(columnCapacity, totalHeight / columns + packingAllowance) : Infinity;

  // ── pass 2: draw, breaking to the next column once its share of the target is used up ──
  let currentColumn = 0;
  let columnAccum = 0;
  let cursorY = ctx.TOP;
  const columnX = () => ctx.LEFT + currentColumn * (columnWidth + columnGap);
  const pageBottom = () => doc.page.height - ctx.bottomMargin;

  const breakColumn = () => {
    if (currentColumn < columns - 1) {
      currentColumn += 1;
      cursorY = ctx.TOP;
      columnAccum = 0;
    } else {
      doc.addPage();
      currentColumn = 0;
      cursorY = ctx.pageTop ?? ctx.TOP;
      columnAccum = 0;
      doc.y = cursorY;
      ctx.onNewPage?.();
      cursorY = doc.y;
    }
  };

  blocks.forEach((block, index) => {
    // Keep a heading with at least the following paragraph/list item.
    const keepWithNext = block.kind === 'heading' ? (blocks[index + 1]?.height ?? 0) : 0;
    const prospectiveHeight = block.height + keepWithNext;
    const wantsBalanceBreak = currentColumn < columns - 1 && columnAccum > 0 && columnAccum + prospectiveHeight > targetPerColumn;
    const wantsHardBreak = cursorY + prospectiveHeight > pageBottom();
    if (wantsBalanceBreak || wantsHardBreak) breakColumn();

    const gapBefore = cursorY > ctx.TOP ? block.gapBefore : 0;
    const textY = cursorY + gapBefore;
    if (block.kind === 'heading') {
      doc.font(ctx.boldFont).fontSize(headingFontSize).fillColor(ctx.headingColor)
        .text(block.text, columnX(), textY, { width: columnWidth });
    } else if (block.kind === 'bullet') {
      const textWidth = columnWidth - bulletIndent;
      const x = columnX();
      doc.font(ctx.regularFont).fontSize(fontSize).fillColor(ctx.bodyColor)
        .text('•', x, textY, { width: bulletIndent, lineGap });
      doc.font(ctx.regularFont).fontSize(fontSize).fillColor(ctx.bodyColor)
        .text(block.text, x + bulletIndent, textY, { width: textWidth, lineGap });
    } else {
      doc.font(ctx.regularFont).fontSize(fontSize).fillColor(ctx.bodyColor)
        .text(block.text, columnX(), textY, { width: columnWidth, lineGap });
    }
    const renderedHeight = gapBefore + block.textHeight + block.gapAfter;
    cursorY += renderedHeight;
    columnAccum += renderedHeight;
    doc.y = cursorY;
  });
};

type SignedWaiverEvidencePdfPayload = {
  sessionId: string;
  payload: {
    event: { name: string; startsAt: string; endsAt: string; location: string };
    driver: { firstName: string; lastName: string; birthdate: string | null };
    signer?: { role: 'driver' | 'codriver'; firstName: string; lastName: string; birthdate: string | null; label: string };
    isMinor: boolean;
    requiresMedicalCertificate: boolean;
    contract: {
      locale: string;
      version: string;
      textHash: string;
      title: string;
      fullText: string;
      authoritativeLocale?: string;
      authoritativeTitle?: string;
      authoritativeFullText?: string;
      authoritativeTextHash?: string;
      authoritativeIntro?: string[];
      authoritativeSections?: WaiverBodySection[];
      translation?: { locale: string; title: string; fullText: string; textHash: string; intro?: string[]; sections?: WaiverBodySection[]; binding: false } | null;
    };
    entries: Array<{
      className: string;
      orgaCode: string | null;
      startNumber: string | null;
      codriver: { firstName: string; lastName: string } | null;
      vehicles: Array<{ role: 'primary' | 'backup'; make: string; model: string; year: number | null; startNumber: string | null; ownerName: string | null }>;
    }>;
  };
  signer: { type: 'driver' | 'codriver' | 'guardian'; guardianName: string | null; guardianEmail?: string | null; guardianRelationship: string | null; representationMode?: 'sole' | null };
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
  fonts?: { regular?: Buffer | null; bold?: Buffer | null };
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

    const regularFont = payload.fonts?.regular ? 'WaiverRegular' : 'Helvetica';
    const boldFont = payload.fonts?.bold ? 'WaiverBold' : 'Helvetica-Bold';
    if (payload.fonts?.regular) doc.registerFont(regularFont, payload.fonts.regular);
    if (payload.fonts?.bold) doc.registerFont(boldFont, payload.fonts.bold);

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
      doc.font(boldFont).fontSize(7.8).fillColor(BLUE)
        .text(title.toUpperCase(), LEFT, doc.y, { width: W, characterSpacing: 0.7 });
      const lineY = doc.y + 1;
      doc.save().lineWidth(1).strokeColor(YELLOW)
        .moveTo(LEFT, lineY).lineTo(LEFT + W, lineY).stroke().restore();
      doc.y = lineY + 7;
    };

    const kv = (label: string, value: string) => {
      const startY = doc.y;
      doc.font(boldFont).fontSize(8.3).fillColor(LABEL)
        .text(label, LEFT, startY, { width: LW });
      const afterLabel = doc.y;
      doc.font(regularFont).fontSize(8.8).fillColor(BODY)
        .text(value || '—', LEFT + LW, startY, { width: W - LW, lineGap: 0.5 });
      doc.y = Math.max(doc.y, afterLabel) + 2;
    };

    const checkRow = (label: string, ts: string | null | undefined, required: boolean) => {
      // ASCII marker stays reliable in every embedded font; some Arial builds render the
      // checkmark glyph as an empty square in the archived evidence PDF.
      const mark = ts ? 'OK' : (required ? '—' : 'n/a');
      const markColor = ts ? '#16A34A' : (required ? '#DC2626' : DIM);
      const startY = doc.y;
      doc.font(regularFont).fontSize(8.5).fillColor(LABEL)
        .text(label, LEFT + 8, startY, { width: LW - 8 });
      const afterText = doc.y;
      doc.font(boldFont).fontSize(8.5).fillColor(markColor)
        .text(mark, LEFT + LW, startY, { width: 16 });
      if (ts) {
        doc.font(regularFont).fontSize(7.8).fillColor(DIM)
          .text(ts, LEFT + LW + 20, startY, { width: W - LW - 20, lineGap: 0.3 });
      }
      doc.y = Math.max(doc.y, afterText) + 2;
    };

    const signature = dataUrlToBuffer(payload.signatureDataUrl);

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1 — evidence summary
    // ════════════════════════════════════════════════════════════════════════
    doc.y = TOP;

    // Header follows the restrained hierarchy of the Nennbestätigung.
    doc.font(boldFont).fontSize(16).fillColor(BODY)
      .text('Persönliche Haftverzichtserklärung', LEFT, doc.y, { width: W });
    doc.y += 2;
    doc.font(boldFont).fontSize(9.2).fillColor(BLUE)
      .text(`${payload.payload.event.name} · ${payload.payload.event.startsAt} – ${payload.payload.event.endsAt}`, LEFT, doc.y, { width: W });
    doc.y += 2;
    doc.font(regularFont).fontSize(7.6).fillColor(DIM)
      .text('Digitaler Unterzeichnungs- und Auditnachweis · MSC Oberlausitzer Dreiländereck e.V.', LEFT, doc.y, { width: W });
    doc.y += 6;
    doc.save().lineWidth(0.8).strokeColor(RULE)
      .moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 5;

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
      kv(payload.signer.type === 'guardian' ? 'Teilnehmer' : 'Unterzeichner', `${signer.firstName} ${signer.lastName}${signer.birthdate ? `, geb. ${signer.birthdate}` : ''}`);
      kv('Rolle', signer.label);
    }
    if (payload.signer.type === 'guardian' && payload.signer.guardianName) {
      kv('Unterzeichner (erziehungsberechtigt)', `${payload.signer.guardianName} (${payload.signer.guardianRelationship ?? '—'})`);
      kv('E-Mail der Vertretung', payload.signer.guardianEmail ?? '—');
      kv('Vertretungsberechtigung', payload.signer.representationMode === 'sole' ? 'Alleinvertretungsberechtigung bestätigt' : '—');
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
    doc.font(boldFont).fontSize(8.5).fillColor(LABEL)
      .text('Unterschrift:', LEFT, doc.y);
    doc.y += 4;
    if (signature) {
      doc.image(signature, LEFT, doc.y, { fit: [260, 72], align: 'left' });
      doc.y += 80;
    } else {
      doc.font(regularFont).fontSize(8).fillColor('#DC2626')
        .text('Unterschriftsbild konnte nicht eingebettet werden.', LEFT, doc.y, { width: W });
      doc.y += 14;
    }
    rule();
    doc.y += 4;

    // footer page 1
    doc.font(regularFont).fontSize(6.5).fillColor(DIM)
      .text(
        `Text-Hash: ${payload.payload.contract.textHash}  ·  Session: ${payload.sessionId}`,
        LEFT, doc.y, { width: W }
      );

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 2 — full waiver text
    // ════════════════════════════════════════════════════════════════════════
    doc.addPage();
    doc.y = TOP;

    const authoritativeTitle = payload.payload.contract.authoritativeTitle ?? payload.payload.contract.title;
    const authoritativeFullText = payload.payload.contract.authoritativeFullText ?? payload.payload.contract.fullText;
    const drawContinuationHeader = () => {
      doc.font(boldFont).fontSize(9).fillColor(DIM)
        .text(`${authoritativeTitle} · Fortsetzung`, LEFT, doc.y, { width: W });
      doc.y += 14;
    };
    doc.font(boldFont).fontSize(16).fillColor(BODY)
      .text(authoritativeTitle, LEFT, doc.y, { width: W });
    doc.y += 5;
    doc.save().lineWidth(0.8).strokeColor(RULE)
      .moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 9;
    const legalTextTop = doc.y;

    if (payload.payload.contract.authoritativeSections) {
      drawWaiverContractBody(doc, { intro: payload.payload.contract.authoritativeIntro, sections: payload.payload.contract.authoritativeSections }, {
        LEFT, W, TOP: legalTextTop, pageTop: TOP, bottomMargin: doc.page.margins.bottom,
        regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
        columns: 3, columnGap: 15,
        fontSize: 6.9, headingFontSize: 7.5, lineGap: 0.3,
        paragraphGap: 2.8, bulletGap: 1.35, sectionGapBefore: 4.2,
        onNewPage: drawContinuationHeader
      });
    } else {
      // authoritativeFullText's first line repeats authoritativeTitle (see flattenWaiverDocument);
      // strip it so the heading above isn't shown a second time as the first line of the body.
      const authoritativeBody = authoritativeFullText.startsWith(authoritativeTitle)
        ? authoritativeFullText.slice(authoritativeTitle.length).replace(/^\n+/, '')
        : authoritativeFullText;
      doc.font(regularFont).fontSize(9.4).fillColor(BODY)
        .text(authoritativeBody, LEFT, doc.y, { width: W, lineGap: 1.5 });
    }
    // Signature, version and hashes deliberately stay on page 1. This page contains only
    // the authoritative German legal wording.

    if (payload.payload.contract.translation) {
      doc.addPage();
      doc.y = TOP;
      doc.font(boldFont).fontSize(11).fillColor(BLUE)
        .text(payload.payload.contract.translation.title, LEFT, doc.y, { width: W });
      doc.y += 5;
      doc.font(boldFont).fontSize(8.5).fillColor('#9A3412')
        .text(waiverTranslationNotice(payload.payload.contract.translation.locale), LEFT, doc.y, { width: W });
      doc.y += 10;
      const translationTitle = payload.payload.contract.translation.title;
      const translationSections = payload.payload.contract.translation.sections;
      const drawTranslationContinuationHeader = () => {
        doc.font(boldFont).fontSize(9).fillColor(DIM)
          .text(`${translationTitle} · Fortsetzung`, LEFT, doc.y, { width: W });
        doc.y += 14;
      };
      if (translationSections) {
        drawWaiverContractBody(doc, { intro: payload.payload.contract.translation.intro, sections: translationSections }, {
          LEFT, W, TOP: doc.y, pageTop: TOP, bottomMargin: doc.page.margins.bottom,
          regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
          columns: 3, columnGap: 15,
          fontSize: 6.9, headingFontSize: 7.5, lineGap: 0.3,
          paragraphGap: 2.8, bulletGap: 1.35, sectionGapBefore: 4.2,
          onNewPage: drawTranslationContinuationHeader
        });
      } else {
        const translationFullText = payload.payload.contract.translation.fullText;
        const translationBody = translationFullText.startsWith(translationTitle)
          ? translationFullText.slice(translationTitle.length).replace(/^\n+/, '')
          : translationFullText;
        doc.font(regularFont).fontSize(9.4).fillColor(BODY)
          .text(translationBody, LEFT, doc.y, { width: W, lineGap: 1.5 });
      }
      doc.y += 10;
      doc.font(regularFont).fontSize(7).fillColor(DIM)
        .text(`Übersetzung: ${payload.payload.contract.translation.locale} · Text-Hash: ${payload.payload.contract.translation.textHash}`, LEFT, doc.y, { width: W });
    }

    doc.end();
  });

export type PaperWaiverPdfPayload = {
  event: { name: string; startsAt: string; endsAt: string; location: string };
  driver: { firstName: string; lastName: string; birthdate: string | null };
  isMinor: boolean;
  requiresMedicalCertificate: boolean;
  contract: {
    locale: string;
    version: string;
    title: string;
    fullText: string;
    authoritativeLocale?: string;
    authoritativeTitle?: string;
    authoritativeFullText?: string;
    authoritativeIntro?: string[];
    authoritativeSections?: WaiverBodySection[];
    translation?: { locale: string; title: string; fullText: string; intro?: string[]; sections?: WaiverBodySection[]; binding: false } | null;
  };
  entries: Array<{
    className: string;
    orgaCode: string | null;
    startNumber: string | null;
    codriver: { firstName: string; lastName: string } | null;
    vehicles: Array<{ role: 'primary' | 'backup'; make: string; model: string; year: number | null; startNumber: string | null }>;
  }>;
  // Without a Unicode-capable font, Czech/Polish diacritics (outside WinAnsi/Latin-1) render
  // as garbage under the built-in Helvetica core font. Falls back to Helvetica for German
  // text or when unavailable, which is not affected.
  fonts?: { regular?: Buffer | null; bold?: Buffer | null };
  logoImage?: Buffer | null;
};

const stripLeadingTitleText = (text: string, title: string): string =>
  text.startsWith(title) ? text.slice(title.length).replace(/^\n+/, '') : text;

const WAIVER_ORGANIZER_CONTACT = 'MSC Oberlausitzer Dreiländereck e.V. · Am Weiher 4 · 02791 Oderwitz · nennung@msc-oberlausitzer-dreilaendereck.eu';

const waiverTranslationNotice = (locale: string, previousPage = false): string => {
  if (locale === 'en-GB') {
    return `Non-binding translation for comprehension. Only the German version${previousPage ? ' on the previous page' : ''} is legally binding.`;
  }
  if (locale === 'cs-CZ') {
    return `Nezávazný překlad pro snazší porozumění. Právně závazné je výhradně německé znění${previousPage ? ' na předchozí straně' : ''}.`;
  }
  if (locale === 'pl-PL') {
    return `Niewiążące tłumaczenie pomocnicze. Wyłącznie niemiecka wersja${previousPage ? ' na poprzedniej stronie' : ''} jest prawnie wiążąca.`;
  }
  return `Unverbindliche Übersetzung als Verständnishilfe. Rechtsverbindlich ist ausschließlich die deutsche Fassung${previousPage ? ' auf der vorherigen Seite' : ''}.`;
};

export const renderPaperWaiverPdf = async (payload: PaperWaiverPdfPayload): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 24, bottom: 18, left: 34, right: 34 },
      info: {
        Title: 'Persönliche Haftverzichtserklärung (Papierfassung)',
        Author: 'MSC Oberlausitzer Dreiländereck e.V.',
        Subject: payload.event.name
      }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Without a Unicode-capable font, Czech/Polish diacritics render as garbage under the
    // built-in Helvetica core font (WinAnsi/Latin-1 only) — embed Arial when supplied.
    const regularFont = payload.fonts?.regular ? 'PaperWaiverRegular' : 'Helvetica';
    const boldFont = payload.fonts?.bold ? 'PaperWaiverBold' : 'Helvetica-Bold';
    if (payload.fonts?.regular) doc.registerFont(regularFont, payload.fonts.regular);
    if (payload.fonts?.bold) doc.registerFont(boldFont, payload.fonts.bold);

    const LEFT = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const TOP = doc.page.margins.top;
    const BLUE = '#163A70';
    const YELLOW = '#E6B800';
    const LABEL = '#334155';
    const BODY = '#0F172A';
    const DIM = '#475569';
    const SIGNATURE_ZONE_HEIGHT = 28;
    const HEADER_HEIGHT = 58;
    const ROW_HEIGHT = 19;

    const fillLine = (x: number, y: number, width: number, label: string, labelWidth: number, value: string) => {
      const startY = y;
      doc.font(boldFont).fontSize(7).fillColor(LABEL).text(label, x, startY, { width: labelWidth });
      doc.font(regularFont).fontSize(7).fillColor(BODY).text(value || '—', x + labelWidth + 3, startY, { width: width - labelWidth - 3 });
      const lineY = startY + 12;
      doc.save().lineWidth(0.7).strokeColor('#94A3B8').moveTo(x + labelWidth, lineY).lineTo(x + width, lineY).stroke().restore();
    };

    // ── page 1 header ─────────────────────────────────────────────────────
    doc.y = TOP;
    const headerTextWidth = payload.logoImage ? W - 66 : W;
    doc.font(boldFont).fontSize(16).fillColor(BODY)
      .text('Persönliche Haftverzichtserklärung', LEFT, doc.y, { width: headerTextWidth });
    doc.y += 2;
    doc.font(boldFont).fontSize(9.5).fillColor(BLUE)
      .text(`${payload.event.name} · ${payload.event.startsAt} – ${payload.event.endsAt}`, LEFT, doc.y, { width: headerTextWidth });
    doc.y += 2;
    doc.font(regularFont).fontSize(7.4).fillColor(DIM)
      .text('Papierfassung zur Unterschrift vor Ort · MSC Oberlausitzer Dreiländereck e.V.', LEFT, doc.y, { width: headerTextWidth });
    doc.y += 1;
    doc.font(regularFont).fontSize(6.8).fillColor(DIM)
      .text('Am Weiher 4 · 02791 Oderwitz · nennung@msc-oberlausitzer-dreilaendereck.eu', LEFT, doc.y, { width: headerTextWidth });
    if (payload.logoImage) {
      try {
        doc.image(Buffer.from(payload.logoImage), LEFT + W - 54, TOP - 2, { fit: [54, 54], align: 'right', valign: 'top' });
      } catch {
        // Logo is decorative; the form remains usable if the asset is unavailable.
      }
    }
    doc.y = TOP + HEADER_HEIGHT;
    doc.save().lineWidth(0.8).strokeColor('#D8DEE9').moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 6;

    // ── compact personal-data box spanning the full width ──────────────────
    const dataBoxTop = doc.y;
    doc.y += 4;
    const pad = LEFT + 6;
    const boxWidth = W - 12;
    const driverName = `${payload.driver.firstName} ${payload.driver.lastName}`;
    const half = (boxWidth - 10) / 2;
    const primaryEntry = payload.entries[0];
    const firstRowY = doc.y;
    fillLine(pad, firstRowY, half, 'Fahrer:', 40, `${driverName}${payload.driver.birthdate ? `, geb. ${payload.driver.birthdate}` : ''}`);
    fillLine(pad + half + 10, firstRowY, half, 'Klasse / Nr.:', 62, primaryEntry ? [primaryEntry.className, primaryEntry.startNumber ? `#${primaryEntry.startNumber}` : null].filter(Boolean).join(' · ') : '—');
    doc.y = firstRowY;
    doc.y += ROW_HEIGHT;
    payload.entries.forEach((entry) => {
      entry.vehicles.forEach((v) => {
        const vLabel = v.role === 'backup' ? 'Ersatzfahrzeug:' : 'Fahrzeug:';
        const vVal = [v.make, v.model, v.year ? String(v.year) : null, v.startNumber ? `#${v.startNumber}` : null].filter(Boolean).join(' ');
        fillLine(pad, doc.y, boxWidth, vLabel, 78, vVal);
        doc.y += ROW_HEIGHT;
      });
      if (entry.codriver) {
        fillLine(pad, doc.y, boxWidth, 'Beifahrer:', 78, `${entry.codriver.firstName} ${entry.codriver.lastName}`);
        doc.y += ROW_HEIGHT;
      }
    });
    const flags: string[] = [];
    if (payload.isMinor) flags.push('Minderjährig – Unterschrift der/des Erziehungsberechtigten erforderlich');
    if (payload.requiresMedicalCertificate) flags.push('Attest ab 70 J. erforderlich');
    if (flags.length > 0) {
      doc.font(boldFont).fontSize(6.8).fillColor('#9A3412').text(flags.join(' · '), pad, doc.y, { width: boxWidth });
      doc.y += doc.heightOfString(flags.join(' · '), { width: boxWidth }) + 4;
    }
    doc.save().lineWidth(0.9).strokeColor('#94A3B8')
      .rect(LEFT, dataBoxTop, W, doc.y - dataBoxTop).stroke().restore();
    doc.y += 6;

    // ── contract text: small, three-column, so the whole declaration fits on this page ──
    const authoritativeTitle = payload.contract.authoritativeTitle ?? payload.contract.title;
    const authoritativeFullText = payload.contract.authoritativeFullText ?? payload.contract.fullText;
    doc.font(boldFont).fontSize(8.8).fillColor(BLUE).text(authoritativeTitle, LEFT, doc.y, { width: W });
    doc.y += 2;
    doc.save().lineWidth(0.8).strokeColor(YELLOW).moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 5;
    const columnsTop = doc.y;

    if (payload.contract.authoritativeSections) {
      const drawOverflowContinuationHeader = () => {
        doc.font(boldFont).fontSize(9).fillColor(DIM)
          .text(`${authoritativeTitle} · Fortsetzung`, LEFT, doc.y, { width: W });
        doc.y += 14;
      };
      drawWaiverContractBody(doc, { intro: payload.contract.authoritativeIntro, sections: payload.contract.authoritativeSections }, {
        LEFT, W, TOP: columnsTop, pageTop: TOP,
        bottomMargin: doc.page.margins.bottom + SIGNATURE_ZONE_HEIGHT,
        regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
        columns: 3, columnGap: 13,
        fontSize: 6.35, headingFontSize: 6.9, lineGap: 0.2, paragraphGap: 2.1, bulletGap: 0.9, sectionGapBefore: 3.2,
        onNewPage: drawOverflowContinuationHeader
      });
    } else {
      doc.font(regularFont).fontSize(5.5).fillColor(BODY)
        .text(stripLeadingTitleText(authoritativeFullText, authoritativeTitle), LEFT, doc.y, { width: W, lineGap: 0.2 });
    }

    // ── signature line(s), fixed at the bottom of the (reserved) signature zone ──
    const signatureY = doc.page.height - doc.page.margins.bottom - SIGNATURE_ZONE_HEIGHT + 8;
    const signatureLabel = payload.isMinor ? 'Unterschrift Erziehungsberechtigte/r' : 'Unterschrift Fahrer/in';
    doc.save().lineWidth(0.8).strokeColor('#111827').moveTo(LEFT, signatureY).lineTo(LEFT + Math.floor(W * 0.46), signatureY).stroke().restore();
    doc.save().lineWidth(0.8).strokeColor('#111827').moveTo(LEFT + Math.floor(W * 0.56), signatureY).lineTo(LEFT + W, signatureY).stroke().restore();
    doc.font(regularFont).fontSize(7).fillColor(DIM).text('Ort, Datum', LEFT, signatureY + 2, { width: Math.floor(W * 0.46) });
    doc.font(regularFont).fontSize(7).fillColor(DIM).text(signatureLabel, LEFT + Math.floor(W * 0.56), signatureY + 2, { width: W - Math.floor(W * 0.56) });

    // ── page 2 (optional) — non-binding translation, only if the driver's locale differs ──
    if (payload.contract.translation) {
      doc.addPage();
      doc.y = TOP;
      doc.font(boldFont).fontSize(11).fillColor(BLUE).text(payload.contract.translation.title, LEFT, doc.y, { width: W });
      doc.y += 5;
      doc.font(boldFont).fontSize(8.5).fillColor('#9A3412')
        .text(waiverTranslationNotice(payload.contract.translation.locale, true), LEFT, doc.y, { width: W });
      doc.y += 10;
      {
        const translationTitle = payload.contract.translation.title;
        const drawPaperTranslationContinuationHeader = () => {
          doc.font(boldFont).fontSize(9).fillColor(DIM)
            .text(`${translationTitle} · Fortsetzung`, LEFT, doc.y, { width: W });
          doc.y += 14;
        };
        if (payload.contract.translation.sections) {
          drawWaiverContractBody(doc, { intro: payload.contract.translation.intro, sections: payload.contract.translation.sections }, {
            LEFT, W, TOP: doc.y, pageTop: TOP, bottomMargin: doc.page.margins.bottom,
            regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
            columns: 3, columnGap: 13,
            fontSize: 6.35, headingFontSize: 6.9, lineGap: 0.2,
            paragraphGap: 2.1, bulletGap: 0.9, sectionGapBefore: 3.2,
            onNewPage: drawPaperTranslationContinuationHeader
          });
        } else {
          doc.font(regularFont).fontSize(9.4).fillColor(BODY)
            .text(stripLeadingTitleText(payload.contract.translation.fullText, translationTitle), LEFT, doc.y, { width: W, lineGap: 1.5 });
        }
      }
      doc.y += 10;
      doc.font(regularFont).fontSize(7).fillColor(DIM)
        .text(`Übersetzung: ${payload.contract.translation.locale}`, LEFT, doc.y, { width: W });
    }

    doc.end();
  });

// A single, unpersonalized paper form: same legal text as the per-driver paper-fallback
// export, but with blank fill-in fields instead of data, for handing out and filling in by
// hand. The binding German form deliberately remains one compact page, with a separate
// reading-aid page only when a translated locale was selected.
export const renderBlankWaiverPdf = async (
  locale: WaiverLocale = 'de-DE',
  fonts?: { regular?: Buffer | null; bold?: Buffer | null },
  logoImage?: Buffer | null
): Promise<Buffer> => {
  const contract = buildPaperWaiverContract(locale);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 24, bottom: 18, left: 34, right: 34 },
      info: {
        Title: 'Haftverzichtserklärung (Blanko)',
        Author: 'MSC Oberlausitzer Dreiländereck e.V.'
      }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Without a Unicode-capable font, Czech/Polish diacritics render as garbage under the
    // built-in Helvetica core font (WinAnsi/Latin-1 only) — embed Arial when supplied.
    const regularFont = fonts?.regular ? 'BlankWaiverRegular' : 'Helvetica';
    const boldFont = fonts?.bold ? 'BlankWaiverBold' : 'Helvetica-Bold';
    if (fonts?.regular) doc.registerFont(regularFont, fonts.regular);
    if (fonts?.bold) doc.registerFont(boldFont, fonts.bold);

    const LEFT = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const TOP = doc.page.margins.top;
    const BLUE = '#163A70';
    const YELLOW = '#E6B800';
    const LABEL = '#334155';
    const DIM = '#475569';
    const BODY = '#0F172A';
    const SIGNATURE_ZONE_HEIGHT = 28;
    const HEADER_HEIGHT = 58;
    const ROW_HEIGHT = 19;

    const fillLine = (x: number, y: number, width: number, label: string, labelWidth: number) => {
      const startY = y;
      doc.font(boldFont).fontSize(7).fillColor(LABEL).text(label, x, startY, { width: labelWidth });
      const lineY = startY + 12;
      doc.save().lineWidth(0.7).strokeColor('#94A3B8').moveTo(x + labelWidth, lineY).lineTo(x + width, lineY).stroke().restore();
    };

    doc.y = TOP;
    const headerTextWidth = logoImage ? W - 66 : W;
    doc.font(boldFont).fontSize(16).fillColor(BODY)
      .text('Haftverzichtserklärung', LEFT, doc.y, { width: headerTextWidth });
    doc.y += 2;
    doc.font(regularFont).fontSize(7.2).fillColor(DIM)
      .text(WAIVER_ORGANIZER_CONTACT, LEFT, doc.y, { width: headerTextWidth });
    if (logoImage) {
      try {
        doc.image(Buffer.from(logoImage), LEFT + W - 54, TOP - 2, { fit: [54, 54], align: 'right', valign: 'top' });
      } catch {
        // Logo is decorative; the form remains usable if the asset is unavailable.
      }
    }
    doc.y = TOP + HEADER_HEIGHT;
    doc.save().lineWidth(0.8).strokeColor('#D8DEE9').moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 6;

    // ── compact personal-data box: two rows of fill-in fields spanning the full width ──
    const dataBoxTop = doc.y;
    doc.y += 4;
    const col1 = LEFT + 6;
    const boxWidth = W - 12;
    const col2Width = (boxWidth - 20) / 3;
    fillLine(col1, doc.y, W - 12, 'Name, Vorname:', 78);
    doc.y += ROW_HEIGHT;
    const secondRowY = doc.y;
    fillLine(col1, secondRowY, col2Width, 'Geburtsdatum:', 62);
    fillLine(col1 + col2Width + 10, secondRowY, col2Width, 'Klasse:', 40);
    fillLine(col1 + 2 * (col2Width + 10), secondRowY, col2Width, 'Startnummer:', 62);
    doc.y = secondRowY;
    doc.y += ROW_HEIGHT;
    fillLine(col1, doc.y, W - 12, 'Fahrzeug (Hersteller/Modell):', 130);
    doc.y += 15;
    doc.save().lineWidth(0.9).strokeColor('#94A3B8')
      .rect(LEFT, dataBoxTop, W, doc.y - dataBoxTop).stroke().restore();
    doc.y += 6;

    // ── contract text: compact three-column layout, kept readable on one page ───
    const authoritativeTitle = contract.authoritativeTitle;
    const authoritativeFullText = contract.authoritativeFullText;
    doc.font(boldFont).fontSize(8.8).fillColor(BLUE).text(authoritativeTitle, LEFT, doc.y, { width: W });
    doc.y += 2;
    doc.save().lineWidth(0.8).strokeColor(YELLOW).moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).stroke().restore();
    doc.y += 6;
    // Columns must all start below this full-width header, not at the page's outer margin —
    // otherwise the 2nd/3rd column reset to the very top of the page and overlap it.
    const columnsTop = doc.y;

    if (contract.authoritativeSections) {
      const drawOverflowContinuationHeader = () => {
        doc.font(boldFont).fontSize(9).fillColor(DIM)
          .text(`${authoritativeTitle} · Fortsetzung`, LEFT, doc.y, { width: W });
        doc.y += 14;
      };
      drawWaiverContractBody(doc, { intro: contract.authoritativeIntro, sections: contract.authoritativeSections }, {
        LEFT, W, TOP: columnsTop, pageTop: TOP,
        bottomMargin: doc.page.margins.bottom + SIGNATURE_ZONE_HEIGHT,
        regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
        columns: 3, columnGap: 13,
        fontSize: 6.35, headingFontSize: 6.9, lineGap: 0.2, paragraphGap: 2.1, bulletGap: 0.9, sectionGapBefore: 3.2,
        onNewPage: drawOverflowContinuationHeader
      });
    } else {
      doc.font(regularFont).fontSize(5.9).fillColor(BODY)
        .text(stripLeadingTitleText(authoritativeFullText, authoritativeTitle), LEFT, doc.y, { width: W, lineGap: 0.6 });
    }

    // ── signature line, fixed at the bottom of the (reserved) signature zone ──
    const signatureY = doc.page.height - doc.page.margins.bottom - SIGNATURE_ZONE_HEIGHT + 8;
    doc.save().lineWidth(0.8).strokeColor('#111827').moveTo(LEFT, signatureY).lineTo(LEFT + Math.floor(W * 0.46), signatureY).stroke().restore();
    doc.save().lineWidth(0.8).strokeColor('#111827').moveTo(LEFT + Math.floor(W * 0.56), signatureY).lineTo(LEFT + W, signatureY).stroke().restore();
    doc.font(regularFont).fontSize(7).fillColor(DIM).text('Ort, Datum', LEFT, signatureY + 2, { width: Math.floor(W * 0.46) });
    doc.font(regularFont).fontSize(7).fillColor(DIM).text('Unterschrift', LEFT + Math.floor(W * 0.56), signatureY + 2, { width: W - Math.floor(W * 0.56) });

    if (contract.translation) {
      doc.addPage();
      doc.y = TOP;
      doc.font(boldFont).fontSize(14).fillColor(BODY).text(contract.translation.title, LEFT, doc.y, { width: W });
      doc.y += 4;
      doc.font(boldFont).fontSize(8).fillColor('#9A3412')
        .text(waiverTranslationNotice(contract.translation.locale, true), LEFT, doc.y, { width: W });
      doc.y += 9;
      const translationTop = doc.y;
      drawWaiverContractBody(doc, { intro: contract.translation.intro, sections: contract.translation.sections }, {
        LEFT, W, TOP: translationTop, pageTop: TOP, bottomMargin: doc.page.margins.bottom,
        regularFont, boldFont, bodyColor: BODY, headingColor: BLUE,
        columns: 3, columnGap: 13,
        fontSize: 6.35, headingFontSize: 6.9, lineGap: 0.2,
        paragraphGap: 2.1, bulletGap: 0.9, sectionGapBefore: 3.2
      });
    }

    doc.end();
  });
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
