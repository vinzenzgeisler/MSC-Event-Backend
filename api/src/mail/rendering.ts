import { KNOWN_PLACEHOLDER_NAMES, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';
import { getTemplateContract, MailRenderOptions } from './templateContracts';
import { getMailChromeCopy, resolveMailLocale, SupportedMailLocale } from './i18n';

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
  const noteHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0 0;border:1px solid #DDE4EE;border-radius:10px;background:#F8FAFC;"><tr><td style="padding:12px 14px;"><div style="margin:0 0 6px 0;color:#254CA2;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(noteTitle)}</div><div style="color:#0F1729;font-size:15px;line-height:1.55;">${escapeHtml(driverNote).replace(/\r?\n/g, '<br />')}</div></td></tr></table>`;
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

const resolveVehicleLabel = (data: TemplateData): string => {
  if (isPresentValue(data.vehicleLabel)) {
    return toStringValue(data.vehicleLabel);
  }
  const parts: string[] = [];
  if (isPresentValue(data.vehicleType)) {
    parts.push(toStringValue(data.vehicleType));
  }
  if (isPresentValue(data.vehicleMake)) {
    parts.push(toStringValue(data.vehicleMake));
  }
  if (isPresentValue(data.vehicleModel)) {
    parts.push(toStringValue(data.vehicleModel));
  }
  return parts.join(' · ');
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
  const visual = getTemplateVisualConfig(templateKey);
  const rows: Array<{ label: string; value: string }> = [];
  if (isPresentValue(data.className)) {
    rows.push({ label: 'Klasse', value: toStringValue(data.className) });
  }
  if (isPresentValue(data.startNumber)) {
    rows.push({ label: 'Startnummer', value: toStringValue(data.startNumber) });
  }
  const vehicleLabel = resolveVehicleLabel(data);
  if (vehicleLabel) {
    rows.push({ label: 'Fahrzeug', value: vehicleLabel });
  }
  if (isPresentValue(data.amountOpen)) {
    rows.push({ label: 'Nenngeld offen', value: toStringValue(data.amountOpen) });
  }
  if (rows.length === 0) {
    return '';
  }

  const rowHtml = rows
    .map(
      (row) =>
        `<tr><td class="mail-entry-label" style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '13px' : '14px'};line-height:1.4;color:#475569;">${escapeHtml(row.label)}</td><td class="mail-entry-value" style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '13px' : '14px'};line-height:1.4;color:#0F1729;font-weight:600;text-align:right;">${escapeHtml(row.value)}</td></tr>`
    )
    .join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mail-entry" style="margin:0 0 14px 0;border:1px solid ${visual.entryBorder};border-radius:10px;background:${visual.entryBackground};">`,
    `<tr><td style="padding:${compact ? '10px 12px' : '12px 14px'};">`,
    `<div style="margin:0 0 8px 0;color:${visual.entryLabelColor};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(copy.entryContextTitle)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${rowHtml}</tbody></table>`,
    '</td></tr>',
    '</table>'
  ].join('');
};

const buildSectionCard = (title: string, bodyHtml: string): string =>
  [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;border:1px solid #DDE4EE;border-radius:10px;background:#FFFFFF;">',
    '<tr><td style="padding:12px 14px;">',
    `<div style="margin:0 0 8px 0;color:#254CA2;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(title)}</div>`,
    `<div style="color:#0F1729;font-size:15px;line-height:1.55;">${bodyHtml}</div>`,
    '</td></tr>',
    '</table>'
  ].join('');

const buildStructuredSections = (data: TemplateData, locale: SupportedMailLocale): { html: string; text: string } => {
  const copy = getMailChromeCopy(locale);
  const introText = isPresentValue(data.introText) ? toStringValue(data.introText).trim() : '';
  const detailsText = isPresentValue(data.detailsText) ? toStringValue(data.detailsText).trim() : '';
  const closingText = isPresentValue(data.closingText) ? toStringValue(data.closingText).trim() : '';
  const highlightLines = parseMultiline(data.highlights);
  const paymentDeadline = isPresentValue(data.paymentDeadline) ? toStringValue(data.paymentDeadline).trim() : '';

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (highlightLines.length > 0) {
    const listHtml = `<ul style="margin:0;padding-left:18px;">${highlightLines
      .map((line) => `<li style="margin:0 0 6px 0;">${escapeHtml(line)}</li>`)
      .join('')}</ul>`;
    htmlParts.push(buildSectionCard(copy.highlightsTitle, listHtml));
    textParts.push(`${copy.highlightsTitle}:\n${highlightLines.map((line) => `- ${line}`).join('\n')}`);
  }

  const detailsChunks = [introText, detailsText].filter((chunk) => chunk.length > 0);
  if (detailsChunks.length > 0) {
    htmlParts.push(buildSectionCard(copy.detailsTitle, detailsChunks.map((chunk) => escapeHtml(chunk).replace(/\r?\n/g, '<br />')).join('<br /><br />')));
    textParts.push(`${copy.detailsTitle}:\n${detailsChunks.join('\n\n')}`);
  }

  const nextStepsLines: string[] = [];
  if (paymentDeadline) {
    nextStepsLines.push(`Zahlungsfrist: ${paymentDeadline}`);
  }
  if (closingText) {
    nextStepsLines.push(closingText);
  }
  if (nextStepsLines.length > 0) {
    htmlParts.push(buildSectionCard(copy.nextStepsTitle, nextStepsLines.map((line) => escapeHtml(line).replace(/\r?\n/g, '<br />')).join('<br />')));
    textParts.push(`${copy.nextStepsTitle}:\n${nextStepsLines.join('\n')}`);
  }

  return {
    html: htmlParts.join(''),
    text: textParts.join('\n\n').trim()
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
  const brandName = ensureClubSuffix((process.env.MAIL_BRAND_NAME ?? 'MSC Oberlausitzer Dreiländereck').trim());

  const eventDateText = isPresentValue(input.data.eventDateText)
    ? toStringValue(input.data.eventDateText)
    : (process.env.MAIL_EVENT_DATE_TEXT ?? '');
  const contactEmail = isPresentValue(input.data.contactEmail)
    ? toStringValue(input.data.contactEmail)
    : (process.env.MAIL_CONTACT_EMAIL ?? '');
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
      ? `<p style="margin:18px 0 0 0;"><a class="mail-cta" href="${escapeHtml(input.verificationUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#FACC15;color:#0F172A;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:700;">${verificationCtaLabel}</a></p><p style="margin:10px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">${escapeHtml(copy.ctaFallbackPrefix)} <a href="${escapeHtml(input.verificationUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;">${escapeHtml(input.verificationUrl)}</a></p>`
      : isCampaignTemplate(input.templateKey) && campaignCtaUrl
        ? `<p style="margin:18px 0 0 0;"><a class="mail-cta" href="${escapeHtml(campaignCtaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#FACC15;color:#0F172A;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:700;">${escapeHtml(campaignCtaText)}</a></p><p style="margin:10px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">${escapeHtml(copy.ctaFallbackPrefix)} <a href="${escapeHtml(campaignCtaUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;">${escapeHtml(campaignCtaUrl)}</a></p>`
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
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" class="mail-card" style="width:100%;max-width:640px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;">',
    '<tr><td class="mail-hero" style="background:linear-gradient(90deg,#172554 0%,#1E3A8A 55%,#1E40AF 100%);padding:24px 26px;color:#FFFFFF;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    logoHtml ? `<td valign="middle" style="width:36px;padding:0 8px 0 0;">${logoHtml}</td>` : '',
    `<td valign="middle" style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;">${escapeHtml(brandName)}</td>`,
    `<td valign="middle" align="right">${headerRight}</td>`,
    '</tr></table>',
    `<div class="mail-title" style="margin-top:14px;font-size:28px;line-height:1.22;font-weight:700;">${escapeHtml(eventName)}</div>`,
    `<div style="margin-top:12px;height:4px;width:86px;background:${visual.accentLine};border-radius:999px;"></div>`,
    contract.scope === 'process' ? processHeaderLine : campaignPreheaderLine,
    '</td></tr>',
    heroImageUrl
      ? `<tr><td style="padding:0;"><img src="${escapeHtml(heroImageUrl)}" alt="Hero" width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;" /></td></tr>`
      : '',
    '<tr><td class="mail-content" style="padding:24px 26px;font-size:15px;line-height:1.72;">',
    entryContextHtml,
    sectionsHtml,
    `<div class="mail-body">${input.bodyHtmlRendered}</div>`,
    ctaBlock,
    signoffHtml,
    '</td></tr>',
    `<tr><td class="mail-footer" style="border-top:1px solid #E2E8F0;background:#F8FAFC;padding:14px 26px;font-size:12px;line-height:1.5;color:#64748B;">${dateHtml}${contactHtml}${replyHintHtml}${legalLinks}</td></tr>`,
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

export const renderMailContract = (input: RenderMailContractInput): RenderMailContractResult => {
  const warnings: string[] = [];
  const eventName = isPresentValue(input.data.eventName) ? toStringValue(input.data.eventName).trim() : null;
  const locale = resolveMailLocale(input.data);
  const chromeCopy = getMailChromeCopy(locale);
  const templateData: TemplateData = {
    ...input.data,
    locale,
    fallbackGreeting: isPresentValue(input.data.fallbackGreeting) ? input.data.fallbackGreeting : chromeCopy.fallbackGreeting,
    ...(eventName ? { eventNameWithArticle: withDefaultEventArticle(eventName) } : {})
  };
  const required = REQUIRED_PLACEHOLDERS_BY_TEMPLATE[input.templateKey] ?? [];
  const missing = required.filter((name) => !isPresentValue(templateData[name]));

  const subject = renderString(input.subjectTemplate, templateData, false);
  const bodyText = renderString(input.bodyTextTemplate, templateData, false);
  const htmlTemplateRaw = (input.bodyHtmlTemplate ?? '').trim();
  const htmlTemplateNormalized = normalizeHtmlTemplateSource(htmlTemplateRaw);
  const htmlSource = CANONICAL_LAYOUT_ONLY_TEMPLATES.has(input.templateKey) ? '' : htmlTemplateNormalized;
  if (CANONICAL_LAYOUT_ONLY_TEMPLATES.has(input.templateKey) && htmlTemplateRaw.length > 0) {
    warnings.push('Template-HTML wird für dieses Template ignoriert; Standard-Layout wird erzwungen.');
  }
  let bodyHtmlRendered = htmlSource.length > 0
    ? sanitizeHtmlFragment(renderString(htmlSource, templateData, true).rendered.trim())
    : textToHtml(bodyText.rendered.trim());

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
  const driverNote = isPresentValue(templateData.driverNote) ? toStringValue(templateData.driverNote).trim() : '';

  if (!input.hasContentOverride && isCampaignTemplate(input.templateKey) && structuredSections.text.length > 0) {
    bodyTextRendered = `${bodyTextRendered}\n\n${structuredSections.text}`.trim();
  }

  bodyTextRendered = stripLegacySupportHintsText(bodyTextRendered);
  bodyHtmlRendered = stripLegacySupportHintsHtml(bodyHtmlRendered);
  if (input.templateKey === 'codriver_info') {
    bodyTextRendered = stripCodriverSupportSentenceText(bodyTextRendered);
    bodyHtmlRendered = stripCodriverSupportSentenceHtml(bodyHtmlRendered);
  }
  bodyHtmlRendered = normalizeInlineTypographyHtml(bodyHtmlRendered);
  bodyTextRendered = applyEventArticleHeuristic(bodyTextRendered, eventName);
  bodyHtmlRendered = applyEventArticleHeuristic(bodyHtmlRendered, eventName);
  bodyTextRendered = normalizeClassPrefixDuplicates(bodyTextRendered);
  bodyHtmlRendered = normalizeClassPrefixDuplicates(bodyHtmlRendered);
  if (shouldInjectDriverNote(input.templateKey, driverNote)) {
    bodyTextRendered = appendDriverNoteText(bodyTextRendered, driverNote, chromeCopy.organizerNoteTitle);
    bodyHtmlRendered = appendDriverNoteHtml(bodyHtmlRendered, driverNote, chromeCopy.organizerNoteTitle);
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
