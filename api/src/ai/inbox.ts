import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { writeAuditLog } from '../audit/log';
import { aiMessageSource, entry, event, invoice, person } from '../db/schema';
import { uploadAssetFile } from '../docs/storage';
import { isPgUniqueViolation } from '../http/dbErrors';

export type ImportedInboxMessage = {
  source: 'imap' | 'manual';
  mailboxKey: string;
  externalMessageId: string;
  imapUid?: number | null;
  fromEmail?: string | null;
  fromName?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  receivedAt?: Date | null;
  textContent: string;
  rawEmail?: Buffer | null;
};

const normalizeTextContent = (value: string): string =>
  value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const buildFallbackExternalMessageId = (mailboxKey: string, textContent: string, subject: string | null | undefined): string =>
  createHash('sha256')
    .update(`${mailboxKey}:${subject ?? ''}:${textContent}`)
    .digest('hex');

const inferMessageContext = async (fromEmail: string | null | undefined) => {
  const db = await getDb();
  const normalizedEmail = fromEmail?.trim().toLowerCase() ?? null;

  if (normalizedEmail) {
    const entryRows = await db
      .select({
        entryId: entry.id,
        eventId: entry.eventId
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(sql`${entry.deletedAt} is null`, sql`lower(${person.email}) = ${normalizedEmail}`))
      .orderBy(desc(entry.updatedAt))
      .limit(1);
    if (entryRows[0]) {
      return entryRows[0];
    }
  }

  const currentEventRows = await db
    .select({
      eventId: event.id
    })
    .from(event)
    .where(eq(event.isCurrent, true))
    .limit(1);

  return {
    eventId: currentEventRows[0]?.eventId ?? null,
    entryId: null
  };
};

export const importInboxMessage = async (input: ImportedInboxMessage) => {
  const db = await getDb();
  const now = new Date();
  const normalizedContent = normalizeTextContent(input.textContent);
  const externalMessageId =
    input.externalMessageId?.trim().length > 0
      ? input.externalMessageId.trim()
      : buildFallbackExternalMessageId(input.mailboxKey, normalizedContent, input.subject);
  const inferred = await inferMessageContext(input.fromEmail ?? null);
  const rawS3Key =
    input.rawEmail && input.rawEmail.length > 0
      ? `ai/inbox/${input.mailboxKey}/${now.toISOString().slice(0, 10)}/${randomUUID()}.eml`
      : null;

  if (rawS3Key && input.rawEmail) {
    await uploadAssetFile(rawS3Key, input.rawEmail, 'message/rfc822');
  }

  try {
    const [created] = await db
      .insert(aiMessageSource)
      .values({
        source: input.source,
        mailboxKey: input.mailboxKey,
        externalMessageId,
        imapUid: input.imapUid ?? null,
        fromEmail: input.fromEmail ?? null,
        fromName: input.fromName ?? null,
        toEmail: input.toEmail ?? null,
        subject: input.subject ?? null,
        receivedAt: input.receivedAt ?? now,
        eventId: inferred.eventId ?? null,
        entryId: inferred.entryId ?? null,
        rawS3Key,
        textContent: input.textContent,
        normalizedContent,
        status: 'imported',
        createdAt: now,
        updatedAt: now
      })
      .returning({
        id: aiMessageSource.id,
        eventId: aiMessageSource.eventId,
        entryId: aiMessageSource.entryId
      });

    if (!created) {
      throw new Error('AI_MESSAGE_IMPORT_FAILED');
    }

    await writeAuditLog(db as never, {
      eventId: created.eventId,
      actorUserId: 'system',
      action: 'ai_message_imported',
      entityType: 'ai_message_source',
      entityId: created.id as never,
      payload: {
        messageId: created.id,
        source: input.source,
        mailboxKey: input.mailboxKey,
        eventId: created.eventId,
        entryId: created.entryId
      }
    });

    return {
      id: created.id,
      imported: true as const
    };
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      const existing = await db
        .select({ id: aiMessageSource.id })
        .from(aiMessageSource)
        .where(
          and(
            eq(aiMessageSource.source, input.source),
            eq(aiMessageSource.mailboxKey, input.mailboxKey),
            eq(aiMessageSource.externalMessageId, externalMessageId)
          )
        )
        .limit(1);
      return {
        id: existing[0]?.id ?? null,
        imported: false as const
      };
    }
    throw error;
  }
};

export const listInboxMessages = async (query: { eventId?: string; status?: 'imported' | 'processed' | 'archived'; limit?: number }) => {
  const db = await getDb();
  const conditions = [];
  if (query.eventId) {
    conditions.push(eq(aiMessageSource.eventId, query.eventId));
  }
  if (query.status) {
    conditions.push(eq(aiMessageSource.status, query.status));
  }
  const rows = await db
    .select({
      id: aiMessageSource.id,
      source: aiMessageSource.source,
      mailboxKey: aiMessageSource.mailboxKey,
      fromEmail: aiMessageSource.fromEmail,
      fromName: aiMessageSource.fromName,
      toEmail: aiMessageSource.toEmail,
      subject: aiMessageSource.subject,
      receivedAt: aiMessageSource.receivedAt,
      eventId: aiMessageSource.eventId,
      entryId: aiMessageSource.entryId,
      status: aiMessageSource.status,
      aiSummary: aiMessageSource.aiSummary,
      aiCategory: aiMessageSource.aiCategory,
      textContent: aiMessageSource.textContent,
      createdAt: aiMessageSource.createdAt
    })
    .from(aiMessageSource)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(aiMessageSource.receivedAt), desc(aiMessageSource.createdAt))
    .limit(query.limit ?? 50);

  return rows.map((row) => ({
    ...row,
    preview: row.textContent.slice(0, 280)
  }));
};

export const getInboxMessageDetail = async (messageId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiMessageSource.id,
      source: aiMessageSource.source,
      mailboxKey: aiMessageSource.mailboxKey,
      fromEmail: aiMessageSource.fromEmail,
      fromName: aiMessageSource.fromName,
      toEmail: aiMessageSource.toEmail,
      subject: aiMessageSource.subject,
      receivedAt: aiMessageSource.receivedAt,
      eventId: aiMessageSource.eventId,
      entryId: aiMessageSource.entryId,
      status: aiMessageSource.status,
      aiCategory: aiMessageSource.aiCategory,
      aiSummary: aiMessageSource.aiSummary,
      aiLastProcessedAt: aiMessageSource.aiLastProcessedAt,
      textContent: aiMessageSource.textContent,
      createdAt: aiMessageSource.createdAt,
      eventName: event.name,
      eventContactEmail: event.contactEmail,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      orgaCode: entry.orgaCode,
      paymentStatus: invoice.paymentStatus
    })
    .from(aiMessageSource)
    .leftJoin(event, eq(aiMessageSource.eventId, event.id))
    .leftJoin(entry, eq(aiMessageSource.entryId, entry.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(eq(aiMessageSource.id, messageId))
    .limit(1);

  const current = rows[0];
  if (!current) {
    return null;
  }

  return {
    message: {
      id: current.id,
      source: current.source,
      mailboxKey: current.mailboxKey,
      fromEmail: current.fromEmail,
      fromName: current.fromName,
      toEmail: current.toEmail,
      subject: current.subject,
      receivedAt: current.receivedAt,
      eventId: current.eventId,
      entryId: current.entryId,
      status: current.status,
      aiCategory: current.aiCategory,
      aiSummary: current.aiSummary,
      aiLastProcessedAt: current.aiLastProcessedAt,
      textContent: current.textContent,
      createdAt: current.createdAt
    },
    basis: {
      event: current.eventId
        ? {
            id: current.eventId,
            name: current.eventName,
            contactEmail: current.eventContactEmail
          }
        : null,
      entry: current.entryId
        ? {
            id: current.entryId,
            registrationStatus: current.registrationStatus,
            acceptanceStatus: current.acceptanceStatus,
            paymentStatus: current.paymentStatus,
            orgaCode: current.orgaCode
          }
        : null
    }
  };
};
