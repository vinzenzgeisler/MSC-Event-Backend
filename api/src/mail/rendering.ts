import { KNOWN_PLACEHOLDER_NAMES, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';
import { getTemplateContract, MailRenderOptions } from './templateContracts';

type TemplateData = Record<string, unknown>;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

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

const buildEntryContextCard = (data: TemplateData, compact: boolean): string => {
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
        `<tr><td style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '12px' : '13px'};line-height:1.4;color:#475569;">${escapeHtml(row.label)}</td><td style="padding:${compact ? '5px 0' : '7px 0'};font-size:${compact ? '12px' : '13px'};line-height:1.4;color:#0F1729;font-weight:600;text-align:right;">${escapeHtml(row.value)}</td></tr>`
    )
    .join('');

  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;border:1px solid #DDE4EE;border-left:4px solid #F4C406;border-radius:10px;background:#FFFFFF;">',
    `<tr><td style="padding:${compact ? '10px 12px' : '12px 14px'};">`,
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
    `<div style="color:#0F1729;font-size:14px;line-height:1.55;">${bodyHtml}</div>`,
    '</td></tr>',
    '</table>'
  ].join('');

const buildStructuredSections = (data: TemplateData): { html: string; text: string } => {
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
    htmlParts.push(buildSectionCard('Highlights', listHtml));
    textParts.push(`Highlights:\n${highlightLines.map((line) => `- ${line}`).join('\n')}`);
  }

  const detailsChunks = [introText, detailsText].filter((chunk) => chunk.length > 0);
  if (detailsChunks.length > 0) {
    htmlParts.push(buildSectionCard('Details', detailsChunks.map((chunk) => escapeHtml(chunk).replace(/\r?\n/g, '<br />')).join('<br /><br />')));
    textParts.push(`Details:\n${detailsChunks.join('\n\n')}`);
  }

  const nextStepsLines: string[] = [];
  if (paymentDeadline) {
    nextStepsLines.push(`Zahlungsfrist: ${paymentDeadline}`);
  }
  if (closingText) {
    nextStepsLines.push(closingText);
  }
  if (nextStepsLines.length > 0) {
    htmlParts.push(buildSectionCard('Nächste Schritte', nextStepsLines.map((line) => escapeHtml(line).replace(/\r?\n/g, '<br />')).join('<br />')));
    textParts.push(`Nächste Schritte:\n${nextStepsLines.join('\n')}`);
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
  accepted_open_payment: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Startplatz fixiert. Jetzt fehlt nur noch der Zahlungsschritt.'
  },
  payment_reminder: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Deine Nennung ist fast komplett.'
  },
  rejected: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Statusupdate zu deiner Anmeldung.'
  },
  newsletter: {
    mailLabel: '',
    heroSubtitle: 'Frische News. Klare Kante. Volle Vorfreude aufs Event.'
  },
  event_update: {
    mailLabel: '',
    heroSubtitle: 'Wichtige Updates für deinen Renntag.'
  },
  free_form: {
    mailLabel: '',
    heroSubtitle: 'Kurze Mitteilung vom Orga-Team.'
  },
  payment_reminder_followup: {
    mailLabel: '',
    heroSubtitle: 'Letzte Runde vor dem Start: Bitte Zahlung abschließen.'
  },
  email_confirmation: {
    mailLabel: '',
    heroSubtitle: 'Ein Klick trennt dich noch vom finalen Go.'
  },
  codriver_info: {
    mailLabel: '',
    heroSubtitle: 'Du wurdest als Beifahrer eingetragen.'
  }
};

const isCampaignTemplate = (templateKey: string): boolean =>
  templateKey === 'newsletter' ||
  templateKey === 'event_update' ||
  templateKey === 'free_form' ||
  templateKey === 'payment_reminder_followup' ||
  templateKey === 'email_confirmation';

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
}): string => {
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

  const heroEyebrow = isPresentValue(input.data.heroEyebrow) ? toStringValue(input.data.heroEyebrow) : '';
  const heroSubtitle = isPresentValue(input.data.heroSubtitle)
    ? toStringValue(input.data.heroSubtitle)
    : templatePresentation.heroSubtitle;
  const heroImageUrl = normalizeHttpsUrl(input.data.heroImageUrl);

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
    ? `<div style="margin-top:6px;">Kontakt: <a href="mailto:${escapeHtml(contactEmail)}" style="color:#254CA2;text-decoration:underline;">${escapeHtml(contactEmail)}</a></div>`
    : '';
  const legalLinks = impressumUrl && datenschutzUrl
    ? `<div style="margin-top:8px;"><a href="${escapeHtml(impressumUrl)}" target="_blank" rel="noopener noreferrer" style="color:#254CA2;text-decoration:underline;">Impressum</a> · <a href="${escapeHtml(datenschutzUrl)}" target="_blank" rel="noopener noreferrer" style="color:#254CA2;text-decoration:underline;">Datenschutz</a></div>`
    : '';
  const dateHtml = eventDateText ? `<div>${escapeHtml(eventName)} · ${escapeHtml(eventDateText)}</div>` : `<div>${escapeHtml(eventName)}</div>`;

  const campaignCtaUrl = normalizePublicUrl(input.data.ctaUrl);
  const campaignCtaText = isPresentValue(input.data.ctaText) ? toStringValue(input.data.ctaText) : 'Mehr erfahren';
  const verificationCtaLabel = input.templateKey === 'email_confirmation' ? 'E-Mail bestätigen' : 'Anmeldung bestätigen';
  const ctaBlock =
    (input.templateKey === 'registration_received' || input.templateKey === 'email_confirmation') && input.verificationUrl
      ? `<p style="margin:18px 0 0 0;"><a href="${escapeHtml(input.verificationUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#254CA2;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;line-height:1;padding:12px 18px;border-radius:10px;">${verificationCtaLabel}</a></p><p style="margin:8px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">Falls der Button nicht funktioniert: ${escapeHtml(input.verificationUrl)}</p>`
      : isCampaignTemplate(input.templateKey) && campaignCtaUrl
        ? `<p style="margin:18px 0 0 0;"><a href="${escapeHtml(campaignCtaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#254CA2;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;line-height:1;padding:12px 18px;border-radius:10px;">${escapeHtml(campaignCtaText)}</a></p><p style="margin:8px 0 0 0;color:#64748B;font-size:12px;line-height:1.5;">Falls der Button nicht funktioniert: ${escapeHtml(campaignCtaUrl)}</p>`
        : '';

  const sectionsHtml = !input.hasContentOverride && isCampaignTemplate(input.templateKey) ? input.structuredSectionsHtml : '';
  const entryContextHtml = includeEntryContext ? input.entryContextHtml : '';

  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" width="124" style="display:block;width:124px;max-width:124px;height:auto;border:0;outline:none;text-decoration:none;" />`
    : '';
  const badgeHtml = showBadge && mailLabel
    ? `<div style="display:inline-block;background:#F4C406;color:#0F1729;padding:4px 10px;border-radius:8px;font-size:11px;font-weight:700;line-height:1;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(mailLabel)}</div>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.subjectRendered)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background:#F3F5F8;color:#0F1729;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#F3F5F8;padding:22px 10px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #DDE4EE;border-radius:12px;">',
    '<tr>',
    '<td style="padding:16px 18px 10px 18px;border-bottom:1px solid #DDE4EE;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">',
    '<tr>',
    `<td valign="middle" align="left">${logoHtml}</td>`,
    `<td valign="middle" align="right">${badgeHtml}</td>`,
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:16px 18px 14px 18px;background:#254CA2;color:#FFFFFF;">',
    heroEyebrow
      ? `<div style="margin:0 0 6px 0;font-size:11px;line-height:1.2;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#F4C406;">${escapeHtml(heroEyebrow)}</div>`
      : '',
    `<div style="margin:0;font-size:30px;line-height:1.1;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;">${escapeHtml(eventName)}</div>`,
    `<div style="margin:8px 0 0 0;font-size:14px;line-height:1.5;color:#DCE7FF;">${escapeHtml(heroSubtitle)}</div>`,
    '</td>',
    '</tr>',
    heroImageUrl
      ? `<tr><td style="padding:0;"><img src="${escapeHtml(heroImageUrl)}" alt="Hero" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;" /></td></tr>`
      : '',
    '<tr><td style="padding:18px;">',
    entryContextHtml,
    sectionsHtml,
    input.bodyHtmlRendered,
    ctaBlock,
    '</td></tr>',
    `<tr><td style="padding:14px 18px 18px 18px;border-top:1px solid #DDE4EE;background:#FFFFFF;color:#64748B;font-size:12px;line-height:1.5;">${dateHtml}${contactHtml}${legalLinks}</td></tr>`,
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
  const required = REQUIRED_PLACEHOLDERS_BY_TEMPLATE[input.templateKey] ?? [];
  const missing = required.filter((name) => !isPresentValue(input.data[name]));

  const subject = renderString(input.subjectTemplate, input.data, false);
  const bodyText = renderString(input.bodyTextTemplate, input.data, false);
  const htmlSource = (input.bodyHtmlTemplate ?? '').trim();
  const bodyHtmlRendered = htmlSource.length > 0
    ? sanitizeHtmlFragment(renderString(htmlSource, input.data, true).rendered.trim())
    : textToHtml(bodyText.rendered.trim());

  const usedSet = new Set<string>([...subject.placeholders, ...bodyText.placeholders]);
  const htmlTemplatePlaceholders = htmlSource.length > 0 ? renderString(htmlSource, input.data, true).placeholders : [];
  htmlTemplatePlaceholders.forEach((item) => usedSet.add(item));

  const structuredSections = buildStructuredSections(input.data);
  const contract = getTemplateContract(input.templateKey);
  const includeEntryContext = input.renderOptions?.includeEntryContext ?? contract.renderOptions.includeEntryContextDefault;
  const entryContextHtml = includeEntryContext ? buildEntryContextCard(input.data, isCompactEntryContextTemplate(input.templateKey)) : '';

  const verificationUrl = normalizePublicUrl(input.data.verificationUrl);
  let bodyTextRendered = bodyText.rendered.trim();

  if (!input.hasContentOverride && isCampaignTemplate(input.templateKey) && structuredSections.text.length > 0) {
    bodyTextRendered = `${bodyTextRendered}\n\n${structuredSections.text}`.trim();
  }

  if (input.templateKey === 'registration_received' || input.templateKey === 'email_confirmation') {
    if (!verificationUrl) {
      warnings.push('verificationUrl fehlt; CTA und Verifizierungslink können nicht gerendert werden.');
    } else if (!bodyTextRendered.includes(verificationUrl)) {
      bodyTextRendered = `${bodyTextRendered}\n\nVerifizierung: ${verificationUrl}`.trim();
    }
  }

  const logoWarning = resolveLogoUrl(input.data).warning;
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
    data: input.data,
    renderOptions: input.renderOptions,
    hasContentOverride: input.hasContentOverride ?? false
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
