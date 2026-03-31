import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { writeAuditLog } from '../audit/log';
import { aiKnowledgeItem, aiMessageSource, entry, event, eventClass, invoice, person, vehicle } from '../db/schema';
import { getAssetObjectBuffer, uploadAssetFile } from '../docs/storage';
import { isPgUniqueViolation } from '../http/dbErrors';
import { decodeMimeHeaderValue, parseRawEmail } from './imap';

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

const registrationStatusLabel = (value: string | null | undefined) => {
  if (value === 'submitted_verified') {
    return 'E-Mail bestätigt, Nennung eingegangen';
  }
  if (value === 'submitted_unverified') {
    return 'Nennung eingegangen, E-Mail noch unbestätigt';
  }
  return null;
};

const acceptanceStatusLabel = (value: string | null | undefined) => {
  if (value === 'accepted') {
    return 'Zugelassen';
  }
  if (value === 'shortlist') {
    return 'Vorauswahl';
  }
  if (value === 'pending') {
    return 'In Prüfung';
  }
  if (value === 'rejected') {
    return 'Abgelehnt';
  }
  return null;
};

const paymentStatusLabel = (value: string | null | undefined) => {
  if (value === 'paid') {
    return 'Bezahlt';
  }
  if (value === 'due') {
    return 'Offen';
  }
  return null;
};

const detectKnowledgeTopics = (value: string): Array<'documents' | 'payment' | 'interview' | 'logistics' | 'contact' | 'general'> => {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const topics = new Set<'documents' | 'payment' | 'interview' | 'logistics' | 'contact' | 'general'>();
  if (/\bunterlag|\bdokument|\bnenn|\banmeld/.test(normalized)) {
    topics.add('documents');
  }
  if (/\bzahl|\biban|\buberweis|\bnenngeld/.test(normalized)) {
    topics.add('payment');
  }
  if (/\binterview|\bpresse|\bmedien|\bakkredit/.test(normalized)) {
    topics.add('interview');
  }
  if (/\banreise|\bfahrerlager|\bzeitplan|\bzugang|\bablauf/.test(normalized)) {
    topics.add('logistics');
  }
  if (/\bkontakt|\bansprechpartner|\btelefon/.test(normalized)) {
    topics.add('contact');
  }
  if (topics.size === 0) {
    topics.add('general');
  }
  return Array.from(topics);
};

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
    subject: row.subject ? decodeMimeHeaderValue(row.subject) : row.subject,
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
      rawS3Key: aiMessageSource.rawS3Key,
      status: aiMessageSource.status,
      aiCategory: aiMessageSource.aiCategory,
      aiSummary: aiMessageSource.aiSummary,
      aiLastProcessedAt: aiMessageSource.aiLastProcessedAt,
      textContent: aiMessageSource.textContent,
      createdAt: aiMessageSource.createdAt,
      eventName: event.name,
      eventContactEmail: event.contactEmail,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      className: eventClass.name,
      vehicleLabel: sql<string | null>`nullif(trim(coalesce(${vehicle.make}, '') || ' ' || coalesce(${vehicle.model}, '')), '')`,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      orgaCode: entry.orgaCode,
      paymentStatus: invoice.paymentStatus,
      amountOpenCents: sql<number | null>`case when ${invoice.totalCents} is null then null else greatest(${invoice.totalCents} - coalesce(${invoice.paidAmountCents}, 0), 0) end`
    })
    .from(aiMessageSource)
    .leftJoin(event, eq(aiMessageSource.eventId, event.id))
    .leftJoin(entry, eq(aiMessageSource.entryId, entry.id))
    .leftJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(eq(aiMessageSource.id, messageId))
    .limit(1);

  const current = rows[0];
  if (!current) {
    return null;
  }

  const raw = current.rawS3Key ? await getAssetObjectBuffer(current.rawS3Key) : null;
  const parsed = raw ? parseRawEmail(raw) : null;
  const bodyText = parsed?.textContent?.trim() || current.textContent;
  const detectedTopics = detectKnowledgeTopics(
    [current.subject ? decodeMimeHeaderValue(current.subject) : current.subject, bodyText].filter(Boolean).join('\n')
  );
  const knowledgeHits = await db
    .select({
      id: aiKnowledgeItem.id,
      topic: aiKnowledgeItem.topic,
      title: aiKnowledgeItem.title,
      content: aiKnowledgeItem.content
    })
    .from(aiKnowledgeItem)
    .where(
      and(
        eq(aiKnowledgeItem.status, 'approved'),
        inArray(aiKnowledgeItem.topic, detectedTopics),
        current.eventId
          ? sql`(${aiKnowledgeItem.eventId} = ${current.eventId} or ${aiKnowledgeItem.eventId} is null)`
          : sql`${aiKnowledgeItem.eventId} is null`
      )
    )
    .orderBy(desc(aiKnowledgeItem.eventId), desc(aiKnowledgeItem.createdAt))
    .limit(6);

  return {
    message: {
      id: current.id,
      source: current.source,
      mailboxKey: current.mailboxKey,
      fromEmail: current.fromEmail,
      fromName: current.fromName,
      toEmail: current.toEmail,
      subject: current.subject ? decodeMimeHeaderValue(current.subject) : current.subject,
      receivedAt: current.receivedAt,
      eventId: current.eventId,
      entryId: current.entryId,
      status: current.status,
      aiCategory: current.aiCategory,
      aiSummary: current.aiSummary,
      aiLastProcessedAt: current.aiLastProcessedAt,
      textContent: bodyText,
      bodyText,
      bodyHtml: parsed?.htmlContent ?? null,
      bodyFormat: parsed?.htmlContent ? 'html+text' : 'text',
      snippet: bodyText.slice(0, 280),
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
            registrationStatusLabel: registrationStatusLabel(current.registrationStatus),
            acceptanceStatus: current.acceptanceStatus,
            acceptanceStatusLabel: acceptanceStatusLabel(current.acceptanceStatus),
            paymentStatus: current.paymentStatus,
            paymentStatusLabel: paymentStatusLabel(current.paymentStatus),
            orgaCode: current.orgaCode,
            amountOpenCents: current.amountOpenCents,
            driverName: [current.driverFirstName, current.driverLastName].filter(Boolean).join(' ').trim() || null,
            className: current.className,
            vehicleLabel: current.vehicleLabel,
            detailPath: `/admin/entries/${current.entryId}`
          }
        : null
    },
    assistantContext: {
      knowledgeHits: knowledgeHits.map((item) => ({
        id: item.id,
        topic: item.topic,
        title: item.title,
        content: item.content
      }))
    }
  };
};
