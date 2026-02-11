import { sql } from 'drizzle-orm';
import {
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('event_status_check', sql`${table.status} in ('active', 'archived')`)
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
    startNumberRaw: text('start_number_raw'),
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
    startNumberNorm: text('start_number_norm'),
    registrationStatus: text('registration_status').notNull(),
    acceptanceStatus: text('acceptance_status').notNull(),
    idVerified: boolean('id_verified').notNull().default(false),
    idVerifiedAt: timestamp('id_verified_at', { withTimezone: true }),
    idVerifiedBy: text('id_verified_by'),
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
    startNumberUnique: uniqueIndex('entry_start_number_unique')
      .on(table.eventId, table.classId, table.startNumberNorm)
      .where(sql`${table.startNumberNorm} is not null`)
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
    templateData: jsonb('template_data'),
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    sendAfter: timestamp('send_after', { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text('idempotency_key'),
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
    statusCheck: check('email_delivery_status_check', sql`${table.status} in ('sent', 'failed')`)
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
    templateVersion: text('template_version').notNull(),
    sha256: text('sha256').notNull(),
    s3Key: text('s3_key').notNull(),
    status: text('status').notNull().default('generated'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by')
  },
  (table) => ({
    typeCheck: check('document_type_check', sql`${table.type} in ('waiver', 'tech_check')`),
    statusCheck: check('document_status_check', sql`${table.status} in ('generated', 'failed')`),
    eventTypeIndex: index('document_event_type_idx').on(table.eventId, table.type)
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
