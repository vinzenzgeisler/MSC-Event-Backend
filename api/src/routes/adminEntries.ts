import { and, asc, desc, eq, ilike, inArray, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  auditLog,
  classPricingRule,
  consentEvidence,
  document,
  entry,
  eventClass,
  eventPricingRule,
  invoice,
  invoicePayment,
  person,
  registrationGroup,
  vehicle
} from '../db/schema';
import { doesAssetObjectExist, getPresignedAssetsDownloadUrl } from '../docs/storage';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { deriveInvoicePaymentStatus } from '../domain/invoiceStatus';
import { getEntryLineTotalCents, getManualEntryTotalOverrideCents } from '../domain/pricingSnapshot';
import { isPgUniqueViolation } from '../http/dbErrors';
import { decodeCursor, encodeCursor, parseListQuery } from '../http/pagination';
import { recalculateInvoices } from './adminFinance';
import { queueLifecycleMail } from './adminMail';

const listEntriesQuerySchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
  paymentStatus: z.enum(['due', 'paid']).optional(),
  q: z.string().min(1).optional(),
  checkinIdVerified: z.boolean().optional(),
  techStatus: z.enum(['pending', 'passed', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sortBy: z
    .enum(['className', 'driverLastName', 'driverFirstName', 'createdAt', 'updatedAt', 'startNumberNorm', 'deletedAt'])
    .optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
});

const entryStatusPatchSchema = z.object({
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']),
  sendLifecycleMail: z.boolean().optional().default(false),
  includeDriverNoteInLifecycleMail: z.boolean().optional().default(false),
  lifecycleEventType: z
    .enum([
      'registration_received',
      'preselection',
      'accepted_open_payment',
      'accepted_paid_completed',
      'rejected',
      'waitlist'
    ])
    .optional()
});

const techStatusPatchSchema = z.object({
  techStatus: z.enum(['pending', 'passed', 'failed'])
});

const entryClassPatchSchema = z.object({
  classId: z.string().uuid(),
  applyToBackupVehicle: z.boolean().optional().default(false),
  allowVehicleTypeChange: z.boolean().optional().default(true)
});

const entryNotesPatchSchema = z
  .object({
    internalNote: z.string().max(2000).nullable().optional(),
    driverNote: z.string().max(2000).nullable().optional()
  })
  .refine((value) => value.internalNote !== undefined || value.driverNote !== undefined, {
    message: 'Provide at least one note field'
  });

const entryPaymentStatusPatchSchema = z.object({
  paymentStatus: z.literal('paid'),
  paidAt: z.string().datetime().optional(),
  note: z.string().max(1000).optional()
});

const entryPaymentAmountsPatchSchema = z
  .object({
    totalCents: z.number().int().min(0).optional(),
    paidAmountCents: z.number().int().min(0).optional(),
    note: z.string().max(1000).optional()
  })
  .refine((payload) => payload.totalCents !== undefined || payload.paidAmountCents !== undefined, {
    message: 'Provide at least one of totalCents or paidAmountCents'
  })
  .refine(
    (payload) =>
      payload.totalCents === undefined || payload.paidAmountCents === undefined || payload.paidAmountCents <= payload.totalCents,
    {
      message: 'paidAmountCents must not exceed totalCents',
      path: ['paidAmountCents']
    }
  );

const entryDeleteSchema = z
  .object({
    deleteReason: z.string().max(2000).nullable().optional()
  })
  .nullable()
  .optional();

type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type EntryStatusPatch = z.infer<typeof entryStatusPatchSchema>;
type TechStatusPatch = z.infer<typeof techStatusPatchSchema>;
type EntryClassPatch = z.infer<typeof entryClassPatchSchema>;
type EntryNotesPatch = z.infer<typeof entryNotesPatchSchema>;
type EntryPaymentStatusPatch = z.infer<typeof entryPaymentStatusPatchSchema>;
type EntryPaymentAmountsPatch = z.infer<typeof entryPaymentAmountsPatchSchema>;
type EntryDeleteInput = z.infer<typeof entryDeleteSchema>;

const toVehicleLabel = (make: string | null, model: string | null, startNumberNorm: string | null): string => {
  const label = [make, model].filter((part) => !!part && part.trim().length > 0).join(' ');
  if (label) {
    return label;
  }
  return startNumberNorm ? `#${startNumberNorm}` : 'Unknown vehicle';
};

const assertAcceptanceTransitionAllowed = (from: EntryStatusPatch['acceptanceStatus'], to: EntryStatusPatch['acceptanceStatus']) => {
  const allowed: Record<EntryStatusPatch['acceptanceStatus'], EntryStatusPatch['acceptanceStatus'][]> = {
    pending: ['shortlist', 'accepted', 'rejected'],
    shortlist: ['pending', 'accepted', 'rejected'],
    accepted: ['shortlist', 'rejected'],
    rejected: ['shortlist', 'accepted']
  };
  if (!allowed[from].includes(to)) {
    throw new Error('INVALID_STATUS_TRANSITION');
  }
};

export const listEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) => {
  return listEntriesByDeleteState(query, redactSensitiveFields, false);
};

export const listDeletedEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) => {
  return listEntriesByDeleteState(query, redactSensitiveFields, true);
};

const getVehicleThumbUrl = async (s3Key: string | null): Promise<string | null> => {
  if (!s3Key) {
    return null;
  }
  const candidates = [s3Key, `${s3Key}.jpg`, `${s3Key}.jpeg`, `${s3Key}.png`, `${s3Key}.webp`];
  for (const candidate of candidates) {
    const exists = await doesAssetObjectExist(candidate);
    if (exists) {
      return getPresignedAssetsDownloadUrl(candidate, 900);
    }
  }
  return null;
};

const listEntriesByDeleteState = async (query: ListEntriesQuery, redactSensitiveFields: boolean, deleted: boolean) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [
    eq(entry.eventId, query.eventId),
    deleted ? sql`${entry.deletedAt} is not null` : sql`${entry.deletedAt} is null`
  ];
  if (query.classId) {
    conditions.push(eq(entry.classId, query.classId));
  }
  if (query.acceptanceStatus) {
    conditions.push(eq(entry.acceptanceStatus, query.acceptanceStatus));
  }
  if (query.registrationStatus) {
    conditions.push(eq(entry.registrationStatus, query.registrationStatus));
  }
  if (query.paymentStatus) {
    conditions.push(eq(invoice.paymentStatus, query.paymentStatus));
  }
  if (query.checkinIdVerified !== undefined) {
    conditions.push(eq(entry.checkinIdVerified, query.checkinIdVerified));
  }
  if (query.techStatus) {
    conditions.push(eq(entry.techStatus, query.techStatus));
  }
  if (query.q) {
    const tokens = query.q
      .trim()
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const tokenConditions = tokens.map((token) => {
      const pattern = `%${token}%`;
      return or(
        ilike(person.firstName, pattern),
        ilike(person.lastName, pattern),
        ilike(person.email, pattern),
        ilike(entry.orgaCode, pattern),
        ilike(entry.startNumberNorm, pattern),
        sql`lower(trim(coalesce(${person.firstName}, '') || ' ' || coalesce(${person.lastName}, ''))) like lower(${pattern})`
      ) as SQL<unknown>;
    });
    if (tokenConditions.length > 0) {
      conditions.push(and(...tokenConditions) as SQL<unknown>);
    }
  }

  const paginationQuery = parseListQuery(
    {
      cursor: query.cursor,
      limit: query.limit?.toString(),
      sortBy: query.sortBy,
      sortDir: query.sortDir
    },
    ['className', 'driverLastName', 'driverFirstName', 'createdAt', 'updatedAt', 'startNumberNorm', 'deletedAt'],
    'className',
    'asc'
  );

  const offset = decodeCursor(paginationQuery.cursor);
  const isAsc = paginationQuery.sortDir === 'asc';
  const orderTerm = <T>(column: T) => (isAsc ? asc(column as never) : desc(column as never));
  const orderBy =
    paginationQuery.sortBy === 'driverLastName'
      ? [orderTerm(person.lastName), orderTerm(person.firstName), orderTerm(entry.id)]
      : paginationQuery.sortBy === 'driverFirstName'
        ? [orderTerm(person.firstName), orderTerm(person.lastName), orderTerm(entry.id)]
        : paginationQuery.sortBy === 'createdAt'
          ? [orderTerm(entry.createdAt), orderTerm(entry.id)]
          : paginationQuery.sortBy === 'updatedAt'
            ? [orderTerm(entry.updatedAt), orderTerm(entry.id)]
            : paginationQuery.sortBy === 'startNumberNorm'
              ? [orderTerm(entry.startNumberNorm), orderTerm(entry.id)]
              : paginationQuery.sortBy === 'deletedAt'
                ? [orderTerm(entry.deletedAt), orderTerm(entry.id)]
                : [orderTerm(eventClass.name), orderTerm(person.lastName), orderTerm(person.firstName), orderTerm(entry.id)];

  const totalRows = await db
    .select({
      total: sql<number>`count(distinct ${entry.id})::int`
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(...conditions));

  const total = Number(totalRows[0]?.total ?? 0);

  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
      groupId: entry.registrationGroupId,
      groupSize: sql<number>`coalesce((select count(*)::int from "entry" e2 where e2."registration_group_id" = ${entry.registrationGroupId} and e2."deleted_at" is null), 1)`,
      vehicleId: entry.vehicleId,
      className: eventClass.name,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      checkinIdVerified: entry.checkinIdVerified,
      checkinIdVerifiedAt: entry.checkinIdVerifiedAt,
      checkinIdVerifiedBy: entry.checkinIdVerifiedBy,
      techStatus: entry.techStatus,
      techCheckedAt: entry.techCheckedAt,
      techCheckedBy: entry.techCheckedBy,
      startNumberNorm: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      confirmationMailSentAt: entry.confirmationMailSentAt,
      confirmationMailVerifiedAt: entry.confirmationMailVerifiedAt,
      deletedAt: entry.deletedAt,
      deletedBy: entry.deletedBy,
      deletedByDisplay: entry.deletedByDisplay,
      deleteReason: entry.deleteReason,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      driverPersonId: entry.driverPersonId,
      driverProcessingRestricted: person.processingRestricted,
      driverObjectionFlag: person.objectionFlag,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleImageS3Key: vehicle.imageS3Key,
      paymentStatus: invoice.paymentStatus,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(paginationQuery.limit)
    .offset(offset);

  const mapped = await Promise.all(rows.map(async (row) => {
    const completed = row.acceptanceStatus === 'accepted' && row.paymentStatus === 'paid';
    const vehicleLabel = toVehicleLabel(row.vehicleMake, row.vehicleModel, row.startNumberNorm);
    const vehicleThumbUrl = await getVehicleThumbUrl(row.vehicleImageS3Key);
    const shouldRedactSensitiveFields = redactSensitiveFields || row.driverProcessingRestricted || row.driverObjectionFlag;
    return {
      ...row,
      completionStatus: completed ? 'completed' : 'open',
      vehicleLabel,
      vehicleThumbUrl,
      confirmationMailSent: row.confirmationMailSentAt !== null,
      confirmationMailVerified: row.confirmationMailVerifiedAt !== null,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      deletedByUserId: row.deletedBy,
      deletedByDisplay: row.deletedByDisplay ?? (row.deletedBy && row.deletedBy.includes('@') ? row.deletedBy : null),
      deleteReason: row.deleteReason,
      driverFirstName: shouldRedactSensitiveFields ? null : row.driverFirstName,
      driverLastName: shouldRedactSensitiveFields ? null : row.driverLastName,
      driverEmail: shouldRedactSensitiveFields ? null : row.driverEmail
    };
  }));

  const nextOffset = offset + mapped.length;
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;
  return {
    items: mapped,
    meta: {
      page: Math.floor(offset / paginationQuery.limit) + 1,
      pageSize: paginationQuery.limit,
      total,
      hasMore: nextCursor !== null,
      nextCursor
    }
  };
};

export const listCheckinEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) =>
  listEntries(query, redactSensitiveFields);

export const getEntryDetail = async (entryId: string, redactSensitiveFields: boolean) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
      vehicleId: entry.vehicleId,
      backupVehicleId: entry.backupVehicleId,
      className: eventClass.name,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      checkinIdVerified: entry.checkinIdVerified,
      checkinIdVerifiedAt: entry.checkinIdVerifiedAt,
      checkinIdVerifiedBy: entry.checkinIdVerifiedBy,
      techStatus: entry.techStatus,
      techCheckedAt: entry.techCheckedAt,
      techCheckedBy: entry.techCheckedBy,
      startNumberNorm: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      isBackupVehicle: entry.isBackupVehicle,
      backupOfEntryId: entry.backupOfEntryId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      specialNotes: entry.specialNotes,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      confirmationMailSentAt: entry.confirmationMailSentAt,
      confirmationMailVerifiedAt: entry.confirmationMailVerifiedAt,
      consentTermsAccepted: entry.consentTermsAccepted,
      consentPrivacyAccepted: entry.consentPrivacyAccepted,
      consentMediaAccepted: entry.consentMediaAccepted,
      consentVersion: entry.consentVersion,
      consentCapturedAt: entry.consentCapturedAt,
      driverPersonId: entry.driverPersonId,
      codriverPersonId: entry.codriverPersonId,
      driverProcessingRestricted: person.processingRestricted,
      driverObjectionFlag: person.objectionFlag,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      driverBirthdate: person.birthdate,
      driverCountry: person.country,
      driverStreet: person.street,
      driverZip: person.zip,
      driverCity: person.city,
      driverPhone: person.phone,
      driverEmergencyContactName: person.emergencyContactName,
      driverEmergencyContactFirstName: person.emergencyContactFirstName,
      driverEmergencyContactLastName: person.emergencyContactLastName,
      driverEmergencyContactPhone: person.emergencyContactPhone,
      driverMotorsportHistory: person.motorsportHistory,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleDisplacementCcm: vehicle.displacementCcm,
      vehicleEngineType: vehicle.engineType,
      vehicleCylinders: vehicle.cylinders,
      vehicleBrakes: vehicle.brakes,
      vehicleOwnerName: vehicle.ownerName,
      vehicleHistory: vehicle.vehicleHistory,
      vehicleImageS3Key: vehicle.imageS3Key,
      invoiceTotalCents: invoice.totalCents,
      invoicePricingSnapshot: invoice.pricingSnapshot,
      invoicePaidAmountCents: invoice.paidAmountCents,
      invoicePaymentStatus: invoice.paymentStatus
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(eq(entry.id, entryId), sql`${entry.deletedAt} is null`))
    .limit(1);

  const current = rows[0];
  if (!current) {
    return null;
  }

  const codriverRows =
    current.codriverPersonId === null
      ? []
      : await db
          .select({
            id: person.id,
            processingRestricted: person.processingRestricted,
            objectionFlag: person.objectionFlag,
            firstName: person.firstName,
            lastName: person.lastName,
            email: person.email,
            birthdate: person.birthdate,
            country: person.country,
            street: person.street,
            zip: person.zip,
            city: person.city,
            phone: person.phone,
            emergencyContactName: person.emergencyContactName,
            emergencyContactFirstName: person.emergencyContactFirstName,
            emergencyContactLastName: person.emergencyContactLastName,
            emergencyContactPhone: person.emergencyContactPhone,
            motorsportHistory: person.motorsportHistory
          })
          .from(person)
          .where(eq(person.id, current.codriverPersonId))
          .limit(1);
  const codriver = codriverRows[0] ?? null;
  const backupVehicleRows =
    current.backupVehicleId === null
      ? []
      : await db
          .select({
            id: vehicle.id,
            vehicleType: vehicle.vehicleType,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            displacementCcm: vehicle.displacementCcm,
            engineType: vehicle.engineType,
            cylinders: vehicle.cylinders,
            brakes: vehicle.brakes,
            ownerName: vehicle.ownerName,
            vehicleHistory: vehicle.vehicleHistory,
            imageS3Key: vehicle.imageS3Key
          })
          .from(vehicle)
          .where(eq(vehicle.id, current.backupVehicleId))
          .limit(1);
  const backupVehicle = backupVehicleRows[0] ?? null;
  const consentEvidenceRows = await db
    .select({
      consentTextHash: consentEvidence.consentTextHash,
      locale: consentEvidence.locale,
      consentSource: consentEvidence.consentSource,
      waiverAccepted: consentEvidence.waiverAccepted,
      clubInfoAccepted: consentEvidence.clubInfoAccepted,
      guardianFullName: consentEvidence.guardianFullName,
      guardianEmail: consentEvidence.guardianEmail,
      guardianPhone: consentEvidence.guardianPhone,
      guardianConsentAccepted: consentEvidence.guardianConsentAccepted
    })
    .from(consentEvidence)
    .where(eq(consentEvidence.entryId, entryId))
    .orderBy(sql`${consentEvidence.capturedAt} desc`, sql`${consentEvidence.createdAt} desc`)
    .limit(1);
  const guardianConsent = consentEvidenceRows[0] ?? null;

  const documentRows = await db
    .select({
      id: document.id,
      type: document.type,
      status: document.status,
      createdAt: document.createdAt
    })
    .from(document)
    .where(eq(document.entryId, entryId));

  const driverEntryRows = await db
    .select({
      id: entry.id,
      createdAt: entry.createdAt
    })
    .from(entry)
    .where(and(eq(entry.eventId, current.eventId), eq(entry.driverPersonId, current.driverPersonId), sql`${entry.deletedAt} is null`))
    .orderBy(asc(entry.createdAt), asc(entry.id));

  const relatedEntryIds = driverEntryRows.map((row) => row.id).filter((id) => id !== entryId);

  const pricingRuleRows = await db
    .select({
      earlyDeadline: eventPricingRule.earlyDeadline,
      lateFeeCents: eventPricingRule.lateFeeCents,
      secondVehicleDiscountCents: eventPricingRule.secondVehicleDiscountCents,
      baseFeeCents: classPricingRule.baseFeeCents
    })
    .from(eventPricingRule)
    .leftJoin(
      classPricingRule,
      and(eq(classPricingRule.eventId, current.eventId), eq(classPricingRule.classId, current.classId))
    )
    .where(eq(eventPricingRule.eventId, current.eventId))
    .limit(1);
  const pricingRule = pricingRuleRows[0] ?? null;

  const entryOrderIndex = driverEntryRows.findIndex((row) => row.id === entryId);
  const provisionalTotalCents = (() => {
    if (!pricingRule) {
      return null;
    }
    const baseFeeCents = pricingRule.baseFeeCents ?? 0;
    const lateFeeCents = current.createdAt > pricingRule.earlyDeadline ? pricingRule.lateFeeCents : 0;
    const secondVehicleDiscountCents = entryOrderIndex > 0 ? pricingRule.secondVehicleDiscountCents : 0;
    return Math.max(0, baseFeeCents + lateFeeCents - secondVehicleDiscountCents);
  })();

  const focusedInvoiceTotalCents = getEntryLineTotalCents(current.invoicePricingSnapshot, entryId);
  const manualOverrideCents = getManualEntryTotalOverrideCents(current.invoicePricingSnapshot, entryId);
  const totalCents =
    focusedInvoiceTotalCents ??
    manualOverrideCents ??
    (driverEntryRows.length === 1 && current.invoiceTotalCents !== null ? current.invoiceTotalCents : provisionalTotalCents) ??
    current.invoiceTotalCents ??
    0;
  const paidAmountCents =
    current.invoicePaymentStatus === 'paid'
      ? totalCents
      : driverEntryRows.length === 1
        ? Math.min(current.invoicePaidAmountCents ?? 0, totalCents)
        : 0;
  const amountOpenCents = Math.max(0, totalCents - paidAmountCents);

  const historyRows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      createdAt: auditLog.createdAt,
      payload: auditLog.payload
    })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'entry'), eq(auditLog.entityId, entryId as never)))
    .orderBy(asc(auditLog.createdAt));

  const vehicleLabel = toVehicleLabel(current.vehicleMake, current.vehicleModel, current.startNumberNorm);
  const [vehicleThumbUrl, backupVehicleThumbUrl] = await Promise.all([
    getVehicleThumbUrl(current.vehicleImageS3Key),
    getVehicleThumbUrl(backupVehicle?.imageS3Key ?? null)
  ]);
  const driverRestricted = redactSensitiveFields || current.driverProcessingRestricted || current.driverObjectionFlag;
  const codriverRestricted = redactSensitiveFields || Boolean(codriver?.processingRestricted) || Boolean(codriver?.objectionFlag);

  return {
    entry: {
      ids: {
        entryId: current.id,
        eventId: current.eventId,
        classId: current.classId,
        driverPersonId: current.driverPersonId,
        codriverPersonId: current.codriverPersonId,
        vehicleId: current.vehicleId,
        backupVehicleId: current.backupVehicleId,
        backupOfEntryId: current.backupOfEntryId
      },
      className: current.className,
      registrationStatus: current.registrationStatus,
      acceptanceStatus: current.acceptanceStatus,
      startNumberNorm: current.startNumberNorm,
      orgaCode: current.orgaCode,
      isBackupVehicle: current.isBackupVehicle,
      relatedEntryIds,
      vehicleLabel,
      vehicleThumbUrl,
      backupVehicleThumbUrl,
      confirmationMailSent: current.confirmationMailSentAt !== null,
      confirmationMailVerified: current.confirmationMailVerifiedAt !== null,
      person: {
        driver: {
          firstName: driverRestricted ? null : current.driverFirstName,
          lastName: driverRestricted ? null : current.driverLastName,
          email: driverRestricted ? null : current.driverEmail,
          birthdate: driverRestricted ? null : current.driverBirthdate,
          country: driverRestricted ? null : current.driverCountry,
          street: driverRestricted ? null : current.driverStreet,
          zip: driverRestricted ? null : current.driverZip,
          city: driverRestricted ? null : current.driverCity,
          phone: driverRestricted ? null : current.driverPhone,
          emergencyContactName: driverRestricted ? null : current.driverEmergencyContactName,
          emergencyContactFirstName: driverRestricted ? null : current.driverEmergencyContactFirstName,
          emergencyContactLastName: driverRestricted ? null : current.driverEmergencyContactLastName,
          emergencyContactPhone: driverRestricted ? null : current.driverEmergencyContactPhone,
          motorsportHistory: driverRestricted ? null : current.driverMotorsportHistory
        },
        codriver: codriver
          ? {
              firstName: codriverRestricted ? null : codriver.firstName,
              lastName: codriverRestricted ? null : codriver.lastName,
              email: codriverRestricted ? null : codriver.email,
              birthdate: codriverRestricted ? null : codriver.birthdate,
              country: codriverRestricted ? null : codriver.country,
              street: codriverRestricted ? null : codriver.street,
              zip: codriverRestricted ? null : codriver.zip,
              city: codriverRestricted ? null : codriver.city,
              phone: codriverRestricted ? null : codriver.phone,
              emergencyContactName: codriverRestricted ? null : codriver.emergencyContactName,
              emergencyContactFirstName: codriverRestricted ? null : codriver.emergencyContactFirstName,
              emergencyContactLastName: codriverRestricted ? null : codriver.emergencyContactLastName,
              emergencyContactPhone: codriverRestricted ? null : codriver.emergencyContactPhone,
              motorsportHistory: codriverRestricted ? null : codriver.motorsportHistory
            }
          : null
      },
      vehicle: {
        vehicleType: current.vehicleType,
        make: current.vehicleMake,
        model: current.vehicleModel,
        year: current.vehicleYear,
        displacementCcm: current.vehicleDisplacementCcm,
        engineType: current.vehicleEngineType,
        cylinders: current.vehicleCylinders,
        brakes: current.vehicleBrakes,
        ownerName: current.vehicleOwnerName,
        vehicleHistory: current.vehicleHistory,
        imageS3Key: current.vehicleImageS3Key
      },
      backupVehicle: backupVehicle
        ? {
            vehicleType: backupVehicle.vehicleType,
            make: backupVehicle.make,
            model: backupVehicle.model,
            year: backupVehicle.year,
            displacementCcm: backupVehicle.displacementCcm,
            engineType: backupVehicle.engineType,
            cylinders: backupVehicle.cylinders,
            brakes: backupVehicle.brakes,
            ownerName: backupVehicle.ownerName,
            vehicleHistory: backupVehicle.vehicleHistory,
            imageS3Key: backupVehicle.imageS3Key
          }
        : null,
      payment: {
        totalCents,
        paidAmountCents,
        amountOpenCents,
        paymentStatus: current.invoicePaymentStatus ?? 'due'
      },
      checkin: {
        checkinIdVerified: current.checkinIdVerified,
        checkinIdVerifiedAt: current.checkinIdVerifiedAt,
        checkinIdVerifiedBy: current.checkinIdVerifiedBy,
        techStatus: current.techStatus,
        techCheckedAt: current.techCheckedAt,
        techCheckedBy: current.techCheckedBy
      },
      documents: documentRows,
      specialNotes: current.specialNotes,
      internalNote: current.internalNote,
      driverNote: current.driverNote,
      consent: {
        termsAccepted: current.consentTermsAccepted,
        privacyAccepted: current.consentPrivacyAccepted,
        waiverAccepted: guardianConsent?.waiverAccepted ?? false,
        mediaAccepted: current.consentMediaAccepted,
        clubInfoAccepted: guardianConsent?.clubInfoAccepted ?? false,
        guardian: guardianConsent
          ? {
              fullName: driverRestricted ? null : guardianConsent.guardianFullName,
              email: driverRestricted ? null : guardianConsent.guardianEmail,
              phone: driverRestricted ? null : guardianConsent.guardianPhone,
              consentAccepted: driverRestricted ? false : guardianConsent.guardianConsentAccepted
            }
          : null,
        consentVersion: current.consentVersion,
        consentCapturedAt: current.consentCapturedAt,
        consentTextHash: guardianConsent?.consentTextHash ?? null,
        locale: guardianConsent?.locale ?? null,
        consentSource: guardianConsent?.consentSource ?? null
      },
      createdAt: current.createdAt,
      updatedAt: current.updatedAt
    },
    history: historyRows
  };
};

export const patchEntryStatus = async (entryId: string, input: EntryStatusPatch, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      acceptanceStatus: entry.acceptanceStatus,
      driverPersonId: entry.driverPersonId
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);
  assertAcceptanceTransitionAllowed(existing.acceptanceStatus as EntryStatusPatch['acceptanceStatus'], input.acceptanceStatus);

  const [updated] = await db
    .update(entry)
    .set({
      acceptanceStatus: input.acceptanceStatus,
      updatedAt: new Date()
    })
    .where(eq(entry.id, entryId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_status_updated',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      from: existing.acceptanceStatus,
      to: input.acceptanceStatus
    }
  });

  await recalculateInvoices(
    existing.eventId,
    {
      driverPersonId: existing.driverPersonId
    },
    actorUserId
  );

  const shouldQueueLifecycleMail = input.sendLifecycleMail && input.acceptanceStatus !== 'shortlist';
  if (shouldQueueLifecycleMail) {
    if (!input.lifecycleEventType) {
      throw new Error('LIFECYCLE_EVENT_TYPE_REQUIRED');
    }
    await queueLifecycleMail(
      {
        eventId: existing.eventId,
        entryId,
        eventType: input.lifecycleEventType,
        allowDuplicate: false,
        includeDriverNote: input.includeDriverNoteInLifecycleMail
      },
      actorUserId
    );
  }

  return updated ?? null;
};

export const patchEntryTechStatus = async (entryId: string, input: TechStatusPatch, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

  const now = new Date();
  const [updated] = await db
    .update(entry)
    .set({
      techStatus: input.techStatus,
      techCheckedAt: now,
      techCheckedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(entry.id, entryId))
    .returning();

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_tech_status_updated',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      techStatus: input.techStatus
    }
  });

  return updated ?? null;
};

export const patchEntryClass = async (entryId: string, input: EntryClassPatch, actorUserId: string | null) => {
  const db = await getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        classId: entry.classId,
        isBackupVehicle: entry.isBackupVehicle,
        backupOfEntryId: entry.backupOfEntryId,
        startNumberNorm: entry.startNumberNorm,
        vehicleType: vehicle.vehicleType,
        deletedAt: entry.deletedAt
      })
      .from(entry)
      .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
      .where(eq(entry.id, entryId))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      return null;
    }
    if (existing.deletedAt) {
      throw new Error('INVALID_STATE');
    }

    await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

    const classRows = await tx
      .select({
        id: eventClass.id,
        eventId: eventClass.eventId,
        vehicleType: eventClass.vehicleType
      })
      .from(eventClass)
      .where(eq(eventClass.id, input.classId))
      .limit(1);
    const targetClass = classRows[0];
    if (!targetClass || targetClass.eventId !== existing.eventId) {
      throw new Error('CLASS_NOT_FOUND');
    }
    const warnings: string[] = [];
    const updateEntryIds = new Set<string>([entryId]);
    let backupEntryId: string | null = null;

    if (input.applyToBackupVehicle) {
      if (existing.isBackupVehicle && existing.backupOfEntryId) {
        backupEntryId = existing.backupOfEntryId;
      } else {
        const linkedRows = await tx
          .select({ id: entry.id })
          .from(entry)
          .where(and(eq(entry.backupOfEntryId, entryId), sql`${entry.deletedAt} is null`))
          .limit(1);
        if (linkedRows[0]?.id) {
          backupEntryId = linkedRows[0].id;
        }
      }
      if (!backupEntryId) {
        warnings.push('No linked backup entry found to update.');
      } else {
        updateEntryIds.add(backupEntryId);
      }
    }

    const targetIds = Array.from(updateEntryIds);
    const targetRows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        classId: entry.classId,
        vehicleId: entry.vehicleId,
        startNumberNorm: entry.startNumberNorm,
        deletedAt: entry.deletedAt,
        vehicleType: vehicle.vehicleType
      })
      .from(entry)
      .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
      .where(inArray(entry.id, targetIds));

    const updateRows = targetRows.filter((row) => {
      if (row.deletedAt || row.eventId !== existing.eventId) {
        if (row.id === entryId) {
          throw new Error('INVALID_STATE');
        }
        warnings.push('Linked backup entry was skipped because it is not active.');
        updateEntryIds.delete(row.id);
        return false;
      }
      return true;
    });

    if (!updateRows.some((row) => row.id === entryId)) {
      throw new Error('INVALID_STATE');
    }

    const updateIds = updateRows.map((row) => row.id);

    for (const targetRow of targetRows) {
      if (!updateEntryIds.has(targetRow.id)) {
        continue;
      }
      if (!targetRow.startNumberNorm) {
        continue;
      }
      const conflictRows = await tx
        .select({ id: entry.id })
        .from(entry)
        .where(
          and(
            eq(entry.eventId, existing.eventId),
            eq(entry.classId, input.classId),
            eq(entry.startNumberNorm, targetRow.startNumberNorm),
            sql`${entry.deletedAt} is null`
          )
        )
        .limit(1);
      const conflict = conflictRows[0];
      if (conflict && !updateEntryIds.has(conflict.id)) {
        throw new Error('START_NUMBER_CONFLICT');
      }
    }

    const updatedRows = await tx
      .update(entry)
      .set({
        classId: input.classId,
        updatedAt: now
      })
      .where(inArray(entry.id, updateIds))
      .returning({
        id: entry.id,
        classId: entry.classId
      });

    let vehicleTypeAfter = existing.vehicleType;
    if (input.allowVehicleTypeChange) {
      const vehicleIds = updateRows.map((row) => row.vehicleId);
      if (vehicleIds.length > 0) {
        await tx
          .update(vehicle)
          .set({
            vehicleType: targetClass.vehicleType,
            updatedAt: now
          })
          .where(inArray(vehicle.id, vehicleIds));
      }
      vehicleTypeAfter = targetClass.vehicleType;
    } else if (existing.vehicleType !== targetClass.vehicleType) {
      warnings.push('Vehicle type change skipped by request; class and vehicle type now differ.');
    }

    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'entry_class_updated',
      entityType: 'entry',
      entityId: entryId,
      payload: {
        previousClassId: existing.classId,
        classId: input.classId
      }
    });

    const updatedCurrent = updatedRows.find((row) => row.id === entryId);
    if (!updatedCurrent) {
      throw new Error('INVALID_STATE');
    }
    return {
      id: updatedCurrent.id,
      classId: updatedCurrent.classId,
      vehicleTypeBefore: existing.vehicleType,
      vehicleTypeAfter,
      backupVehicleUpdated: Boolean(backupEntryId && updateEntryIds.has(backupEntryId)),
      warnings
    };
  });
};

export const patchEntryNotes = async (entryId: string, input: EntryNotesPatch, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      updatedAt: entry.updatedAt
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }

  const nextInternalNote = input.internalNote === undefined ? existing.internalNote : input.internalNote;
  const nextDriverNote = input.driverNote === undefined ? existing.driverNote : input.driverNote;
  if (nextInternalNote === existing.internalNote && nextDriverNote === existing.driverNote) {
    return {
      id: existing.id,
      eventId: existing.eventId,
      internalNote: existing.internalNote,
      driverNote: existing.driverNote,
      updatedAt: existing.updatedAt
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(entry)
    .set({
      internalNote: nextInternalNote,
      driverNote: nextDriverNote,
      updatedAt: now
    })
    .where(eq(entry.id, entryId))
    .returning({
      id: entry.id,
      eventId: entry.eventId,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      updatedAt: entry.updatedAt
    });

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_notes_updated',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      internalNoteUpdated: input.internalNote !== undefined,
      driverNoteUpdated: input.driverNote !== undefined
    }
  });

  return updated ?? null;
};

export const patchEntryPaymentStatus = async (
  entryId: string,
  input: EntryPaymentStatusPatch,
  actorUserId: string | null
) => {
  const db = await getDb();
  const entryRows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      entryFeeCents: entry.entryFeeCents,
      deletedAt: entry.deletedAt
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const current = entryRows[0];
  if (!current) {
    return null;
  }
  if (current.deletedAt) {
    throw new Error('ENTRY_DELETED');
  }
  await assertEventStatusAllowed(current.eventId, ['open', 'closed']);

  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  const now = new Date();
  const invoiceRows = await db
    .select({
      id: invoice.id,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      paymentStatus: invoice.paymentStatus
    })
    .from(invoice)
    .where(and(eq(invoice.eventId, current.eventId), eq(invoice.driverPersonId, current.driverPersonId)))
    .limit(1);

  let currentInvoice = invoiceRows[0];
  if (!currentInvoice) {
    const [createdInvoice] = await db
      .insert(invoice)
      .values({
        eventId: current.eventId,
        driverPersonId: current.driverPersonId,
        totalCents: current.entryFeeCents ?? 0,
        pricingSnapshot: {
          source: 'entry_payment_status_patch',
          entryId: current.id
        },
        paymentStatus: 'due',
        paidAmountCents: 0,
        updatedAt: now
      })
      .returning({
        id: invoice.id,
        totalCents: invoice.totalCents,
        paidAmountCents: invoice.paidAmountCents,
        paymentStatus: invoice.paymentStatus
      });
    if (!createdInvoice) {
      throw new Error('INVOICE_CREATE_FAILED');
    }
    currentInvoice = createdInvoice;
  }

  if (currentInvoice.paymentStatus !== 'paid') {
    const amountToRecord = Math.max(0, currentInvoice.totalCents - (currentInvoice.paidAmountCents ?? 0));
    if (amountToRecord > 0) {
      await db.insert(invoicePayment).values({
        invoiceId: currentInvoice.id,
        amountCents: amountToRecord,
        paidAt,
        method: 'other',
        recordedBy: actorUserId,
        note: input.note,
        createdAt: now
      });
    }
  }

  const sumRows = await db
    .select({
      paidAmountCents: sql<number>`coalesce(sum(${invoicePayment.amountCents}), 0)`,
      maxPaidAt: sql<Date | string | null>`max(${invoicePayment.paidAt})`
    })
    .from(invoicePayment)
    .where(eq(invoicePayment.invoiceId, currentInvoice.id));

  const paidAmountCents = sumRows[0]?.paidAmountCents ?? 0;
  const maxPaidAtRaw = sumRows[0]?.maxPaidAt ?? null;
  const maxPaidAt = maxPaidAtRaw ? new Date(maxPaidAtRaw) : paidAt;
  const effectiveTotal = currentInvoice.totalCents ?? 0;
  const amountOpenCents = Math.max(0, effectiveTotal - paidAmountCents);
  const effectiveStatus = deriveInvoicePaymentStatus(effectiveTotal, paidAmountCents);

  await db
    .update(invoice)
    .set({
      paidAmountCents,
      paymentStatus: effectiveStatus,
      paidAt: effectiveStatus === 'paid' ? maxPaidAt : null,
      recordedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(invoice.id, currentInvoice.id));

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'entry_payment_status_set',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      paymentStatus: effectiveStatus,
      paidAmountCents,
      amountOpenCents,
      invoiceId: currentInvoice.id
    }
  });

  return {
    entryId,
    paymentStatus: effectiveStatus,
    paidAmountCents,
    amountOpenCents
  };
};

export const patchEntryPaymentAmounts = async (
  entryId: string,
  input: EntryPaymentAmountsPatch,
  actorUserId: string | null
) => {
  const db = await getDb();
  const entryRows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      entryFeeCents: entry.entryFeeCents,
      deletedAt: entry.deletedAt
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const current = entryRows[0];
  if (!current) {
    return null;
  }
  if (current.deletedAt) {
    throw new Error('ENTRY_DELETED');
  }
  await assertEventStatusAllowed(current.eventId, ['open', 'closed']);

  const now = new Date();
  const invoiceRows = await db
    .select({
      id: invoice.id,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      pricingSnapshot: invoice.pricingSnapshot
    })
    .from(invoice)
    .where(and(eq(invoice.eventId, current.eventId), eq(invoice.driverPersonId, current.driverPersonId)))
    .limit(1);

  let currentInvoice = invoiceRows[0];
  if (!currentInvoice) {
    const [createdInvoice] = await db
      .insert(invoice)
      .values({
        eventId: current.eventId,
        driverPersonId: current.driverPersonId,
        totalCents: current.entryFeeCents ?? 0,
        pricingSnapshot: {
          source: 'entry_payment_amounts_patch',
          entryId: current.id,
          manualOverrides: input.totalCents === undefined ? {} : { [current.id]: input.totalCents }
        },
        paymentStatus: 'due',
        paidAmountCents: 0,
        updatedAt: now
      })
      .returning({
        id: invoice.id,
        totalCents: invoice.totalCents,
        paidAmountCents: invoice.paidAmountCents,
        pricingSnapshot: invoice.pricingSnapshot
      });
    if (!createdInvoice) {
      throw new Error('INVOICE_CREATE_FAILED');
    }
    currentInvoice = createdInvoice;
  }

  const nextTotalCents = input.totalCents ?? currentInvoice.totalCents ?? 0;
  const nextPaidAmountCents = input.paidAmountCents ?? currentInvoice.paidAmountCents ?? 0;
  if (nextPaidAmountCents > nextTotalCents) {
    throw new Error('PAID_AMOUNT_EXCEEDS_TOTAL');
  }

  const existingSnapshot =
    currentInvoice.pricingSnapshot && typeof currentInvoice.pricingSnapshot === 'object' && !Array.isArray(currentInvoice.pricingSnapshot)
      ? (currentInvoice.pricingSnapshot as Record<string, unknown>)
      : {};
  const existingManualOverrides =
    existingSnapshot.manualOverrides && typeof existingSnapshot.manualOverrides === 'object' && !Array.isArray(existingSnapshot.manualOverrides)
      ? { ...(existingSnapshot.manualOverrides as Record<string, unknown>) }
      : {};
  if (input.totalCents !== undefined) {
    existingManualOverrides[current.id] = input.totalCents;
  }

  if (input.paidAmountCents !== undefined) {
    await db.delete(invoicePayment).where(eq(invoicePayment.invoiceId, currentInvoice.id));
    if (nextPaidAmountCents > 0) {
      await db.insert(invoicePayment).values({
        invoiceId: currentInvoice.id,
        amountCents: nextPaidAmountCents,
        paidAt: now,
        method: 'other',
        recordedBy: actorUserId,
        note: input.note ?? 'manual payment amount adjustment',
        createdAt: now
      });
    }
  }

  const paymentStatus = deriveInvoicePaymentStatus(nextTotalCents, nextPaidAmountCents);
  const amountOpenCents = Math.max(0, nextTotalCents - nextPaidAmountCents);

  await db
    .update(invoice)
    .set({
      totalCents: nextTotalCents,
      paidAmountCents: nextPaidAmountCents,
      pricingSnapshot: {
        ...existingSnapshot,
        manualOverrides: existingManualOverrides
      },
      paymentStatus,
      paidAt: paymentStatus === 'paid' ? now : null,
      recordedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(invoice.id, currentInvoice.id));

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'entry_payment_amounts_set',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      invoiceId: currentInvoice.id,
      totalCents: nextTotalCents,
      paidAmountCents: nextPaidAmountCents,
      amountOpenCents,
      paymentStatus
    }
  });

  return {
    entryId,
    paymentStatus,
    totalCents: nextTotalCents,
    paidAmountCents: nextPaidAmountCents,
    amountOpenCents
  };
};

export const deleteEntry = async (
  entryId: string,
  input: EntryDeleteInput,
  actorUserId: string | null,
  actorDisplay: string | null
) => {
  const db = await getDb();
  const normalizedDeleteReasonRaw = input?.deleteReason;
  const normalizedDeleteReason =
    typeof normalizedDeleteReasonRaw === 'string' ? (normalizedDeleteReasonRaw.trim().length > 0 ? normalizedDeleteReasonRaw.trim() : null) : null;
  const resolvedActorDisplay = actorDisplay && actorDisplay.trim().length > 0 ? actorDisplay.trim() : actorUserId;

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        driverPersonId: entry.driverPersonId,
        registrationGroupId: entry.registrationGroupId,
        classId: entry.classId,
        startNumberNorm: entry.startNumberNorm,
        registrationStatus: entry.registrationStatus,
        acceptanceStatus: entry.acceptanceStatus,
        checkinIdVerified: entry.checkinIdVerified,
        techStatus: entry.techStatus,
        deletedAt: entry.deletedAt,
        deletedBy: entry.deletedBy,
        deletedByDisplay: entry.deletedByDisplay,
        deleteReason: entry.deleteReason,
        invoiceId: invoice.id,
        invoicePaymentStatus: invoice.paymentStatus
      })
      .from(entry)
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(eq(entry.id, entryId))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      return null;
    }

    if (existing.deletedAt) {
      return {
        deletedEntryId: entryId,
        deletedReason: existing.deleteReason ?? null,
        deletedByUserId: existing.deletedBy ?? null,
        deletedByDisplay:
          existing.deletedByDisplay ?? (existing.deletedBy && existing.deletedBy.includes('@') ? existing.deletedBy : null)
      };
    }

    await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

    if (existing.checkinIdVerified) {
      throw new Error('ENTRY_DELETE_FORBIDDEN_CHECKIN');
    }
    if (existing.techStatus !== 'pending') {
      throw new Error('ENTRY_DELETE_FORBIDDEN_TECH');
    }

    const paymentRows =
      existing.invoiceId === null
        ? [{ count: 0 }]
        : await tx
            .select({
              count: sql<number>`count(*)::int`
            })
            .from(invoicePayment)
            .where(eq(invoicePayment.invoiceId, existing.invoiceId))
            .limit(1);
    const paymentCount = Number(paymentRows[0]?.count ?? 0);

    if (existing.invoicePaymentStatus === 'paid' || paymentCount > 0) {
      throw new Error('ENTRY_DELETE_FORBIDDEN_PAYMENT');
    }

    await tx
      .update(entry)
      .set({
        deletedAt: new Date(),
        deletedBy: actorUserId,
        deletedByDisplay: resolvedActorDisplay,
        deleteReason: normalizedDeleteReason,
        updatedAt: new Date()
      })
      .where(eq(entry.id, entryId));

    if (existing.registrationGroupId) {
      const activeGroupEntryCountRows = await tx
        .select({
          count: sql<number>`count(*)::int`
        })
        .from(entry)
        .where(and(eq(entry.registrationGroupId, existing.registrationGroupId), sql`${entry.deletedAt} is null`))
        .limit(1);
      const activeGroupEntryCount = Number(activeGroupEntryCountRows[0]?.count ?? 0);
      if (activeGroupEntryCount === 0) {
        await tx
          .update(registrationGroup)
          .set({
            deletedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(registrationGroup.id, existing.registrationGroupId));
      }
    }

    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'entry_soft_deleted',
      entityType: 'entry',
      entityId: entryId,
      payload: {
        classId: existing.classId,
        driverPersonId: existing.driverPersonId,
        registrationStatus: existing.registrationStatus,
        acceptanceStatus: existing.acceptanceStatus,
        startNumberNorm: existing.startNumberNorm,
        deleteReason: normalizedDeleteReason,
        deletedByDisplay: resolvedActorDisplay
      }
    });

    return {
      deletedEntryId: entryId,
      deletedReason: normalizedDeleteReason,
      deletedByUserId: actorUserId,
      deletedByDisplay: resolvedActorDisplay,
      eventId: existing.eventId,
      driverPersonId: existing.driverPersonId
    };
  });

  if (result?.eventId && result?.driverPersonId) {
    await recalculateInvoices(
      result.eventId,
      {
        driverPersonId: result.driverPersonId
      },
      actorUserId
    );
  }

  if (!result) {
    return null;
  }

  return {
    deletedEntryId: result.deletedEntryId,
    deletedReason: result.deletedReason,
    deletedByUserId: result.deletedByUserId,
    deletedByDisplay: result.deletedByDisplay
  };
};

export const restoreEntry = async (entryId: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      registrationGroupId: entry.registrationGroupId,
      deletedAt: entry.deletedAt
    })
    .from(entry)
    .where(eq(entry.id, entryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  if (!existing.deletedAt) {
    return { restoredEntryId: entryId };
  }

  await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);

  try {
    await db.transaction(async (tx) => {
      if (existing.registrationGroupId) {
        await tx
          .update(registrationGroup)
          .set({
            deletedAt: null,
            updatedAt: new Date()
          })
          .where(eq(registrationGroup.id, existing.registrationGroupId));
      }
      await tx
        .update(entry)
        .set({
          deletedAt: null,
          deletedBy: null,
          deletedByDisplay: null,
          deleteReason: null,
          updatedAt: new Date()
        })
        .where(eq(entry.id, entryId));
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('RESTORE_CONFLICT');
    }
    throw error;
  }

  await writeAuditLog(db as never, {
    eventId: existing.eventId,
    actorUserId,
    action: 'entry_restored',
    entityType: 'entry',
    entityId: entryId
  });

  await recalculateInvoices(
    existing.eventId,
    {
      driverPersonId: existing.driverPersonId
    },
    actorUserId
  );

  return { restoredEntryId: entryId };
};

export const validateListEntriesQuery = (query: Record<string, string | undefined>) =>
  listEntriesQuerySchema.parse({
    eventId: query.eventId,
    classId: query.classId,
    acceptanceStatus: query.acceptanceStatus,
    registrationStatus: query.registrationStatus,
    paymentStatus: query.paymentStatus,
    q: query.q,
    checkinIdVerified: query.checkinIdVerified === undefined ? undefined : query.checkinIdVerified === 'true',
    techStatus: query.techStatus,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    sortBy: query.sortBy,
    sortDir: query.sortDir
  });
export const validateEntryStatusPatchInput = (payload: unknown) => entryStatusPatchSchema.parse(payload);
export const validateEntryTechStatusPatchInput = (payload: unknown) => techStatusPatchSchema.parse(payload);
export const validateEntryClassPatchInput = (payload: unknown) => entryClassPatchSchema.parse(payload);
export const validateEntryNotesPatchInput = (payload: unknown) => entryNotesPatchSchema.parse(payload);
export const validateEntryPaymentStatusPatchInput = (payload: unknown) => entryPaymentStatusPatchSchema.parse(payload);
export const validateEntryPaymentAmountsPatchInput = (payload: unknown) => entryPaymentAmountsPatchSchema.parse(payload);
export const validateEntryDeleteInput = (payload: unknown) => entryDeleteSchema.parse(payload);
