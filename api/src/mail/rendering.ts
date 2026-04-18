import { KNOWN_PLACEHOLDER_NAMES, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';
import { getTemplateContract, MailRenderOptions } from './templateContracts';
import { getMailChromeCopy, getProcessTemplateCopy, resolveMailLocale, SupportedMailLocale } from './i18n';

type TemplateData = Record<string, unknown>;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const CANONICAL_LAYOUT_ONLY_TEMPLATES = new Set<string>([
  'registration_received',
  'email_confirmation_reminder',
  'preselection',
  'accepted_open_payment',
  'accepted_paid_completed',
  'payment_reminder',
  'rejected',
  'codriver_info'
]);

const readPath = (data: TemplateData, keyPath: string): unknown => {
  const keys = keyPath.split('.');
  let current: unknown = data;
  for (const key of keys) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toStringValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

const isPresentValue = (value: unknown): boolean => !(value === undefined || value === null || String(value).trim().length === 0);

type RenderStringResult = {
  rendered: string;
  placeholders: string[];
};

const renderString = (template: string, data: TemplateData, escapeValuesForHtml: boolean): RenderStringResult => {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, keyPath: string) => {
    used.add(keyPath);
    const value = toStringValue(readPath(data, keyPath));
    return escapeValuesForHtml ? escapeHtml(value) : value;
  });
  return { rendered, placeholders: Array.from(used.values()) };
};

const normalizePublicUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeBaseUrl = (value: unknown): string | null => {
  const normalized = normalizePublicUrl(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\/+$/, '');
};

const normalizeHttpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const sanitizeHtmlFragment = (value: string): string =>
  value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\shref\s*=\s*(['"])\s*javascript:[^'"]*\1/gi, ' href="#"');

const normalizeHtmlTemplateSource = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  // Strip full document wrappers so templates can only contribute body fragments.
  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : trimmed;
  return body
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<html[^>]*>/gi, '')
    .replace(/<\/html>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<body[^>]*>/gi, '')
    .replace(/<\/body>/gi, '')
    .trim();
};

const hasStandardSignoff = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('mit freundlichen grüßen') ||
    normalized.includes('mit freundlichen gruessen') ||
    normalized.includes('kind regards') ||
    normalized.includes('s pozdravem') ||
    normalized.includes('z pozdrowieniami')
  );
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeWhitespaceBlocks = (value: string): string =>
  value
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

const ensureClubSuffix = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/\be\.\s?v\.\s*$/i.test(trimmed)) {
    return trimmed.replace(/\be\.\s?v\.\s*$/i, 'e.V.');
  }
  return `${trimmed} e.V.`;
};

const stripLegacySupportHintsText = (value: string): string => {
  const lines = value
    .split(/\r?\n/)
    .filter((line) => !/^\s*bei\s+r(?:ü|ue)ckfragen\b/i.test(line) && !/^\s*bei\s+fragen\b/i.test(line));
  return normalizeWhitespaceBlocks(lines.join('\n'));
};

const stripLegacySupportHintsHtml = (value: string): string =>
  value
    .replace(/<p[^>]*>\s*bei\s+r(?:ü|ue)ckfragen[\s\S]*?<\/p>/gi, '')
    .replace(/<p[^>]*>\s*bei\s+fragen[\s\S]*?<\/p>/gi, '');

const stripCodriverSupportSentenceText = (value: string): string =>
  normalizeWhitespaceBlocks(
    value.replace(
      /(?:^|[\s\n])bei\s+r(?:ü|ue)ckfragen\s+melde\s+dich\s+bitte\s+unter\s+[^\n.]+\.?/gi,
      ' '
    )
  );

const stripCodriverSupportSentenceHtml = (value: string): string =>
  value
    .replace(/<p[^>]*>[\s\S]*?bei\s+r(?:ü|ue)ckfragen\s+melde\s+dich\s+bitte\s+unter[\s\S]*?<\/p>/gi, '')
    .replace(/bei\s+r(?:ü|ue)ckfragen\s+melde\s+dich\s+bitte\s+unter\s+[^<.]+\.?/gi, '');

const normalizeInlineTypographyHtml = (value: string): string =>
  value
    .replace(/\sstyle=(['"])(.*?)\1/gi, (_match, quote: string, styleValue: string) => {
      const cleaned = styleValue
        .replace(/(?:^|;)\s*font-size\s*:[^;]+/gi, '')
        .replace(/(?:^|;)\s*line-height\s*:[^;]+/gi, '')
        .replace(/^\s*;+/g, '')
        .replace(/;+\s*$/g, '')
        .replace(/;;+/g, ';')
        .trim();
      return cleaned ? ` style=${quote}${cleaned}${quote}` : '';
    })
    .replace(/\sfont-size=(['"]).*?\1/gi, '')
    .replace(/\sline-height=(['"]).*?\1/gi, '');

const normalizeClassPrefixDuplicates = (value: string): string =>
  value
    .replace(/\bKlasse:\s*Klasse\b/gi, 'Klasse')
    .replace(/\bclass:\s*class\b/gi, 'Class');

const withDefaultEventArticle = (eventName: string): string => {
  const trimmed = eventName.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^(der|die|das)\s+/i.test(trimmed)) {
    return trimmed;
  }
  return `das ${trimmed}`;
};

const applyEventArticleHeuristic = (value: string, eventName: string | null): string => {
  if (!eventName) {
    return value;
  }
  const eventNameWithArticle = withDefaultEventArticle(eventName);
  if (eventNameWithArticle === eventName) {
    return value;
  }
  const escapedEventName = escapeRegExp(eventName);
  return value.replace(new RegExp(`(\\bfür\\s+)${escapedEventName}(\\b)`, 'g'), `$1${eventNameWithArticle}$2`);
};

const shouldInjectDriverNote = (templateKey: string, driverNote: string): boolean =>
  (templateKey === 'accepted_open_payment' || templateKey === 'rejected') && driverNote.trim().length > 0;

const appendDriverNoteText = (value: string, driverNote: string, noteTitle: string): string => {
  if (value.toLowerCase().includes(driverNote.toLowerCase())) {
    return value;
  }
  return `${value}\n\n${noteTitle}:\n${driverNote}`.trim();
};

const appendDriverNoteHtml = (value: string, driverNote: string, noteTitle: string): string => {
  if (value.toLowerCase().includes(driverNote.toLowerCase())) {
    return value;
  }
  const noteHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0 0;border:1px solid #DDE4EE;border-radius:10px;background:#F8FAFC;background-color:#F8FAFC;"><tr><td bgcolor="#F8FAFC" style="padding:12px 14px;background:#F8FAFC;background-color:#F8FAFC;"><div style="margin:0 0 6px 0;color:#254CA2;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(noteTitle)}</div><div style="color:#0F1729;font-size:15px;line-height:1.55;">${escapeHtml(driverNote).replace(/\r?\n/g, '<br />')}</div></td></tr></table>`;
  return `${value}${noteHtml}`;
};

const textToHtml = (text: string): string =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) => `<p style="margin:0 0 14px 0;color:#0F1729;font-size:15px;line-height:1.6;">${escapeHtml(block).replace(/\r?\n/g, '<br />')}</p>`)
    .join('');

const parseMultiline = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => toStringValue(item).trim()).filter((item) => item.length > 0);
  }
  if (!isPresentValue(value)) {
    return [];
  }
  return toStringValue(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const renderTemplateText = (template: string, data: TemplateData): string => renderString(template, data, false).rendered.trim();

const renderTextBlocksToHtml = (blocks: string[]): string => textToHtml(blocks.filter((block) => block.trim().length > 0).join('\n\n'));

const resolveVehicleLabel = (data: TemplateData): string => {
  if (isPresentValue(data.vehicleLabel)) {
    return toStringValue(data.vehicleLabel);
  }
  const parts: string[] = [];
  if (isPresentValue(data.vehicleMake)) {
    parts.push(toStringValue(data.vehicleMake));
  }
  if (isPresentValue(data.vehicleModel)) {
    parts.push(toStringValue(data.vehicleModel));
  }
  return parts.join(' · ');
};

const getEntryContextLabels = (
  locale: SupportedMailLocale
): {
  className: string;
  startNumber: string;
  vehicle: string;
  entries: string;
  amountOpen: string;
  paymentDueDate: string;
  paymentRecipient: string;
  paymentIban: string;
  paymentBic: string;
} => {
  if (locale === 'cs') {
    return {
      className: 'Třída',
      startNumber: 'Startovní číslo',
      vehicle: 'Vozidlo',
      entries: 'Přihlášky',
      amountOpen: 'Startovné',
      paymentDueDate: 'Termín',
      paymentRecipient: 'Příjemce',
      paymentIban: 'IBAN',
      paymentBic: 'BIC'
    };
  }
  if (locale === 'pl') {
    return {
      className: 'Klasa',
      startNumber: 'Numer startowy',
      vehicle: 'Pojazd',
      entries: 'Zgłoszenia',
      amountOpen: 'Wpisowe',
      paymentDueDate: 'Termin',
      paymentRecipient: 'Odbiorca',
      paymentIban: 'IBAN',
      paymentBic: 'BIC'
    };
  }
  if (locale === 'en') {
    return {
      className: 'Class',
      startNumber: 'Start number',
      vehicle: 'Vehicle',
      entries: 'Entries',
      amountOpen: 'Entry fee',
      paymentDueDate: 'Due date',
      paymentRecipient: 'Recipient',
      paymentIban: 'IBAN',
      paymentBic: 'BIC'
    };
  }
  return {
    className: 'Klasse',
    startNumber: 'Startnummer',
    vehicle: 'Fahrzeug',
    entries: 'Nennungen',
    amountOpen: 'Nenngeld',
    paymentDueDate: 'Frist',
    paymentRecipient: 'Empfänger',
    paymentIban: 'IBAN',
    paymentBic: 'BIC'
  };
};

type TemplateVisualConfig = {
  accentLine: string;
  entryBackground: string;
  entryBorder: string;
  entryLabelColor: string;
};

const TEMPLATE_VISUALS: Record<string, TemplateVisualConfig> = {
  registration_received: {
    accentLine: '#7DD3FC',
    entryBackground: '#F0F9FF',
    entryBorder: '#BAE6FD',
    entryLabelColor: '#0369A1'
  },
  email_confirmation_reminder: {
    accentLine: '#67E8F9',
    entryBackground: '#ECFEFF',
    entryBorder: '#A5F3FC',
    entryLabelColor: '#0891B2'
  },
  preselection: {
    accentLine: '#93C5FD',
    entryBackground: '#EFF6FF',
    entryBorder: '#BFDBFE',
    entryLabelColor: '#1D4ED8'
  },
  accepted_open_payment: {
    accentLine: '#FCD34D',
    entryBackground: '#FFFBEB',
    entryBorder: '#FDE68A',
    entryLabelColor: '#B45309'
  },
  accepted_paid_completed: {
    accentLine: '#86EFAC',
    entryBackground: '#ECFDF5',
    entryBorder: '#BBF7D0',
    entryLabelColor: '#15803D'
  },
  rejected: {
    accentLine: '#FDA4AF',
    entryBackground: '#FFF1F2',
    entryBorder: '#FECDD3',
    entryLabelColor: '#BE123C'
  },
  newsletter: {
    accentLine: '#7DD3FC',
    entryBackground: '#F0F9FF',
    entryBorder: '#BAE6FD',
    entryLabelColor: '#0369A1'
  },
  event_update: {
    accentLine: '#93C5FD',
    entryBackground: '#EFF6FF',
    entryBorder: '#BFDBFE',
    entryLabelColor: '#1D4ED8'
  },
  free_form: {
    accentLine: '#A5B4FC',
    entryBackground: '#EEF2FF',
    entryBorder: '#C7D2FE',
    entryLabelColor: '#4338CA'
  },
  payment_reminder_followup: {
    accentLine: '#FCD34D',
    entryBackground: '#FFFBEB',
    entryBorder: '#FDE68A',
    entryLabelColor: '#B45309'
  },
  payment_reminder: {
    accentLine: '#FCD34D',
    entryBackground: '#FFFBEB',
    entryBorder: '#FDE68A',
    entryLabelColor: '#B45309'
  },
  email_confirmation: {
    accentLine: '#7DD3FC',
    entryBackground: '#F0F9FF',
    entryBorder: '#BAE6FD',
    entryLabelColor: '#0369A1'
  },
  codriver_info: {
    accentLine: '#7DD3FC',
    entryBackground: '#F0F9FF',
    entryBorder: '#BAE6FD',
    entryLabelColor: '#0369A1'
  }
};

const getTemplateVisualConfig = (templateKey: string): TemplateVisualConfig =>
  TEMPLATE_VISUALS[templateKey] ?? {
    accentLine: '#93C5FD',
    entryBackground: '#EFF6FF',
    entryBorder: '#BFDBFE',
    entryLabelColor: '#1D4ED8'
  };

const buildEntryContextCard = (
  templateKey: string,
  data: TemplateData,
  compact: boolean,
  locale: SupportedMailLocale
): string => {
  const copy = getMailChromeCopy(locale);
  const labels = getEntryContextLabels(locale);
  const visual = getTemplateVisualConfig(templateKey);
  const entryContextTitle = templateKey === 'codriver_info' ? copy.codriverEntryContextTitle : copy.entryContextTitle;
  const rows: Array<{ label: string; value: string; multiline?: boolean }> = [];
  const entrySummaries = parseMultiline(data.entrySummaries);
  const showFocusedEntryDetails = entrySummaries.length <= 1;
  if (showFocusedEntryDetails && isPresentValue(data.className)) {
    rows.push({ label: labels.className, value: toStringValue(data.className) });
  }
  if (showFocusedEntryDetails && isPresentValue(data.startNumber)) {
    rows.push({ label: labels.startNumber, value: toStringValue(data.startNumber) });
  }
  const vehicleLabel = resolveVehicleLabel(data);
  if (showFocusedEntryDetails && vehicleLabel) {
    rows.push({ label: labels.vehicle, value: vehicleLabel });
  }
  if (entrySummaries.length > 1) {
    rows.push({ label: labels.entries, value: entrySummaries.join('\n'), multiline: true });
  }
  if (rows.length === 0) {
    return '';
  }

  const rowHtml = rows
    .map(
      (row) =>
        `<tr><td class="mail-entry-label" style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '13px' : '14px'};line-height:1.4;color:#475569;vertical-align:${row.multiline ? 'top' : 'middle'};">${escapeHtml(row.label)}</td><td class="mail-entry-value" style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '13px' : '14px'};line-height:1.4;color:#0F1729;font-weight:600;text-align:${row.multiline ? 'left' : 'right'};">${escapeHtml(row.value).replace(/\n/g, '<br />')}</td></tr>`
    )
    .join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mail-entry" style="margin:0 0 14px 0;border:1px solid ${visual.entryBorder};border-radius:10px;background:${visual.entryBackground};background-color:${visual.entryBackground};">`,
    `<tr><td bgcolor="${visual.entryBackground}" style="padding:${compact ? '10px 12px' : '12px 14px'};background:${visual.entryBackground};background-color:${visual.entryBackground};">`,
    `<div style="margin:0 0 8px 0;color:${visual.entryLabelColor};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(entryContextTitle)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${rowHtml}</tbody></table>`,
    '</td></tr>',
    '</table>'
  ].join('');
};

const buildSectionCard = (title: string, bodyHtml: string): string =>
  [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;border:1px solid #DDE4EE;border-radius:10px;background:#FFFFFF;background-color:#FFFFFF;">',
    '<tr><td bgcolor="#FFFFFF" style="padding:12px 14px;background:#FFFFFF;background-color:#FFFFFF;">',
    `<div style="margin:0 0 8px 0;color:#254CA2;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(title)}</div>`,
    `<div style="color:#0F1729;font-size:15px;line-height:1.55;">${bodyHtml}</div>`,
    '</td></tr>',
    '</table>'
  ].join('');

const buildSpacer = (height: number): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="${height}" style="height:${height}px;line-height:${height}px;font-size:0;">&nbsp;</td></tr></table>`;

const buildBulletproofButton = (url: string, label: string): string => {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0 0;"><tr><td align="left">',
    '<!--[if mso]>',
    `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height:40px;v-text-anchor:middle;width:220px;" arcsize="18%" strokecolor="#FACC15" fillcolor="#FACC15">`,
    '<w:anchorlock/>',
    `<center style="color:#0F172A;font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:700;">${safeLabel}</center>`,
    '</v:roundrect>',
    '<![endif]-->',
    `<!--[if !mso]><!-- --><a class="mail-cta" href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#FACC15;background-color:#FACC15;color:#0F172A;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:700;border:1px solid #FACC15;mso-hide:all;">${safeLabel}</a><!--<![endif]-->`,
    '</td></tr></table>'
  ].join('');
};

const buildAccentBar = (color: string): string =>
  [
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr><td>',
    '<!--[if mso]>',
    `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" style="width:86px;height:4px;v-text-anchor:middle;" arcsize="100%" stroked="f" fillcolor="${color}"><w:anchorlock/><center style="font-size:0;line-height:0;">&nbsp;</center></v:roundrect>`,
    '<![endif]-->',
    `<!--[if !mso]><!-- --><div style="width:86px;height:4px;background:${color};background-color:${color};border-radius:999px;font-size:0;line-height:0;"></div><!--<![endif]-->`,
    '</td></tr></table>'
  ].join('');

const buildStructuredSections = (data: TemplateData, locale: SupportedMailLocale): { html: string; text: string } => {
  const copy = getMailChromeCopy(locale);
  const highlightLines = parseMultiline(data.highlights).map((line) => renderTemplateText(line, data)).filter((line) => line.length > 0);
  const paymentDeadline = isPresentValue(data.paymentDeadline) ? renderTemplateText(toStringValue(data.paymentDeadline), data) : '';

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (highlightLines.length > 0) {
    const listHtml = `<ul style="margin:0;padding-left:18px;">${highlightLines
      .map((line) => `<li style="margin:0 0 6px 0;">${escapeHtml(line)}</li>`)
      .join('')}</ul>`;
    htmlParts.push(buildSectionCard(copy.highlightsTitle, listHtml));
    textParts.push(`${copy.highlightsTitle}:\n${highlightLines.map((line) => `- ${line}`).join('\n')}`);
  }

  if (paymentDeadline) {
    htmlParts.push(buildSectionCard(copy.paymentDeadlineTitle, escapeHtml(paymentDeadline).replace(/\r?\n/g, '<br />')));
    textParts.push(`${copy.paymentDeadlineTitle}:\n${paymentDeadline}`);
  }

  return {
    html: htmlParts.join(''),
    text: textParts.join('\n\n').trim()
  };
};

const resolveFreeFormBlocks = (data: TemplateData): {
  bodyBlocks: string[];
  closingText: string;
} => {
  const explicitGreeting = isPresentValue(data.greetingText) ? renderTemplateText(toStringValue(data.greetingText), data) : '';
  const explicitContent = isPresentValue(data.contentText) ? renderTemplateText(toStringValue(data.contentText), data) : '';
  const legacyIntro = isPresentValue(data.introText) ? renderTemplateText(toStringValue(data.introText), data) : '';
  const legacyDetails = isPresentValue(data.detailsText) ? renderTemplateText(toStringValue(data.detailsText), data) : '';
  const closingText = isPresentValue(data.closingText) ? renderTemplateText(toStringValue(data.closingText), data) : '';

  const greeting = explicitGreeting || renderTemplateText('{{fallbackGreeting}} {{driverName}},', data);
  const contentBlocks =
    explicitContent.length > 0 ? [explicitContent] : [legacyIntro, legacyDetails].filter((item) => item.length > 0);

  return {
    bodyBlocks: [greeting, ...contentBlocks].filter((item) => item.length > 0),
    closingText
  };
};

const TEMPLATE_PRESENTATION: Record<string, { mailLabel: string; heroSubtitle: string }> = {
  registration_received: {
    mailLabel: '',
    heroSubtitle: 'Bitte bestätige deine E-Mail-Adresse, um die Anmeldung abzuschließen.'
  },
  email_confirmation_reminder: {
    mailLabel: '',
    heroSubtitle: 'Bitte bestätige deine E-Mail-Adresse, damit wir deine Nennung final bearbeiten können.'
  },
  preselection: {
    mailLabel: '',
    heroSubtitle: 'Statusupdate zu deiner Anmeldung.'
  },
  accepted_open_payment: {
    mailLabel: '',
    heroSubtitle: 'Deine Nennung ist zugelassen. Jetzt fehlt nur noch der Zahlungsschritt.'
  },
  accepted_paid_completed: {
    mailLabel: '',
    heroSubtitle: 'Deine Nennung ist vollständig bestätigt.'
  },
  payment_reminder: {
    mailLabel: '',
    heroSubtitle: 'Deine Nennung ist fast komplett.'
  },
  rejected: {
    mailLabel: '',
    heroSubtitle: 'Statusupdate zu deiner Anmeldung.'
  },
  newsletter: {
    mailLabel: '',
    heroSubtitle: 'Aktuelle Informationen rund um die Veranstaltung.'
  },
  event_update: {
    mailLabel: '',
    heroSubtitle: 'Wichtige Updates für deine Teilnahme.'
  },
  free_form: {
    mailLabel: '',
    heroSubtitle: 'Kurze Mitteilung vom Orga-Team.'
  },
  payment_reminder_followup: {
    mailLabel: '',
    heroSubtitle: 'Bitte schließe den offenen Zahlungsschritt für deine Nennung ab.'
  },
  email_confirmation: {
    mailLabel: '',
    heroSubtitle: 'Bitte bestätige deine E-Mail-Adresse, damit wir deine Nennung bearbeiten können.'
  },
  codriver_info: {
    mailLabel: '',
    heroSubtitle: 'Information zu deiner Beifahrer-Eintragung'
  }
};

const isCampaignTemplate = (templateKey: string): boolean =>
  templateKey === 'newsletter' ||
  templateKey === 'event_update' ||
  templateKey === 'free_form' ||
  templateKey === 'payment_reminder_followup';

const isCompactEntryContextTemplate = (templateKey: string): boolean =>
  templateKey === 'newsletter' || templateKey === 'event_update' || templateKey === 'payment_reminder_followup';

const resolveLogoUrl = (data: TemplateData): { logoUrl: string | null; warning: string | null } => {
  const candidate = data.logoUrl ?? process.env.MAIL_LOGO_URL;
  if (!isPresentValue(candidate)) {
    return { logoUrl: null, warning: null };
  }
  const httpsUrl = normalizeHttpsUrl(candidate);
  if (!httpsUrl) {
    return { logoUrl: null, warning: 'logoUrl verworfen (ungültig oder nicht https).' };
  }

  const configuredLogoUrl = normalizeHttpsUrl(process.env.MAIL_LOGO_URL);
  if (configuredLogoUrl && configuredLogoUrl === httpsUrl) {
    return { logoUrl: httpsUrl, warning: null };
  }

  const url = new URL(httpsUrl);
  const allowedHosts = new Set<string>();
  const baseUrl = normalizeBaseUrl(process.env.MAIL_PUBLIC_BASE_URL);
  if (baseUrl) {
    allowedHosts.add(new URL(baseUrl).hostname.toLowerCase());
  }
  const allowlist = (process.env.MAIL_LOGO_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  allowlist.forEach((host) => allowedHosts.add(host));

  if (allowedHosts.size > 0 && !allowedHosts.has(url.hostname.toLowerCase())) {
    return { logoUrl: null, warning: 'logoUrl verworfen (Host nicht erlaubt).' };
  }

  return { logoUrl: httpsUrl, warning: null };
};

const buildHtmlDocument = (input: {
  templateKey: string;
  subjectRendered: string;
  bodyHtmlRendered: string;
  postCtaHtmlRendered?: string;
  structuredSectionsHtml: string;
  entryContextHtml: string;
  verificationUrl: string | null;
  data: TemplateData;
  renderOptions?: MailRenderOptions;
  hasContentOverride: boolean;
  includeStandardSignoff: boolean;
  locale: SupportedMailLocale;
}): string => {
  const copy = getMailChromeCopy(input.locale);
  const visual = getTemplateVisualConfig(input.templateKey);
  const eventName = isPresentValue(input.data.eventName)
    ? toStringValue(input.data.eventName)
    : (process.env.MAIL_BRAND_EVENT_NAME ?? 'MSC Event');
  const contract = getTemplateContract(input.templateKey);
  const templatePresentation = TEMPLATE_PRESENTATION[input.templateKey] ?? {
    mailLabel: 'Mitteilung',
    heroSubtitle: 'Information vom Veranstalter.'
  };
  const payloadRenderOptions =
    input.data.renderOptions && typeof input.data.renderOptions === 'object'
      ? (input.data.renderOptions as MailRenderOptions)
      : undefined;
  const showBadge =
    input.renderOptions?.showBadge ?? payloadRenderOptions?.showBadge ?? contract.renderOptions.showBadgeDefault;
  const includeEntryContext =
    input.renderOptions?.includeEntryContext ??
    payloadRenderOptions?.includeEntryContext ??
    contract.renderOptions.includeEntryContextDefault;
  const mailLabelValue =
    input.renderOptions?.mailLabel ??
    payloadRenderOptions?.mailLabel ??
    contract.renderOptions.defaultMailLabel ??
    templatePresentation.mailLabel;
  const mailLabel = isPresentValue(mailLabelValue) ? toStringValue(mailLabelValue) : '';

  const processHeaderTitle = isPresentValue(input.data.headerTitle) ? toStringValue(input.data.headerTitle) : '';
  const heroSubtitle = isPresentValue(input.data.heroSubtitle)
    ? toStringValue(input.data.heroSubtitle)
    : templatePresentation.heroSubtitle;
  const preheaderText = isPresentValue(input.data.preheader) ? toStringValue(input.data.preheader) : '';
  const heroImageUrl = normalizeHttpsUrl(input.data.heroImageUrl);
  const brandName = ensureClubSuffix(
    (isPresentValue(input.data.brandName) ? toStringValue(input.data.brandName) : 'MSC Oberlausitzer Dreiländereck e.V.').trim()
  );

  const eventDateText = isPresentValue(input.data.eventDateText)
    ? toStringValue(input.data.eventDateText)
    : '';
  const contactEmail = isPresentValue(input.data.contactEmail)
    ? toStringValue(input.data.contactEmail)
    : '';
  const baseUrl =
    normalizeBaseUrl(input.data.nennungstoolUrl) ??
    normalizeBaseUrl(input.data.url) ??
    normalizeBaseUrl(process.env.MAIL_PUBLIC_BASE_URL) ??
    normalizeBaseUrl(process.env.NENNUNGSTOOL_URL);
  const impressumUrl = baseUrl ? `${baseUrl}/anmeldung/rechtliches/impressum` : null;
  const datenschutzUrl = baseUrl ? `${baseUrl}/anmeldung/rechtliches/datenschutz` : null;
  const { logoUrl } = resolveLogoUrl(input.data);

  const contactHtml = contactEmail
    ? `<div style="margin-top:6px;">Kontakt: <a href="mailto:${escapeHtml(contactEmail)}" style="color:#1D4ED8;text-decoration:underline;">${escapeHtml(contactEmail)}</a></div>`
    : '';
  const replyHintHtml = `<div style="margin-top:8px;">${escapeHtml(copy.replyHint)}</div>`;
  const legalLinks = impressumUrl && datenschutzUrl
    ? `<div style="margin-top:8px;"><a href="${escapeHtml(impressumUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${escapeHtml(copy.impressumLabel)}</a> · <a href="${escapeHtml(datenschutzUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${escapeHtml(copy.privacyLabel)}</a></div>`
    : '';
  const dateHtml = eventDateText
    ? `<div>${escapeHtml(eventName)} · ${escapeHtml(eventDateText)}</div>`
    : `<div>${escapeHtml(eventName)}</div>`;

  const campaignCtaUrl = normalizePublicUrl(input.data.ctaUrl);
  const campaignCtaText = isPresentValue(input.data.ctaText) ? toStringValue(input.data.ctaText) : 'Mehr erfahren';
  const verificationCtaLabel =
    input.templateKey === 'email_confirmation_reminder' ? copy.confirmationReminderCta : copy.verificationCta;
  const ctaBlock =
    (
      input.templateKey === 'registration_received' ||
      input.templateKey === 'email_confirmation' ||
      input.templateKey === 'email_confirmation_reminder'
    ) && input.verificationUrl
      ? `${buildBulletproofButton(input.verificationUrl, verificationCtaLabel)}<p style="margin:10px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">${escapeHtml(copy.ctaFallbackPrefix)} <a href="${escapeHtml(input.verificationUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;">${escapeHtml(input.verificationUrl)}</a></p>`
      : isCampaignTemplate(input.templateKey) && campaignCtaUrl
        ? `${buildBulletproofButton(campaignCtaUrl, campaignCtaText)}<p style="margin:10px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">${escapeHtml(copy.ctaFallbackPrefix)} <a href="${escapeHtml(campaignCtaUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;">${escapeHtml(campaignCtaUrl)}</a></p>`
        : '';

  const sectionsHtml = !input.hasContentOverride && isCampaignTemplate(input.templateKey) ? input.structuredSectionsHtml : '';
  const entryContextHtml = includeEntryContext ? input.entryContextHtml : '';
  const signoffHtml = input.includeStandardSignoff
    ? `<p style="margin:18px 0 0 0;color:#475569;font-size:15px;line-height:1.72;">${escapeHtml(copy.signoffLead)}</p><p style="margin:12px 0 0 0;color:#475569;font-size:15px;line-height:1.72;">${escapeHtml(copy.signoffLine1)}<br />${escapeHtml(copy.signoffLine2)}<br />${escapeHtml(copy.signoffLine3)}</p>`
    : '';

  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" width="28" style="display:block;width:28px;max-width:28px;height:auto;border:0;" />`
    : '';
  const badgeHtml = showBadge && mailLabel
    ? `<div style="display:inline-block;background:#FACC15;color:#0F172A;padding:4px 10px;border-radius:8px;font-size:11px;font-weight:700;line-height:1;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(mailLabel)}</div>`
    : '';
  const headerRight = badgeHtml || (eventDateText ? `<div style="font-size:12px;opacity:.9;">${escapeHtml(eventDateText)}</div>` : '');
  const processHeaderText = processHeaderTitle || preheaderText;
  const processHeaderLine = processHeaderText
    ? `<div style="margin-top:14px;font-size:13px;line-height:1.55;letter-spacing:.10em;text-transform:uppercase;font-weight:700;">${escapeHtml(processHeaderText)}</div>`
    : '';
  const campaignPreheaderLine = preheaderText
    ? `<div style="margin-top:14px;font-size:14px;line-height:1.7;opacity:.95;">${escapeHtml(preheaderText)}</div>`
    : '';
  const hiddenPreheaderText = (contract.scope === 'process' ? processHeaderText : preheaderText) || heroSubtitle;
  const hiddenPreheader = hiddenPreheaderText
    ? `<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(hiddenPreheaderText)}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>`
    : '';

  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(input.locale)}">`,
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="x-apple-disable-message-reformatting" />',
    `<title>${escapeHtml(input.subjectRendered)}</title>`,
    '<style>',
    'table,td{mso-table-lspace:0pt !important;mso-table-rspace:0pt !important;}',
    'img{-ms-interpolation-mode:bicubic;}',
    '@media only screen and (max-width:640px){',
    '  .mail-wrapper{padding:12px 8px !important;}',
    '  .mail-hero,.mail-content,.mail-footer{padding:16px !important;}',
    '  .mail-title{font-size:24px !important;line-height:1.15 !important;}',
    '  .mail-entry-label,.mail-entry-value{display:block !important;width:100% !important;text-align:left !important;padding:3px 0 !important;}',
    '  .mail-cta{display:block !important;width:100% !important;box-sizing:border-box !important;text-align:center !important;}',
    '}',
    '.mail-body,.mail-body p,.mail-body li,.mail-body td,.mail-body div,.mail-body span,.mail-body a{font-size:15px;line-height:1.72;color:#0F172A;}',
    '</style>',
    '</head>',
    '<body style="margin:0;padding:0;background:#F8FAFC;color:#0F172A;font-family:Segoe UI,Arial,sans-serif;">',
    hiddenPreheader,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mail-wrapper" style="width:100%;background:#F8FAFC;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" class="mail-card" style="width:100%;max-width:640px;background:#FFFFFF;background-color:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;">',
    '<tr><td class="mail-hero" bgcolor="#1E3A8A" style="background:#1E3A8A;background-color:#1E3A8A;background-image:linear-gradient(90deg,#172554 0%,#1E3A8A 55%,#1E40AF 100%);padding:24px 26px;color:#FFFFFF;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    logoHtml ? `<td valign="middle" style="width:36px;padding:0 8px 0 0;">${logoHtml}</td>` : '',
    `<td valign="middle" style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;">${escapeHtml(brandName)}</td>`,
    `<td valign="middle" align="right">${headerRight}</td>`,
    '</tr></table>',
    `<div class="mail-title" style="margin-top:14px;font-size:28px;line-height:1.22;font-weight:700;">${escapeHtml(eventName)}</div>`,
    buildAccentBar(visual.accentLine),
    contract.scope === 'process' ? processHeaderLine : campaignPreheaderLine,
    '</td></tr>',
    heroImageUrl
      ? `<tr><td style="padding:0;"><img src="${escapeHtml(heroImageUrl)}" alt="Hero" width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;" /></td></tr>`
      : '',
    '<tr><td class="mail-content" style="padding:24px 26px;font-size:15px;line-height:1.72;">',
    entryContextHtml,
    entryContextHtml ? buildSpacer(8) : '',
    sectionsHtml,
    `<div class="mail-body">${input.bodyHtmlRendered}</div>`,
    ctaBlock,
    input.postCtaHtmlRendered ? buildSpacer(20) : '',
    input.postCtaHtmlRendered ? `<div class="mail-body">${input.postCtaHtmlRendered}</div>` : '',
    signoffHtml,
    '</td></tr>',
    `<tr><td class="mail-footer" bgcolor="#F8FAFC" style="border-top:1px solid #E2E8F0;background:#F8FAFC;background-color:#F8FAFC;padding:14px 26px;font-size:12px;line-height:1.5;color:#64748B;">${dateHtml}${contactHtml}${replyHintHtml}${legalLinks}</td></tr>`,
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>'
  ].join('');
};

export type RenderMailContractInput = {
  templateKey: string;
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate?: string | null;
  data: TemplateData;
  renderOptions?: MailRenderOptions;
  hasContentOverride?: boolean;
};

export type RenderMailContractResult = {
  subjectRendered: string;
  bodyTextRendered: string;
  bodyHtmlRendered: string;
  htmlDocument: string;
  usedPlaceholders: string[];
  missingPlaceholders: string[];
  unknownPlaceholders: string[];
  warnings: string[];
};

const hasMultipleEntries = (data: TemplateData): boolean => {
  const entryCount = Number(data.entryCount);
  if (Number.isFinite(entryCount) && entryCount > 1) {
    return true;
  }
  return parseMultiline(data.entrySummaries).length > 1;
};

const localizeMultiEntryCopy = (
  templateKey: string,
  locale: SupportedMailLocale,
  bodyTextTemplate: string,
  preheader: string | undefined
): { bodyTextTemplate: string; preheader?: string } => {
  if (locale === 'de') {
    if (templateKey === 'registration_received') {
      return {
        bodyTextTemplate: bodyTextTemplate
          .replace(
            'Folgende Nennung ist für das {{eventName}} bei uns eingegangen.',
            'Folgende Nennungen sind für das {{eventName}} bei uns eingegangen.'
          )
          .replace('deine Nennung für das {{eventName}} ist bei uns eingegangen.', 'deine Nennungen für das {{eventName}} sind bei uns eingegangen.')
          .replace('deine Nennung', 'deine Nennungen'),
        preheader: preheader?.replace('deine Nennung', 'deine Nennungen')
      };
    }
    if (templateKey === 'email_confirmation_reminder') {
      return {
        bodyTextTemplate: bodyTextTemplate
          .replace(
            'Folgende Nennung für das {{eventName}} ist noch nicht bestätigt.',
            'Folgende Nennungen für das {{eventName}} sind noch nicht bestätigt.'
          )
          .replace('deine Nennung für das {{eventName}} ist noch nicht bestätigt.', 'deine Nennungen für das {{eventName}} sind noch nicht bestätigt.')
          .replace(/deine Nennung/g, 'deine Nennungen'),
        preheader: preheader?.replace('deine Nennung', 'deine Nennungen')
      };
    }
  }
  if (locale === 'en') {
    if (templateKey !== 'registration_received' && templateKey !== 'email_confirmation_reminder') {
      return { bodyTextTemplate, preheader };
    }
    return {
      bodyTextTemplate: bodyTextTemplate.replace(/\byour entry\b/g, 'your entries'),
      preheader
    };
  }
  if (locale === 'cs') {
    if (templateKey !== 'registration_received' && templateKey !== 'email_confirmation_reminder') {
      return { bodyTextTemplate, preheader };
    }
    return {
      bodyTextTemplate: bodyTextTemplate
        .replace(/vaši přihlášku/g, 'vaše přihlášky')
        .replace(/vaše přihláška/g, 'vaše přihlášky'),
      preheader
    };
  }
  if (locale === 'pl') {
    if (templateKey !== 'registration_received' && templateKey !== 'email_confirmation_reminder') {
      return { bodyTextTemplate, preheader };
    }
    return {
      bodyTextTemplate: bodyTextTemplate
        .replace(/Twoje zgłoszenie/g, 'Twoje zgłoszenia')
        .replace(/Twojego zgłoszenia/g, 'Twoich zgłoszeń'),
      preheader
    };
  }
  return { bodyTextTemplate, preheader };
};

export const renderMailContract = (input: RenderMailContractInput): RenderMailContractResult => {
  const warnings: string[] = [];
  const eventName = isPresentValue(input.data.eventName) ? toStringValue(input.data.eventName).trim() : null;
  const locale = resolveMailLocale(input.data);
  const chromeCopy = getMailChromeCopy(locale);
  const localizedProcessCopy =
    input.templateKey === 'registration_received' ||
    input.templateKey === 'email_confirmation_reminder' ||
    input.templateKey === 'accepted_open_payment' ||
    input.templateKey === 'accepted_paid_completed' ||
    input.templateKey === 'payment_reminder' ||
    input.templateKey === 'rejected'
      ? getProcessTemplateCopy(input.templateKey, locale)
      : null;
  const multipleEntries = hasMultipleEntries(input.data);
  const adjustedProcessCopy =
    localizedProcessCopy && multipleEntries
      ? (() => {
          const localized = localizeMultiEntryCopy(
            input.templateKey,
            locale,
            localizedProcessCopy.bodyTextTemplate,
            localizedProcessCopy.preheader
          );
          return {
            ...localizedProcessCopy,
            bodyTextTemplate: localized.bodyTextTemplate,
            preheader: localized.preheader ?? localizedProcessCopy.preheader
          };
        })()
      : localizedProcessCopy;
  const templateData: TemplateData = {
    ...input.data,
    locale,
    fallbackGreeting: isPresentValue(input.data.fallbackGreeting) ? input.data.fallbackGreeting : chromeCopy.fallbackGreeting,
    headerTitle:
      isPresentValue(input.data.headerTitle) ? input.data.headerTitle : adjustedProcessCopy?.headerTitle ?? input.data.headerTitle,
    preheader:
      isPresentValue(input.data.preheader) ? input.data.preheader : adjustedProcessCopy?.preheader ?? input.data.preheader,
    ...(eventName ? { eventNameWithArticle: withDefaultEventArticle(eventName) } : {})
  };
  const required = REQUIRED_PLACEHOLDERS_BY_TEMPLATE[input.templateKey] ?? [];
  const missing = required.filter((name) => !isPresentValue(templateData[name]));

  const subjectTemplate = adjustedProcessCopy?.subjectTemplate ?? input.subjectTemplate;
  const bodyTextTemplate = adjustedProcessCopy?.bodyTextTemplate ?? input.bodyTextTemplate;
  const subject = renderString(subjectTemplate, templateData, false);
  const bodyText = renderString(bodyTextTemplate, templateData, false);
  const htmlTemplateRaw = (input.bodyHtmlTemplate ?? '').trim();
  const htmlTemplateNormalized = normalizeHtmlTemplateSource(htmlTemplateRaw);
  const htmlSource = CANONICAL_LAYOUT_ONLY_TEMPLATES.has(input.templateKey) ? '' : htmlTemplateNormalized;
  if (CANONICAL_LAYOUT_ONLY_TEMPLATES.has(input.templateKey) && htmlTemplateRaw.length > 0) {
    warnings.push('Template-HTML wird für dieses Template ignoriert; Standard-Layout wird erzwungen.');
  }
  let bodyHtmlRendered = htmlSource.length > 0
    ? sanitizeHtmlFragment(renderString(htmlSource, templateData, true).rendered.trim())
    : textToHtml(bodyText.rendered.trim());
  let postCtaHtmlRendered = '';

  const usedSet = new Set<string>([...subject.placeholders, ...bodyText.placeholders]);
  const htmlTemplatePlaceholders = htmlSource.length > 0 ? renderString(htmlSource, templateData, true).placeholders : [];
  htmlTemplatePlaceholders.forEach((item) => usedSet.add(item));

  const structuredSections = buildStructuredSections(templateData, locale);
  const contract = getTemplateContract(input.templateKey);
  const includeEntryContext = input.renderOptions?.includeEntryContext ?? contract.renderOptions.includeEntryContextDefault;
  const entryContextHtml = includeEntryContext
    ? buildEntryContextCard(input.templateKey, templateData, isCompactEntryContextTemplate(input.templateKey), locale)
    : '';

  const verificationUrl = normalizePublicUrl(templateData.verificationUrl);
  let bodyTextRendered = bodyText.rendered.trim();
  let postCtaTextRendered = '';
  const driverNote = isPresentValue(templateData.driverNote) ? toStringValue(templateData.driverNote).trim() : '';

  if (!input.hasContentOverride && input.templateKey === 'free_form') {
    const freeFormBlocks = resolveFreeFormBlocks(templateData);
    bodyTextRendered = freeFormBlocks.bodyBlocks.join('\n\n').trim();
    bodyHtmlRendered = renderTextBlocksToHtml(freeFormBlocks.bodyBlocks);
    postCtaTextRendered = freeFormBlocks.closingText;
    postCtaHtmlRendered = renderTextBlocksToHtml(postCtaTextRendered ? [postCtaTextRendered] : []);
  }

  bodyTextRendered = stripLegacySupportHintsText(bodyTextRendered);
  bodyHtmlRendered = stripLegacySupportHintsHtml(bodyHtmlRendered);
  postCtaTextRendered = stripLegacySupportHintsText(postCtaTextRendered);
  postCtaHtmlRendered = stripLegacySupportHintsHtml(postCtaHtmlRendered);
  if (input.templateKey === 'codriver_info') {
    bodyTextRendered = stripCodriverSupportSentenceText(bodyTextRendered);
    bodyHtmlRendered = stripCodriverSupportSentenceHtml(bodyHtmlRendered);
  }
  bodyHtmlRendered = normalizeInlineTypographyHtml(bodyHtmlRendered);
  postCtaHtmlRendered = normalizeInlineTypographyHtml(postCtaHtmlRendered);
  bodyTextRendered = applyEventArticleHeuristic(bodyTextRendered, eventName);
  bodyHtmlRendered = applyEventArticleHeuristic(bodyHtmlRendered, eventName);
  postCtaTextRendered = applyEventArticleHeuristic(postCtaTextRendered, eventName);
  postCtaHtmlRendered = applyEventArticleHeuristic(postCtaHtmlRendered, eventName);
  bodyTextRendered = normalizeClassPrefixDuplicates(bodyTextRendered);
  bodyHtmlRendered = normalizeClassPrefixDuplicates(bodyHtmlRendered);
  postCtaTextRendered = normalizeClassPrefixDuplicates(postCtaTextRendered);
  postCtaHtmlRendered = normalizeClassPrefixDuplicates(postCtaHtmlRendered);
  if (shouldInjectDriverNote(input.templateKey, driverNote)) {
    bodyTextRendered = appendDriverNoteText(bodyTextRendered, driverNote, chromeCopy.organizerNoteTitle);
    bodyHtmlRendered = appendDriverNoteHtml(bodyHtmlRendered, driverNote, chromeCopy.organizerNoteTitle);
  }

  const campaignCtaUrl = isCampaignTemplate(input.templateKey) ? normalizePublicUrl(templateData.ctaUrl) : null;
  const campaignCtaText = isPresentValue(templateData.ctaText) ? toStringValue(templateData.ctaText).trim() : '';
  if (isCampaignTemplate(input.templateKey) && campaignCtaUrl) {
    const ctaTextForPlain = campaignCtaText || (locale === 'de' ? 'Mehr erfahren' : 'Learn more');
    bodyTextRendered = `${bodyTextRendered}\n\n${ctaTextForPlain}: ${campaignCtaUrl}`.trim();
  }
  if (postCtaTextRendered) {
    bodyTextRendered = `${bodyTextRendered}\n\n${postCtaTextRendered}`.trim();
  }

  if (
    input.templateKey === 'registration_received' ||
    input.templateKey === 'email_confirmation' ||
    input.templateKey === 'email_confirmation_reminder'
  ) {
    if (!verificationUrl) {
      warnings.push('verificationUrl fehlt; CTA und Verifizierungslink können nicht gerendert werden.');
    } else if (!bodyTextRendered.includes(verificationUrl)) {
      bodyTextRendered = `${bodyTextRendered}\n\nVerifizierung: ${verificationUrl}`.trim();
    }
  }

  const includeStandardSignoff = !hasStandardSignoff(bodyTextRendered);
  if (includeStandardSignoff) {
    bodyTextRendered = `${bodyTextRendered}\n\n${chromeCopy.signoffLead}\n\n${[
      chromeCopy.signoffLine1,
      chromeCopy.signoffLine2,
      chromeCopy.signoffLine3
    ].join('\n')}`.trim();
  }
  bodyTextRendered = `${bodyTextRendered}\n\n${chromeCopy.replyHint}`.trim();

  const logoWarning = resolveLogoUrl(templateData).warning;
  if (logoWarning) {
    warnings.push(logoWarning);
  }

  if (!subject.rendered.trim() || !bodyTextRendered) {
    warnings.push('Gerenderter Betreff oder Text ist leer.');
  }

  const usedPlaceholders = Array.from(usedSet.values()).sort((a, b) => a.localeCompare(b));
  const unknownPlaceholders = usedPlaceholders.filter((item) => !KNOWN_PLACEHOLDER_NAMES.has(item));
  const htmlDocument = buildHtmlDocument({
    templateKey: input.templateKey,
    subjectRendered: subject.rendered.trim(),
    bodyHtmlRendered,
    postCtaHtmlRendered,
    structuredSectionsHtml: structuredSections.html,
    entryContextHtml,
    verificationUrl,
    data: templateData,
    renderOptions: input.renderOptions,
    hasContentOverride: input.hasContentOverride ?? false,
    includeStandardSignoff,
    locale
  });

  return {
    subjectRendered: subject.rendered.trim(),
    bodyTextRendered,
    bodyHtmlRendered,
    htmlDocument,
    usedPlaceholders,
    missingPlaceholders: missing,
    unknownPlaceholders,
    warnings
  };
};
