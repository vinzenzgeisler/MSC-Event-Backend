import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  emailOutboxAttachment,
  emailOutbox,
  emailTemplate,
  emailTemplateVersion,
  entry,
  event,
  eventClass,
  eventPricingRule,
  invoice,
  mailAttachmentUpload,
  person,
  registrationGroupEmailVerification,
  vehicle
} from '../db/schema';
import { isPgUniqueViolation } from '../http/dbErrors';
import { writeAuditLog } from '../audit/log';
import { getTemplateVersion } from '../mail/templateStore';
import { buildPublicVerificationUrl } from '../mail/verificationUrl';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';
import { PLACEHOLDER_CATALOG, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from '../mail/placeholders';
import { renderMailContract } from '../mail/rendering';
import { CAMPAIGN_TEMPLATE_KEYS, getTemplateContract, MailRenderOptions } from '../mail/templateContracts';
import { getAssetObjectMetadata, getPresignedAssetsUploadUrl } from '../docs/storage';
import { getMailChromeCopy, getProcessTemplateCopy, resolveMailLocale } from '../mail/i18n';
import { getOrCreateEntryConfirmationAttachment } from '../docs/entryConfirmation';

type RecipientFilter = {
  acceptanceStatus?: 'pending' | 'shortlist' | 'accepted' | 'rejected';
  registrationStatus?: 'submitted_unverified' | 'submitted_verified';
  paymentStatus?: 'due' | 'paid';
  classId?: string;
};

const hasRecipientFilter = (filters: RecipientFilter | undefined): boolean =>
  Boolean(filters?.acceptanceStatus || filters?.registrationStatus || filters?.paymentStatus || filters?.classId);

const DISABLED_LIFECYCLE_EVENTS = new Set<LifecycleInput['eventType']>(['preselection']);
const MAX_CAMPAIGN_ATTACHMENTS = 3;
const MAX_ATTACHMENT_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_SIZE_BYTES = 15 * 1024 * 1024;

const assertCampaignTemplateAllowed = (templateKey: string) => {
  if (!CAMPAIGN_TEMPLATE_KEYS.has(templateKey)) {
    throw new Error('TEMPLATE_NOT_ALLOWED_IN_CAMPAIGN');
  }
};

const renderOptionsSchema = z
  .object({
    showBadge: z.boolean().optional(),
    mailLabel: z.string().nullable().optional(),
    includeEntryContext: z.boolean().optional()
  })
  .optional();

const queueMailSchema = z
  .object({
    eventId: z.string().uuid(),
    templateId: z.string().min(1).optional(),
    templateKey: z.string().min(1).optional(),
    templateVersion: z.number().int().positive().optional(),
    subject: z.string().min(1).optional(),
    subjectOverride: z.string().min(1).optional(),
    bodyOverride: z.string().min(1).optional(),
    bodyHtmlOverride: z.string().min(1).optional(),
    templateData: z.record(z.unknown()).optional(),
    attachmentUploadIds: z.array(z.string().uuid()).max(MAX_CAMPAIGN_ATTACHMENTS).optional(),
    renderOptions: renderOptionsSchema,
    sendAfter: z.string().datetime().optional(),
    recipientEmails: z.array(z.string().email()).optional(),
    additionalEmails: z.array(z.string().email()).optional(),
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
  .refine((value) => Boolean(value.templateId || value.templateKey), { message: 'Provide templateId or templateKey.' })
  .refine(
    (value) =>
      (value.recipientEmails && value.recipientEmails.length > 0) ||
      (value.additionalEmails && value.additionalEmails.length > 0) ||
      (value.driverPersonIds && value.driverPersonIds.length > 0) ||
      (value.entryIds && value.entryIds.length > 0) ||
      hasRecipientFilter(value.filters),
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
    'email_confirmation_reminder',
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

const templateCreateSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  isActive: z.boolean().optional().default(true),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  bodyHtml: z.string().min(1).optional(),
  status: z.enum(['draft', 'published']).optional().default('draft')
});

const templatePatchSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    subject: z.string().min(1).optional(),
    bodyText: z.string().min(1).optional(),
    bodyHtml: z.string().min(1).optional(),
    status: z.enum(['draft', 'published']).optional(),
    isActive: z.boolean().optional()
  })
  .refine(
    (value) =>
      value.label !== undefined ||
      value.subject !== undefined ||
      value.bodyText !== undefined ||
      value.bodyHtml !== undefined ||
      value.status !== undefined ||
      value.isActive !== undefined,
    {
    message: 'Provide at least one field to update'
  });

const templateVersionCreateSchema = z.object({
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  bodyHtml: z.string().min(1).optional(),
  status: z.enum(['draft', 'published']).optional().default('draft')
});

const templatePreviewSchema = z.object({
  templateKey: z.string().min(1),
  entryId: z.string().uuid().optional(),
  templateData: z.record(z.unknown()).optional(),
  sampleData: z.record(z.unknown()).optional(),
  attachmentUploadIds: z.array(z.string().uuid()).max(MAX_CAMPAIGN_ATTACHMENTS).optional(),
  subjectOverride: z.string().min(1).optional(),
  bodyOverride: z.string().min(1).optional(),
  bodyHtmlOverride: z.string().min(1).optional(),
  renderOptions: renderOptionsSchema,
  previewMode: z.enum(['stored', 'draft']).optional().default('stored')
});

const communicationSendSchema = z
  .object({
    eventId: z.string().uuid(),
    templateId: z.string().min(1).optional(),
    templateKey: z.string().min(1).optional(),
    templateVersion: z.number().int().positive().optional(),
    subject: z.string().min(1).optional(),
    subjectOverride: z.string().min(1).optional(),
    bodyOverride: z.string().min(1).optional(),
    bodyHtmlOverride: z.string().min(1).optional(),
    templateData: z.record(z.unknown()).optional(),
    attachmentUploadIds: z.array(z.string().uuid()).max(MAX_CAMPAIGN_ATTACHMENTS).optional(),
    renderOptions: renderOptionsSchema,
    sendAfter: z.string().datetime().optional(),
    additionalEmails: z.array(z.string().email()).optional(),
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
  .refine((value) => Boolean(value.templateId || value.templateKey), { message: 'Provide templateId or templateKey.' })
  .refine(
    (value) =>
      (value.additionalEmails && value.additionalEmails.length > 0) ||
      (value.driverPersonIds && value.driverPersonIds.length > 0) ||
      (value.entryIds && value.entryIds.length > 0) ||
      hasRecipientFilter(value.filters),
    { message: 'Provide additionalEmails, driverPersonIds, entryIds, or filters.' }
  );

const listTemplateVersionsSchema = z.object({
  key: z.string().trim().min(1)
});

const resolveRecipientsSchema = z.object({
  eventId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  driverPersonIds: z.array(z.string().uuid()).optional(),
  entryIds: z.array(z.string().uuid()).optional(),
  additionalEmails: z.array(z.string().email()).optional()
});

const searchRecipientsSchema = z.object({
  eventId: z.string().uuid(),
  q: z.string().trim().optional(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20)
});

const attachmentUploadInitSchema = z.object({
  eventId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.literal('application/pdf'),
  fileSizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_FILE_SIZE_BYTES)
});

const attachmentUploadFinalizeSchema = z.object({
  uploadId: z.string().uuid(),
  eventId: z.string().uuid()
});

type QueueMailInput = z.infer<typeof queueMailSchema>;
type ReminderInput = z.infer<typeof reminderSchema>;
type LifecycleInput = z.infer<typeof lifecycleSchema>;
type BroadcastInput = z.infer<typeof broadcastSchema>;
type ListOutboxInput = z.infer<typeof listOutboxSchema>;
type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
type TemplatePatchInput = z.infer<typeof templatePatchSchema>;
type TemplateVersionCreateInput = z.infer<typeof templateVersionCreateSchema>;
type TemplatePreviewInput = z.infer<typeof templatePreviewSchema>;
type CommunicationSendInput = z.infer<typeof communicationSendSchema>;
type ResolveRecipientsInput = z.infer<typeof resolveRecipientsSchema>;
type SearchRecipientsInput = z.infer<typeof searchRecipientsSchema>;
type AttachmentUploadInitInput = z.infer<typeof attachmentUploadInitSchema>;
type AttachmentUploadFinalizeInput = z.infer<typeof attachmentUploadFinalizeSchema>;

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

export class MissingRequiredPlaceholdersError extends Error {
  public readonly missingPlaceholders: string[];
  public readonly recipientEmail: string | null;
  public readonly templateKey: string | null;

  constructor(missingPlaceholders: string[], recipientEmail: string | null = null, templateKey: string | null = null) {
    super('MISSING_REQUIRED_PLACEHOLDERS');
    this.missingPlaceholders = missingPlaceholders;
    this.recipientEmail = recipientEmail;
    this.templateKey = templateKey;
  }
}

const normalizeRenderOptions = (templateKey: string, input?: MailRenderOptions): MailRenderOptions => {
  const contract = getTemplateContract(templateKey);
  const mailLabel =
    input?.mailLabel === undefined
      ? contract.renderOptions.defaultMailLabel
      : input.mailLabel === null
        ? null
        : input.mailLabel.trim().length > 0
          ? input.mailLabel.trim()
          : null;
  return {
    showBadge: input?.showBadge ?? contract.renderOptions.showBadgeDefault,
    mailLabel,
    includeEntryContext: input?.includeEntryContext ?? contract.renderOptions.includeEntryContextDefault
  };
};

export type LifecycleMailErrorCode =
  | 'NO_RECIPIENT'
  | 'NOT_ALLOWED'
  | 'TEMPLATE_RENDER_FAILED'
  | 'OUTBOX_INSERT_FAILED'
  | 'TEMPLATE_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_CONFIRMATION_PDF_GENERATION_FAILED';

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
  },
  ENTRY_CONFIRMATION_PDF_GENERATION_FAILED: {
    statusCode: 500,
    message: 'Entry confirmation PDF generation failed'
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
  registrationGroupId: string | null;
  eventName: string | null;
  firstName: string | null;
  lastName: string | null;
  driverName: string | null;
};

type QueuedAttachmentRef = {
  fileName: string;
  contentType: 'application/pdf';
  s3Key: string;
  fileSizeBytes: number | null;
  source: 'upload' | 'system' | 'document';
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

const formatEventDateText = (startsAt: string | Date | null, endsAt: string | Date | null): string | null => {
  const normalize = (value: string | Date | null): Date | null => {
    if (!value) {
      return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const from = normalize(startsAt);
  const to = normalize(endsAt);
  if (!from && !to) {
    return null;
  }
  const format = (value: Date) =>
    new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Berlin'
    }).format(value);
  if (from && to) {
    return `${format(from)} - ${format(to)}`;
  }
  return format((from ?? to) as Date);
};

const formatDateOnlyText = (value: string | Date | null): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

const getFallbackContactEmail = (): string | null => {
  const candidate = (process.env.MAIL_CONTACT_EMAIL ?? process.env.SES_FROM_EMAIL ?? '').trim();
  return candidate.length > 0 ? candidate : null;
};

const getEventMailDefaults = async (eventId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      contactEmail: event.contactEmail
    })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      eventName: null,
      eventDateText: null,
      contactEmail: getFallbackContactEmail(),
      nennungstoolUrl: process.env.MAIL_PUBLIC_BASE_URL ?? process.env.NENNUNGSTOOL_URL ?? null
    };
  }
  return {
    eventName: row.name,
    eventDateText: formatEventDateText(row.startsAt, row.endsAt),
    contactEmail: row.contactEmail ?? getFallbackContactEmail(),
    nennungstoolUrl: process.env.MAIL_PUBLIC_BASE_URL ?? process.env.NENNUNGSTOOL_URL ?? null
  };
};

const normalizePdfFileName = (value: string): string => {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 200);
  if (!safe.toLowerCase().endsWith('.pdf')) {
    return `${safe || 'attachment'}.pdf`;
  }
  return safe;
};

const validateAttachmentBundle = (attachments: QueuedAttachmentRef[]) => {
  if (attachments.length > MAX_CAMPAIGN_ATTACHMENTS) {
    throw new Error('ATTACHMENT_LIMIT_EXCEEDED');
  }
  let totalSize = 0;
  attachments.forEach((attachment) => {
    if (attachment.contentType !== 'application/pdf') {
      throw new Error('ATTACHMENT_INVALID_CONTENT_TYPE');
    }
    const size = attachment.fileSizeBytes ?? 0;
    if (size > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
      throw new Error('ATTACHMENT_FILE_TOO_LARGE');
    }
    totalSize += size;
  });
  if (totalSize > MAX_ATTACHMENT_TOTAL_SIZE_BYTES) {
    throw new Error('ATTACHMENT_TOTAL_SIZE_EXCEEDED');
  }
};

const resolveUploadAttachments = async (eventId: string, uploadIds: string[] | undefined): Promise<QueuedAttachmentRef[]> => {
  if (!uploadIds || uploadIds.length === 0) {
    return [];
  }
  const uniqueIds = Array.from(new Set(uploadIds));
  if (uniqueIds.length > MAX_CAMPAIGN_ATTACHMENTS) {
    throw new Error('ATTACHMENT_LIMIT_EXCEEDED');
  }
  const db = await getDb();
  const rows = await db
    .select({
      id: mailAttachmentUpload.id,
      eventId: mailAttachmentUpload.eventId,
      s3Key: mailAttachmentUpload.s3Key,
      contentType: mailAttachmentUpload.contentType,
      fileName: mailAttachmentUpload.fileName,
      fileSizeBytes: mailAttachmentUpload.fileSizeBytes,
      status: mailAttachmentUpload.status,
      expiresAt: mailAttachmentUpload.expiresAt
    })
    .from(mailAttachmentUpload)
    .where(inArray(mailAttachmentUpload.id, uniqueIds));

  if (rows.length !== uniqueIds.length) {
    throw new Error('ATTACHMENT_UPLOAD_NOT_FOUND');
  }
  const now = new Date();
  const attachments = rows.map((row) => {
    if (row.eventId !== eventId) {
      throw new Error('ATTACHMENT_UPLOAD_EVENT_MISMATCH');
    }
    if (row.status !== 'finalized' || row.expiresAt <= now) {
      throw new Error('ATTACHMENT_UPLOAD_NOT_FINALIZED');
    }
    if (row.contentType !== 'application/pdf') {
      throw new Error('ATTACHMENT_INVALID_CONTENT_TYPE');
    }
    return {
      fileName: normalizePdfFileName(row.fileName),
      contentType: 'application/pdf' as const,
      s3Key: row.s3Key,
      fileSizeBytes: row.fileSizeBytes,
      source: 'upload' as const
    };
  });
  validateAttachmentBundle(attachments);
  return attachments;
};

const resolvePaymentDeadlineDefault = async (eventId: string): Promise<string | null> => {
  const db = await getDb();
  const rows = await db
    .select({ earlyDeadline: eventPricingRule.earlyDeadline })
    .from(eventPricingRule)
    .where(eq(eventPricingRule.eventId, eventId))
    .limit(1);
  return formatDateOnlyText(rows[0]?.earlyDeadline ?? null);
};

const enrichEntryContextTemplateData = async (
  eventId: string,
  currentData: Record<string, unknown>,
  target: RecipientTarget
): Promise<Record<string, unknown>> => {
  const db = await getDb();
  const byEntryId = toUuidOrNull(target.entryId) ?? toUuidOrNull(currentData.entryId);
  const byDriverPersonId = toUuidOrNull(target.driverPersonId) ?? toUuidOrNull(currentData.driverPersonId);
  if (!byEntryId && !byDriverPersonId) {
    // Recipient-only mails can intentionally have no entry/person binding.
    return currentData;
  }
  const rows = await db
    .select({
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(
      byEntryId
        ? and(eq(entry.eventId, eventId), eq(entry.id, byEntryId), sql`${entry.deletedAt} is null`)
        : and(eq(entry.eventId, eventId), eq(entry.driverPersonId, byDriverPersonId as string), sql`${entry.deletedAt} is null`)
    )
    .orderBy(desc(entry.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return currentData;
  }

  const vehicleLabel = [row.vehicleType, row.vehicleMake, row.vehicleModel]
    .filter((item): item is string => Boolean(item && item.trim().length > 0))
    .join(' · ');
  const amountOpen = formatAmountOpen(row.totalCents ?? 0, row.paidAmountCents ?? 0);

  return {
    ...currentData,
    className: currentData.className ?? row.className,
    startNumber: currentData.startNumber ?? row.startNumber,
    vehicleType: currentData.vehicleType ?? row.vehicleType,
    vehicleMake: currentData.vehicleMake ?? row.vehicleMake,
    vehicleModel: currentData.vehicleModel ?? row.vehicleModel,
    vehicleLabel: (currentData.vehicleLabel ?? vehicleLabel) || null,
    amountOpen: currentData.amountOpen ?? amountOpen
  };
};

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toUuidOrNull = (value: unknown): string | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
};

export const hasRequiredRegistrationReceivedVariables = (templateData: Record<string, unknown>): boolean =>
  Boolean(templateData.eventName && templateData.driverName && templateData.verificationUrl);

const isUndefinedColumnError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === '42703';

const upsertRegistrationGroupVerificationToken = async (registrationGroupId: string, seed: string): Promise<string> => {
  const db = await getDb();
  const now = new Date();
  const existingRows = await db
    .select({
      token: registrationGroupEmailVerification.token,
      expiresAt: registrationGroupEmailVerification.expiresAt,
      verifiedAt: registrationGroupEmailVerification.verifiedAt
    })
    .from(registrationGroupEmailVerification)
    .where(eq(registrationGroupEmailVerification.registrationGroupId, registrationGroupId))
    .limit(1);
  const existing = existingRows[0];
  if (existing && existing.expiresAt > now && existing.verifiedAt === null) {
    return existing.token;
  }

  const token = createHash('sha256').update(`${randomUUID()}:${seed}:${Date.now()}`).digest('hex');
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24);

  await db
    .insert(registrationGroupEmailVerification)
    .values({
      registrationGroupId,
      token,
      expiresAt,
      verifiedAt: null,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: registrationGroupEmailVerification.registrationGroupId,
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
        registrationGroupId: entry.registrationGroupId,
        eventName: event.name,
        driverFirstName: person.firstName,
        driverLastName: person.lastName
      })
      .from(entry)
      .innerJoin(event, eq(entry.eventId, event.id))
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(eq(entry.id, candidateEntryId), eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
      .limit(1);
    const row = rows[0];
    if (row) {
      const firstName = row.driverFirstName?.trim() ?? null;
      const lastName = row.driverLastName?.trim() ?? null;
      return {
        entryId: row.entryId,
        registrationGroupId: row.registrationGroupId,
        eventName: row.eventName,
        firstName,
        lastName,
        driverName: [firstName, lastName].filter((item): item is string => Boolean(item && item.length > 0)).join(' ').trim() || null
      };
    }
  }

  const rows = await db
    .select({
      entryId: entry.id,
      registrationGroupId: entry.registrationGroupId,
      eventName: event.name,
      driverFirstName: person.firstName,
      driverLastName: person.lastName
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(and(eq(entry.eventId, eventId), eq(person.email, target.email), sql`${entry.deletedAt} is null`))
    .orderBy(desc(entry.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      entryId: candidateEntryId,
      registrationGroupId: null,
      eventName: isNonEmptyString(templateData?.eventName) ? templateData.eventName : null,
      firstName: isNonEmptyString(templateData?.firstName) ? templateData.firstName : null,
      lastName: isNonEmptyString(templateData?.lastName) ? templateData.lastName : null,
      driverName: isNonEmptyString(templateData?.driverName) ? templateData.driverName : null
    };
  }
  const firstName = row.driverFirstName?.trim() ?? null;
  const lastName = row.driverLastName?.trim() ?? null;
  return {
    entryId: row.entryId,
    registrationGroupId: row.registrationGroupId,
    eventName: row.eventName,
    firstName,
    lastName,
    driverName: [firstName, lastName].filter((item): item is string => Boolean(item && item.length > 0)).join(' ').trim() || null
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
    bodyTemplate: template.bodyTextTemplate,
    bodyHtmlTemplate: template.bodyHtmlTemplate,
    bodyTextTemplate: template.bodyTextTemplate
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
  const collected: RecipientTarget[] = [];

  const recipientEmails = [...(input.recipientEmails ?? []), ...(input.additionalEmails ?? [])];
  if (recipientEmails.length > 0) {
    const candidates = dedupeTargets(
      recipientEmails.map((email) => ({
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
    collected.push(...candidates.filter((candidate) => !blocked.has(candidate.email.toLowerCase())));
  }

  if (input.driverPersonIds && input.driverPersonIds.length > 0) {
    const rows = await db
      .select({ email: person.email, driverPersonId: person.id })
      .from(person)
      .where(and(inArray(person.id, input.driverPersonIds), eq(person.processingRestricted, false), eq(person.objectionFlag, false)));
    collected.push(
      ...
      rows
        .filter((row) => row.email)
        .map((row) => ({
          email: row.email as string,
          driverPersonId: row.driverPersonId,
          entryId: null
        }))
    );
  }

  if (input.entryIds && input.entryIds.length > 0) {
    const rows = await db
      .select({
        email: person.email,
        driverPersonId: entry.driverPersonId,
        entryId: entry.id
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(inArray(entry.id, input.entryIds), eq(person.processingRestricted, false), eq(person.objectionFlag, false)));
    collected.push(
      ...
      rows
        .filter((row) => row.email)
        .map((row) => ({
          email: row.email as string,
          driverPersonId: row.driverPersonId,
          entryId: row.entryId
        }))
    );
  }

  if (hasRecipientFilter(input.filters)) {
    const filters = input.filters as NonNullable<QueueMailInput['filters']>;
    const conditions: SQL<unknown>[] = [
      eq(entry.eventId, input.eventId),
      eq(person.processingRestricted, false),
      eq(person.objectionFlag, false)
    ];
    if (filters.acceptanceStatus) {
      conditions.push(eq(entry.acceptanceStatus, filters.acceptanceStatus));
    }
    if (filters.registrationStatus) {
      conditions.push(eq(entry.registrationStatus, filters.registrationStatus));
    }
    if (filters.classId) {
      conditions.push(eq(entry.classId, filters.classId));
    }

    const query = db
      .select({
        email: person.email,
        driverPersonId: entry.driverPersonId,
        entryId: entry.id
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id));

    if (filters.paymentStatus) {
      const rows = await query
        .innerJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
        .where(and(...conditions, eq(invoice.paymentStatus, filters.paymentStatus)));

      collected.push(
        ...
        rows
          .filter((row) => row.email)
          .map((row) => ({
            email: row.email as string,
            driverPersonId: row.driverPersonId,
            entryId: row.entryId
          }))
      );
    } else {
      const rows = await query.where(and(...conditions));
      collected.push(
        ...
        rows
          .filter((row) => row.email)
          .map((row) => ({
            email: row.email as string,
            driverPersonId: row.driverPersonId,
            entryId: row.entryId
          }))
      );
    }
  }

  return dedupeTargets(collected);
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
    attachments?: QueuedAttachmentRef[];
  }>
) => {
  const db = await getDb();
  if (rows.length === 0) {
    return;
  }

  try {
    const inserted = await db.insert(emailOutbox).values(
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
    ).returning({
      id: emailOutbox.id,
      idempotencyKey: emailOutbox.idempotencyKey
    });

    const idByDedupe = new Map(inserted.map((item) => [item.idempotencyKey, item.id]));
    const attachmentRows = rows.flatMap((row) => {
      const outboxId = idByDedupe.get(row.idempotencyKey);
      if (!outboxId || !row.attachments || row.attachments.length === 0) {
        return [];
      }
      return row.attachments.map((attachment) => ({
        outboxId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        s3Key: attachment.s3Key,
        fileSizeBytes: attachment.fileSizeBytes,
        source: attachment.source
      }));
    });

    if (attachmentRows.length > 0) {
      await db.insert(emailOutboxAttachment).values(attachmentRows);
    }
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

  const templateKey = input.templateKey ?? input.templateId;
  if (!templateKey) {
    throw new Error('TEMPLATE_NOT_FOUND');
  }
  const template = await resolveTemplate(templateKey, input.templateVersion, input.subjectOverride ?? input.subject);
  const sendAfter = toIsoDate(input.sendAfter);
  const eventMailDefaults = await getEventMailDefaults(input.eventId);
  const paymentDeadlineDefault =
    template.templateKey === 'payment_reminder_followup' ? await resolvePaymentDeadlineDefault(input.eventId) : null;
  const templateContract = getTemplateContract(template.templateKey);
  if (templateContract.scope !== 'campaign' && input.attachmentUploadIds && input.attachmentUploadIds.length > 0) {
    throw new Error('ATTACHMENT_NOT_ALLOWED_FOR_PROCESS');
  }
  const uploadAttachments =
    templateContract.scope === 'campaign'
      ? await resolveUploadAttachments(input.eventId, input.attachmentUploadIds)
      : [];
  const renderOptions = normalizeRenderOptions(template.templateKey, input.renderOptions);
  const hasContentOverride = Boolean(input.bodyOverride || input.bodyHtmlOverride);

  const outboxRows = await Promise.all(
    targets.map(async (target) => {
      let templateData: Record<string, unknown> = {
        ...eventMailDefaults,
        ...(input.templateData ?? {}),
        ...(paymentDeadlineDefault && !isNonEmptyString(input.templateData?.paymentDeadline)
          ? { paymentDeadline: paymentDeadlineDefault }
          : {}),
        renderOptions,
        driverPersonId: target.driverPersonId,
        entryId: target.entryId,
        bodyTextOverride: input.bodyOverride ?? null,
        bodyHtmlOverride: input.bodyHtmlOverride ?? null
      };
      const locale = resolveMailLocale(templateData);
      templateData = {
        ...templateData,
        locale
      };

      templateData = await enrichEntryContextTemplateData(input.eventId, templateData, target);

      if (
        template.templateKey === 'registration_received' ||
        template.templateKey === 'email_confirmation' ||
        template.templateKey === 'email_confirmation_reminder'
      ) {
        const context = await resolveRegistrationContext(input.eventId, target, input.templateData);
        let generatedVerificationUrl: string | null = null;
        if (context.entryId && context.registrationGroupId) {
          const token = await upsertRegistrationGroupVerificationToken(context.registrationGroupId, target.email);
          generatedVerificationUrl = buildPublicVerificationUrl(context.entryId, token);
          templateData = {
            ...templateData,
            entryId: context.entryId,
            eventName: isNonEmptyString(templateData.eventName) ? templateData.eventName : context.eventName,
            firstName: isNonEmptyString(templateData.firstName) ? templateData.firstName : context.firstName,
            lastName: isNonEmptyString(templateData.lastName) ? templateData.lastName : context.lastName,
            driverName: isNonEmptyString(templateData.driverName) ? templateData.driverName : context.driverName,
            verificationToken: token,
            verificationUrl: generatedVerificationUrl ?? (isNonEmptyString(templateData.verificationUrl) ? templateData.verificationUrl : null)
          };
        } else {
          templateData = {
            ...templateData,
            eventName: isNonEmptyString(templateData.eventName) ? templateData.eventName : context.eventName,
            firstName: isNonEmptyString(templateData.firstName) ? templateData.firstName : context.firstName,
            lastName: isNonEmptyString(templateData.lastName) ? templateData.lastName : context.lastName,
            driverName: isNonEmptyString(templateData.driverName) ? templateData.driverName : context.driverName
          };
        }
        if (!isNonEmptyString(templateData.verificationUrl) && generatedVerificationUrl) {
          templateData = {
            ...templateData,
            verificationUrl: generatedVerificationUrl
          };
        }
        if (!isNonEmptyString(templateData.verificationUrl)) {
          throw new Error('MISSING_VERIFICATION_URL');
        }
      }

      const renderValidation = renderMailContract({
        templateKey: template.templateKey,
        subjectTemplate: template.subjectTemplate,
        bodyTextTemplate: input.bodyOverride ?? template.bodyTextTemplate,
        bodyHtmlTemplate: input.bodyHtmlOverride ?? template.bodyHtmlTemplate,
        data: templateData,
        renderOptions,
        hasContentOverride
      });
      if (renderValidation.missingPlaceholders.length > 0) {
        throw new MissingRequiredPlaceholdersError(renderValidation.missingPlaceholders, target.email, template.templateKey);
      }

      return {
        toEmail: target.email,
        templateData,
        attachments: uploadAttachments,
        idempotencyKey: buildDedupeKey(
          'mail',
          input.eventId,
          template.templateKey,
          template.templateVersion,
          target.email,
          {
            sendAfter: sendAfter.toISOString(),
            templateData,
            attachmentKeys: uploadAttachments.map((item) => item.s3Key),
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
  const amountOpen = `${amountOpenEur} EUR`;

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
    amountOpenEur,
    amountOpen
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
  if (DISABLED_LIFECYCLE_EVENTS.has(input.eventType)) {
    throw new Error('TEMPLATE_NOT_ALLOWED_IN_PROCESS');
  }
  const templateKey = templateKeyFromEventType(input.eventType);
  if (getTemplateContract(templateKey).scope !== 'process') {
    throw new Error('TEMPLATE_NOT_ALLOWED_IN_PROCESS');
  }
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
      registrationGroupId: entry.registrationGroupId,
      driverPersonId: entry.driverPersonId,
      driverNote: entry.driverNote,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      totalCents: invoice.totalCents,
      paymentStatus: invoice.paymentStatus,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      eventContactEmail: event.contactEmail,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      nationality: person.nationality
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
  const locale = resolveMailLocale({
    locale: null,
    nationality: row.nationality
  });
  const chromeCopy = getMailChromeCopy(locale);
  const processTemplateCopy = (
    template.templateKey === 'registration_received' ||
    template.templateKey === 'email_confirmation_reminder' ||
    template.templateKey === 'accepted_open_payment' ||
    template.templateKey === 'accepted_paid_completed' ||
    template.templateKey === 'rejected'
  )
    ? getProcessTemplateCopy(template.templateKey, locale)
    : null;
  const lifecycleSubjectTemplate = processTemplateCopy?.subjectTemplate ?? template.subjectTemplate;
  const lifecycleBodyTextTemplate = processTemplateCopy?.bodyTextTemplate ?? template.bodyTextTemplate;
  const normalizedDriverNote = (row.driverNote ?? '').trim();
  const driverNoteBlock =
    normalizedDriverNote.length > 0 ? `\n\nHinweis vom Veranstalter:\n${normalizedDriverNote}` : '';
  const supportsDriverNoteInLifecycleMail = input.eventType === 'accepted_open_payment' || input.eventType === 'rejected';
  const includeDriverNoteInLifecycleMail = supportsDriverNoteInLifecycleMail && input.includeDriverNote;
  let templateData: Record<string, unknown> = {
    eventType: input.eventType,
    eventName: row.eventName,
    eventDateText: formatEventDateText(row.eventStartsAt ?? null, row.eventEndsAt ?? null),
    className: row.className,
    startNumber: row.startNumber,
    driverName,
    entryId: row.entryId,
    registrationStatus: row.registrationStatus,
    acceptanceStatus: row.acceptanceStatus,
    paymentStatus: row.paymentStatus ?? null,
    amountOpenCents: row.totalCents ?? 0,
    amountOpen: `${formatEuroFromCents(row.totalCents ?? 0)} EUR`,
    locale,
    fallbackGreeting: chromeCopy.fallbackGreeting,
    headerTitle: processTemplateCopy?.headerTitle ?? null,
    preheader: processTemplateCopy?.preheader ?? null,
    ctaText:
      template.templateKey === 'email_confirmation_reminder'
        ? chromeCopy.confirmationReminderCta
        : chromeCopy.verificationCta,
    contactEmail: row.eventContactEmail ?? getFallbackContactEmail(),
    nennungstoolUrl: process.env.MAIL_PUBLIC_BASE_URL ?? process.env.NENNUNGSTOOL_URL ?? null,
    driverNote: includeDriverNoteInLifecycleMail && normalizedDriverNote.length > 0 ? normalizedDriverNote : null,
    driverNoteBlock: includeDriverNoteInLifecycleMail ? driverNoteBlock : '',
    paymentIban: process.env.PAYMENT_IBAN ?? '',
    paymentBic: process.env.PAYMENT_BIC ?? '',
    paymentRecipient: process.env.PAYMENT_RECIPIENT ?? ''
  };

  if (template.templateKey === 'registration_received' || template.templateKey === 'email_confirmation_reminder') {
    if (!row.registrationGroupId) {
      throw new LifecycleMailError('TEMPLATE_RENDER_FAILED', 'missing_registration_group');
    }
    let token: string;
    try {
      token = await upsertRegistrationGroupVerificationToken(row.registrationGroupId, email);
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

  if (template.templateKey === 'registration_received' || template.templateKey === 'email_confirmation_reminder') {
    if (!hasRequiredRegistrationReceivedVariables(templateData)) {
      throw new LifecycleMailError('TEMPLATE_RENDER_FAILED', 'missing_required_registration_received_variables');
    }
  }

  templateData = {
    ...templateData,
    bodyTextOverride: lifecycleBodyTextTemplate,
    bodyHtmlOverride: null,
    renderOptions: normalizeRenderOptions(template.templateKey, undefined)
  };

  const renderValidation = renderMailContract({
    templateKey: template.templateKey,
    subjectTemplate: lifecycleSubjectTemplate,
    bodyTextTemplate: lifecycleBodyTextTemplate,
    bodyHtmlTemplate: template.bodyHtmlTemplate,
    data: templateData,
    renderOptions: normalizeRenderOptions(template.templateKey, undefined),
    hasContentOverride: true
  });
  if (renderValidation.missingPlaceholders.length > 0) {
    throw new LifecycleMailError(
      'TEMPLATE_RENDER_FAILED',
      `missing_placeholders:${renderValidation.missingPlaceholders.join(',')}`
    );
  }

  if (!renderValidation.subjectRendered || !renderValidation.bodyTextRendered) {
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
  let lifecycleAttachments: QueuedAttachmentRef[] = [];
  if (template.templateKey === 'accepted_open_payment') {
    try {
      const attachment = await getOrCreateEntryConfirmationAttachment(input.eventId, row.entryId, actorUserId);
      lifecycleAttachments = [
        {
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          s3Key: attachment.s3Key,
          fileSizeBytes: attachment.fileSizeBytes,
          source: attachment.source
        }
      ];
    } catch (error) {
      if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
        throw new LifecycleMailError('ENTRY_NOT_FOUND', 'entry_not_found_for_entry_confirmation_pdf');
      }
      const reason = error instanceof Error ? error.message : 'unknown_entry_confirmation_pdf_error';
      throw new LifecycleMailError('ENTRY_CONFIRMATION_PDF_GENERATION_FAILED', reason);
    }
  }

  let createdOutboxId: string | null = null;
  try {
    const inserted = await db
      .insert(emailOutbox)
      .values({
        eventId: input.eventId,
        toEmail: email,
        subject: lifecycleSubjectTemplate,
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
    if (createdOutboxId && lifecycleAttachments.length > 0) {
      await db.insert(emailOutboxAttachment).values(
        lifecycleAttachments.map((attachment) => ({
          outboxId: createdOutboxId as string,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          s3Key: attachment.s3Key,
          fileSizeBytes: attachment.fileSizeBytes,
          source: attachment.source
        }))
      );
    }
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
  assertCampaignTemplateAllowed(template.templateKey);
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
      nationality: person.nationality,
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
        nationality: row.nationality,
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
        paymentStatus: source?.paymentStatus ?? null,
        locale: resolveMailLocale({ nationality: source?.nationality ?? null })
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

const formatAmountOpen = (totalCents: number, paidAmountCents: number): string =>
  `${((Math.max(0, totalCents - paidAmountCents)) / 100).toFixed(2).replace('.', ',')} EUR`;

const getVersionRowsByTemplateId = async (templateId: string) => {
  const db = await getDb();
  return db
    .select({
      version: emailTemplateVersion.version,
      subject: emailTemplateVersion.subjectTemplate,
      bodyText: emailTemplateVersion.bodyTextTemplate,
      bodyHtml: emailTemplateVersion.bodyHtmlTemplate,
      status: emailTemplateVersion.status,
      updatedAt: emailTemplateVersion.updatedAt,
      updatedBy: emailTemplateVersion.updatedBy
    })
    .from(emailTemplateVersion)
    .where(eq(emailTemplateVersion.templateId, templateId))
    .orderBy(desc(emailTemplateVersion.version));
};

const getPublishedOrLatestTemplateVersion = async (templateId: string) => {
  const rows = await getVersionRowsByTemplateId(templateId);
  const published = rows.find((row) => row.status === 'published');
  return published ?? rows[0] ?? null;
};

export const listMailTemplates = async () => {
  const db = await getDb();
  const templates = await db
    .select({
      id: emailTemplate.id,
      key: emailTemplate.templateKey,
      label: emailTemplate.description,
      isActive: emailTemplate.isActive
    })
    .from(emailTemplate)
    .orderBy(emailTemplate.templateKey);

  const mapped = await Promise.all(
    templates.map(async (item) => {
      const selected = await getPublishedOrLatestTemplateVersion(item.id);
      const contract = getTemplateContract(item.key);
      return {
        key: item.key,
        label: item.label ?? item.key,
        scope: contract.scope,
        channels: contract.channels,
        composer: contract.composer,
        renderOptions: contract.renderOptions,
        subject: selected?.subject ?? '',
        bodyText: selected?.bodyText ?? '',
        bodyHtml: selected?.bodyHtml ?? null,
        version: selected?.version ?? 0,
        status: (selected?.status ?? 'draft') as 'draft' | 'published',
        updatedAt: selected?.updatedAt ?? null,
        updatedBy: selected?.updatedBy ?? null,
        isActive: item.isActive
      };
    })
  );

  return mapped;
};

const getTemplateByKey = async (templateKey: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: emailTemplate.id,
      templateKey: emailTemplate.templateKey,
      description: emailTemplate.description,
      isActive: emailTemplate.isActive
    })
    .from(emailTemplate)
    .where(eq(emailTemplate.templateKey, templateKey))
    .limit(1);
  return rows[0] ?? null;
};

export const createMailTemplate = async (input: TemplateCreateInput, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  try {
    return db.transaction(async (tx) => {
      const [templateRow] = await tx
        .insert(emailTemplate)
        .values({
          templateKey: input.key,
          description: input.label,
          isActive: input.isActive,
          updatedAt: now
        })
        .returning({
          id: emailTemplate.id,
          key: emailTemplate.templateKey,
          label: emailTemplate.description,
          isActive: emailTemplate.isActive
        });

      const [versionRow] = await tx
        .insert(emailTemplateVersion)
        .values({
          templateId: templateRow.id,
          version: 1,
          subjectTemplate: input.subject,
          bodyTemplate: input.bodyText,
          bodyHtmlTemplate: input.bodyHtml ?? null,
          bodyTextTemplate: input.bodyText,
          status: input.status,
          createdBy: actorUserId,
          updatedBy: actorUserId,
          updatedAt: now
        })
        .returning({
          version: emailTemplateVersion.version,
          subject: emailTemplateVersion.subjectTemplate,
          bodyText: emailTemplateVersion.bodyTextTemplate,
          bodyHtml: emailTemplateVersion.bodyHtmlTemplate,
          status: emailTemplateVersion.status,
          updatedAt: emailTemplateVersion.updatedAt,
          updatedBy: emailTemplateVersion.updatedBy
        });

      const contract = getTemplateContract(templateRow.key);
      return {
        key: templateRow.key,
        label: templateRow.label ?? templateRow.key,
        scope: contract.scope,
        channels: contract.channels,
        composer: contract.composer,
        renderOptions: contract.renderOptions,
        subject: versionRow?.subject ?? input.subject,
        bodyText: versionRow?.bodyText ?? input.bodyText,
        bodyHtml: versionRow?.bodyHtml ?? input.bodyHtml ?? null,
        version: versionRow?.version ?? 1,
        status: (versionRow?.status ?? input.status) as 'draft' | 'published',
        updatedAt: versionRow?.updatedAt ?? now,
        updatedBy: versionRow?.updatedBy ?? actorUserId,
        isActive: templateRow.isActive
      };
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('TEMPLATE_KEY_NOT_UNIQUE');
    }
    throw error;
  }
};

export const patchMailTemplate = async (templateKey: string, input: TemplatePatchInput, actorUserId: string | null) => {
  const db = await getDb();
  const existing = await getTemplateByKey(templateKey);
  if (!existing) {
    return null;
  }

  const now = new Date();
  await db
    .update(emailTemplate)
    .set({
      description: input.label ?? existing.description,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: now
    })
    .where(eq(emailTemplate.id, existing.id));

  const shouldCreateVersion =
    input.subject !== undefined || input.bodyText !== undefined || input.bodyHtml !== undefined || input.status !== undefined;

  if (shouldCreateVersion) {
    const latestRows = await db
      .select({
        version: emailTemplateVersion.version,
        subject: emailTemplateVersion.subjectTemplate,
        bodyText: emailTemplateVersion.bodyTextTemplate,
        bodyHtml: emailTemplateVersion.bodyHtmlTemplate,
        status: emailTemplateVersion.status
      })
      .from(emailTemplateVersion)
      .where(eq(emailTemplateVersion.templateId, existing.id))
      .orderBy(desc(emailTemplateVersion.version))
      .limit(1);
    const latest = latestRows[0];
    if (!latest) {
      throw new Error('INVALID_STATE');
    }
    await db.insert(emailTemplateVersion).values({
      templateId: existing.id,
      version: latest.version + 1,
      subjectTemplate: input.subject ?? latest.subject,
      bodyTemplate: input.bodyText ?? latest.bodyText ?? '',
      bodyTextTemplate: input.bodyText ?? latest.bodyText ?? '',
      bodyHtmlTemplate: input.bodyHtml ?? latest.bodyHtml ?? null,
      status: input.status ?? (latest.status as 'draft' | 'published'),
      createdBy: actorUserId,
      updatedBy: actorUserId,
      updatedAt: now
    });
  }

  const selected = await getPublishedOrLatestTemplateVersion(existing.id);
  const contract = getTemplateContract(existing.templateKey);
  return {
    key: existing.templateKey,
    label: input.label ?? existing.description ?? existing.templateKey,
    scope: contract.scope,
    channels: contract.channels,
    composer: contract.composer,
    renderOptions: contract.renderOptions,
    subject: selected?.subject ?? '',
    bodyText: selected?.bodyText ?? '',
    bodyHtml: selected?.bodyHtml ?? null,
    version: selected?.version ?? 0,
    status: (selected?.status ?? 'draft') as 'draft' | 'published',
    updatedAt: selected?.updatedAt ?? now,
    updatedBy: selected?.updatedBy ?? actorUserId,
    isActive: input.isActive ?? existing.isActive
  };
};

export const createMailTemplateVersion = async (
  templateKey: string,
  input: TemplateVersionCreateInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const template = await getTemplateByKey(templateKey);
  if (!template) {
    return null;
  }

  const latestRows = await db
    .select({
      version: emailTemplateVersion.version
    })
    .from(emailTemplateVersion)
    .where(eq(emailTemplateVersion.templateId, template.id))
    .orderBy(desc(emailTemplateVersion.version))
    .limit(1);

  const nextVersion = (latestRows[0]?.version ?? 0) + 1;

  const [created] = await db
    .insert(emailTemplateVersion)
    .values({
      templateId: template.id,
      version: nextVersion,
      subjectTemplate: input.subject,
      bodyTemplate: input.bodyText,
      bodyHtmlTemplate: input.bodyHtml ?? null,
      bodyTextTemplate: input.bodyText,
      status: input.status,
      createdBy: actorUserId,
      updatedBy: actorUserId,
      updatedAt: new Date()
    })
    .returning({
      version: emailTemplateVersion.version,
      createdAt: emailTemplateVersion.createdAt,
      status: emailTemplateVersion.status
    });

  return {
    key: templateKey,
    version: created?.version ?? nextVersion,
    status: (created?.status ?? input.status) as 'draft' | 'published',
    createdAt: created?.createdAt ?? new Date()
  };
};

export const listMailTemplateVersions = async (key: string) => {
  const template = await getTemplateByKey(key);
  if (!template) {
    return null;
  }
  const rows = await getVersionRowsByTemplateId(template.id);
  return rows.map((row) => ({
    version: row.version,
    subject: row.subject,
    bodyText: row.bodyText ?? '',
    bodyHtml: row.bodyHtml ?? null,
    status: row.status as 'draft' | 'published',
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy
  }));
};

export const getTemplatePlaceholders = async (key: string) => {
  const template = await getTemplateByKey(key);
  if (!template) {
    return null;
  }
  const contract = getTemplateContract(key);
  const requiredSet = new Set(contract.composer.requiredPlaceholders);
  const allowedSet = new Set(contract.composer.allowedPlaceholders);
  return PLACEHOLDER_CATALOG.filter((item) => allowedSet.has(item.name)).map((item) => ({
    name: item.name,
    description: item.description,
    example: item.example,
    required: requiredSet.has(item.name)
  }));
};

const buildPreviewDataFromEntry = async (entryId: string): Promise<Record<string, unknown> | null> => {
  const db = await getDb();
  const rows = await db
    .select({
      entryId: entry.id,
      eventId: entry.eventId,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      eventContactEmail: event.contactEmail,
      className: eventClass.name,
      firstName: person.firstName,
      lastName: person.lastName,
      startNumber: entry.startNumberNorm,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      registrationGroupId: entry.registrationGroupId,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(eq(entry.id, entryId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  let verificationUrl: string | null = null;
  if (row.registrationGroupId) {
    const seed = `${row.entryId}:${row.firstName}:${row.lastName}`;
    const token = await upsertRegistrationGroupVerificationToken(row.registrationGroupId, seed);
    verificationUrl = buildPublicVerificationUrl(row.entryId, token);
  }
  return {
    eventId: row.eventId,
    eventName: row.eventName,
    eventDateText: formatEventDateText(row.eventStartsAt ?? null, row.eventEndsAt ?? null),
    firstName: row.firstName,
    lastName: row.lastName,
    driverName: `${row.firstName} ${row.lastName}`.trim(),
    className: row.className,
    startNumber: row.startNumber,
    vehicleType: row.vehicleType,
    vehicleMake: row.vehicleMake,
    vehicleModel: row.vehicleModel,
    vehicleLabel: [row.vehicleType, row.vehicleMake, row.vehicleModel]
      .filter((item): item is string => Boolean(item && item.trim().length > 0))
      .join(' · '),
    amountOpen: formatAmountOpen(row.totalCents ?? 0, row.paidAmountCents ?? 0),
    verificationUrl,
    contactEmail: row.eventContactEmail ?? process.env.MAIL_CONTACT_EMAIL ?? null,
    nennungstoolUrl: process.env.MAIL_PUBLIC_BASE_URL ?? process.env.NENNUNGSTOOL_URL ?? null
  };
};

export const previewMailTemplate = async (input: TemplatePreviewInput) => {
  const template = await resolveTemplate(input.templateKey, undefined);
  const contract = getTemplateContract(input.templateKey);
  const previewEventId =
    (input.sampleData && isNonEmptyString(input.sampleData.eventId) ? input.sampleData.eventId : null) ??
    (input.templateData && isNonEmptyString(input.templateData.eventId) ? input.templateData.eventId : null);
  if (contract.scope === 'campaign' && input.attachmentUploadIds && input.attachmentUploadIds.length > 0 && !previewEventId) {
    throw new Error('ATTACHMENT_EVENT_REQUIRED');
  }
  const uploadedAttachments =
    contract.scope === 'campaign'
      ? await resolveUploadAttachments(previewEventId ?? '', input.attachmentUploadIds)
      : [];
  let data: Record<string, unknown> = {
    ...(input.templateData ?? {}),
    ...(input.sampleData ?? {}),
    locale:
      (input.templateData && isNonEmptyString(input.templateData.locale) ? input.templateData.locale : null) ??
      (input.sampleData && isNonEmptyString(input.sampleData.locale) ? input.sampleData.locale : null) ??
      'de'
  };
  if (input.entryId) {
    const entryData = await buildPreviewDataFromEntry(input.entryId);
    if (!entryData) {
      throw new Error('ENTRY_NOT_FOUND');
    }
    data = { ...entryData, ...data };
  }
  if (input.templateKey === 'payment_reminder_followup' && !isNonEmptyString(data.paymentDeadline)) {
    const resolvedEventId = isNonEmptyString(data.eventId) ? data.eventId : null;
    if (resolvedEventId) {
      const fallbackDeadline = await resolvePaymentDeadlineDefault(resolvedEventId);
      if (fallbackDeadline) {
        data = { ...data, paymentDeadline: fallbackDeadline };
      }
    }
  }

  const useDraftMode = input.previewMode === 'draft';
  const subjectTemplate = useDraftMode ? input.subjectOverride ?? template.subjectTemplate : template.subjectTemplate;
  const bodyTextTemplate = useDraftMode ? input.bodyOverride ?? template.bodyTextTemplate : template.bodyTextTemplate;
  const bodyHtmlTemplate = useDraftMode
    ? input.bodyHtmlOverride ?? template.bodyHtmlTemplate
    : template.bodyHtmlTemplate;
  const renderOptions = normalizeRenderOptions(input.templateKey, input.renderOptions);
  const hasContentOverride = useDraftMode && Boolean(input.bodyOverride || input.bodyHtmlOverride);

  const rendered = renderMailContract({
    templateKey: input.templateKey,
    subjectTemplate,
    bodyTextTemplate,
    bodyHtmlTemplate,
    data: {
      ...data,
      renderOptions
    },
    renderOptions,
    hasContentOverride
  });

  return {
    templateKey: input.templateKey,
    attachments: uploadedAttachments.map((attachment) => ({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      fileSizeBytes: attachment.fileSizeBytes
    })),
    ...rendered
  };
};

export const initMailAttachmentUpload = async (input: AttachmentUploadInitInput, actorUserId: string | null) => {
  await assertEventStatusAllowed(input.eventId, ['open', 'closed']);
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60);
  const uploadId = randomUUID();
  const fileName = normalizePdfFileName(input.fileName);
  const key = `uploads/${input.eventId}/mail-attachments/${uploadId}.pdf`;
  const upload = await getPresignedAssetsUploadUrl(key, 'application/pdf', 900);

  await db.insert(mailAttachmentUpload).values({
    id: uploadId,
    eventId: input.eventId,
    s3Key: key,
    contentType: 'application/pdf',
    fileName,
    fileSizeBytes: input.fileSizeBytes,
    uploadedBy: actorUserId,
    status: 'initiated',
    expiresAt,
    finalizedAt: null,
    createdAt: now,
    updatedAt: now
  });

  return {
    uploadId,
    eventId: input.eventId,
    fileName,
    contentType: 'application/pdf',
    fileSizeBytes: input.fileSizeBytes,
    uploadUrl: upload.url,
    requiredHeaders: upload.requiredHeaders,
    expiresAt
  };
};

export const finalizeMailAttachmentUpload = async (input: AttachmentUploadFinalizeInput) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(mailAttachmentUpload)
    .where(and(eq(mailAttachmentUpload.id, input.uploadId), eq(mailAttachmentUpload.eventId, input.eventId)))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new Error('ATTACHMENT_UPLOAD_NOT_FOUND');
  }

  const now = new Date();
  if (current.expiresAt <= now) {
    await db
      .update(mailAttachmentUpload)
      .set({
        status: 'expired',
        updatedAt: now
      })
      .where(eq(mailAttachmentUpload.id, current.id));
    throw new Error('ATTACHMENT_UPLOAD_EXPIRED');
  }

  const metadata = await getAssetObjectMetadata(current.s3Key);
  if (!metadata) {
    throw new Error('ATTACHMENT_UPLOAD_OBJECT_MISSING');
  }
  if (metadata.contentType && metadata.contentType !== 'application/pdf') {
    throw new Error('ATTACHMENT_INVALID_CONTENT_TYPE');
  }
  if ((metadata.contentLength ?? current.fileSizeBytes) > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
    throw new Error('ATTACHMENT_FILE_TOO_LARGE');
  }

  const resolvedSize = metadata.contentLength ?? current.fileSizeBytes;
  await db
    .update(mailAttachmentUpload)
    .set({
      contentType: 'application/pdf',
      fileSizeBytes: resolvedSize,
      status: 'finalized',
      finalizedAt: now,
      updatedAt: now
    })
    .where(eq(mailAttachmentUpload.id, current.id));

  return {
    uploadId: current.id,
    eventId: current.eventId,
    fileName: current.fileName,
    contentType: 'application/pdf',
    fileSizeBytes: resolvedSize,
    status: 'finalized'
  };
};

export const resolveBroadcastRecipients = async (input: ResolveRecipientsInput) => {
  const db = await getDb();
  let eventId = input.eventId;
  if (!eventId) {
    const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.isCurrent, true)).limit(1);
    eventId = eventRows[0]?.id;
  }
  if (!eventId) {
    throw new Error('INVALID_STATE');
  }

  const invalidEmails: string[] = [];
  const collectedEmails: string[] = [];

  const hasBroadcastFilter = Boolean(input.classId || input.acceptanceStatus || input.registrationStatus || input.paymentStatus);
  if (hasBroadcastFilter) {
    const conditions: SQL<unknown>[] = [
      eq(entry.eventId, eventId),
      sql`${entry.deletedAt} is null`,
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
    const filteredRows = await db
      .select({
        email: person.email
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(and(...conditions, input.paymentStatus ? eq(invoice.paymentStatus, input.paymentStatus) : sql`true`));
    collectedEmails.push(...filteredRows.map((row) => row.email).filter((email): email is string => Boolean(email)));
  }

  if (input.driverPersonIds && input.driverPersonIds.length > 0) {
    const driverRows = await db
      .select({ email: person.email })
      .from(person)
      .where(and(inArray(person.id, input.driverPersonIds), eq(person.processingRestricted, false), eq(person.objectionFlag, false)));
    collectedEmails.push(...driverRows.map((row) => row.email).filter((email): email is string => Boolean(email)));
  }

  if (input.entryIds && input.entryIds.length > 0) {
    const entryRows = await db
      .select({ email: person.email })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(
        and(
          inArray(entry.id, input.entryIds),
          eq(entry.eventId, eventId),
          sql`${entry.deletedAt} is null`,
          eq(person.processingRestricted, false),
          eq(person.objectionFlag, false)
        )
      );
    collectedEmails.push(...entryRows.map((row) => row.email).filter((email): email is string => Boolean(email)));
  }

  let additionalEmails = input.additionalEmails ?? [];
  if (additionalEmails.length > 0) {
    const blockedRows = await db
      .select({ email: person.email })
      .from(person)
      .where(
        and(
          inArray(person.email, additionalEmails),
          or(eq(person.processingRestricted, true), eq(person.objectionFlag, true))
        )
      );
    const blocked = new Set(blockedRows.map((row) => (row.email ?? '').toLowerCase()).filter((email) => email.length > 0));
    additionalEmails = additionalEmails.filter((email) => !blocked.has(email.toLowerCase()));
  }

  const all = [...collectedEmails, ...additionalEmails];
  const map = new Map<string, string>();
  all.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      invalidEmails.push(trimmed);
      return;
    }
    map.set(key, trimmed);
  });
  const duplicatesRemoved = all.filter((email) => Boolean(email)).length - map.size - invalidEmails.length;
  const resolvedRecipients = Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  return {
    resolvedRecipients,
    invalidEmails,
    duplicatesRemoved: Math.max(0, duplicatesRemoved),
    finalCount: resolvedRecipients.length
  };
};

export const searchMailRecipients = async (input: SearchRecipientsInput) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [eq(entry.eventId, input.eventId), sql`${entry.deletedAt} is null`];
  if (input.classId) {
    conditions.push(eq(entry.classId, input.classId));
  }
  if (input.acceptanceStatus) {
    conditions.push(eq(entry.acceptanceStatus, input.acceptanceStatus));
  }
  if (input.q && input.q.trim().length > 0) {
    const like = `%${input.q.trim().toLowerCase()}%`;
    conditions.push(
      sql`(
        lower(${person.firstName}) like ${like}
        or lower(${person.lastName}) like ${like}
        or lower(${person.email}) like ${like}
        or lower(${entry.startNumberNorm}) like ${like}
      )`
    );
  }

  const query = db
    .select({
      driverPersonId: person.id,
      driverName: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || coalesce(${person.lastName}, ''))`,
      driverEmail: person.email,
      entryId: entry.id,
      className: eventClass.name,
      startNumber: entry.startNumberNorm
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)));

  const rows = await query
    .where(and(...conditions, input.paymentStatus ? eq(invoice.paymentStatus, input.paymentStatus) : sql`true`))
    .orderBy(desc(entry.updatedAt))
    .limit(Math.max(10, input.limit * 5));

  const deduped = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!row.driverEmail) {
      continue;
    }
    if (!deduped.has(row.driverPersonId)) {
      deduped.set(row.driverPersonId, row);
    }
    if (deduped.size >= input.limit) {
      break;
    }
  }

  return Array.from(deduped.values()).map((row) => ({
    driverPersonId: row.driverPersonId,
    driverName: row.driverName,
    driverEmail: row.driverEmail as string,
    entryId: row.entryId,
    className: row.className,
    startNumber: row.startNumber
  }));
};

export const queueCommunicationSend = async (input: CommunicationSendInput, actorUserId: string | null) =>
  (async () => {
    const templateKey = input.templateKey ?? input.templateId;
    if (!templateKey) {
      throw new Error('TEMPLATE_NOT_FOUND');
    }
    assertCampaignTemplateAllowed(templateKey);
    return queueMail(
      {
        eventId: input.eventId,
        templateId: input.templateId,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        subject: input.subject,
        subjectOverride: input.subjectOverride,
        bodyOverride: input.bodyOverride,
        bodyHtmlOverride: input.bodyHtmlOverride,
        templateData: input.templateData,
        attachmentUploadIds: input.attachmentUploadIds,
        renderOptions: input.renderOptions,
        sendAfter: input.sendAfter,
        recipientEmails: input.additionalEmails,
        driverPersonIds: input.driverPersonIds,
        entryIds: input.entryIds,
        filters: input.filters
      },
      actorUserId
    );
  })();

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
export const validateMailTemplateCreateInput = (payload: unknown) => templateCreateSchema.parse(payload);
export const validateMailTemplatePatchInput = (payload: unknown) => templatePatchSchema.parse(payload);
export const validateMailTemplateVersionCreateInput = (payload: unknown) => templateVersionCreateSchema.parse(payload);
export const validateMailTemplatePreviewInput = (payload: unknown) => templatePreviewSchema.parse(payload);
export const validateCommunicationSendInput = (payload: unknown) => communicationSendSchema.parse(payload);
export const validateResolveRecipientsInput = (payload: unknown) => resolveRecipientsSchema.parse(payload);
export const validateSearchRecipientsInput = (query: Record<string, string | undefined>) =>
  searchRecipientsSchema.parse({
    eventId: query.eventId,
    q: query.q,
    classId: query.classId,
    acceptanceStatus: query.acceptanceStatus,
    paymentStatus: query.paymentStatus,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });
export const validateMailAttachmentUploadInitInput = (payload: unknown) => attachmentUploadInitSchema.parse(payload);
export const validateMailAttachmentUploadFinalizeInput = (payload: unknown) => attachmentUploadFinalizeSchema.parse(payload);
export const validateListTemplateVersionsInput = (params: Record<string, string | undefined>) =>
  listTemplateVersionsSchema.parse({
    key: params.key
  });
