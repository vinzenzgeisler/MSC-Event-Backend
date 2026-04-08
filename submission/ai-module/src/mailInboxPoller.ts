export type ImapSecret = {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox: string;
};

export type ImportedMail = {
  externalMessageId: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  textContent: string;
  rawEml?: string;
};

export interface SecretProvider {
  getImapSecret(secretArn: string): Promise<ImapSecret>;
}

export interface ImapClient {
  connect(secret: ImapSecret): Promise<void>;
  listUnread(limit: number): Promise<ImportedMail[]>;
  markSeen(externalMessageIds: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface InboxRepository {
  hasImportedMessage(externalMessageId: string, mailboxKey: string): Promise<boolean>;
  saveImportedMessage(input: {
    mailboxKey: string;
    externalMessageId: string;
    fromEmail: string;
    subject: string;
    receivedAt: string;
    textContent: string;
    rawEml?: string;
  }): Promise<void>;
}

export const pollInbox = async (input: {
  secretArn: string;
  mailboxKey: string;
  batchSize: number;
  secrets: SecretProvider;
  imapClient: ImapClient;
  repository: InboxRepository;
}) => {
  const secret = await input.secrets.getImapSecret(input.secretArn);
  await input.imapClient.connect(secret);

  try {
    const unread = await input.imapClient.listUnread(input.batchSize);
    const importedIds: string[] = [];
    let duplicates = 0;

    for (const mail of unread) {
      const alreadyImported = await input.repository.hasImportedMessage(mail.externalMessageId, input.mailboxKey);
      if (alreadyImported) {
        duplicates += 1;
        importedIds.push(mail.externalMessageId);
        continue;
      }

      await input.repository.saveImportedMessage({
        mailboxKey: input.mailboxKey,
        externalMessageId: mail.externalMessageId,
        fromEmail: mail.fromEmail,
        subject: mail.subject,
        receivedAt: mail.receivedAt,
        textContent: mail.textContent,
        rawEml: mail.rawEml
      });
      importedIds.push(mail.externalMessageId);
    }

    if (importedIds.length > 0) {
      await input.imapClient.markSeen(importedIds);
    }

    return {
      imported: importedIds.length - duplicates,
      duplicates,
      seenMarked: importedIds.length
    };
  } finally {
    await input.imapClient.close();
  }
};
