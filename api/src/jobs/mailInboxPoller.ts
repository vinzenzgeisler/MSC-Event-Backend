import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { importInboxMessage } from '../ai/inbox';
import { ImapConnection, parseMailboxAddress, parseRawEmail } from '../ai/imap';

type InboxSecret = {
  host: string;
  port?: number;
  username: string;
  password: string;
  mailbox?: string;
};

const parseSecret = (value: string): InboxSecret => {
  const parsed = JSON.parse(value) as Partial<InboxSecret>;
  if (
    typeof parsed.host !== 'string' ||
    typeof parsed.username !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    throw new Error('AI_INBOX_SECRET_INVALID');
  }
  return parsed as InboxSecret;
};

const loadInboxSecret = async (): Promise<InboxSecret | null> => {
  const secretArn = process.env.AI_INBOX_IMAP_SECRET_ARN;
  if (!secretArn) {
    return null;
  }
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secretArn
    })
  );
  if (!response.SecretString) {
    throw new Error('AI_INBOX_SECRET_EMPTY');
  }
  return parseSecret(response.SecretString);
};

const mailboxKey = () => process.env.AI_INBOX_IMAP_MAILBOX_KEY ?? 'default-inbox';
const mailboxName = (secret: InboxSecret) => process.env.AI_INBOX_IMAP_MAILBOX ?? secret.mailbox ?? 'INBOX';
const fetchLimit = () => {
  const raw = process.env.AI_INBOX_POLL_BATCH_SIZE;
  const parsed = raw ? Number.parseInt(raw, 10) : 10;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
};

export const handler = async () => {
  const secret = await loadInboxSecret();
  if (!secret) {
    return {
      ok: true,
      skipped: true,
      reason: 'AI inbox not configured'
    };
  }

  const connection = await ImapConnection.connect({
    host: secret.host,
    port: secret.port ?? 993,
    username: secret.username,
    password: secret.password
  });

  let imported = 0;
  let duplicates = 0;
  let seenMarked = 0;

  try {
    await connection.selectMailbox(mailboxName(secret));
    const unseen = await connection.searchUnseen(fetchLimit());

    for (const uid of unseen) {
      const fetched = await connection.fetchRaw(uid);
      if (!fetched) {
        continue;
      }
      const parsed = parseRawEmail(fetched.raw);
      const from = parseMailboxAddress(parsed.from);
      const to = parseMailboxAddress(parsed.to);
      const result = await importInboxMessage({
        source: 'imap',
        mailboxKey: mailboxKey(),
        externalMessageId: parsed.messageId ?? `uid-${uid}`,
        imapUid: uid,
        fromEmail: from.email,
        fromName: from.name,
        toEmail: to.email,
        subject: parsed.subject,
        receivedAt: parsed.date,
        textContent: parsed.textContent || '(empty message body)',
        rawEmail: fetched.raw
      });

      if (result.imported) {
        imported += 1;
      } else {
        duplicates += 1;
      }

      await connection.markSeen(uid);
      seenMarked += 1;
    }
  } finally {
    await connection.logout();
  }

  return {
    ok: true,
    imported,
    duplicates,
    seenMarked
  };
};
