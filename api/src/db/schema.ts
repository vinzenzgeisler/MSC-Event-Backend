import { sql } from 'drizzle-orm';
import {
  AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

export const event = pgTable(
  'event',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    startsAt: date('starts_at').notNull(),
    endsAt: date('ends_at').notNull(),
    status: text('status').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    registrationOpenAt: timestamp('registration_open_at', { withTimezone: true }),
    registrationCloseAt: timestamp('registration_close_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('event_status_check', sql`${table.status} in ('draft', 'open', 'closed', 'archived')`),
    singleCurrentEvent: uniqueIndex('event_single_current_unique')
      .on(table.isCurrent)
      .where(sql`${table.isCurrent} = true`)
  })
);

export const eventClass = pgTable(
  'class',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    vehicleType: text('vehicle_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    uniqueName: uniqueIndex('class_event_name_unique').on(table.eventId, table.name),
    vehicleTypeCheck: check('class_vehicle_type_check', sql`${table.vehicleType} in ('moto', 'auto')`)
  })
);

export const person = pgTable(
  'person',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    birthdate: date('birthdate'),
    nationality: text('nationality'),
    street: text('street'),
    zip: text('zip'),
    city: text('city'),
    phone: text('phone'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    motorsportHistory: text('motorsport_history'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    emailUnique: uniqueIndex('person_email_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`)
  })
);

export const vehicle = pgTable(
  'vehicle',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerPersonId: uuid('owner_person_id').references(() => person.id),
    vehicleType: text('vehicle_type').notNull(),
    make: text('make'),
    model: text('model'),
    year: integer('year'),
    brand: text('brand'),
    displacementCcm: integer('displacement_ccm'),
    engineType: text('engine_type'),
    powerPs: integer('power_ps'),
    cylinders: integer('cylinders'),
    gears: integer('gears'),
    brakes: text('brakes'),
    description: text('description'),
    ownerName: text('owner_name'),
    vehicleHistory: text('vehicle_history'),
    startNumberRaw: text('start_number_raw'),
    imageS3Key: text('image_s3_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    vehicleTypeCheck: check('vehicle_vehicle_type_check', sql`${table.vehicleType} in ('moto', 'auto')`)
  })
);

export const entry = pgTable(
  'entry',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => eventClass.id),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    codriverPersonId: uuid('codriver_person_id').references(() => person.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicle.id),
    isBackupVehicle: boolean('is_backup_vehicle').notNull().default(false),
    backupOfEntryId: uuid('backup_of_entry_id').references((): AnyPgColumn => entry.id, { onDelete: 'set null' }),
    startNumberNorm: text('start_number_norm'),
    registrationStatus: text('registration_status').notNull(),
    acceptanceStatus: text('acceptance_status').notNull(),
    idVerified: boolean('id_verified').notNull().default(false),
    idVerifiedAt: timestamp('id_verified_at', { withTimezone: true }),
    idVerifiedBy: text('id_verified_by'),
    checkinIdVerified: boolean('checkin_id_verified').notNull().default(false),
    checkinIdVerifiedAt: timestamp('checkin_id_verified_at', { withTimezone: true }),
    checkinIdVerifiedBy: text('checkin_id_verified_by'),
    techStatus: text('tech_status').notNull().default('pending'),
    techCheckedAt: timestamp('tech_checked_at', { withTimezone: true }),
    techCheckedBy: text('tech_checked_by'),
    specialNotes: text('special_notes'),
    internalNote: text('internal_note'),
    driverNote: text('driver_note'),
    confirmationMailSentAt: timestamp('confirmation_mail_sent_at', { withTimezone: true }),
    confirmationMailVerifiedAt: timestamp('confirmation_mail_verified_at', { withTimezone: true }),
    consentTermsAccepted: boolean('consent_terms_accepted').notNull().default(false),
    consentPrivacyAccepted: boolean('consent_privacy_accepted').notNull().default(false),
    consentMediaAccepted: boolean('consent_media_accepted').notNull().default(false),
    consentVersion: text('consent_version'),
    consentCapturedAt: timestamp('consent_captured_at', { withTimezone: true }),
    entryFeeCents: integer('entry_fee_cents').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    startNumberCheck: check(
      'entry_start_number_check',
      sql`${table.startNumberNorm} is null or ${table.startNumberNorm} ~ '^[A-Z0-9]{1,6}$'`
    ),
    registrationStatusCheck: check(
      'entry_registration_status_check',
      sql`${table.registrationStatus} in ('submitted_unverified', 'submitted_verified')`
    ),
    acceptanceStatusCheck: check(
      'entry_acceptance_status_check',
      sql`${table.acceptanceStatus} in ('pending', 'shortlist', 'accepted', 'rejected')`
    ),
    techStatusCheck: check('entry_tech_status_check', sql`${table.techStatus} in ('pending', 'passed', 'failed')`),
    backupNotSelfCheck: check('entry_backup_not_self_check', sql`${table.backupOfEntryId} is null or ${table.backupOfEntryId} != ${table.id}`),
    startNumberUnique: uniqueIndex('entry_start_number_unique')
      .on(table.eventId, table.classId, table.startNumberNorm)
      .where(sql`${table.startNumberNorm} is not null`),
    backupOfEntryIndex: index('entry_backup_of_entry_idx').on(table.backupOfEntryId)
  })
);

export const invoice = pgTable(
  'invoice',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    totalCents: integer('total_cents').notNull().default(0),
    pricingSnapshot: jsonb('pricing_snapshot').notNull().default(sql`'{}'::jsonb`),
    paymentStatus: text('payment_status').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidAmountCents: integer('paid_amount_cents'),
    recordedBy: text('recorded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    paymentStatusCheck: check('invoice_payment_status_check', sql`${table.paymentStatus} in ('due', 'paid')`),
    uniqueDriverEvent: uniqueIndex('invoice_event_driver_unique').on(table.eventId, table.driverPersonId)
  })
);

export const eventPricingRule = pgTable(
  'event_pricing_rule',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    earlyDeadline: timestamp('early_deadline', { withTimezone: true }).notNull(),
    lateFeeCents: integer('late_fee_cents').notNull().default(0),
    secondVehicleDiscountCents: integer('second_vehicle_discount_cents').notNull().default(8000),
    currency: text('currency').notNull().default('EUR'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventUnique: uniqueIndex('event_pricing_rule_event_unique').on(table.eventId),
    currencyCheck: check('event_pricing_rule_currency_check', sql`${table.currency} in ('EUR')`)
  })
);

export const classPricingRule = pgTable(
  'class_pricing_rule',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => eventClass.id, { onDelete: 'cascade' }),
    baseFeeCents: integer('base_fee_cents').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventClassUnique: uniqueIndex('class_pricing_rule_event_class_unique').on(table.eventId, table.classId)
  })
);

export const invoicePayment = pgTable(
  'invoice_payment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    method: text('method').notNull(),
    recordedBy: text('recorded_by'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    methodCheck: check('invoice_payment_method_check', sql`${table.method} in ('bank_transfer', 'cash', 'card', 'other')`),
    amountCheck: check('invoice_payment_amount_check', sql`${table.amountCents} > 0`),
    invoiceIndex: index('invoice_payment_invoice_idx').on(table.invoiceId, table.paidAt)
  })
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventIndex: index('audit_log_event_idx').on(table.eventId)
  })
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    templateData: jsonb('template_data'),
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    errorLast: text('error_last'),
    sendAfter: timestamp('send_after', { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('email_outbox_status_check', sql`${table.status} in ('queued', 'sending', 'sent', 'failed')`),
    statusSendAfterIndex: index('email_outbox_status_send_after_idx').on(table.status, table.sendAfter),
    idempotencyUnique: uniqueIndex('email_outbox_idempotency_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`)
  })
);

export const emailDelivery = pgTable(
  'email_delivery',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboxId: uuid('outbox_id')
      .notNull()
      .references(() => emailOutbox.id, { onDelete: 'cascade' }),
    sesMessageId: text('ses_message_id'),
    status: text('status').notNull().default('sent'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    providerResponse: jsonb('provider_response')
  },
  (table) => ({
    statusCheck: check('email_delivery_status_check', sql`${table.status} in ('sent', 'failed', 'bounced', 'complaint')`)
  })
);

export const emailTemplate = pgTable(
  'email_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateKey: text('template_key').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    templateKeyUnique: uniqueIndex('email_template_key_unique').on(table.templateKey)
  })
);

export const emailTemplateVersion = pgTable(
  'email_template_version',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => emailTemplate.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    templateVersionUnique: uniqueIndex('email_template_version_unique').on(table.templateId, table.version)
  })
);

export const document = pgTable(
  'document',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    entryId: uuid('entry_id').references(() => entry.id, { onDelete: 'set null' }),
    driverPersonId: uuid('driver_person_id').references(() => person.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    templateVariant: text('template_variant'),
    templateVersion: text('template_version').notNull(),
    sha256: text('sha256').notNull(),
    s3Key: text('s3_key').notNull(),
    status: text('status').notNull().default('generated'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by')
  },
  (table) => ({
    typeCheck: check('document_type_check', sql`${table.type} in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch')`),
    statusCheck: check('document_status_check', sql`${table.status} in ('generated', 'failed')`),
    templateVariantCheck: check(
      'document_template_variant_check',
      sql`${table.type} != 'tech_check' or ${table.templateVariant} in ('auto', 'moto')`
    ),
    eventTypeIndex: index('document_event_type_idx').on(table.eventId, table.type)
  })
);

export const exportJob = pgTable(
  'export_job',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    filters: jsonb('filters').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('queued'),
    s3Key: text('s3_key'),
    errorLast: text('error_last'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => ({
    typeCheck: check(
      'export_job_type_check',
      sql`${table.type} in ('entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv')`
    ),
    statusCheck: check('export_job_status_check', sql`${table.status} in ('queued', 'processing', 'succeeded', 'failed')`),
    statusIndex: index('export_job_status_idx').on(table.status, table.createdAt),
    eventTypeIndex: index('export_job_event_type_idx').on(table.eventId, table.type)
  })
);

export const entryEmailVerification = pgTable(
  'entry_email_verification',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    entryUnique: uniqueIndex('entry_email_verification_entry_unique').on(table.entryId),
    tokenUnique: uniqueIndex('entry_email_verification_token_unique').on(table.token)
  })
);

export const vehicleImageUpload = pgTable(
  'vehicle_image_upload',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    s3Key: text('s3_key').notNull(),
    contentType: text('content_type').notNull(),
    fileName: text('file_name'),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    status: text('status').notNull().default('initiated'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('vehicle_image_upload_status_check', sql`${table.status} in ('initiated', 'finalized', 'expired')`),
    statusExpiresIndex: index('vehicle_image_upload_status_expires_idx').on(table.status, table.expiresAt)
  })
);

export const documentGenerationJob = pgTable(
  'document_generation_job',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check(
      'document_generation_job_status_check',
      sql`${table.status} in ('queued', 'processing', 'succeeded', 'failed')`
    ),
    statusIndex: index('document_generation_job_status_idx').on(table.status)
  })
);
