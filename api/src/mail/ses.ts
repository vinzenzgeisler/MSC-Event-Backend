import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';

const getSesClient = () => new SESClient({});
const DEFAULT_SES_FROM_EMAIL = 'nennung@msc-oberlausitzer-dreilaendereck.eu';
const DEFAULT_SES_FROM_NAME = 'MSC Oberlausitzer Dreiländereck e.V.';

const sanitizeDisplayName = (value: string): string =>
  value
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '')
    .trim();

const encodeDisplayName = (value: string): string => {
  if (!/[^\x20-\x7E]/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\');
    return `"${escaped}"`;
  }
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${base64}?=`;
};

const getSender = (): string => {
  const sender = process.env.SES_FROM_EMAIL?.trim();
  const senderEmail = sender && sender.length > 0 ? sender : DEFAULT_SES_FROM_EMAIL;
  if (senderEmail.includes('<') && senderEmail.includes('>')) {
    return senderEmail;
  }
  const senderName = sanitizeDisplayName(DEFAULT_SES_FROM_NAME);
  return `${encodeDisplayName(senderName)} <${senderEmail}>`;
};

export type EmailAttachment = {
  fileName: string;
  contentType: string;
  content: Buffer;
};

const encodeSubject = (value: string): string => {
  if (!/[^\x20-\x7E]/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
};

const toBase64Lines = (value: Buffer | string): string =>
  Buffer.from(value)
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trimEnd();

const buildRawMessage = (
  to: string,
  subject: string,
  bodyText: string,
  bodyHtml: string | undefined,
  attachments: EmailAttachment[]
): Buffer => {
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const lines: string[] = [];

  lines.push(`From: ${getSender()}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${encodeSubject(subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  lines.push('');
  lines.push(`--${mixedBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(toBase64Lines(bodyText));
  lines.push('');
  if (bodyHtml && bodyHtml.trim().length > 0) {
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(toBase64Lines(bodyHtml));
    lines.push('');
  }
  lines.push(`--${altBoundary}--`);
  lines.push('');

  attachments.forEach((attachment) => {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${attachment.contentType}; name="${attachment.fileName}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${attachment.fileName}"`);
    lines.push('');
    lines.push(toBase64Lines(attachment.content));
    lines.push('');
  });

  lines.push(`--${mixedBoundary}--`);
  lines.push('');
  return Buffer.from(lines.join('\r\n'), 'utf8');
};

export const sendEmail = async (
  to: string,
  subject: string,
  bodyText: string,
  bodyHtml?: string,
  attachments: EmailAttachment[] = []
) => {
  const client = getSesClient();
  if (attachments.length > 0) {
    const raw = buildRawMessage(to, subject, bodyText, bodyHtml, attachments);
    const command = new SendRawEmailCommand({
      RawMessage: {
        Data: raw
      }
    });
    return client.send(command);
  }
  const command = new SendEmailCommand({
    Source: getSender(),
    Destination: {
      ToAddresses: [to]
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: bodyText },
        ...(bodyHtml && bodyHtml.trim().length > 0 ? { Html: { Data: bodyHtml } } : {})
      }
    }
  });

  return client.send(command);
};
