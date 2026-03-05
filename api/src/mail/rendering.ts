import { KNOWN_PLACEHOLDER_NAMES, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';

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

const sanitizeHtmlFragment = (value: string): string =>
  value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\shref\s*=\s*(['"])\s*javascript:[^'"]*\1/gi, ' href="#"');

const textToHtml = (text: string): string =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) => `<p style="margin:0 0 16px 0;color:#0f172a;font-size:15px;line-height:1.6;">${escapeHtml(block).replace(/\r?\n/g, '<br />')}</p>`)
    .join('');

const buildInfoBoxes = (data: TemplateData): string => {
  const rows: Array<{ label: string; value: string }> = [];
  if (isPresentValue(data.className)) {
    rows.push({ label: 'Klasse', value: toStringValue(data.className) });
  }
  if (isPresentValue(data.startNumber)) {
    rows.push({ label: 'Startnummer', value: toStringValue(data.startNumber) });
  }
  if (isPresentValue(data.amountOpen)) {
    rows.push({ label: 'Offener Betrag', value: toStringValue(data.amountOpen) });
  }
  if (rows.length === 0) {
    return '';
  }

  const items = rows
    .map(
      (row) =>
        `<tr><td style="padding:8px 0;color:#475569;font-size:13px;line-height:1.4;">${escapeHtml(row.label)}</td><td style="padding:8px 0;color:#0f172a;font-size:14px;font-weight:600;line-height:1.4;text-align:right;">${escapeHtml(row.value)}</td></tr>`
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;padding:0 16px;margin:0 0 20px 0;"><tbody>${items}</tbody></table>`;
};

const TEMPLATE_PRESENTATION: Record<string, { mailLabel: string; heroSubtitle: string }> = {
  registration_received: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Bitte bestaetige deine E-Mail-Adresse, um die Anmeldung abzuschliessen.'
  },
  accepted_open_payment: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Dein Startplatz ist bestaetigt.'
  },
  payment_reminder: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Offener Betrag fuer deine Nennung.'
  },
  rejected: {
    mailLabel: 'Prozessmail',
    heroSubtitle: 'Update zu deiner Anmeldung.'
  },
  newsletter: {
    mailLabel: 'Kampagne',
    heroSubtitle: 'Neuigkeiten rund um das Event.'
  },
  event_update: {
    mailLabel: 'Kampagne',
    heroSubtitle: 'Wichtige organisatorische Infos.'
  },
  free_form: {
    mailLabel: 'Kampagne',
    heroSubtitle: 'Mitteilung vom Orga-Team.'
  }
};

const buildHtmlDocument = (input: {
  templateKey: string;
  subjectRendered: string;
  bodyHtmlRendered: string;
  verificationUrl: string | null;
  data: TemplateData;
}): string => {
  const eventName = isPresentValue(input.data.eventName)
    ? toStringValue(input.data.eventName)
    : (process.env.MAIL_BRAND_EVENT_NAME ?? 'MSC Event');
  const templatePresentation = TEMPLATE_PRESENTATION[input.templateKey] ?? {
    mailLabel: 'Mitteilung',
    heroSubtitle: 'Information vom Veranstalter.'
  };
  const mailLabel = isPresentValue(input.data.mailLabel) ? toStringValue(input.data.mailLabel) : templatePresentation.mailLabel;
  const heroSubtitle = isPresentValue(input.data.heroSubtitle)
    ? toStringValue(input.data.heroSubtitle)
    : templatePresentation.heroSubtitle;
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
  const contactHtml = contactEmail
    ? `<div style="margin-top:6px;">Kontakt: <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></div>`
    : '';
  const legalLinks = impressumUrl && datenschutzUrl
    ? `<div style="margin-top:8px;"><a href="${escapeHtml(impressumUrl)}" target="_blank" rel="noopener noreferrer">Impressum</a> · <a href="${escapeHtml(datenschutzUrl)}" target="_blank" rel="noopener noreferrer">Datenschutz</a></div>`
    : '';
  const dateHtml = eventDateText ? `<div>${escapeHtml(eventName)} · ${escapeHtml(eventDateText)}</div>` : `<div>${escapeHtml(eventName)}</div>`;
  const ctaBlock = input.templateKey === 'registration_received' && input.verificationUrl
    ? `<p style="margin-top:18px;"><a class="btn" href="${escapeHtml(input.verificationUrl)}" target="_blank" rel="noopener noreferrer">Anmeldung bestaetigen</a></p><p class="muted">Falls der Button nicht funktioniert: ${escapeHtml(input.verificationUrl)}</p>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.subjectRendered)}</title>`,
    '<style>:root{color-scheme:light;}body{margin:0;padding:0;background:#F9FAFB;color:#0F1729;font-family:"IBM Plex Sans","Segoe UI",Arial,sans-serif;}table{border-collapse:separate;} .wrapper{width:100%;background:#F9FAFB;padding:24px 12px;} .container{max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #DDE4EE;border-radius:12px;overflow:hidden;} .hero{background:#254CA2;color:#FFFFFF;padding:20px 24px;} .badge{display:inline-block;background:#F4C406;color:#0F1729;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:8px;} .title{margin:14px 0 0;font-family:"Barlow Condensed","IBM Plex Sans","Segoe UI",Arial,sans-serif;font-size:34px;line-height:1.1;font-weight:600;} .subtitle{margin:8px 0 0;color:rgba(255,255,255,.9);font-size:15px;line-height:1.5;} .content{padding:24px;} .content p{margin:0 0 14px;font-size:15px;line-height:1.6;color:#0F1729;} .btn{display:inline-block;background:#F4C406;color:#0F1729 !important;text-decoration:none;font-weight:700;font-size:14px;line-height:1;padding:12px 16px;border-radius:10px;} .muted{color:#637288;font-size:13px;} .footer{border-top:1px solid #DDE4EE;padding:16px 24px 20px;color:#637288;font-size:12px;line-height:1.5;} .footer a{color:#254CA2;text-decoration:underline;} @media only screen and (max-width:600px){ .wrapper{padding:16px 8px;} .hero,.content,.footer{padding:16px;} .title{font-size:28px;} .content p{font-size:16px;} }</style>',
    '</head>',
    '<body>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wrapper">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="container">',
    `<tr><td class="hero"><span class="badge">${escapeHtml(mailLabel)}</span><h1 class="title">${escapeHtml(eventName)}</h1><p class="subtitle">${escapeHtml(heroSubtitle)}</p></td></tr>`,
    `<tr><td class="content">${buildInfoBoxes(input.data)}${input.bodyHtmlRendered}${ctaBlock}</td></tr>`,
    `<tr><td class="footer">${dateHtml}${contactHtml}${legalLinks}</td></tr>`,
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

  const verificationUrl = normalizePublicUrl(input.data.verificationUrl);
  let bodyTextRendered = bodyText.rendered.trim();
  if (input.templateKey === 'registration_received') {
    if (!verificationUrl) {
      warnings.push('verificationUrl fehlt; CTA und Verifizierungslink koennen nicht gerendert werden.');
    } else if (!bodyTextRendered.includes(verificationUrl)) {
      bodyTextRendered = `${bodyTextRendered}\n\nVerifizierung: ${verificationUrl}`.trim();
    }
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
    verificationUrl,
    data: input.data
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
