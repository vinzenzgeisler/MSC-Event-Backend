import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, inArray, isNull, or, SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { emailOutbox, entry, entryEmailVerification, event, eventClass, invoice, person } from '../db/schema';
import { isPgUniqueViolation } from '../http/dbErrors';
import { writeAuditLog } from '../audit/log';
import { getTemplateVersion } from '../mail/templateStore';
import { buildPublicVerificationUrl } from '../mail/verificationUrl';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';
import { renderTemplateString } from '../mail/templates';

const queueMailSchema = z
  .object({
    eventId: z.string().uuid(),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive().optional(),
    subject: z.string().min(1).optional(),
    templateData: z.record(z.unknown()).optional(),
    sendAfter: z.string().datetime().optional(),
    recipientEmails: z.array(z.string().email()).optional(),
    driverPersonIds: z.array(z.string().uuid()).optional(),
    entryIds: z.array(z.string().uuid()).optional(),
    filters: z
      .object({
        acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
        registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
        paymentStatus: z.enum(['due', 'paid']).optional(),
        classId: z.string().uuid().optional()
      })
      .optional()
  })
  .refine(
    (value) =>
      (value.recipientEmails && value.recipientEmails.length > 0) ||
      (value.driverPersonIds && value.driverPersonIds.length > 0) ||
      (value.entryIds && value.entryIds.length > 0) ||
      value.filters,
    { message: 'Provide recipientEmails, driverPersonIds, entryIds, or filters.' }
  );

const reminderSchema = z.object({
  eventId: z.string().uuid(),
  entryId: z.string().uuid(),
  allowDuplicate: z.boolean().optional().default(false),
  templateId: z.string().min(1).optional().default('payment_reminder'),
  templateVersion: z.number().int().positive().optional(),
  subject: z.string().min(1).optional(),
  templateData: z.record(z.unknown()).optional(),
  sendAfter: z.string().datetime().optional()
});

const lifecycleSchema = z.object({
  eventId: z.string().uuid(),
  entryId: z.string().uuid(),
  eventType: z.enum([
    'registration_received',
    'preselection',
    'accepted_open_payment',
    'accepted_paid_completed',
    'rejected',
    'waitlist'
  ]),
  templateVersion: z.number().int().positive().optional(),
  sendAfter: z.string().datetime().optional(),
  includeDriverNote: z.boolean().optional().default(false),
  allowDuplicate: z.boolean().optional().default(false)
});

const broadcastSchema = z.object({
  eventId: z.string().uuid(),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive().optional(),
  sendAfter: z.string().datetime().optional(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  subjectOverride: z.string().min(1).optional()
});

const listOutboxSchema = z.object({
  eventId: z.string().uuid(),
  status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'sendAfter', 'updatedAt', 'status']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
});

type QueueMailInput = z.infer<typeof queueMailSchema>;
type ReminderInput = z.infer<typeof reminderSchema>;
type LifecycleInput = z.infer<typeof lifecycleSchema>;
type BroadcastInput = z.infer<typeof broadcastSchema>;
type ListOutboxInput = z.infer<typeof listOutboxSchema>;

export class DuplicateRequestError extends Error {
  public readonly existingOutboxId: string | null;
  public readonly blockedUntil: string | null;

  constructor(existingOutboxId: string | null, blockedUntil: string | null) {
    super('DUPLICATE_REQUEST');
    this.existingOutboxId = existingOutboxId;
    this.blockedUntil = blockedUntil;
  }
}

export class LifecycleMailError extends Error {
  public readonly code: LifecycleMailErrorCode;
  public readonly reason: string;

  constructor(code: LifecycleMailErrorCode, reason: string) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}

export type LifecycleMailErrorCode =
  | 'NO_RECIPIENT'
  | 'NOT_ALLOWED'
  | 'TEMPLATE_RENDER_FAILED'
  | 'OUTBOX_INSERT_FAILED'
  | 'TEMPLATE_NOT_FOUND'
  | 'ENTRY_NOT_FOUND';

const lifecycleErrorMeta: Record<LifecycleMailErrorCode, { statusCode: number; message: string }> = {
  NO_RECIPIENT: {
    statusCode: 409,
    message: 'No recipient email available'
  },
  NOT_ALLOWED: {
    statusCode: 409,
    message: 'Lifecycle mail not allowed for this entry'
  },
  TEMPLATE_RENDER_FAILED: {
    statusCode: 400,
    message: 'Lifecycle template render failed'
  },
  OUTBOX_INSERT_FAILED: {
    statusCode: 409,
    message: 'Lifecycle outbox insert failed'
  },
  TEMPLATE_NOT_FOUND: {
    statusCode: 404,
    message: 'Template not found'
  },
  ENTRY_NOT_FOUND: {
    statusCode: 404,
    message: 'Entry not found'
  }
};

export const toLifecycleApiError = (error: LifecycleMailError) => {
  const meta = lifecycleErrorMeta[error.code];
  return {
    statusCode: meta.statusCode,
    message: meta.message,
    code: error.code,
    details: { reason: error.reason }
  };
};

type RecipientTarget = {
  email: string;
  driverPersonId: string | null;
  entryId: string | null;
};

type RegistrationContext = {
  entryId: string | null;
  eventName: string | null;
  driverName: string | null;
};

const buildDedupeKey = (
  prefix: string,
  eventId: string,
  templateKey: string,
  templateVersion: number,
  toEmail: string,
  payload: unknown
): string => {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        eventId,
        templateKey,
        templateVersion,
        toEmail,
        payload
      })
    )
    .digest('hex');
  return `${prefix}:${hash}`;
};

const toIsoDate = (value: string | undefined): Date => (value ? new Date(value) : new Date());

const formatEuroFromCents = (value: number): string => (value / 100).toFixed(2).replace('.', ',');

const templateKeyFromEventType = (eventType: LifecycleInput['eventType']): string => eventType;

const findOutboxByIdempotencyKey = async (idempotencyKey: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: emailOutbox.id,
      sendAfter: emailOutbox.sendAfter
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ?? null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const hasRequiredRegistrationReceivedVariables = (templateData: Record<string, unknown>): boolean =>
  Boolean(templateData.eventName && templateData.driverName && templateData.verificationUrl);

const isUndefinedColumnError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === '42703';

const upsertEntryVerificationToken = async (entryId: string, seed: string): Promise<string> => {
  const db = await getDb();
  const now = new Date();
  const existingRows = await db
    .select({
      token: entryEmailVerification.token,
      expiresAt: entryEmailVerification.expiresAt
    })
    .from(entryEmailVerification)
    .where(eq(entryEmailVerification.entryId, entryId))
    .limit(1);
  const existing = existingRows[0];
  if (existing && existing.expiresAt > now) {
    return existing.token;
  }

  const token = createHash('sha256').update(`${randomUUID()}:${seed}:${Date.now()}`).digest('hex');
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24);

  await db
    .insert(entryEmailVerification)
    .values({
      entryId,
      token,
      expiresAt,
      verifiedAt: null,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: entryEmailVerification.entryId,
      set: {
        token,
        expiresAt,
        verifiedAt: null,
        createdAt: now
      }
    });

  return token;
};

const resolveRegistrationContext = async (
  eventId: string,
  target: RecipientTarget,
  templateData: Record<string, unknown> | undefined
): Promise<RegistrationContext> => {
  const db = await getDb();
  const explicitEntryId = isNonEmptyString(templateData?.entryId) ? templateData.entryId : null;
  const candidateEntryId = explicitEntryId ?? target.entryId;

  if (candidateEntryId) {
    const rows = await db
      .select({
        entryId: entry.id,
        eventName: event.name,
        driverFirstName: person.firstName,
        driverLastName: person.lastName
      })
      .from(entry)
      .innerJoin(event, eq(entry.eventId, event.id))
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(eq(entry.id, candidateEntryId), eq(entry.eventId, eventId)))
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        entryId: row.entryId,
        eventName: row.eventName,
        driverName: `${row.driverFirstName} ${row.driverLastName}`.trim()
      };
    }
  }

  const rows = await db
    .select({
      entryId: entry.id,
      eventName: event.name,
      driverFirstName: person.firstName,
      driverLastName: person.lastName
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(and(eq(entry.eventId, eventId), eq(person.email, target.email)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      entryId: candidateEntryId,
      eventName: isNonEmptyString(templateData?.eventName) ? templateData.eventName : null,
      driverName: isNonEmptyString(templateData?.driverName) ? templateData.driverName : null
    };
  }
  return {
    entryId: row.entryId,
    eventName: row.eventName,
    driverName: `${row.driverFirstName} ${row.driverLastName}`.trim()
  };
};

const resolveTemplate = async (
  templateKey: string,
  requestedVersion: number | undefined,
  subjectOverride?: string
) => {
  const template = await getTemplateVersion(templateKey, requestedVersion);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND');
  }
  return {
    templateKey: template.templateKey,
    templateVersion: template.version,
    subjectTemplate: subjectOverride ?? template.subjectTemplate,
    bodyTemplate: template.bodyTemplate
  };
};

const dedupeTargets = (targets: RecipientTarget[]): RecipientTarget[] => {
  const map = new Map<string, RecipientTarget>();
  for (const target of targets) {
    const trimmed = target.email.trim();
    if (!trimmed) {
      continue;
    }
    map.set(trimmed.toLowerCase(), { ...target, email: trimmed });
  }
  return Array.from(map.values());
};

const resolveTargets = async (input: QueueMailInput): Promise<RecipientTarget[]> => {
  const db = await getDb();
  if (input.recipientEmails) {
    const candidates = dedupeTargets(
      input.recipientEmails.map((email) => ({
        email,
        driverPersonId: null,
        entryId: null
      }))
    );
    if (candidates.length === 0) {
      return [];
    }
    const blockedRows = await db
      .select({ email: person.email })
      .from(person)
      .where(
        and(
          inArray(
            person.email,
            candidates.map((candidate) => candidate.email)
          ),
          or(eq(person.processingRestricted, true), eq(person.objectionFlag, true))
        )
      );
    const blocked = new Set(blockedRows.map((row) => (row.email ?? '').toLowerCase()).filter((email) => email.length > 0));
    return candidates.filter((candidate) => !blocked.has(candidate.email.toLowerCase()));
  }

  if (input.driverPersonIds) {
    const rows = await db
      .select({ email: person.email, driverPersonId: person.id })
      .from(person)
      .where(and(inArray(person.id, input.driverPersonIds), eq(person.processingRestricted, false), eq(person.objectionFlag, false)));
    return dedupeTargets(
      rows
        .filter((row) => row.email)
        .map((row) => ({
          email: row.email as string,
          driverPersonId: row.driverPersonId,
          entryId: null
        }))
    );
  }

  if (input.entryIds) {
    const rows = await db
      .select({
        email: person.email,
        driverPersonId: entry.driverPersonId,
        entryId: entry.id
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(inArray(entry.id, input.entryIds), eq(person.processingRestricted, false), eq(person.objectionFlag, false)));
    return dedupeTargets(
      rows
        .filter((row) => row.email)
        .map((row) => ({
          email: row.email as string,
          driverPersonId: row.driverPersonId,
          entryId: row.entryId
        }))
    );
  }

  if (input.filters) {
    const conditions: SQL<unknown>[] = [
      eq(entry.eventId, input.eventId),
      eq(person.processingRestricted, false),
      eq(person.objectionFlag, false)
    ];
    if (input.filters.acceptanceStatus) {
      conditions.push(eq(entry.acceptanceStatus, input.filters.acceptanceStatus));
    }
    if (input.filters.registrationStatus) {
      conditions.push(eq(entry.registrationStatus, input.filters.registrationStatus));
    }
    if (input.filters.classId) {
      conditions.push(eq(entry.classId, input.filters.classId));
    }

    const query = db
      .select({
        email: person.email,
        driverPersonId: entry.driverPersonId,
        entryId: entry.id
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id));

    if (input.filters.paymentStatus) {
      const rows = await query
        .innerJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
        .where(and(...conditions, eq(invoice.paymentStatus, input.filters.paymentStatus)));

      return dedupeTargets(
        rows
          .filter((row) => row.email)
          .map((row) => ({
            email: row.email as string,
            driverPersonId: row.driverPersonId,
            entryId: row.entryId
          }))
      );
    }

    const rows = await query.where(and(...conditions));
    return dedupeTargets(
      rows
        .filter((row) => row.email)
        .map((row) => ({
          email: row.email as string,
          driverPersonId: row.driverPersonId,
          entryId: row.entryId
        }))
    );
  }

  return [];
};

const insertOutboxRows = async (
  eventId: string,
  templateKey: string,
  templateVersion: number,
  subject: string,
  sendAfter: Date,
  rows: Array<{
    toEmail: string;
    templateData: Record<string, unknown>;
    idempotencyKey: string;
  }>
) => {
  const db = await getDb();
  if (rows.length === 0) {
    return;
  }

  try {
    await db.insert(emailOutbox).values(
      rows.map((row) => ({
        eventId,
        toEmail: row.toEmail,
        subject,
        templateId: templateKey,
        templateVersion,
        templateData: row.templateData,
        status: 'queued',
        sendAfter,
        idempotencyKey: row.idempotencyKey,
        maxAttempts: 5
      }))
    );
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }
};

export const queueMail = async (input: QueueMailInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const targets = await resolveTargets(input);
  if (targets.length === 0) {
    return { queued: 0 };
  }

  const template = await resolveTemplate(input.templateId, input.templateVersion, input.subject);
  const sendAfter = toIsoDate(input.sendAfter);

  const outboxRows = await Promise.all(
    targets.map(async (target) => {
      let templateData: Record<string, unknown> = {
        ...(input.templateData ?? {}),
        driverPersonId: target.driverPersonId,
        entryId: target.entryId
      };

      if (template.templateKey === 'registration_received') {
        const context = await resolveRegistrationContext(input.eventId, target, input.templateData);
        if (context.entryId) {
          const token = await upsertEntryVerificationToken(context.entryId, target.email);
          const existingVerificationUrl = isNonEmptyString(templateData.verificationUrl)
            ? templateData.verificationUrl
            : null;
          const generatedVerificationUrl = buildPublicVerificationUrl(context.entryId, token);
          templateData = {
            ...templateData,
            entryId: context.entryId,
            eventName: context.eventName,
            driverName: context.driverName,
            verificationToken: token,
            verificationUrl: generatedVerificationUrl ?? existingVerificationUrl
          };
        }
      }

      return {
        toEmail: target.email,
        templateData,
        idempotencyKey: buildDedupeKey(
          'mail',
          input.eventId,
          template.templateKey,
          template.templateVersion,
          target.email,
          {
            sendAfter: sendAfter.toISOString(),
            templateData,
            driverPersonId: target.driverPersonId,
            entryId: target.entryId
          }
        )
      };
    })
  );

  await insertOutboxRows(
    input.eventId,
    template.templateKey,
    template.templateVersion,
    template.subjectTemplate,
    sendAfter,
    outboxRows
  );

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'email_outbox_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: outboxRows.length,
      templateId: template.templateKey,
      templateVersion: template.templateVersion
    }
  });

  return { queued: outboxRows.length };
};

export const queuePaymentReminders = async (input: ReminderInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const template = await resolveTemplate(input.templateId, input.templateVersion, input.subject);
  const sendAfter = toIsoDate(input.sendAfter);

  const rows = await db
    .select({
      entryId: entry.id,
      eventId: invoice.eventId,
      invoiceId: invoice.id,
      driverPersonId: invoice.driverPersonId,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      paymentStatus: invoice.paymentStatus,
      entryFeeCents: entry.entryFeeCents,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      eventName: event.name
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(event, eq(entry.eventId, event.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(eq(entry.eventId, input.eventId), eq(entry.id, input.entryId)))
    .limit(1);

  const current = rows[0];
  if (!current) {
    throw new Error('ENTRY_NOT_FOUND');
  }

  if (!current.email) {
    return { queued: 0, skipped: 1, reason: 'no_recipient', outboxIds: [] as string[] };
  }
  if (!current.driverPersonId) {
    return { queued: 0, skipped: 1, reason: 'no_recipient', outboxIds: [] as string[] };
  }
  const blockedRows = await db
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.id, current.driverPersonId), or(eq(person.processingRestricted, true), eq(person.objectionFlag, true))))
    .limit(1);
  if (blockedRows[0]) {
    return { queued: 0, skipped: 1, reason: 'processing_restricted', outboxIds: [] as string[] };
  }

  if (current.paymentStatus === 'paid') {
    return { queued: 0, skipped: 1, reason: 'not_allowed', outboxIds: [] as string[] };
  }

  const effectiveTotalCents = current.totalCents ?? current.entryFeeCents ?? 0;
  const effectivePaidAmountCents = current.paidAmountCents ?? 0;
  const amountOpenCents = Math.max(0, effectiveTotalCents - effectivePaidAmountCents);
  const amountOpenEur = formatEuroFromCents(amountOpenCents);

  const idempotencyKey = buildDedupeKey(
    'reminder',
    input.eventId,
    template.templateKey,
    template.templateVersion,
    current.email,
    {
      entryId: current.entryId,
      paymentStatus: current.paymentStatus ?? 'due',
      allowDuplicate: input.allowDuplicate ? randomUUID() : false
    }
  );

  if (!input.allowDuplicate) {
    const existing = await db.select({ id: emailOutbox.id }).from(emailOutbox).where(eq(emailOutbox.idempotencyKey, idempotencyKey)).limit(1);
    if (existing[0]) {
      return { queued: 0, skipped: 1, reason: 'duplicate', outboxIds: [existing[0].id] };
    }
  }

  const templateData = {
    ...(input.templateData ?? {}),
    entryId: current.entryId,
    driverPersonId: current.driverPersonId,
    driverName: `${current.firstName} ${current.lastName}`,
    eventName: current.eventName,
    totalCents: effectiveTotalCents,
    paidAmountCents: effectivePaidAmountCents,
    amountOpenCents,
    amountOpenEur
  };

  let createdId: string | null = null;
  try {
    const inserted = await db
      .insert(emailOutbox)
      .values({
        eventId: input.eventId,
        toEmail: current.email,
        subject: template.subjectTemplate,
        templateId: template.templateKey,
        templateVersion: template.templateVersion,
        templateData,
        status: 'queued',
        sendAfter,
        idempotencyKey,
        maxAttempts: 5
      })
      .returning({ id: emailOutbox.id });
    createdId = inserted[0]?.id ?? null;
  } catch (error) {
    if (isPgUniqueViolation(error) && !input.allowDuplicate) {
      const duplicated = await db.select({ id: emailOutbox.id }).from(emailOutbox).where(eq(emailOutbox.idempotencyKey, idempotencyKey)).limit(1);
      return { queued: 0, skipped: 1, reason: 'duplicate', outboxIds: duplicated[0] ? [duplicated[0].id] : [] };
    }
    throw error;
  }

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'payment_reminders_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: createdId ? 1 : 0,
      skipped: createdId ? 0 : 1,
      reason: createdId ? null : 'duplicate',
      outboxIds: createdId ? [createdId] : [],
      templateId: template.templateKey,
      templateVersion: template.templateVersion
    }
  });

  return {
    queued: createdId ? 1 : 0,
    skipped: createdId ? 0 : 1,
    reason: createdId ? undefined : 'duplicate',
    outboxIds: createdId ? [createdId] : []
  };
};

export const queueLifecycleMail = async (input: LifecycleInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const templateKey = templateKeyFromEventType(input.eventType);
  let template: Awaited<ReturnType<typeof resolveTemplate>>;
  try {
    template = await resolveTemplate(templateKey, input.templateVersion);
  } catch (error) {
    if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
      throw new LifecycleMailError('TEMPLATE_NOT_FOUND', 'template_not_found');
    }
    throw error;
  }
  const sendAfter = toIsoDate(input.sendAfter);

  const rows = await db
    .select({
      eventId: entry.eventId,
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      driverNote: entry.driverNote,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      totalCents: invoice.totalCents,
      paymentStatus: invoice.paymentStatus,
      eventName: event.name,
      className: eventClass.name,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(eq(entry.eventId, input.eventId), eq(entry.id, input.entryId)));

  if (rows.length === 0) {
    throw new LifecycleMailError('ENTRY_NOT_FOUND', 'entry_not_found');
  }
  if (!rows[0].email || rows[0].driverPersonId === null) {
    throw new LifecycleMailError('NO_RECIPIENT', 'entry_has_no_driver_email');
  }
  let blockedRows: Array<{ id: string }> = [];
  try {
    blockedRows = await db
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.id, rows[0].driverPersonId), or(eq(person.processingRestricted, true), eq(person.objectionFlag, true))))
      .limit(1);
  } catch (error) {
    if (!isUndefinedColumnError(error)) {
      throw new LifecycleMailError('NOT_ALLOWED', 'policy_guard_query_failed');
    }
    blockedRows = [];
  }
  if (blockedRows[0]) {
    throw new LifecycleMailError('NOT_ALLOWED', 'processing_restricted_or_objection');
  }

  const row = rows[0];
  const email = row.email as string;
  const driverName = `${row.firstName} ${row.lastName}`;
  const normalizedDriverNote = (row.driverNote ?? '').trim();
  const driverNoteBlock =
    normalizedDriverNote.length > 0 ? `\n\nHinweis vom Veranstalter:\n${normalizedDriverNote}` : '';
  const supportsDriverNoteInLifecycleMail = input.eventType === 'accepted_open_payment' || input.eventType === 'rejected';
  const includeDriverNoteInLifecycleMail = supportsDriverNoteInLifecycleMail && input.includeDriverNote;
  let templateData: Record<string, unknown> = {
    eventType: input.eventType,
    eventName: row.eventName,
    className: row.className,
    driverName,
    entryId: row.entryId,
    registrationStatus: row.registrationStatus,
    acceptanceStatus: row.acceptanceStatus,
    paymentStatus: row.paymentStatus ?? null,
    amountOpenCents: row.totalCents ?? 0,
    driverNote: includeDriverNoteInLifecycleMail && normalizedDriverNote.length > 0 ? normalizedDriverNote : null,
    driverNoteBlock: includeDriverNoteInLifecycleMail ? driverNoteBlock : '',
    paymentIban: process.env.PAYMENT_IBAN ?? '',
    paymentBic: process.env.PAYMENT_BIC ?? '',
    paymentRecipient: process.env.PAYMENT_RECIPIENT ?? ''
  };

  if (template.templateKey === 'registration_received') {
    let token: string;
    try {
      token = await upsertEntryVerificationToken(row.entryId, email);
    } catch {
      throw new LifecycleMailError('TEMPLATE_RENDER_FAILED', 'verification_token_upsert_failed');
    }
    const existingVerificationUrl = isNonEmptyString(templateData.verificationUrl) ? templateData.verificationUrl : null;
    const generatedVerificationUrl = buildPublicVerificationUrl(row.entryId, token);
    templateData = {
      ...templateData,
      verificationToken: token,
      verificationUrl: generatedVerificationUrl ?? existingVerificationUrl
    };
  }

  if (template.templateKey === 'registration_received') {
    if (!hasRequiredRegistrationReceivedVariables(templateData)) {
      throw new LifecycleMailError('TEMPLATE_RENDER_FAILED', 'missing_required_registration_received_variables');
    }
  }

  const renderedSubject = renderTemplateString(template.subjectTemplate, templateData).trim();
  const renderedBody = renderTemplateString(template.bodyTemplate, templateData).trim();
  if (!renderedSubject || !renderedBody) {
    throw new LifecycleMailError('TEMPLATE_RENDER_FAILED', 'rendered_subject_or_body_empty');
  }

  const lifecycleDedupeKey = buildDedupeKey(
    'lifecycle',
    input.eventId,
    template.templateKey,
    template.templateVersion,
    email,
    {
      entryId: row.entryId,
      eventType: input.eventType
    }
  );

  if (!input.allowDuplicate) {
    const existing = await findOutboxByIdempotencyKey(lifecycleDedupeKey);
    if (existing) {
      throw new DuplicateRequestError(existing.id, existing.sendAfter.toISOString());
    }
  }

  const idempotencyKey = input.allowDuplicate
    ? `${lifecycleDedupeKey}:allowDuplicate:${Date.now()}:${randomUUID()}`
    : lifecycleDedupeKey;

  let createdOutboxId: string | null = null;
  try {
    const inserted = await db
      .insert(emailOutbox)
      .values({
        eventId: input.eventId,
        toEmail: email,
        subject: template.subjectTemplate,
        templateId: template.templateKey,
        templateVersion: template.templateVersion,
        templateData,
        status: 'queued',
        sendAfter,
        idempotencyKey,
        maxAttempts: 5
      })
      .returning({ id: emailOutbox.id });
    createdOutboxId = inserted[0]?.id ?? null;
  } catch (error) {
    if (!input.allowDuplicate && error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
      const existing = await findOutboxByIdempotencyKey(lifecycleDedupeKey);
      throw new DuplicateRequestError(existing?.id ?? null, existing?.sendAfter?.toISOString() ?? null);
    }
    if (isPgUniqueViolation(error) && !input.allowDuplicate) {
      const existing = await findOutboxByIdempotencyKey(lifecycleDedupeKey);
      throw new DuplicateRequestError(existing?.id ?? null, existing?.sendAfter?.toISOString() ?? null);
    }
    if (error instanceof Error) {
      throw new LifecycleMailError('OUTBOX_INSERT_FAILED', error.message);
    }
    throw new LifecycleMailError('OUTBOX_INSERT_FAILED', 'unknown_outbox_insert_error');
  }

  if (!createdOutboxId) {
    throw new LifecycleMailError('OUTBOX_INSERT_FAILED', 'no_outbox_id_returned');
  }

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'lifecycle_email_queued',
    entityType: 'email_outbox',
    payload: {
      entryId: row.entryId,
      eventType: input.eventType,
      templateId: template.templateKey,
      templateVersion: template.templateVersion
    }
  });

  return { queued: 1, skipped: 0, outboxIds: [createdOutboxId] };
};

export const queueBroadcastMail = async (input: BroadcastInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const template = await resolveTemplate(input.templateKey, input.templateVersion, input.subjectOverride);
  const sendAfter = toIsoDate(input.sendAfter);

  const conditions: SQL<unknown>[] = [
    eq(entry.eventId, input.eventId),
    eq(person.processingRestricted, false),
    eq(person.objectionFlag, false)
  ];
  if (input.classId) {
    conditions.push(eq(entry.classId, input.classId));
  }
  if (input.acceptanceStatus) {
    conditions.push(eq(entry.acceptanceStatus, input.acceptanceStatus));
  }
  if (input.registrationStatus) {
    conditions.push(eq(entry.registrationStatus, input.registrationStatus));
  }

  const query = db
    .select({
      email: person.email,
      eventName: event.name,
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      firstName: person.firstName,
      lastName: person.lastName,
      paymentStatus: invoice.paymentStatus
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(event, eq(entry.eventId, event.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)));

  if (input.paymentStatus) {
    conditions.push(eq(invoice.paymentStatus, input.paymentStatus));
  } else {
    conditions.push(or(eq(invoice.paymentStatus, 'due'), eq(invoice.paymentStatus, 'paid'), isNull(invoice.paymentStatus)) as SQL<unknown>);
  }

  const rows = await query.where(and(...conditions));
  const targets = dedupeTargets(
    rows
      .filter((row) => row.email)
      .map((row) => ({
        email: row.email as string,
        driverPersonId: row.driverPersonId,
        entryId: row.entryId
      }))
  );
  if (targets.length === 0) {
    return { queued: 0 };
  }

  const sourceByEmail = new Map(
    rows.filter((row) => row.email).map((row) => [
      (row.email as string).toLowerCase(),
      {
        eventName: row.eventName,
        entryId: row.entryId,
        driverPersonId: row.driverPersonId,
        driverName: `${row.firstName} ${row.lastName}`,
        paymentStatus: row.paymentStatus ?? null
      }
    ])
  );

  const outboxRows = targets.map((target) => {
    const source = sourceByEmail.get(target.email.toLowerCase());
    return {
      toEmail: target.email,
      templateData: {
        eventName: source?.eventName ?? null,
        entryId: source?.entryId ?? null,
        driverPersonId: source?.driverPersonId ?? null,
        driverName: source?.driverName ?? null,
        paymentStatus: source?.paymentStatus ?? null
      },
      idempotencyKey: buildDedupeKey(
        'broadcast',
        input.eventId,
        template.templateKey,
        template.templateVersion,
        target.email,
        {
          classId: input.classId ?? null,
          acceptanceStatus: input.acceptanceStatus ?? null,
          registrationStatus: input.registrationStatus ?? null,
          paymentStatus: input.paymentStatus ?? null
        }
      )
    };
  });

  await insertOutboxRows(
    input.eventId,
    template.templateKey,
    template.templateVersion,
    template.subjectTemplate,
    sendAfter,
    outboxRows
  );

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'broadcast_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: outboxRows.length,
      templateId: template.templateKey,
      templateVersion: template.templateVersion
    }
  });

  return { queued: outboxRows.length };
};

export const listOutbox = async (input: ListOutboxInput) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [eq(emailOutbox.eventId, input.eventId)];
  if (input.status) {
    conditions.push(eq(emailOutbox.status, input.status));
  }
  const rows = await db
    .select({
      id: emailOutbox.id,
      eventId: emailOutbox.eventId,
      toEmail: emailOutbox.toEmail,
      subject: emailOutbox.subject,
      templateId: emailOutbox.templateId,
      templateVersion: emailOutbox.templateVersion,
      status: emailOutbox.status,
      attemptCount: emailOutbox.attemptCount,
      maxAttempts: emailOutbox.maxAttempts,
      errorLast: emailOutbox.errorLast,
      sendAfter: emailOutbox.sendAfter,
      createdAt: emailOutbox.createdAt,
      updatedAt: emailOutbox.updatedAt
    })
    .from(emailOutbox)
    .where(and(...conditions));

  const paginationQuery = parseListQuery(
    {
      cursor: input.cursor,
      limit: input.limit?.toString(),
      sortBy: input.sortBy,
      sortDir: input.sortDir
    },
    ['createdAt', 'sendAfter', 'updatedAt', 'status'],
    'createdAt',
    'asc'
  );

  return paginateAndSortRows(rows, paginationQuery);
};

export const retryOutboxMail = async (outboxId: string, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  if (existing.status !== 'failed' && existing.status !== 'queued') {
    throw new Error('OUTBOX_RETRY_FORBIDDEN_STATUS');
  }

  const [updated] = await db
    .update(emailOutbox)
    .set({
      status: 'queued',
      sendAfter: now,
      errorLast: null,
      updatedAt: now
    })
    .where(eq(emailOutbox.id, outboxId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'email_outbox_retry_requested',
    entityType: 'email_outbox',
    entityId: existing.id,
    payload: {
      previousStatus: existing.status
    }
  });

  return updated ?? null;
};

export const validateQueueMailInput = (payload: unknown) => queueMailSchema.parse(payload);
export const validateReminderInput = (payload: unknown) => reminderSchema.parse(payload);
export const validateLifecycleInput = (payload: unknown) => lifecycleSchema.parse(payload);
export const validateBroadcastInput = (payload: unknown) => broadcastSchema.parse(payload);
export const validateListOutboxInput = (query: Record<string, string | undefined>) =>
  listOutboxSchema.parse({
    eventId: query.eventId,
    status: query.status,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    sortBy: query.sortBy,
    sortDir: query.sortDir
  });
