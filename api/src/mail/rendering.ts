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

const buildHtmlDocument = (input: {
  subjectRendered: string;
  bodyHtmlRendered: string;
  verificationUrl: string | null;
  data: TemplateData;
}): string => {
  const eventName = isPresentValue(input.data.eventName)
    ? toStringValue(input.data.eventName)
    : (process.env.MAIL_BRAND_EVENT_NAME ?? 'MSC Event');
  const logoText = process.env.MAIL_BRAND_LOGO_TEXT ?? eventName;
  const contactHint = process.env.MAIL_CONTACT_HINT ?? 'Bei Rueckfragen bitte auf diese E-Mail antworten.';
  const imprintHint = process.env.MAIL_IMPRINT_HINT ?? 'Impressum und Datenschutz finden Sie auf der offiziellen Event-Webseite.';
  const ctaBlock = input.verificationUrl
    ? `<tr><td style="padding:0 32px 28px 32px;"><a href="${escapeHtml(input.verificationUrl)}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">E-Mail bestaetigen</a></td></tr>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.subjectRendered)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background:#f1f5f9;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">',
    `<tr><td style="padding:22px 28px;background:#f8fafc;border-bottom:1px solid #e2e8f0;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#334155;font-weight:600;">${escapeHtml(logoText)}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#64748b;margin-top:4px;">${escapeHtml(eventName)}</div></td></tr>`,
    `<tr><td style="padding:28px 32px 8px 32px;font-family:Segoe UI,Arial,sans-serif;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;">${escapeHtml(input.subjectRendered)}</td></tr>`,
    `<tr><td style="padding:0 32px 0 32px;font-family:Segoe UI,Arial,sans-serif;">${buildInfoBoxes(input.data)}${input.bodyHtmlRendered}</td></tr>`,
    ctaBlock,
    `<tr><td style="padding:20px 32px 24px 32px;border-top:1px solid #e2e8f0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;"><div style="font-size:12px;line-height:1.5;color:#64748b;">${escapeHtml(contactHint)}</div><div style="font-size:12px;line-height:1.5;color:#94a3b8;margin-top:6px;">${escapeHtml(imprintHint)}</div></td></tr>`,
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
