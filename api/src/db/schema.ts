import { sql } from 'drizzle-orm';
import {
  AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector
} from 'drizzle-orm/pg-core';
import type { EntryConfirmationConfig } from '../domain/entryConfirmationConfig';

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
    paymentDueAt: timestamp('payment_due_at', { withTimezone: true }),
    contactEmail: text('contact_email'),
    websiteUrl: text('website_url'),
    stampCardAccentColor: text('stamp_card_accent_color').notNull().default('#153A81'),
    entryConfirmationConfig: jsonb('entry_confirmation_config').$type<EntryConfirmationConfig>().notNull().default(sql`'{}'::jsonb`),
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
      .where(sql`${table.isCurrent} = true`),
    stampCardAccentColorCheck: check(
      'event_stamp_card_accent_color_check',
      sql`${table.stampCardAccentColor} ~ '^#[0-9A-Fa-f]{6}$'`
    )
  })
);

export const appConfig = pgTable(
  'app_config',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    configKey: text('config_key').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by')
  },
  (table) => ({
    configKeyUnique: uniqueIndex('app_config_key_unique').on(table.configKey)
  })
);

export const publicRateLimit = pgTable(
  'public_rate_limit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scope: text('scope').notNull(),
    keyHash: text('key_hash').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    scopeKeyWindowUnique: uniqueIndex('public_rate_limit_scope_key_window_unique').on(
      table.scope,
      table.keyHash,
      table.windowStart
    ),
    updatedIndex: index('public_rate_limit_updated_idx').on(table.updatedAt)
  })
);

export const runGroup = pgTable(
  'run_group',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    uniqueName: uniqueIndex('run_group_event_name_unique').on(table.eventId, table.name),
    nameNotBlank: check('run_group_name_not_blank_check', sql`btrim(${table.name}) <> ''`)
  })
);

export const eventClass = pgTable(
  'class',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    runGroupId: uuid('run_group_id').references(() => runGroup.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    vehicleType: text('vehicle_type').notNull(),
    allowsCodriver: boolean('allows_codriver').notNull().default(false),
    registrationClosed: boolean('registration_closed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    uniqueName: uniqueIndex('class_event_name_unique').on(table.eventId, table.name),
    runGroupIndex: index('class_run_group_idx').on(table.runGroupId),
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
    country: text('country'),
    street: text('street'),
    zip: text('zip'),
    city: text('city'),
    phone: text('phone'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactFirstName: text('emergency_contact_first_name'),
    emergencyContactLastName: text('emergency_contact_last_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    motorsportHistory: text('motorsport_history'),
    publicationName: text('publication_name'),
    publicationNameVersion: integer('publication_name_version').notNull().default(0),
    publicationNameUpdatedAt: timestamp('publication_name_updated_at', { withTimezone: true }),
    publicationNameUpdatedBy: text('publication_name_updated_by'),
    processingRestricted: boolean('processing_restricted').notNull().default(false),
    objectionFlag: boolean('objection_flag').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    emailUnique: uniqueIndex('person_email_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`)
  })
);

export const geoLocationCache = pgTable(
  'geo_location_cache',
  {
    locationKey: text('location_key').primaryKey(),
    country: text('country'),
    zip: text('zip'),
    city: text('city'),
    lat: text('lat').notNull(),
    lng: text('lng').notNull(),
    source: text('source').notNull().default('manual'),
    status: text('status').notNull().default('resolved'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('geo_location_cache_status_check', sql`${table.status} in ('resolved', 'disabled')`),
    countryCityIndex: index('geo_location_cache_country_city_idx').on(table.country, table.city)
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
    backupClassId: uuid('backup_class_id').references(() => eventClass.id),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    registrationGroupId: uuid('registration_group_id'),
    codriverPersonId: uuid('codriver_person_id').references(() => person.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicle.id),
    backupVehicleId: uuid('backup_vehicle_id').references(() => vehicle.id, { onDelete: 'set null' }),
    isBackupVehicle: boolean('is_backup_vehicle').notNull().default(false),
    backupOfEntryId: uuid('backup_of_entry_id').references((): AnyPgColumn => entry.id, { onDelete: 'set null' }),
    startNumberNorm: text('start_number_norm'),
    driverEmailNorm: text('driver_email_norm'),
    registrationStatus: text('registration_status').notNull(),
    acceptanceStatus: text('acceptance_status').notNull(),
    withdrawnReason: text('withdrawn_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: text('withdrawn_by'),
    idVerified: boolean('id_verified').notNull().default(false),
    idVerifiedAt: timestamp('id_verified_at', { withTimezone: true }),
    idVerifiedBy: text('id_verified_by'),
    checkinIdVerified: boolean('checkin_id_verified').notNull().default(false),
    checkinIdVerifiedAt: timestamp('checkin_id_verified_at', { withTimezone: true }),
    checkinIdVerifiedBy: text('checkin_id_verified_by'),
    techStatus: text('tech_status').notNull().default('pending'),
    techCheckedAt: timestamp('tech_checked_at', { withTimezone: true }),
    techCheckedBy: text('tech_checked_by'),
    backupTechStatus: text('backup_tech_status').notNull().default('pending'),
    backupTechCheckedAt: timestamp('backup_tech_checked_at', { withTimezone: true }),
    backupTechCheckedBy: text('backup_tech_checked_by'),
    specialNotes: text('special_notes'),
    internalNote: text('internal_note'),
    driverNote: text('driver_note'),
    inspectionNote: text('inspection_note'),
    backupInspectionNote: text('backup_inspection_note'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    deletedByDisplay: text('deleted_by_display'),
    deleteReason: text('delete_reason'),
    confirmationMailSentAt: timestamp('confirmation_mail_sent_at', { withTimezone: true }),
    confirmationMailVerifiedAt: timestamp('confirmation_mail_verified_at', { withTimezone: true }),
    consentTermsAccepted: boolean('consent_terms_accepted').notNull().default(false),
    consentPrivacyAccepted: boolean('consent_privacy_accepted').notNull().default(false),
    consentMediaAccepted: boolean('consent_media_accepted').notNull().default(false),
    consentVersion: text('consent_version'),
    consentCapturedAt: timestamp('consent_captured_at', { withTimezone: true }),
    entryFeeCents: integer('entry_fee_cents').notNull().default(0),
    orgaCode: text('orga_code'),
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
      sql`${table.acceptanceStatus} in ('pending', 'shortlist', 'accepted', 'rejected', 'withdrawn')`
    ),
    techStatusCheck: check('entry_tech_status_check', sql`${table.techStatus} in ('pending', 'passed', 'failed')`),
    backupTechStatusCheck: check(
      'entry_backup_tech_status_check',
      sql`${table.backupTechStatus} in ('pending', 'passed', 'failed')`
    ),
    backupNotSelfCheck: check('entry_backup_not_self_check', sql`${table.backupOfEntryId} is null or ${table.backupOfEntryId} != ${table.id}`),
    backupVehicleNotPrimaryCheck: check(
      'entry_backup_vehicle_not_primary_check',
      sql`${table.backupVehicleId} is null or ${table.backupVehicleId} != ${table.vehicleId}`
    ),
    backupVehicleClassConsistencyCheck: check(
      'entry_backup_vehicle_class_consistency_check',
      sql`(${table.backupVehicleId} is null) = (${table.backupClassId} is null)`
    ),
    startNumberUnique: uniqueIndex('entry_start_number_unique')
      .on(table.eventId, table.classId, table.startNumberNorm)
      .where(sql`${table.startNumberNorm} is not null and ${table.deletedAt} is null and ${table.acceptanceStatus} != 'withdrawn'`),
    backupOfEntryIndex: index('entry_backup_of_entry_idx').on(table.backupOfEntryId),
    backupVehicleIndex: index('entry_backup_vehicle_idx').on(table.backupVehicleId),
    backupClassIndex: index('entry_backup_class_idx').on(table.backupClassId),
    registrationGroupIndex: index('entry_registration_group_idx').on(table.registrationGroupId),
    orgaCodeIndex: index('entry_orga_code_idx').on(table.orgaCode)
  })
);

export const eventHubConfig = pgTable(
  'event_hub_config',
  {
    eventId: uuid('event_id').primaryKey().references(() => event.id, { onDelete: 'cascade' }),
    votingOpensAt: timestamp('voting_opens_at', { withTimezone: true }),
    votingClosesAt: timestamp('voting_closes_at', { withTimezone: true }),
    votingMode: text('voting_mode').notNull().default('auto'),
    venueLat: text('venue_lat'),
    venueLng: text('venue_lng'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by')
  },
  (table) => ({
    votingModeCheck: check(
      'event_hub_config_voting_mode_check',
      sql`${table.votingMode} in ('auto', 'forced_open', 'forced_closed')`
    )
  })
);

export const eventHubCandidateOverride = pgTable(
  'event_hub_candidate_override',
  {
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id').notNull().references(() => entry.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('auto'),
    featured: boolean('featured').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by')
  },
  (table) => ({
    primary: uniqueIndex('event_hub_candidate_override_unique').on(table.eventId, table.entryId),
    stateCheck: check(
      'event_hub_candidate_override_state_check',
      sql`${table.state} in ('auto', 'pinned', 'hidden')`
    )
  })
);

export const eventVoteChallenge = pgTable(
  'event_vote_challenge',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    nonceHash: text('nonce_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ expiryIndex: index('event_vote_challenge_expiry_idx').on(table.expiresAt) })
);

export const eventVote = pgTable(
  'event_vote',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    classId: uuid('class_id').notNull().references(() => eventClass.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id').notNull().references(() => entry.id, { onDelete: 'cascade' }),
    voterKeyHash: text('voter_key_hash').notNull(),
    clientSubmissionKey: uuid('client_submission_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    voterClassUnique: uniqueIndex('event_vote_event_class_voter_unique').on(
      table.eventId,
      table.classId,
      table.voterKeyHash
    ),
    submissionUnique: uniqueIndex('event_vote_submission_unique').on(table.clientSubmissionKey),
    eventClassIndex: index('event_vote_event_class_idx').on(table.eventId, table.classId, table.createdAt)
  })
);

export const eventVoteResultSnapshot = pgTable(
  'event_vote_result_snapshot',
  {
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    classId: uuid('class_id').notNull().references(() => eventClass.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id').notNull().references(() => entry.id, { onDelete: 'cascade' }),
    voteCount: integer('vote_count').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    primary: uniqueIndex('event_vote_result_snapshot_unique').on(table.eventId, table.classId, table.entryId)
  })
);

export const entryStartNumberReservation = pgTable(
  'entry_start_number_reservation',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => eventClass.id, { onDelete: 'cascade' }),
    startNumberNorm: text('start_number_norm').notNull()
  },
  (table) => ({
    entryClassUnique: uniqueIndex('entry_start_number_reservation_entry_class_unique').on(table.entryId, table.classId),
    classNumberUnique: uniqueIndex('entry_start_number_reservation_class_number_unique').on(
      table.eventId,
      table.classId,
      table.startNumberNorm
    )
  })
);

export const entryRunGroupReservation = pgTable(
  'entry_run_group_reservation',
  {
    entryId: uuid('entry_id')
      .primaryKey()
      .references(() => entry.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    effectiveGroupId: uuid('effective_group_id').notNull()
  },
  (table) => ({
    driverGroupUnique: uniqueIndex('entry_run_group_reservation_driver_group_unique').on(
      table.eventId,
      table.driverPersonId,
      table.effectiveGroupId
    )
  })
);

export const registrationGroup = pgTable(
  'registration_group',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    driverEmailNorm: text('driver_email_norm').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    activeDriverEmailUnique: uniqueIndex('registration_group_event_driver_email_active_unique')
      .on(table.eventId, table.driverEmailNorm)
      .where(sql`${table.deletedAt} is null`),
    eventIndex: index('registration_group_event_idx').on(table.eventId)
  })
);

export const registrationGroupEmailVerification = pgTable(
  'registration_group_email_verification',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    registrationGroupId: uuid('registration_group_id')
      .notNull()
      .references(() => registrationGroup.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    groupUnique: uniqueIndex('registration_group_email_verification_group_unique').on(table.registrationGroupId),
    tokenUnique: uniqueIndex('registration_group_email_verification_token_unique').on(table.token)
  })
);

export const publicEntrySubmission = pgTable(
  'public_entry_submission',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    clientSubmissionKey: text('client_submission_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    responsePayload: jsonb('response_payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventKeyUnique: uniqueIndex('public_entry_submission_event_key_unique').on(table.eventId, table.clientSubmissionKey),
    eventIndex: index('public_entry_submission_event_idx').on(table.eventId)
  })
);

export const registrationInvitation = pgTable(
  'registration_invitation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    recipientName: text('recipient_name'),
    recipientEmailNorm: text('recipient_email_norm'),
    allowedClassIds: uuid('allowed_class_ids').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedRegistrationGroupId: uuid('consumed_registration_group_id').references(() => registrationGroup.id, {
      onDelete: 'set null'
    }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('registration_invitation_token_hash_unique').on(table.tokenHash),
    eventIndex: index('registration_invitation_event_idx').on(table.eventId, table.createdAt),
    expiryIndex: index('registration_invitation_expiry_idx').on(table.expiresAt),
    allowedClassesNotEmpty: check(
      'registration_invitation_allowed_classes_not_empty_check',
      sql`cardinality(${table.allowedClassIds}) > 0`
    )
  })
);

export const consentEvidence = pgTable(
  'consent_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => person.id, { onDelete: 'set null' }),
    participantRole: text('participant_role'),
    terminalSessionId: uuid('terminal_session_id'),
    consentVersion: text('consent_version').notNull(),
    consentTextHash: text('consent_text_hash').notNull(),
    locale: text('locale').notNull(),
    consentSource: text('consent_source').notNull(),
    termsAccepted: boolean('terms_accepted').notNull().default(true),
    privacyAccepted: boolean('privacy_accepted').notNull().default(true),
    waiverAccepted: boolean('waiver_accepted').notNull().default(false),
    mediaAccepted: boolean('media_accepted').notNull().default(false),
    clubInfoAccepted: boolean('club_info_accepted').notNull().default(false),
    guardianFullName: text('guardian_full_name'),
    guardianEmail: text('guardian_email'),
    guardianPhone: text('guardian_phone'),
    guardianRelationship: text('guardian_relationship'),
    guardianConsentAccepted: boolean('guardian_consent_accepted').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    isLegacy: boolean('is_legacy').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    entryIndex: index('consent_evidence_entry_idx').on(table.entryId, table.createdAt),
    personIndex: index('consent_evidence_person_event_idx').on(table.personId, table.capturedAt),
    sourceCheck: check('consent_evidence_source_check', sql`${table.consentSource} in ('public_form', 'admin_ui')`),
    participantRoleCheck: check(
      'consent_evidence_participant_role_check',
      sql`${table.participantRole} is null or ${table.participantRole} in ('driver', 'codriver', 'charity_codriver')`
    )
  })
);

export const dataSubjectRequest = pgTable(
  'data_subject_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestType: text('request_type').notNull(),
    subjectEmailNorm: text('subject_email_norm'),
    subjectPersonId: uuid('subject_person_id').references(() => person.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('open'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    identityLevel: text('identity_level').notNull().default('medium'),
    handledBy: text('handled_by'),
    legalBasisDecision: text('legal_basis_decision'),
    actionsTaken: text('actions_taken'),
    responseChannel: text('response_channel'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    requestTypeCheck: check(
      'data_subject_request_type_check',
      sql`${table.requestType} in ('access', 'rectification', 'erasure', 'restriction', 'objection', 'portability')`
    ),
    statusCheck: check('data_subject_request_status_check', sql`${table.status} in ('open', 'in_progress', 'closed', 'rejected')`),
    identityCheck: check('data_subject_request_identity_check', sql`${table.identityLevel} in ('low', 'medium', 'high')`),
    subjectEmailIndex: index('data_subject_request_subject_email_idx').on(table.subjectEmailNorm, table.createdAt),
    statusIndex: index('data_subject_request_status_idx').on(table.status, table.receivedAt)
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
    paymentStatusCheck: check('invoice_payment_status_check', sql`${table.paymentStatus} in ('due', 'paid', 'not_required')`),
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

export const technicalInspectorAssignment = pgTable(
  'technical_inspector_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    userEmailNorm: text('user_email_norm').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userEventUnique: uniqueIndex('technical_inspector_assignment_user_event_unique').on(
      table.userEmailNorm,
      table.eventId
    ),
    eventValidityIndex: index('technical_inspector_assignment_event_validity_idx').on(
      table.eventId,
      table.validFrom,
      table.validUntil
    ),
    validityCheck: check(
      'technical_inspector_assignment_validity_check',
      sql`${table.validUntil} > ${table.validFrom}`
    )
  })
);

export const technicalInspectionDecision = pgTable(
  'technical_inspection_decision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    target: text('target').notNull().default('primary'),
    note: text('note'),
    inspectorUserId: text('inspector_user_id').notNull(),
    inspectorEmail: text('inspector_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    entryCreatedIndex: index('technical_inspection_decision_entry_created_idx').on(
      table.entryId,
      table.createdAt
    ),
    statusCheck: check(
      'technical_inspection_decision_status_check',
      sql`${table.status} in ('pending', 'passed', 'failed')`
    ),
    targetCheck: check(
      'technical_inspection_decision_target_check',
      sql`${table.target} in ('primary', 'backup')`
    ),
    failedNoteCheck: check(
      'technical_inspection_decision_failed_note_check',
      sql`${table.status} != 'failed' or length(trim(coalesce(${table.note}, ''))) > 0`
    )
  })
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    batchId: uuid('batch_id'),
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
    eventBatchIndex: index('email_outbox_event_batch_idx').on(table.eventId, table.batchId),
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

export const mailAttachmentUpload = pgTable(
  'mail_attachment_upload',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    s3Key: text('s3_key').notNull(),
    contentType: text('content_type').notNull(),
    fileName: text('file_name').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    uploadedBy: text('uploaded_by'),
    status: text('status').notNull().default('initiated'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    statusCheck: check('mail_attachment_upload_status_check', sql`${table.status} in ('initiated', 'finalized', 'expired')`),
    statusExpiresIndex: index('mail_attachment_upload_status_expires_idx').on(table.status, table.expiresAt),
    eventIndex: index('mail_attachment_upload_event_idx').on(table.eventId, table.createdAt)
  })
);

export const emailOutboxAttachment = pgTable(
  'email_outbox_attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboxId: uuid('outbox_id')
      .notNull()
      .references(() => emailOutbox.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    s3Key: text('s3_key').notNull(),
    fileSizeBytes: integer('file_size_bytes'),
    source: text('source').notNull().default('upload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceCheck: check('email_outbox_attachment_source_check', sql`${table.source} in ('upload', 'system', 'document')`),
    outboxIndex: index('email_outbox_attachment_outbox_idx').on(table.outboxId)
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
    bodyHtmlTemplate: text('body_html_template'),
    bodyTextTemplate: text('body_text_template'),
    status: text('status').notNull().default('published'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    templateVersionUnique: uniqueIndex('email_template_version_unique').on(table.templateId, table.version),
    statusCheck: check('email_template_version_status_check', sql`${table.status} in ('draft', 'published')`)
  })
);

export const document = pgTable(
  'document',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    entryId: uuid('entry_id').references(() => entry.id, { onDelete: 'set null' }),
    driverPersonId: uuid('driver_person_id').references(() => person.id, { onDelete: 'set null' }),
    signingSessionId: uuid('signing_session_id'),
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
    typeCheck: check(
      'document_type_check',
      sql`${table.type} in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch', 'entry_confirmation', 'waiver_signed')`
    ),
    statusCheck: check('document_status_check', sql`${table.status} in ('generated', 'failed', 'superseded')`),
    templateVariantCheck: check(
      'document_template_variant_check',
      sql`${table.type} != 'tech_check' or ${table.templateVariant} in ('auto', 'moto')`
    ),
    eventTypeIndex: index('document_event_type_idx').on(table.eventId, table.type),
    signingSessionIndex: index('document_signing_session_idx').on(table.signingSessionId, table.createdAt)
  })
);

export const signingDeviceSession = pgTable(
  'signing_device_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pairingCode: text('pairing_code').notNull(),
    deviceName: text('device_name'),
    tokenHash: text('token_hash'),
    status: text('status').notNull().default('pairing'),
    pairedBy: text('paired_by'),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pairingCodeIndex: index('signing_device_session_pairing_code_idx').on(table.pairingCode),
    statusCheck: check('signing_device_session_status_check', sql`${table.status} in ('pairing', 'connected', 'revoked', 'expired')`),
    tokenHashUnique: uniqueIndex('signing_device_session_token_hash_unique')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} is not null`)
  })
);

export const signingSession = pgTable(
  'signing_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deviceSessionId: uuid('device_session_id')
      .notNull()
      .references(() => signingDeviceSession.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => person.id),
    sourceEntryId: uuid('source_entry_id').references(() => entry.id, { onDelete: 'set null' }),
    workflowType: text('workflow_type').notNull().default('waiver_signature'),
    workflowStage: text('workflow_stage').notNull().default('ready_to_sign'),
    status: text('status').notNull().default('pending'),
    sessionPayload: jsonb('session_payload').notNull(),
    precheckPayload: jsonb('precheck_payload').notNull(),
    signerPayload: jsonb('signer_payload').notNull(),
    draftPayload: jsonb('draft_payload'),
    resultPayload: jsonb('result_payload'),
    operatorUserId: text('operator_user_id'),
    operatorDisplay: text('operator_display'),
    displayedAt: timestamp('displayed_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    documentId: uuid('document_id').references(() => document.id, { onDelete: 'set null' }),
    evidenceAuditS3Key: text('evidence_audit_s3_key'),
    errorLast: text('error_last'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    deviceStatusIndex: index('signing_session_device_status_idx').on(table.deviceSessionId, table.status, table.createdAt),
    driverIndex: index('signing_session_driver_idx').on(table.eventId, table.driverPersonId, table.createdAt),
    statusExpiresIndex: index('signing_session_status_expires_idx').on(table.status, table.expiresAt),
    activeDriverUnique: uniqueIndex('signing_session_event_driver_active_unique')
      .on(table.eventId, table.driverPersonId)
      .where(sql`${table.status} in ('pending', 'displayed')`),
    activeDeviceUnique: uniqueIndex('signing_session_device_active_unique')
      .on(table.deviceSessionId)
      .where(sql`${table.status} in ('pending', 'displayed')`),
    statusCheck: check('signing_session_status_check', sql`${table.status} in ('pending', 'displayed', 'completed', 'cancelled', 'failed')`),
    workflowTypeCheck: check(
      'signing_session_workflow_type_check',
      sql`${table.workflowType} in ('waiver_signature', 'regular_codriver_registration', 'charity_codriver_registration')`
    ),
    workflowStageCheck: check(
      'signing_session_workflow_stage_check',
      sql`${table.workflowStage} in ('collecting_data', 'awaiting_operator_approval', 'ready_to_sign', 'completed', 'cancelled', 'failed')`
    )
  })
);

export const entryCharityCodriver = pgTable(
  'entry_charity_codriver',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    terminalSessionId: uuid('terminal_session_id').references(() => signingSession.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    activeUnique: uniqueIndex('entry_charity_codriver_active_unique')
      .on(table.eventId, table.entryId, table.personId)
      .where(sql`${table.status} = 'active'`),
    entryIndex: index('entry_charity_codriver_entry_idx').on(table.entryId, table.status, table.createdAt),
    statusCheck: check('entry_charity_codriver_status_check', sql`${table.status} in ('active', 'revoked')`),
    revocationReasonCheck: check(
      'entry_charity_codriver_revocation_reason_check',
      sql`${table.status} != 'revoked' or length(trim(coalesce(${table.revocationReason}, ''))) between 1 and 500`
    )
  })
);

export const codriverInvitation = pgTable(
  'codriver_invitation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    sourceEntryId: uuid('source_entry_id').notNull().references(() => entry.id, { onDelete: 'cascade' }),
    entryIds: uuid('entry_ids').array().notNull(),
    tokenHash: text('token_hash').notNull(),
    recipientName: text('recipient_name'),
    recipientEmailNorm: text('recipient_email_norm'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    codriverPersonId: uuid('codriver_person_id').references(() => person.id, { onDelete: 'set null' }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('codriver_invitation_token_hash_unique').on(table.tokenHash),
    sourceEntryIndex: index('codriver_invitation_source_entry_idx').on(table.sourceEntryId, table.createdAt),
    entryIdsNotEmpty: check('codriver_invitation_entry_ids_not_empty_check', sql`cardinality(${table.entryIds}) > 0`)
  })
);

export const marshalPerson = pgTable(
  'marshal_person',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    helperNumber: integer('helper_number').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    street: text('street'),
    zip: text('zip'),
    city: text('city'),
    birthdate: date('birthdate'),
    phone: text('phone'),
    email: text('email'),
    shirtSize: text('shirt_size'),
    clubMember: boolean('club_member').notNull().default(false),
    licenseNumber: text('license_number'),
    vehicleRegistration: text('vehicle_registration'),
    activityAreas: jsonb('activity_areas').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    note: text('note'),
    isActive: boolean('is_active').notNull().default(true),
    noDeployment: boolean('no_deployment').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    helperNumberUnique: uniqueIndex('marshal_person_helper_number_unique').on(table.helperNumber),
    nameIndex: index('marshal_person_name_idx').on(table.lastName, table.firstName)
  })
);

export const marshalEventParticipation = pgTable(
  'marshal_event_participation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull().references(() => marshalPerson.id, { onDelete: 'cascade' }),
    contactOwner: text('contact_owner'),
    wish: text('wish'),
    note: text('note'),
    shirtSizeSnapshot: text('shirt_size_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventPersonUnique: uniqueIndex('marshal_event_participation_event_person_unique').on(table.eventId, table.personId),
    idEventUnique: unique('marshal_event_participation_id_event_unique').on(table.id, table.eventId),
    eventIndex: index('marshal_event_participation_event_idx').on(table.eventId)
  })
);

export const marshalEventDay = pgTable(
  'marshal_event_day',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    dayKey: text('day_key').notNull(),
    label: text('label').notNull(),
    eventDate: date('event_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventDayUnique: uniqueIndex('marshal_event_day_event_key_unique').on(table.eventId, table.dayKey),
    dayKeyCheck: check('marshal_event_day_key_check', sql`${table.dayKey} in ('saturday', 'sunday')`)
  })
);

export const marshalSection = pgTable(
  'marshal_section',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    leaderCode: text('leader_code').notNull(),
    leaderTargetStaff: integer('leader_target_staff').notNull().default(2),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventCodeUnique: uniqueIndex('marshal_section_event_code_unique').on(table.eventId, table.code),
    eventSortIndex: index('marshal_section_event_sort_idx').on(table.eventId, table.sortOrder),
    leaderTargetStaffCheck: check('marshal_section_leader_target_staff_check', sql`${table.leaderTargetStaff} > 0 and ${table.leaderTargetStaff} <= 20`)
  })
);

export const marshalPost = pgTable(
  'marshal_post',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').notNull().references(() => marshalSection.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description'),
    targetStaff: integer('target_staff').notNull().default(2),
    emergencyTargetStaff: integer('emergency_target_staff').notNull().default(1),
    mapX: integer('map_x'),
    mapY: integer('map_y'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventCodeUnique: uniqueIndex('marshal_post_event_code_unique').on(table.eventId, table.code),
    sectionSortIndex: index('marshal_post_section_sort_idx').on(table.sectionId, table.sortOrder),
    targetStaffCheck: check('marshal_post_target_staff_check', sql`${table.targetStaff} > 0`),
    emergencyTargetStaffCheck: check('marshal_post_emergency_target_staff_check', sql`${table.emergencyTargetStaff} > 0 and ${table.emergencyTargetStaff} <= ${table.targetStaff}`),
    mapCoordinatesCheck: check('marshal_post_map_coordinates_check', sql`(${table.mapX} is null and ${table.mapY} is null) or (${table.mapX} is not null and ${table.mapY} is not null and ${table.mapX} between 0 and 1000 and ${table.mapY} between 0 and 1000)`)
  })
);

export const marshalDayAssignment = pgTable(
  'marshal_day_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    participationId: uuid('participation_id').notNull().references(() => marshalEventParticipation.id, { onDelete: 'cascade' }),
    dayId: uuid('day_id').notNull().references(() => marshalEventDay.id, { onDelete: 'cascade' }),
    commitmentStatus: text('commitment_status').notNull().default('not_asked'),
    role: text('role'),
    sectionId: uuid('section_id').references(() => marshalSection.id, { onDelete: 'set null' }),
    postId: uuid('post_id').references(() => marshalPost.id, { onDelete: 'set null' }),
    functionCode: text('function_code'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    participationDayUnique: uniqueIndex('marshal_day_assignment_participation_day_unique').on(table.participationId, table.dayId),
    daySectionIndex: index('marshal_day_assignment_day_section_idx').on(table.dayId, table.sectionId),
    commitmentCheck: check('marshal_day_assignment_commitment_check', sql`${table.commitmentStatus} in ('not_asked', 'pending', 'accepted', 'declined', 'tentative')`),
    roleCheck: check('marshal_day_assignment_role_check', sql`${table.role} is null or ${table.role} in ('marshal', 'section_leader', 'special')`)
  })
);

export const marshalQualification = pgTable(
  'marshal_qualification',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personId: uuid('person_id').notNull().references(() => marshalPerson.id, { onDelete: 'cascade' }),
    qualificationType: text('qualification_type').notNull().default('dmsb_license'),
    number: text('number'),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    personTypeUnique: uniqueIndex('marshal_qualification_person_type_unique').on(table.personId, table.qualificationType)
  })
);

export const marshalTrainingSession = pgTable(
  'marshal_training_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    sessionType: text('session_type').notNull(),
    title: text('title').notNull(),
    sessionDate: date('session_date').notNull(),
    location: text('location'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventDateIndex: index('marshal_training_session_event_date_idx').on(table.eventId, table.sessionDate),
    typeCheck: check('marshal_training_session_type_check', sql`${table.sessionType} in ('training', 'briefing')`)
  })
);

export const marshalTrainingParticipant = pgTable(
  'marshal_training_participant',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id').notNull().references(() => marshalTrainingSession.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull().references(() => marshalPerson.id, { onDelete: 'cascade' }),
    attendanceStatus: text('attendance_status').notNull().default('registered'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sessionPersonUnique: uniqueIndex('marshal_training_participant_session_person_unique').on(table.sessionId, table.personId),
    attendanceCheck: check('marshal_training_participant_attendance_check', sql`${table.attendanceStatus} in ('registered', 'attended', 'absent', 'excused')`)
  })
);

export const marshalImportRun = pgTable(
  'marshal_import_run',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    workbookSha256: text('workbook_sha256').notNull(),
    filename: text('filename').notNull(),
    status: text('status').notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    conflicts: jsonb('conflicts').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => ({
    completedWorkbookUnique: uniqueIndex('marshal_import_run_completed_workbook_unique')
      .on(table.eventId, table.workbookSha256)
      .where(sql`${table.status} = 'completed'`),
    statusCheck: check('marshal_import_run_status_check', sql`${table.status} in ('preview', 'completed', 'failed')`)
  })
);

export const marshalImportRepairSnapshot = pgTable(
  'marshal_import_repair_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repairKey: text('repair_key').notNull(),
    sourceWorkbookSha256: text('source_workbook_sha256').notNull(),
    personId: uuid('person_id').notNull().references(() => marshalPerson.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => event.id, { onDelete: 'set null' }),
    beforeData: jsonb('before_data').$type<Record<string, unknown>>().notNull(),
    afterData: jsonb('after_data').$type<Record<string, unknown>>().notNull(),
    appliedFields: text('applied_fields').array().notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    repairPersonUnique: unique('marshal_import_repair_snapshot_repair_person_unique').on(table.repairKey, table.personId),
    eventIndex: index('marshal_import_repair_snapshot_event_idx').on(table.eventId, table.createdAt),
    hashCheck: check('marshal_import_repair_snapshot_hash_check', sql`${table.sourceWorkbookSha256} ~ '^[a-f0-9]{64}$'`),
    fieldsCheck: check('marshal_import_repair_snapshot_fields_check', sql`cardinality(${table.appliedFields}) > 0`)
  })
);

export const marshalHelperArea = pgTable(
  'marshal_helper_area',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    areaType: text('area_type').notNull(),
    dayScope: text('day_scope'),
    sortOrder: integer('sort_order').notNull().default(0),
    responsibleLabel: text('responsible_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    eventCodeUnique: uniqueIndex('marshal_helper_area_event_code_unique').on(table.eventId, table.code),
    idEventUnique: unique('marshal_helper_area_id_event_unique').on(table.id, table.eventId),
    eventSortIndex: index('marshal_helper_area_event_sort_idx').on(table.eventId, table.sortOrder),
    areaTypeCheck: check('marshal_helper_area_type_check', sql`${table.areaType} in ('setup', 'general')`),
    dayScopeCheck: check('marshal_helper_area_day_scope_check', sql`${table.dayScope} is null or ${table.dayScope} in ('saturday', 'sunday')`)
  })
);

export const marshalAreaShift = pgTable(
  'marshal_area_shift',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    areaId: uuid('area_id').notNull(),
    label: text('label').notNull(),
    shiftDate: date('shift_date').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    areaDateUnique: uniqueIndex('marshal_area_shift_area_date_unique').on(table.areaId, table.shiftDate),
    idEventUnique: unique('marshal_area_shift_id_event_unique').on(table.id, table.eventId),
    areaEventForeignKey: foreignKey({
      columns: [table.areaId, table.eventId],
      foreignColumns: [marshalHelperArea.id, marshalHelperArea.eventId],
      name: 'marshal_area_shift_area_event_fk'
    }).onDelete('cascade'),
    areaSortIndex: index('marshal_area_shift_area_sort_idx').on(table.areaId, table.sortOrder)
  })
);

export const marshalShiftAssignment = pgTable(
  'marshal_shift_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    participationId: uuid('participation_id').notNull(),
    shiftId: uuid('shift_id').notNull(),
    commitmentStatus: text('commitment_status').notNull().default('not_asked'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    participationShiftUnique: uniqueIndex('marshal_shift_assignment_unique').on(table.participationId, table.shiftId),
    participationEventForeignKey: foreignKey({
      columns: [table.participationId, table.eventId],
      foreignColumns: [marshalEventParticipation.id, marshalEventParticipation.eventId],
      name: 'marshal_shift_assignment_participation_event_fk'
    }).onDelete('cascade'),
    shiftEventForeignKey: foreignKey({
      columns: [table.shiftId, table.eventId],
      foreignColumns: [marshalAreaShift.id, marshalAreaShift.eventId],
      name: 'marshal_shift_assignment_shift_event_fk'
    }).onDelete('cascade'),
    shiftIndex: index('marshal_shift_assignment_shift_idx').on(table.shiftId),
    statusCheck: check('marshal_shift_assignment_status_check', sql`${table.commitmentStatus} in ('not_asked', 'pending', 'accepted', 'declined', 'tentative')`)
  })
);

export const marshalAreaAssignment = pgTable(
  'marshal_area_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
    participationId: uuid('participation_id').notNull(),
    areaId: uuid('area_id').notNull(),
    commitmentStatus: text('commitment_status').notNull().default('not_asked'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    participationAreaUnique: uniqueIndex('marshal_area_assignment_unique').on(table.participationId, table.areaId),
    participationEventForeignKey: foreignKey({
      columns: [table.participationId, table.eventId],
      foreignColumns: [marshalEventParticipation.id, marshalEventParticipation.eventId],
      name: 'marshal_area_assignment_participation_event_fk'
    }).onDelete('cascade'),
    areaEventForeignKey: foreignKey({
      columns: [table.areaId, table.eventId],
      foreignColumns: [marshalHelperArea.id, marshalHelperArea.eventId],
      name: 'marshal_area_assignment_area_event_fk'
    }).onDelete('cascade'),
    areaIndex: index('marshal_area_assignment_area_idx').on(table.areaId),
    statusCheck: check('marshal_area_assignment_status_check', sql`${table.commitmentStatus} in ('not_asked', 'pending', 'accepted', 'declined', 'tentative')`)
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
      sql`${table.type} in ('entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv', 'programmheft_xlsx', 'stamp_cards_pdf', 'waiver_paper_zip')`
    ),
    statusCheck: check('export_job_status_check', sql`${table.status} in ('queued', 'processing', 'succeeded', 'failed', 'invalidated')`),
    statusIndex: index('export_job_status_idx').on(table.status, table.createdAt),
    eventTypeIndex: index('export_job_event_type_idx').on(table.eventId, table.type)
  })
);

export const exportJobPerson = pgTable(
  'export_job_person',
  {
    exportJobId: uuid('export_job_id')
      .notNull()
      .references(() => exportJob.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    publicationNameVersion: integer('publication_name_version').notNull()
  },
  (table) => ({
    primary: uniqueIndex('export_job_person_unique').on(table.exportJobId, table.personId),
    personIndex: index('export_job_person_person_idx').on(table.personId, table.exportJobId)
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
    uploadTokenHash: text('upload_token_hash').notNull(),
    fileName: text('file_name'),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    status: text('status').notNull().default('initiated'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByRegistrationGroupId: uuid('consumed_by_registration_group_id').references(() => registrationGroup.id, {
      onDelete: 'set null'
    }),
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

export const simulatorEntry = pgTable(
  'simulator_entry',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    bestTimeMs: integer('best_time_ms').notNull(),
    day: text('day').notNull(), // 'saturday' | 'sunday'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    nameUnique: uniqueIndex('simulator_entry_event_name_day_unique').on(
      table.eventId,
      table.name,
      table.day
    ),
    eventDayTimeIdx: index('simulator_entry_event_day_time_idx').on(
      table.eventId,
      table.day,
      table.bestTimeMs
    )
  })
);

export const newsletterSubscriber = pgTable(
  'newsletter_subscriber',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    emailNorm: text('email_norm').notNull(),
    locale: text('locale').notNull().default('de'),
    status: text('status').notNull().default('pending'),
    consentVersion: text('consent_version').notNull(),
    consentTextHash: text('consent_text_hash').notNull(),
    verificationTokenHash: text('verification_token_hash'),
    verificationExpiresAt: timestamp('verification_expires_at', { withTimezone: true }),
    verificationSentAt: timestamp('verification_sent_at', { withTimezone: true }),
    verificationWindowStartedAt: timestamp('verification_window_started_at', { withTimezone: true }),
    verificationSendCount: integer('verification_send_count').notNull().default(0),
    unsubscribeTokenHash: text('unsubscribe_token_hash'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    complainedAt: timestamp('complained_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    emailUnique: uniqueIndex('newsletter_subscriber_email_norm_unique').on(table.emailNorm),
    statusCreatedIndex: index('newsletter_subscriber_status_created_idx').on(table.status, table.createdAt),
    localeCheck: check('newsletter_subscriber_locale_check', sql`${table.locale} in ('de','en','cs','pl')`),
    statusCheck: check('newsletter_subscriber_status_check', sql`${table.status} in ('pending','active','unsubscribed','bounced','complained')`)
  })
);

export const newsletterConsentEvent = pgTable(
  'newsletter_consent_event',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriberId: uuid('subscriber_id').references(() => newsletterSubscriber.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    consentVersion: text('consent_version'),
    consentTextHash: text('consent_text_hash'),
    locale: text('locale').notNull(),
    source: text('source').notNull().default('website'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ subscriberCreatedIndex: index('newsletter_consent_event_subscriber_created_idx').on(table.subscriberId, table.createdAt) })
);

// --- RacePic (Paket 1: Fundament) --------------------------------------------------------------
// Siehe docs/memory-bank/racepic-architecture.md Abschnitt C und api/migrations/0095_racepic_core.sql.
// Referenziert event/entry/vehicle statt sie zu duplizieren.

export const racepicEvent = pgTable('racepic_event', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => event.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  uploadOpensAt: timestamp('upload_opens_at', { withTimezone: true }),
  uploadClosesAt: timestamp('upload_closes_at', { withTimezone: true }),
  published: boolean('published').notNull().default(false),
  defaultLicenseId: uuid('default_license_id').references((): AnyPgColumn => racepicLicense.id),
  matchingConfigId: uuid('matching_config_id').references((): AnyPgColumn => racepicMatchingConfig.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  slugUnique: unique('racepic_event_slug_unique').on(table.slug)
}));

export const racepicPhotographer = pgTable('racepic_photographer', {
  id: uuid('id').defaultRandom().primaryKey(),
  cognitoSub: text('cognito_sub'),
  email: text('email').notNull(),
  emailNorm: text('email_norm').notNull(),
  // Oeffentliches Profil (Paket 12), siehe migrations/0098_racepic_photographer_slug.sql.
  slug: text('slug'),
  displayName: text('display_name').notNull(),
  legalName: text('legal_name'),
  copyrightLine: text('copyright_line'),
  website: text('website'),
  social: jsonb('social').notNull().default(sql`'{}'::jsonb`),
  avatarKey: text('avatar_key'),
  defaultLicenseId: uuid('default_license_id').references((): AnyPgColumn => racepicLicense.id),
  status: text('status').notNull().default('INVITED'),
  termsAcceptedVersion: text('terms_accepted_version'),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => ({
  statusCheck: check(
    'racepic_photographer_status_check',
    sql`${table.status} in ('INVITED','PENDING_APPROVAL','ACTIVE_FREE','PAYMENT_ONBOARDING_REQUIRED','PAYMENT_ONBOARDING_PENDING','PAYMENT_ENABLED','PAYMENT_RESTRICTED','PAYMENT_DISABLED','DISABLED')`
  )
}));

export const racepicPhotographerEvent = pgTable('racepic_photographer_event', {
  id: uuid('id').defaultRandom().primaryKey(),
  photographerId: uuid('photographer_id')
    .notNull()
    .references(() => racepicPhotographer.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id')
    .notNull()
    .references(() => event.id, { onDelete: 'cascade' }),
  uploadOpensAt: timestamp('upload_opens_at', { withTimezone: true }),
  uploadClosesAt: timestamp('upload_closes_at', { withTimezone: true }),
  quotaImages: integer('quota_images'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  photographerEventUnique: unique('racepic_photographer_event_unique').on(table.photographerId, table.eventId)
}));

export const racepicInvitation = pgTable('racepic_invitation', {
  id: uuid('id').defaultRandom().primaryKey(),
  photographerId: uuid('photographer_id')
    .notNull()
    .references(() => racepicPhotographer.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashUnique: unique('racepic_invitation_token_hash_unique').on(table.tokenHash),
  photographerIndex: index('racepic_invitation_photographer_idx').on(table.photographerId)
}));

export const racepicLicense = pgTable('racepic_license', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull(),
  version: integer('version').notNull().default(1),
  title: jsonb('title').notNull(),
  summary: jsonb('summary').notNull(),
  terms: jsonb('terms').notNull(),
  privateUse: boolean('private_use').notNull().default(false),
  socialMedia: boolean('social_media').notNull().default(false),
  editorial: boolean('editorial').notNull().default(false),
  commercial: boolean('commercial').notNull().default(false),
  attributionRequired: boolean('attribution_required').notNull().default(false),
  attributionTemplate: text('attribution_template'),
  pricingKind: text('pricing_kind').notNull().default('FREE'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  pricingKindCheck: check('racepic_license_pricing_kind_check', sql`${table.pricingKind} in ('FREE','PAID')`),
  codeVersionUnique: unique('racepic_license_code_version_unique').on(table.code, table.version)
}));

export const racepicMatchingConfig = pgTable('racepic_matching_config', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventId: uuid('event_id').references(() => event.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  weights: jsonb('weights').notNull(),
  autoThreshold: numeric('auto_threshold', { precision: 5, scale: 4 }).notNull(),
  reviewThreshold: numeric('review_threshold', { precision: 5, scale: 4 }).notNull(),
  minMargin: numeric('min_margin', { precision: 5, scale: 4 }).notNull().default('0'),
  featureFlags: jsonb('feature_flags').notNull().default(sql`'{}'::jsonb`),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  eventIndex: index('racepic_matching_config_event_idx').on(table.eventId),
  thresholdsCheck: check('racepic_matching_config_thresholds_check', sql`${table.reviewThreshold} <= ${table.autoThreshold}`)
}));

export const racepicUploadBatch = pgTable('racepic_upload_batch', {
  id: uuid('id').defaultRandom().primaryKey(),
  photographerId: uuid('photographer_id')
    .notNull()
    .references(() => racepicPhotographer.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id')
    .notNull()
    .references(() => event.id, { onDelete: 'cascade' }),
  licenseId: uuid('license_id')
    .notNull()
    .references(() => racepicLicense.id),
  fileCount: integer('file_count').notNull().default(0),
  completedCount: integer('completed_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  photographerEventIndex: index('racepic_upload_batch_photographer_event_idx').on(table.photographerId, table.eventId)
}));

export const racepicUpload = pgTable('racepic_upload', {
  id: uuid('id').defaultRandom().primaryKey(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => racepicUploadBatch.id, { onDelete: 'cascade' }),
  s3Key: text('s3_key').notNull(),
  s3UploadId: text('s3_upload_id'),
  fileName: text('file_name'),
  contentType: text('content_type').notNull(),
  declaredSizeBytes: bigint('declared_size_bytes', { mode: 'number' }).notNull(),
  clientFingerprint: text('client_fingerprint'),
  status: text('status').notNull().default('INITIATED'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  s3KeyUnique: uniqueIndex('racepic_upload_s3_key_unique').on(table.s3Key),
  batchFingerprintIndex: index('racepic_upload_batch_fingerprint_idx').on(table.batchId, table.clientFingerprint),
  statusCheck: check(
    'racepic_upload_status_check',
    sql`${table.status} in ('INITIATED','MULTIPART_OPEN','COMPLETED','FAILED','ABORTED','EXPIRED')`
  ),
  contentTypeCheck: check('racepic_upload_content_type_check', sql`${table.contentType} in ('image/jpeg', 'image/png')`)
}));

export const racepicImage = pgTable('racepic_image', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => event.id, { onDelete: 'cascade' }),
  photographerId: uuid('photographer_id')
    .notNull()
    .references(() => racepicPhotographer.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').references(() => racepicUploadBatch.id, { onDelete: 'set null' }),
  uploadId: uuid('upload_id').references(() => racepicUpload.id, { onDelete: 'set null' }),
  licenseId: uuid('license_id')
    .notNull()
    .references(() => racepicLicense.id),
  originalKey: text('original_key'),
  // Nullable: erst ab dem Ingest-Worker (Paket 4) bekannt, siehe migrations/0097_racepic_image_sha256_nullable.sql.
  sha256: text('sha256'),
  bytes: bigint('bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  camera: jsonb('camera'),
  title: text('title'),
  description: text('description'),
  tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
  priceCents: integer('price_cents'),
  processingStatus: text('processing_status').notNull().default('UPLOADED'),
  processingError: text('processing_error'),
  visibility: text('visibility').notNull().default('DRAFT'),
  offerMode: text('offer_mode').notNull().default('FREE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  // Bug gefunden 2026-09-22: REMOVED-Bilder muessen den Hash wieder freigeben, sonst blockiert ein
  // entferntes Bild den Re-Upload derselben Datei fuer immer - siehe migrations/0101_racepic_removed_images_free_sha256.sql.
  eventSha256Unique: uniqueIndex('racepic_image_event_sha256_unique')
    .on(table.eventId, table.sha256)
    .where(sql`${table.sha256} is not null and ${table.processingStatus} <> 'DUPLICATE' and ${table.visibility} <> 'REMOVED'`),
  eventStatusIndex: index('racepic_image_event_status_idx').on(table.eventId, table.processingStatus),
  photographerIndex: index('racepic_image_photographer_idx').on(table.photographerId),
  visibilityIndex: index('racepic_image_visibility_idx').on(table.eventId, table.visibility),
  processingStatusCheck: check(
    'racepic_image_processing_status_check',
    sql`${table.processingStatus} in ('UPLOADED','VALIDATED','DERIVED','ANALYZED','MATCHED','FAILED','DUPLICATE')`
  ),
  visibilityCheck: check('racepic_image_visibility_check', sql`${table.visibility} in ('DRAFT','PUBLISHED','HIDDEN','REMOVED')`),
  offerModeCheck: check('racepic_image_offer_mode_check', sql`${table.offerMode} in ('FREE','PAID')`),
  priceCheck: check('racepic_image_price_check', sql`(${table.offerMode} = 'FREE' and ${table.priceCents} is null) or (${table.offerMode} = 'PAID' and ${table.priceCents} is not null and ${table.priceCents} > 0)`)
}));

export const racepicImageVariant = pgTable('racepic_image_variant', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  s3Key: text('s3_key').notNull(),
  width: integer('width'),
  height: integer('height'),
  bytes: bigint('bytes', { mode: 'number' }),
  access: text('access').notNull().default('signed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  kindCheck: check(
    'racepic_image_variant_kind_check',
    sql`${table.kind} in ('thumb','preview','medium','large','original','watermarked_preview')`
  ),
  accessCheck: check('racepic_image_variant_access_check', sql`${table.access} in ('public','signed')`),
  imageKindUnique: unique('racepic_image_variant_unique').on(table.imageId, table.kind)
}));

export const racepicVehicleReference = pgTable('racepic_vehicle_reference', {
  id: uuid('id').defaultRandom().primaryKey(),
  vehicleId: uuid('vehicle_id')
    .notNull()
    .references(() => vehicle.id, { onDelete: 'cascade' }),
  sourceKeyHash: text('source_key_hash').notNull(),
  // Dimension 1024: Bedrock Cohere Embed v4 (eu-west-1), siehe racepic-architecture.md Abschnitt F.
  embedding: vector('embedding', { dimensions: 1024 }),
  dominantColors: jsonb('dominant_colors'),
  vehicleType: text('vehicle_type'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  vehicleUnique: unique('racepic_vehicle_reference_vehicle_unique').on(table.vehicleId)
}));

export const racepicAiAnalysis = pgTable('racepic_ai_analysis', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  service: text('service').notNull(),
  operation: text('operation').notNull(),
  modelVersion: text('model_version'),
  pipelineVersion: text('pipeline_version').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  rawResultKey: text('raw_result_key'),
  summary: jsonb('summary'),
  error: text('error')
}, (table) => ({
  imageIndex: index('racepic_ai_analysis_image_idx').on(table.imageId),
  serviceCheck: check('racepic_ai_analysis_service_check', sql`${table.service} in ('rekognition','bedrock')`)
}));

export const racepicDetection = pgTable('racepic_detection', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  analysisId: uuid('analysis_id').references(() => racepicAiAnalysis.id, { onDelete: 'set null' }),
  label: text('label').notNull(),
  bbox: jsonb('bbox').notNull(),
  // 0-100 (Rekognition-Skala), nicht 0-1 - siehe migrations/0099_racepic_detection_confidence_range.sql.
  confidence: numeric('confidence', { precision: 7, scale: 4 }),
  dominantColors: jsonb('dominant_colors'),
  embedding: vector('embedding', { dimensions: 1024 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  imageIndex: index('racepic_detection_image_idx').on(table.imageId),
  labelCheck: check('racepic_detection_label_check', sql`${table.label} in ('Car','Motorcycle')`)
}));

export const racepicTextDetection = pgTable('racepic_text_detection', {
  id: uuid('id').defaultRandom().primaryKey(),
  detectionId: uuid('detection_id').references(() => racepicDetection.id, { onDelete: 'cascade' }),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  normalized: text('normalized').notNull(),
  // 0-100 (Rekognition-Skala), nicht 0-1 - siehe migrations/0099_racepic_detection_confidence_range.sql.
  confidence: numeric('confidence', { precision: 7, scale: 4 }),
  bbox: jsonb('bbox').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  imageIndex: index('racepic_text_detection_image_idx').on(table.imageId),
  normalizedIndex: index('racepic_text_detection_normalized_idx').on(table.normalized)
}));

export const racepicMatchCandidate = pgTable('racepic_match_candidate', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  detectionId: uuid('detection_id').references(() => racepicDetection.id, { onDelete: 'cascade' }),
  entryId: uuid('entry_id')
    .notNull()
    .references(() => entry.id, { onDelete: 'cascade' }),
  features: jsonb('features').notNull(),
  score: numeric('score', { precision: 6, scale: 5 }).notNull(),
  rank: integer('rank').notNull(),
  matcherVersion: text('matcher_version').notNull(),
  configVersion: integer('config_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  imageIndex: index('racepic_match_candidate_image_idx').on(table.imageId),
  entryIndex: index('racepic_match_candidate_entry_idx').on(table.entryId)
}));

export const racepicAssignment = pgTable('racepic_assignment', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  entryId: uuid('entry_id')
    .notNull()
    .references(() => entry.id, { onDelete: 'cascade' }),
  detectionId: uuid('detection_id').references(() => racepicDetection.id, { onDelete: 'set null' }),
  candidateId: uuid('candidate_id').references(() => racepicMatchCandidate.id, { onDelete: 'set null' }),
  status: text('status').notNull(),
  source: text('source').notNull(),
  confidence: numeric('confidence', { precision: 6, scale: 5 }),
  decidedByType: text('decided_by_type'),
  decidedById: text('decided_by_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  entryIndex: index('racepic_assignment_entry_idx').on(table.entryId),
  statusIndex: index('racepic_assignment_status_idx').on(table.imageId, table.status),
  imageEntryUnique: unique('racepic_assignment_image_entry_unique').on(table.imageId, table.entryId),
  statusCheck: check(
    'racepic_assignment_status_check',
    sql`${table.status} in ('AUTO_MATCHED','REVIEW_REQUIRED','MANUALLY_CONFIRMED','MANUALLY_CORRECTED','REJECTED')`
  ),
  sourceCheck: check('racepic_assignment_source_check', sql`${table.source} in ('AI','MANUAL')`),
  decidedByTypeCheck: check(
    'racepic_assignment_decided_by_type_check',
    sql`${table.decidedByType} is null or ${table.decidedByType} in ('system','admin','photographer')`
  )
}));

export const racepicAssignmentEvent = pgTable('racepic_assignment_event', {
  id: uuid('id').defaultRandom().primaryKey(),
  assignmentId: uuid('assignment_id')
    .notNull()
    .references(() => racepicAssignment.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  assignmentIndex: index('racepic_assignment_event_assignment_idx').on(table.assignmentId),
  actorTypeCheck: check('racepic_assignment_event_actor_type_check', sql`${table.actorType} in ('system','admin','photographer')`)
}));

export const racepicProcessingStep = pgTable('racepic_processing_step', {
  id: uuid('id').defaultRandom().primaryKey(),
  imageId: uuid('image_id')
    .notNull()
    .references(() => racepicImage.id, { onDelete: 'cascade' }),
  step: text('step').notNull(),
  pipelineVersion: text('pipeline_version').notNull(),
  status: text('status').notNull().default('DONE'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error')
}, (table) => ({
  stepCheck: check('racepic_processing_step_step_check', sql`${table.step} in ('ingest','analyze','match','publish')`),
  uniqueStep: unique('racepic_processing_step_unique').on(table.imageId, table.step, table.pipelineVersion)
}));
