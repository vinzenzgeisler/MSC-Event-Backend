import * as tls from 'node:tls';

type ImapConnectionOptions = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type ImapFetchedMessage = {
  uid: number;
  raw: Buffer;
};

const parseLiteralLength = (line: string): number | null => {
  const match = line.match(/\{(\d+)\}$/);
  return match ? Number.parseInt(match[1], 10) : null;
};

class LineReader {
  private readonly socket: tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private ended = false;

  constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
    this.socket.on('end', () => {
      this.ended = true;
    });
  }

  private async waitForBytes(minBytes: number): Promise<void> {
    if (this.buffer.length >= minBytes) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onData = () => {
        if (this.buffer.length >= minBytes) {
          cleanup();
          resolve();
        }
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('IMAP_CONNECTION_CLOSED'));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off('data', onData);
        this.socket.off('end', onEnd);
        this.socket.off('error', onError);
      };
      this.socket.on('data', onData);
      this.socket.on('end', onEnd);
      this.socket.on('error', onError);
    });
  }

  async readLine(): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx).toString('utf8');
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      if (this.ended) {
        throw new Error('IMAP_CONNECTION_CLOSED');
      }
      await this.waitForBytes(this.buffer.length + 1);
    }
  }

  async readBytes(size: number): Promise<Buffer> {
    await this.waitForBytes(size);
    const chunk = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return chunk;
  }
}

export class ImapConnection {
  private readonly socket: tls.TLSSocket;
  private readonly reader: LineReader;
  private tagCounter = 0;

  private constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    this.reader = new LineReader(socket);
  }

  static async connect(options: ImapConnectionOptions): Promise<ImapConnection> {
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      servername: options.host,
      rejectUnauthorized: true
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => resolve());
      socket.once('error', reject);
    });
    const connection = new ImapConnection(socket);
    const greeting = await connection.reader.readLine();
    if (!greeting.startsWith('* OK')) {
      throw new Error(`IMAP_BAD_GREETING:${greeting}`);
    }
    await connection.execute(`LOGIN "${options.username.replace(/"/g, '\\"')}" "${options.password.replace(/"/g, '\\"')}"`);
    return connection;
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  async execute(command: string): Promise<{ lines: string[]; literals: Buffer[] }> {
    const tag = this.nextTag();
    this.socket.write(`${tag} ${command}\r\n`);
    const lines: string[] = [];
    const literals: Buffer[] = [];
    while (true) {
      const line = await this.reader.readLine();
      const literalLength = parseLiteralLength(line);
      lines.push(line);
      if (literalLength !== null) {
        literals.push(await this.reader.readBytes(literalLength));
      }
      if (line.startsWith(`${tag} OK`)) {
        return { lines, literals };
      }
      if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
        throw new Error(`IMAP_COMMAND_FAILED:${line}`);
      }
    }
  }

  async selectMailbox(mailbox: string): Promise<void> {
    await this.execute(`SELECT "${mailbox.replace(/"/g, '\\"')}"`);
  }

  async searchUnseen(limit: number): Promise<number[]> {
    const result = await this.execute('UID SEARCH UNSEEN');
    const searchLine = result.lines.find((line) => line.startsWith('* SEARCH'));
    if (!searchLine) {
      return [];
    }
    return searchLine
      .replace('* SEARCH', '')
      .trim()
      .split(/\s+/)
      .filter((value) => value.length > 0)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .slice(0, limit);
  }

  async fetchRaw(uid: number): Promise<ImapFetchedMessage | null> {
    const result = await this.execute(`UID FETCH ${uid} (UID RFC822)`);
    const raw = result.literals[0];
    if (!raw) {
      return null;
    }
    return {
      uid,
      raw
    };
  }

  async markSeen(uid: number): Promise<void> {
    await this.execute(`UID STORE ${uid} +FLAGS (\\Seen)`);
  }

  async logout(): Promise<void> {
    try {
      await this.execute('LOGOUT');
    } finally {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

const parseHeaders = (raw: Buffer): { headers: Record<string, string>; body: string } => {
  const text = raw.toString('latin1');
  const separator = text.indexOf('\r\n\r\n');
  const headerText = separator >= 0 ? text.slice(0, separator) : text;
  const body = separator >= 0 ? text.slice(separator + 4) : '';
  const unfolded = headerText.replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  unfolded.split('\r\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      return;
    }
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  });
  return { headers, body };
};

export const decodeMimeHeaderValue = (value: string): string => {
  const normalized = value.replace(/\?\=\s+\=\?/g, '?==?');
  return normalized.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charsetRaw: string, encodingRaw: string, encodedText: string) => {
    const charset = charsetRaw.trim().toLowerCase();
    const encoding = encodingRaw.toUpperCase();
    const buffer =
      encoding === 'B'
        ? Buffer.from(encodedText, 'base64')
        : Buffer.from(
            encodedText
              .replace(/_/g, ' ')
              .replace(/=([A-Fa-f0-9]{2})/g, (_hexMatch: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
            'latin1'
          );

    if (charset === 'utf-8' || charset === 'utf8') {
      return buffer.toString('utf8');
    }
    return buffer.toString('latin1');
  });
};

const decodeQuotedPrintable = (value: string): string =>
  value
    .replace(/=\r?\n/g, '')
    .replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const stripHtml = (value: string): string =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const extractBoundary = (contentType: string | undefined): string | null => {
  const match = contentType?.match(/boundary="?([^";]+)"?/i);
  return match?.[1] ?? null;
};

const extractCharset = (contentType: string | undefined): BufferEncoding => {
  const match = contentType?.match(/charset="?([^";]+)"?/i);
  const charset = match?.[1]?.trim().toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') {
    return 'utf8';
  }
  return 'latin1';
};

const normalizePlainText = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const decodeBody = (body: string, encoding: string | undefined, contentType: string | undefined): string => {
  let decoded = body;
  const charset = extractCharset(contentType);
  if ((encoding ?? '').toLowerCase() === 'quoted-printable') {
    const binary = decodeQuotedPrintable(decoded);
    decoded = Buffer.from(binary, 'latin1').toString(charset);
  } else if ((encoding ?? '').toLowerCase() === 'base64') {
    decoded = Buffer.from(decoded.replace(/\s+/g, ''), 'base64').toString(charset);
  } else if (charset === 'utf8') {
    decoded = Buffer.from(decoded, 'latin1').toString('utf8');
  }
  if ((contentType ?? '').toLowerCase().includes('text/html')) {
    return stripHtml(decoded);
  }
  return normalizePlainText(decoded);
};

const extractMultipartBodies = (body: string, contentType: string | undefined): { text: string | null; html: string | null } => {
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    return { text: null, html: null };
  }
  const parts = body.split(`--${boundary}`);
  let text: string | null = null;
  let html: string | null = null;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '--') {
      continue;
    }
    const parsed = parseHeaders(Buffer.from(part, 'latin1'));
    const partType = parsed.headers['content-type'] ?? '';
    if (partType.toLowerCase().includes('multipart/')) {
      const nested = extractMultipartBodies(parsed.body, partType);
      text = text ?? nested.text;
      html = html ?? nested.html;
      continue;
    }
    if (partType.toLowerCase().includes('text/plain')) {
      text = text ?? decodeBody(parsed.body, parsed.headers['content-transfer-encoding'], partType);
    }
    if (partType.toLowerCase().includes('text/html')) {
      html = html ?? Buffer.from(
        (() => {
          let decoded = parsed.body;
          const encoding = (parsed.headers['content-transfer-encoding'] ?? '').toLowerCase();
          const charset = extractCharset(partType);
          if (encoding === 'quoted-printable') {
            decoded = decodeQuotedPrintable(decoded);
            return Buffer.from(decoded, 'latin1').toString(charset);
          }
          if (encoding === 'base64') {
            return Buffer.from(decoded.replace(/\s+/g, ''), 'base64').toString(charset);
          }
          if (charset === 'utf8') {
            return Buffer.from(decoded, 'latin1').toString('utf8');
          }
          return decoded;
        })(),
        'utf8'
      ).toString('utf8').trim();
    }
  }
  return { text, html };
};

export const parseRawEmail = (raw: Buffer) => {
  const { headers, body } = parseHeaders(raw);
  const contentType = headers['content-type'];
  const multipartBodies = extractMultipartBodies(body, contentType);
  const textContent =
    multipartBodies.text ??
    decodeBody(body, headers['content-transfer-encoding'], contentType);
  const htmlContent = multipartBodies.html ?? ((contentType ?? '').toLowerCase().includes('text/html') ? body : null);
  return {
    messageId: headers['message-id'] ?? null,
    subject: headers.subject ? decodeMimeHeaderValue(headers.subject) : null,
    from: headers.from ? decodeMimeHeaderValue(headers.from) : null,
    to: headers.to ? decodeMimeHeaderValue(headers.to) : null,
    date: headers.date ? new Date(headers.date) : null,
    textContent,
    htmlContent
  };
};

export const parseMailboxAddress = (value: string | null) => {
  if (!value) {
    return {
      email: null,
      name: null
    };
  }
  const angleMatch = value.match(/^(.*)<([^>]+)>$/);
  if (angleMatch) {
    return {
      name: angleMatch[1].replace(/"/g, '').trim() || null,
      email: angleMatch[2].trim().toLowerCase()
    };
  }
  const trimmed = value.trim();
  return {
    name: null,
    email: trimmed.includes('@') ? trimmed.toLowerCase() : null
  };
};
