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
  templateId: z.string().min(1),
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
    subjectTemplate: subjectOverride ?? template.subjectTemplate
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
    return dedupeTargets(
      input.recipientEmails.map((email) => ({
        email,
        driverPersonId: null,
        entryId: null
      }))
    );
  }

  if (input.driverPersonIds) {
    const rows = await db
      .select({ email: person.email, driverPersonId: person.id })
      .from(person)
      .where(inArray(person.id, input.driverPersonIds));
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
      .where(inArray(entry.id, input.entryIds));
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
    const conditions: SQL<unknown>[] = [eq(entry.eventId, input.eventId)];
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
      eventId: invoice.eventId,
      invoiceId: invoice.id,
      driverPersonId: invoice.driverPersonId,
      totalCents: invoice.totalCents,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      eventName: event.name
    })
    .from(invoice)
    .innerJoin(person, eq(invoice.driverPersonId, person.id))
    .innerJoin(event, eq(invoice.eventId, event.id))
    .where(and(eq(invoice.eventId, input.eventId), eq(invoice.paymentStatus, 'due')));

  const targets = dedupeTargets(
    rows
      .filter((row) => row.email)
      .map((row) => ({
        email: row.email as string,
        driverPersonId: row.driverPersonId,
        entryId: null
      }))
  );
  if (targets.length === 0) {
    return { queued: 0 };
  }

  const sourceByEmail = new Map(
    rows.filter((row) => row.email).map((row) => [
      (row.email as string).toLowerCase(),
      {
        invoiceId: row.invoiceId,
        driverPersonId: row.driverPersonId,
        totalCents: row.totalCents,
        driverName: `${row.firstName} ${row.lastName}`,
        eventName: row.eventName
      }
    ])
  );

  const outboxRows = targets.map((target) => {
    const source = sourceByEmail.get(target.email.toLowerCase());
    const templateData = {
      ...(input.templateData ?? {}),
      driverName: source?.driverName ?? null,
      eventName: source?.eventName ?? null,
      amountOpenCents: source?.totalCents ?? null
    };
    return {
      toEmail: target.email,
      templateData,
      idempotencyKey: buildDedupeKey(
        'reminder',
        input.eventId,
        template.templateKey,
        template.templateVersion,
        target.email,
        {
          invoiceId: source?.invoiceId ?? null,
          paymentStatus: 'due'
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
    action: 'payment_reminders_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: outboxRows.length,
      templateId: template.templateKey,
      templateVersion: template.templateVersion
    }
  });

  return { queued: outboxRows.length };
};

export const queueLifecycleMail = async (input: LifecycleInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const templateKey = templateKeyFromEventType(input.eventType);
  const template = await resolveTemplate(templateKey, input.templateVersion);
  const sendAfter = toIsoDate(input.sendAfter);

  const rows = await db
    .select({
      eventId: entry.eventId,
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
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

  if (rows.length === 0 || !rows[0].email) {
    return { queued: 0 };
  }

  const row = rows[0];
  const email = row.email as string;
  const driverName = `${row.firstName} ${row.lastName}`;
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
    paymentIban: process.env.PAYMENT_IBAN ?? '',
    paymentBic: process.env.PAYMENT_BIC ?? '',
    paymentRecipient: process.env.PAYMENT_RECIPIENT ?? ''
  };

  if (template.templateKey === 'registration_received') {
    const token = await upsertEntryVerificationToken(row.entryId, email);
    const existingVerificationUrl = isNonEmptyString(templateData.verificationUrl) ? templateData.verificationUrl : null;
    const generatedVerificationUrl = buildPublicVerificationUrl(row.entryId, token);
    templateData = {
      ...templateData,
      verificationToken: token,
      verificationUrl: generatedVerificationUrl ?? existingVerificationUrl
    };
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

  try {
    await insertOutboxRows(
      input.eventId,
      template.templateKey,
      template.templateVersion,
      template.subjectTemplate,
      sendAfter,
      [
        {
          toEmail: email,
          templateData,
          idempotencyKey
        }
      ]
    );
  } catch (error) {
    if (!input.allowDuplicate && error instanceof Error && error.message === 'UNIQUE_VIOLATION') {
      const existing = await findOutboxByIdempotencyKey(lifecycleDedupeKey);
      throw new DuplicateRequestError(existing?.id ?? null, existing?.sendAfter?.toISOString() ?? null);
    }
    throw error;
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

  return { queued: 1 };
};

export const queueBroadcastMail = async (input: BroadcastInput, actorUserId: string | null) => {
  const db = await getDb();
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const template = await resolveTemplate(input.templateKey, input.templateVersion, input.subjectOverride);
  const sendAfter = toIsoDate(input.sendAfter);

  const conditions: SQL<unknown>[] = [eq(entry.eventId, input.eventId)];
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
