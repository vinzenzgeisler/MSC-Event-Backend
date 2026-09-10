export type OperationalNoticeTone = 'success' | 'danger' | 'info' | 'warning';

type OperationalNoticeField = {
  label: string;
  value: string;
};

const TONE_STYLES: Record<OperationalNoticeTone, { color: string; background: string; border: string }> = {
  success: { color: '#166534', background: '#F0FDF4', border: '#86EFAC' },
  danger: { color: '#991B1B', background: '#FEF2F2', border: '#FCA5A5' },
  info: { color: '#075985', background: '#F0F9FF', border: '#7DD3FC' },
  warning: { color: '#92400E', background: '#FFFBEB', border: '#FCD34D' }
};

export const escapeOperationalMailHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const multilineHtml = (value: string): string => escapeOperationalMailHtml(value).replace(/\r?\n/g, '<br>');

const detailRow = ({ label, value }: OperationalNoticeField): string =>
  `<tr><td style="padding:7px 12px 7px 0;color:#64748B;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;vertical-align:top;white-space:nowrap;">${escapeOperationalMailHtml(label)}</td><td style="padding:7px 0;color:#0F172A;font-size:14px;font-weight:600;vertical-align:top;">${multilineHtml(value)}</td></tr>`;

export const buildOperationalNoticeHtml = (input: {
  intro: string;
  statusLabel: string;
  tone: OperationalNoticeTone;
  fields: OperationalNoticeField[];
  noteTitle?: string;
  note?: string | null;
  footer?: string;
}): string => {
  const style = TONE_STYLES[input.tone];
  const noteHtml = input.note
    ? `<div style="margin-top:18px;padding:14px 16px;background:#F8FAFC;border-left:4px solid #64748B;border-radius:6px;"><div style="color:#475569;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">${escapeOperationalMailHtml(input.noteTitle ?? 'Hinweis')}</div><div style="margin-top:6px;color:#0F172A;font-size:14px;line-height:1.6;">${multilineHtml(input.note)}</div></div>`
    : '';
  const footerHtml = input.footer
    ? `<p style="margin-top:18px;color:#64748B;font-size:12px;">${escapeOperationalMailHtml(input.footer)}</p>`
    : '';

  return [
    `<p style="margin:0 0 16px 0;color:#475569;">${escapeOperationalMailHtml(input.intro)}</p>`,
    `<div style="padding:16px 18px;background:${style.background};border:1px solid ${style.border};border-radius:10px;">`,
    '<div style="color:#64748B;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Status</div>',
    `<div style="margin-top:4px;color:${style.color};font-size:22px;font-weight:800;letter-spacing:.03em;">${escapeOperationalMailHtml(input.statusLabel)}</div>`,
    '</div>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:collapse;">${input.fields.map(detailRow).join('')}</table>`,
    noteHtml,
    footerHtml
  ].join('');
};

export const operationalPresentationData = (input: {
  headerTitle: string;
  preheader: string;
  mailLabel: string;
}) => ({
  headerTitle: input.headerTitle,
  preheader: input.preheader,
  renderOptions: {
    showBadge: true,
    mailLabel: input.mailLabel,
    includeEntryContext: false
  }
});
