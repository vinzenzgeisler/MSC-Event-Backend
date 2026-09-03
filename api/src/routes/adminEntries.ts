import { and, asc, desc, eq, ilike, inArray, ne, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  auditLog,
  classPricingRule,
  consentEvidence,
  document,
  emailOutbox,
  entry,
  entryCharityCodriver,
  event,
  eventClass,
  eventPricingRule,
  invoice,
  invoicePayment,
  entryStartNumberReservation,
  person,
  registrationGroup,
  registrationGroupEmailVerification,
  vehicle
} from '../db/schema';
import { doesAssetObjectExist, getPresignedAssetsDownloadUrl } from '../docs/storage';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import {
  assertBackupClassCompatible,
  assertUniqueEffectiveRunGroups,
  reservedStartNumberClassIds,
  type RunGroupEntry
} from '../domain/runGroups';
import { deriveEntryPaymentStatus, deriveInvoicePaymentStatus, resolveEntryTotalCents } from '../domain/invoiceStatus';
import { getEntryLineTotalCents, getForecastEntryLineTotalCents, getManualEntryTotalOverrideCents } from '../domain/pricingSnapshot';
import { isPgUniqueViolation } from '../http/dbErrors';
import { decodeCursor, encodeCursor, parseListQuery } from '../http/pagination';
import { recalculateInvoices, recalculateInvoicesInTransaction } from './adminFinance';
import { resolveIamUserDisplayNames } from './adminIam';
import { queueLifecycleMail } from './adminMail';

const listEntriesQuerySchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected', 'withdrawn']).optional(),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
  paymentStatus: z.enum(['due', 'paid', 'not_required']).optional(),
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

const entryStatusPatchSchema = z
  .object({
    acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected', 'withdrawn']),
    withdrawalReason: z.string().trim().min(1).max(2000).optional(),
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
  })
  .superRefine((value, context) => {
    if (value.acceptanceStatus === 'withdrawn' && !value.withdrawalReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['withdrawalReason'],
        message: 'withdrawalReason is required when acceptanceStatus=withdrawn'
      });
    }
    if (value.acceptanceStatus === 'withdrawn' && value.sendLifecycleMail) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sendLifecycleMail'],
        message: 'Withdrawal does not have a lifecycle mail template'
      });
    }
  });

const techStatusPatchSchema = z.object({
  techStatus: z.enum(['pending', 'passed', 'failed'])
});

const entryClassPatchSchema = z.object({
  classId: z.string().uuid(),
  applyToBackupVehicle: z.boolean().optional().default(false),
  allowVehicleTypeChange: z.boolean().optional().default(true)
});

const entryBackupClassPatchSchema = z.object({
  backupClassId: z.string().uuid()
});

const entryAssignmentPatchSchema = z.object({
  classId: z.string().uuid(),
  startNumber: z.string().trim().min(1).max(6).regex(/^[a-z0-9]+$/i).transform((value) => value.toUpperCase()),
  applyToBackupVehicle: z.boolean().optional().default(false),
  allowVehicleTypeChange: z.boolean().optional().default(true),
  sendSystemMail: z.literal(true),
  requestCodriverData: z.boolean().optional().default(false)
});

type EntryRuleOverride = RunGroupEntry;

const assertActiveDriverEntryRules = async (
  tx: any,
  eventId: string,
  driverPersonId: string,
  overrides: EntryRuleOverride[] = []
) => {
  const [classes, activeEntries] = await Promise.all([
    tx
      .select({ id: eventClass.id, eventId: eventClass.eventId, runGroupId: eventClass.runGroupId })
      .from(eventClass)
      .where(eq(eventClass.eventId, eventId)),
    tx
      .select({
        id: entry.id,
        driverPersonId: entry.driverPersonId,
        classId: entry.classId,
        backupClassId: entry.backupClassId,
        isBackupVehicle: entry.isBackupVehicle
      })
      .from(entry)
      .where(
        and(
          eq(entry.eventId, eventId),
          eq(entry.driverPersonId, driverPersonId),
          sql`${entry.deletedAt} is null`,
          ne(entry.acceptanceStatus, 'withdrawn')
        )
      )
  ]);
  const overridesById = new Map(overrides.map((item) => [item.id, item]));
  const merged = activeEntries.map((item: RunGroupEntry) => overridesById.get(item.id) ?? item);
  for (const override of overrides) {
    if (!activeEntries.some((item: RunGroupEntry) => item.id === override.id)) merged.push(override);
  }
  assertUniqueEffectiveRunGroups(merged, new Map(classes.map((item: { id: string }) => [item.id, item])));
};

const assertStartNumberReservationsAvailable = async (
  tx: any,
  eventId: string,
  entryId: string,
  classId: string,
  backupClassId: string | null,
  startNumber: string | null,
  ignoredEntryIds: ReadonlySet<string>
) => {
  if (!startNumber) return;
  const classIds = reservedStartNumberClassIds(classId, backupClassId);
  const conflicts = await tx
    .select({ entryId: entryStartNumberReservation.entryId })
    .from(entryStartNumberReservation)
    .where(
      and(
        eq(entryStartNumberReservation.eventId, eventId),
        inArray(entryStartNumberReservation.classId, classIds),
        eq(entryStartNumberReservation.startNumberNorm, startNumber)
      )
    );
  if (conflicts.some((item: { entryId: string }) => item.entryId !== entryId && !ignoredEntryIds.has(item.entryId))) {
    throw new Error('START_NUMBER_CONFLICT');
  }
};

const entryNotesPatchSchema = z
  .object({
    internalNote: z.string().max(2000).nullable().optional(),
    driverNote: z.string().max(2000).nullable().optional(),
    inspectionNote: z.string().max(2000).nullable().optional()
  })
  .refine(
    (value) =>
      value.internalNote !== undefined ||
      value.driverNote !== undefined ||
      value.inspectionNote !== undefined,
    {
      message: 'Provide at least one note field'
    }
  );

const driverEmailPatchSchema = z.object({
  email: z.string().email().max(320).toLowerCase()
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

const charityCodriverRevocationSchema = z.object({
  reason: z.string().trim().min(1).max(500)
});

type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type EntryStatusPatch = z.infer<typeof entryStatusPatchSchema>;
type TechStatusPatch = z.infer<typeof techStatusPatchSchema>;
type EntryClassPatch = z.infer<typeof entryClassPatchSchema>;
type EntryAssignmentPatch = z.infer<typeof entryAssignmentPatchSchema>;
type EntryNotesPatch = z.infer<typeof entryNotesPatchSchema>;
type DriverEmailPatch = z.infer<typeof driverEmailPatchSchema>;
type EntryPaymentStatusPatch = z.infer<typeof entryPaymentStatusPatchSchema>;
type EntryPaymentAmountsPatch = z.infer<typeof entryPaymentAmountsPatchSchema>;
type EntryDeleteInput = z.infer<typeof entryDeleteSchema>;
type CharityCodriverRevocationInput = z.infer<typeof charityCodriverRevocationSchema>;

const toVehicleLabel = (make: string | null, model: string | null, startNumberNorm: string | null): string => {
  const label = [make, model].filter((part) => !!part && part.trim().length > 0).join(' ');
  if (label) {
    return label;
  }
  return startNumberNorm ? `#${startNumberNorm}` : 'Unknown vehicle';
};

export const assertAcceptanceTransitionAllowed = (from: EntryStatusPatch['acceptanceStatus'], to: EntryStatusPatch['acceptanceStatus']) => {
  const allowed: Record<EntryStatusPatch['acceptanceStatus'], EntryStatusPatch['acceptanceStatus'][]> = {
    pending: ['shortlist', 'accepted', 'rejected', 'withdrawn'],
    shortlist: ['pending', 'accepted', 'rejected', 'withdrawn'],
    accepted: ['pending', 'shortlist', 'rejected', 'withdrawn'],
    rejected: ['pending', 'shortlist', 'accepted', 'withdrawn'],
    withdrawn: ['pending', 'shortlist', 'accepted', 'rejected']
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
  const startNumberTypeOrder = sql<number>`case when ${entry.startNumberNorm} ~ '^[0-9]+$' then 0 else 1 end`;
  const numericStartNumber = sql<number>`case when ${entry.startNumberNorm} ~ '^[0-9]+$' then ${entry.startNumberNorm}::int end`;
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
              ? [
                  orderTerm(startNumberTypeOrder),
                  orderTerm(numericStartNumber),
                  orderTerm(entry.startNumberNorm),
                  orderTerm(entry.id)
                ]
              : paginationQuery.sortBy === 'deletedAt'
                ? [orderTerm(entry.deletedAt), orderTerm(entry.id)]
                : [orderTerm(eventClass.name), orderTerm(person.lastName), orderTerm(person.firstName), orderTerm(entry.id)];

  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
      backupClassId: entry.backupClassId,
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
      waiverSignedDocumentId: sql<string | null>`(select d."id" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.driverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      waiverSignedAt: sql<Date | null>`(select d."created_at" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.driverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      codriverWaiverSignedDocumentId: sql<string | null>`(select d."id" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.codriverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      codriverWaiverSignedAt: sql<Date | null>`(select d."created_at" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.codriverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      startNumberNorm: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      confirmationMailSentAt: entry.confirmationMailSentAt,
      confirmationMailVerifiedAt: entry.confirmationMailVerifiedAt,
      deletedAt: entry.deletedAt,
      deletedBy: entry.deletedBy,
      deletedByDisplay: entry.deletedByDisplay,
      deleteReason: entry.deleteReason,
      withdrawnReason: entry.withdrawnReason,
      withdrawnAt: entry.withdrawnAt,
      withdrawnBy: entry.withdrawnBy,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      driverPersonId: entry.driverPersonId,
      codriverPersonId: entry.codriverPersonId,
      driverProcessingRestricted: person.processingRestricted,
      driverObjectionFlag: person.objectionFlag,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleImageS3Key: vehicle.imageS3Key,
      entryFeeCents: entry.entryFeeCents,
      invoiceTotalCents: invoice.totalCents,
      invoicePricingSnapshot: invoice.pricingSnapshot,
      invoicePaymentStatus: invoice.paymentStatus,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(and(...conditions))
    .orderBy(...orderBy);

  const driverPersonIds = Array.from(new Set(rows.map((row) => row.driverPersonId)));
  const [eventPricingRows, classPricingRows, driverEntryRows] = await Promise.all([
    db
      .select({
        earlyDeadline: eventPricingRule.earlyDeadline,
        lateFeeCents: eventPricingRule.lateFeeCents,
        secondVehicleDiscountCents: eventPricingRule.secondVehicleDiscountCents
      })
      .from(eventPricingRule)
      .where(eq(eventPricingRule.eventId, query.eventId))
      .limit(1),
    db
      .select({
        classId: classPricingRule.classId,
        baseFeeCents: classPricingRule.baseFeeCents
      })
      .from(classPricingRule)
      .where(eq(classPricingRule.eventId, query.eventId)),
    driverPersonIds.length > 0
      ? db
          .select({
            id: entry.id,
            driverPersonId: entry.driverPersonId,
            acceptanceStatus: entry.acceptanceStatus,
            createdAt: entry.createdAt
          })
          .from(entry)
          .where(
            and(
              eq(entry.eventId, query.eventId),
              inArray(entry.driverPersonId, driverPersonIds),
              sql`${entry.deletedAt} is null`
            )
          )
          .orderBy(asc(entry.driverPersonId), asc(entry.createdAt), asc(entry.id))
      : Promise.resolve([])
  ]);
  const eventPricing = eventPricingRows[0] ?? null;
  const classFeeByClassId = new Map(classPricingRows.map((row) => [row.classId, row.baseFeeCents]));
  const driverEntriesByPersonId = new Map<string, typeof driverEntryRows>();
  for (const driverEntry of driverEntryRows) {
    const bucket = driverEntriesByPersonId.get(driverEntry.driverPersonId) ?? [];
    bucket.push(driverEntry);
    driverEntriesByPersonId.set(driverEntry.driverPersonId, bucket);
  }

  const rowsWithPaymentStatus = rows.map((row) => {
    const driverEntries = driverEntriesByPersonId.get(row.driverPersonId) ?? [];
    const activeDriverEntries = driverEntries.filter(
      (item) => item.acceptanceStatus !== 'rejected' && item.acceptanceStatus !== 'withdrawn'
    );
    const acceptedDriverEntryCount = driverEntries.filter((item) => item.acceptanceStatus === 'accepted').length;
    const entryOrderIndex = activeDriverEntries.findIndex((item) => item.id === row.id);
    const classBaseFeeCents = classFeeByClassId.get(row.classId);
    const provisionalTotalCents =
      classBaseFeeCents === undefined || row.acceptanceStatus === 'rejected' || row.acceptanceStatus === 'withdrawn'
        ? null
        : Math.max(
            0,
            classBaseFeeCents +
              (eventPricing && row.createdAt > eventPricing.earlyDeadline ? eventPricing.lateFeeCents : 0) -
              (eventPricing && entryOrderIndex > 0 ? eventPricing.secondVehicleDiscountCents : 0)
          );
    const entryTotalCents = resolveEntryTotalCents({
      acceptanceStatus: row.acceptanceStatus,
      focusedBillableTotalCents: getEntryLineTotalCents(row.invoicePricingSnapshot, row.id),
      focusedForecastTotalCents: getForecastEntryLineTotalCents(row.invoicePricingSnapshot, row.id),
      manualOverrideCents: getManualEntryTotalOverrideCents(row.invoicePricingSnapshot, row.id),
      acceptedDriverEntryCount,
      invoiceTotalCents: row.invoiceTotalCents,
      provisionalTotalCents
    });
    const paymentStatus = deriveEntryPaymentStatus(
      entryTotalCents,
      row.acceptanceStatus,
      row.invoicePaymentStatus
    );
    return { row, paymentStatus };
  });
  const filteredRows = query.paymentStatus
    ? rowsWithPaymentStatus.filter((item) => item.paymentStatus === query.paymentStatus)
    : rowsWithPaymentStatus;
  const total = filteredRows.length;
  const pageRows = filteredRows.slice(offset, offset + paginationQuery.limit);

  const mapped = await Promise.all(pageRows.map(async ({ row, paymentStatus }) => {
    const completed =
      row.acceptanceStatus === 'accepted' && (paymentStatus === 'paid' || paymentStatus === 'not_required');
    const vehicleLabel = toVehicleLabel(row.vehicleMake, row.vehicleModel, row.startNumberNorm);
    const vehicleThumbUrl = await getVehicleThumbUrl(row.vehicleImageS3Key);
    const shouldRedactSensitiveFields = redactSensitiveFields || row.driverProcessingRestricted || row.driverObjectionFlag;
    const {
      invoicePricingSnapshot: _pricingSnapshot,
      invoicePaymentStatus: _invoicePaymentStatus,
      waiverSignedDocumentId: _waiverSignedDocumentId,
      waiverSignedAt: _waiverSignedAt,
      codriverWaiverSignedDocumentId: _codriverWaiverSignedDocumentId,
      codriverWaiverSignedAt: _codriverWaiverSignedAt,
      ...publicRow
    } = row;
    return {
      ...publicRow,
      paymentStatus,
      completionStatus: completed ? 'completed' : 'open',
      vehicleLabel,
      vehicleThumbUrl,
      confirmationMailSent: row.confirmationMailSentAt !== null,
      confirmationMailVerified: row.confirmationMailVerifiedAt !== null,
      waiverSigned: {
        signed: Boolean(row.waiverSignedDocumentId),
        signedAt: row.waiverSignedAt,
        documentId: row.waiverSignedDocumentId
      },
      waiverSigners: {
        driver: {
          signed: Boolean(row.waiverSignedDocumentId),
          signedAt: row.waiverSignedAt,
          documentId: row.waiverSignedDocumentId
        },
        codriver: row.codriverPersonId
          ? {
              signed: Boolean(row.codriverWaiverSignedDocumentId),
              signedAt: row.codriverWaiverSignedAt,
              documentId: row.codriverWaiverSignedDocumentId
            }
          : null
      },
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
  listEntries({ ...query, acceptanceStatus: 'accepted' }, redactSensitiveFields);

export const getEntryDetail = async (entryId: string, redactSensitiveFields: boolean) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
      vehicleId: entry.vehicleId,
      backupVehicleId: entry.backupVehicleId,
      backupClassId: entry.backupClassId,
      className: eventClass.name,
      registrationStatus: entry.registrationStatus,
      acceptanceStatus: entry.acceptanceStatus,
      withdrawnReason: entry.withdrawnReason,
      withdrawnAt: entry.withdrawnAt,
      withdrawnBy: entry.withdrawnBy,
      checkinIdVerified: entry.checkinIdVerified,
      checkinIdVerifiedAt: entry.checkinIdVerifiedAt,
      checkinIdVerifiedBy: entry.checkinIdVerifiedBy,
      techStatus: entry.techStatus,
      techCheckedAt: entry.techCheckedAt,
      techCheckedBy: entry.techCheckedBy,
      waiverSignedDocumentId: sql<string | null>`(select d."id" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.driverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      waiverSignedAt: sql<Date | null>`(select d."created_at" from "document" d where d."entry_id" = ${entry.id} and d."type" = 'waiver_signed' and d."status" = 'generated' and d."driver_person_id" = ${entry.driverPersonId} order by d."created_at" desc, d."id" desc limit 1)`,
      startNumberNorm: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      isBackupVehicle: entry.isBackupVehicle,
      backupOfEntryId: entry.backupOfEntryId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      specialNotes: entry.specialNotes,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      inspectionNote: entry.inspectionNote,
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
    .where(eq(entry.id, entryId))
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
  const charityCodriverRows = await db
    .select({
      registrationId: entryCharityCodriver.id,
      personId: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      birthdate: person.birthdate,
      processingRestricted: person.processingRestricted,
      objectionFlag: person.objectionFlag,
      terminalSessionId: entryCharityCodriver.terminalSessionId,
      status: entryCharityCodriver.status,
      revokedAt: entryCharityCodriver.revokedAt,
      revokedBy: entryCharityCodriver.revokedBy,
      revocationReason: entryCharityCodriver.revocationReason,
      createdAt: entryCharityCodriver.createdAt
    })
    .from(entryCharityCodriver)
    .innerJoin(person, eq(entryCharityCodriver.personId, person.id))
    .where(eq(entryCharityCodriver.entryId, current.id))
    .orderBy(asc(entryCharityCodriver.createdAt));
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
  const backupClassRows = current.backupClassId
    ? await db
        .select({ id: eventClass.id, name: eventClass.name })
        .from(eventClass)
        .where(eq(eventClass.id, current.backupClassId))
        .limit(1)
    : [];
  const backupClass = backupClassRows[0] ?? null;
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
      driverPersonId: document.driverPersonId,
      signingSessionId: document.signingSessionId,
      createdAt: document.createdAt
    })
    .from(document)
    .where(eq(document.entryId, entryId))
    .orderBy(sql`${document.createdAt} desc`, sql`${document.id} desc`);

  const driverSignedWaiverDocument = documentRows.find(
    (row) => row.type === 'waiver_signed' && row.status === 'generated' && row.driverPersonId === current.driverPersonId
  ) ?? null;
  const codriverSignedWaiverDocument = current.codriverPersonId
    ? documentRows.find(
        (row) => row.type === 'waiver_signed' && row.status === 'generated' && row.driverPersonId === current.codriverPersonId
      ) ?? null
    : null;

  const driverEntryRows = await db
    .select({
      id: entry.id,
      acceptanceStatus: entry.acceptanceStatus,
      createdAt: entry.createdAt
    })
    .from(entry)
    .where(and(eq(entry.eventId, current.eventId), eq(entry.driverPersonId, current.driverPersonId), sql`${entry.deletedAt} is null`))
    .orderBy(asc(entry.createdAt), asc(entry.id));

  const relatedEntryIds = driverEntryRows
    .filter((row) => row.acceptanceStatus === 'accepted')
    .map((row) => row.id)
    .filter((id) => id !== entryId);
  const activeDriverEntryRows = driverEntryRows.filter(
    (row) => row.acceptanceStatus !== 'rejected' && row.acceptanceStatus !== 'withdrawn'
  );
  const acceptedDriverEntryCount = driverEntryRows.filter((row) => row.acceptanceStatus === 'accepted').length;

  const [eventPricingRuleRows, classPricingRuleRows] = await Promise.all([
    db
      .select({
        earlyDeadline: eventPricingRule.earlyDeadline,
        lateFeeCents: eventPricingRule.lateFeeCents,
        secondVehicleDiscountCents: eventPricingRule.secondVehicleDiscountCents
      })
      .from(eventPricingRule)
      .where(eq(eventPricingRule.eventId, current.eventId))
      .limit(1),
    db
      .select({
        baseFeeCents: classPricingRule.baseFeeCents
      })
      .from(classPricingRule)
      .where(and(eq(classPricingRule.eventId, current.eventId), eq(classPricingRule.classId, current.classId)))
      .limit(1)
  ]);
  const eventPricing = eventPricingRuleRows[0] ?? null;
  const classPricing = classPricingRuleRows[0] ?? null;

  const entryOrderIndex = activeDriverEntryRows.findIndex((row) => row.id === entryId);
  const provisionalTotalCents = (() => {
    if (!classPricing || current.acceptanceStatus === 'rejected' || current.acceptanceStatus === 'withdrawn') {
      return null;
    }
    const baseFeeCents = classPricing.baseFeeCents ?? 0;
    const lateFeeCents =
      eventPricing && current.createdAt > eventPricing.earlyDeadline ? eventPricing.lateFeeCents : 0;
    const secondVehicleDiscountCents = eventPricing && entryOrderIndex > 0 ? eventPricing.secondVehicleDiscountCents : 0;
    return Math.max(0, baseFeeCents + lateFeeCents - secondVehicleDiscountCents);
  })();

  const focusedBillableTotalCents = getEntryLineTotalCents(current.invoicePricingSnapshot, entryId);
  const focusedForecastTotalCents = getForecastEntryLineTotalCents(current.invoicePricingSnapshot, entryId);
  const manualOverrideCents = getManualEntryTotalOverrideCents(current.invoicePricingSnapshot, entryId);
  const resolvedTotalCents = resolveEntryTotalCents({
    acceptanceStatus: current.acceptanceStatus,
    focusedBillableTotalCents,
    focusedForecastTotalCents,
    manualOverrideCents,
    acceptedDriverEntryCount,
    invoiceTotalCents: current.invoiceTotalCents,
    provisionalTotalCents
  });
  const isInactiveEntry = current.acceptanceStatus === 'rejected' || current.acceptanceStatus === 'withdrawn';
  const hasRecordedPayment = (current.invoicePaidAmountCents ?? 0) > 0;
  const isPaymentApplicable = !isInactiveEntry || hasRecordedPayment;
  const totalCents = isPaymentApplicable
    ? resolvedTotalCents ?? current.invoiceTotalCents ?? current.invoicePaidAmountCents ?? 0
    : null;
  const paidAmountCents =
    !isPaymentApplicable
      ? null
      : isInactiveEntry
      ? current.invoicePaidAmountCents ?? 0
      : current.acceptanceStatus !== 'accepted'
      ? 0
      : current.invoicePaymentStatus === 'paid'
      ? totalCents
      : acceptedDriverEntryCount === 1
        ? Math.min(current.invoicePaidAmountCents ?? 0, totalCents ?? 0)
        : 0;
  const amountOpenCents = totalCents === null || paidAmountCents === null ? null : Math.max(0, totalCents - paidAmountCents);
  const paymentStatus = deriveEntryPaymentStatus(
    resolvedTotalCents,
    current.acceptanceStatus,
    current.invoicePaymentStatus
  );

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
    .orderBy(desc(auditLog.createdAt));
  const actorDisplayNames = await resolveIamUserDisplayNames(
    Array.from(new Set(historyRows.map((row) => row.actorUserId).filter((value): value is string => Boolean(value))))
  );

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
        backupClassId: current.backupClassId,
        driverPersonId: current.driverPersonId,
        codriverPersonId: current.codriverPersonId,
        vehicleId: current.vehicleId,
        backupVehicleId: current.backupVehicleId,
        backupOfEntryId: current.backupOfEntryId
      },
      className: current.className,
      backupClassName: backupClass?.name ?? null,
      registrationStatus: current.registrationStatus,
      acceptanceStatus: current.acceptanceStatus,
      withdrawnReason: current.withdrawnReason,
      withdrawnAt: current.withdrawnAt,
      withdrawnBy: current.withdrawnBy,
      startNumberNorm: current.startNumberNorm,
      orgaCode: current.orgaCode,
      isBackupVehicle: current.isBackupVehicle,
      relatedEntryIds,
      vehicleLabel,
      vehicleThumbUrl,
      backupVehicleThumbUrl,
      confirmationMailSent: current.confirmationMailSentAt !== null,
      confirmationMailVerified: current.confirmationMailVerifiedAt !== null,
      waiverSigned: {
        signed: Boolean(driverSignedWaiverDocument),
        signedAt: driverSignedWaiverDocument?.createdAt ?? null,
        documentId: driverSignedWaiverDocument?.id ?? null
      },
      waiverSigners: {
        driver: {
          signed: Boolean(driverSignedWaiverDocument),
          signedAt: driverSignedWaiverDocument?.createdAt ?? null,
          documentId: driverSignedWaiverDocument?.id ?? null,
          signingSessionId: driverSignedWaiverDocument?.signingSessionId ?? null
        },
        codriver: codriver
          ? {
              signed: Boolean(codriverSignedWaiverDocument),
              signedAt: codriverSignedWaiverDocument?.createdAt ?? null,
              documentId: codriverSignedWaiverDocument?.id ?? null,
              signingSessionId: codriverSignedWaiverDocument?.signingSessionId ?? null
            }
          : null
      },
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
              id: codriver.id,
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
          : null,
        charityCodrivers: charityCodriverRows.map((item) => {
          const restricted = redactSensitiveFields || item.processingRestricted || item.objectionFlag;
          return {
            registrationId: item.registrationId,
            personId: item.personId,
            firstName: restricted ? null : item.firstName,
            lastName: restricted ? null : item.lastName,
            email: restricted ? null : item.email,
            birthdate: restricted ? null : item.birthdate,
            createdAt: item.createdAt,
            status: item.status,
            terminalSessionId: item.terminalSessionId,
            revokedAt: item.revokedAt,
            revokedBy: item.revokedBy,
            revocationReason: item.revocationReason,
            waiverSigned: (() => {
              const signedDocument = documentRows.find(
                (row) => row.type === 'waiver_signed'
                  && row.status === 'generated'
                  && row.driverPersonId === item.personId
                  && (!item.terminalSessionId || row.signingSessionId === item.terminalSessionId)
              ) ?? null;
              return {
                signed: Boolean(signedDocument),
                signedAt: signedDocument?.createdAt ?? null,
                documentId: signedDocument?.id ?? null,
                signingSessionId: signedDocument?.signingSessionId ?? item.terminalSessionId ?? null
              };
            })()
          };
        })
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
        paymentStatus
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
      inspectionNote: current.inspectionNote,
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
    history: historyRows.map((row) => ({
      ...row,
      actorDisplay: row.actorUserId ? actorDisplayNames.get(row.actorUserId) ?? null : 'System'
    }))
  };
};

export const patchEntryStatus = async (entryId: string, input: EntryStatusPatch, actorUserId: string | null) => {
  const db = await getDb();
  const shouldQueueLifecycleMail = input.sendLifecycleMail && input.acceptanceStatus !== 'shortlist';
  const lifecycleEventType =
    input.lifecycleEventType ??
    (input.acceptanceStatus === 'accepted'
      ? 'accepted_open_payment'
      : input.acceptanceStatus === 'rejected'
        ? 'rejected'
        : undefined);
  if (shouldQueueLifecycleMail && !lifecycleEventType) {
    throw new Error('LIFECYCLE_EVENT_TYPE_REQUIRED');
  }
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      registrationGroupId: entry.registrationGroupId,
      acceptanceStatus: entry.acceptanceStatus,
      driverPersonId: entry.driverPersonId,
      classId: entry.classId,
      backupClassId: entry.backupClassId,
      isBackupVehicle: entry.isBackupVehicle,
      startNumberNorm: entry.startNumberNorm,
      deletedAt: entry.deletedAt
    })
    .from(entry)
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
  assertAcceptanceTransitionAllowed(existing.acceptanceStatus as EntryStatusPatch['acceptanceStatus'], input.acceptanceStatus);

  if (existing.acceptanceStatus === 'withdrawn' && input.acceptanceStatus !== 'withdrawn' && existing.startNumberNorm) {
    await assertStartNumberReservationsAvailable(
      db,
      existing.eventId,
      entryId,
      existing.classId,
      existing.backupClassId,
      existing.startNumberNorm,
      new Set([entryId])
    );
  }
  if (existing.acceptanceStatus === 'withdrawn' && input.acceptanceStatus !== 'withdrawn') {
    await assertActiveDriverEntryRules(db, existing.eventId, existing.driverPersonId, [{
      id: entryId,
      driverPersonId: existing.driverPersonId,
      classId: existing.classId,
      backupClassId: existing.backupClassId,
      isBackupVehicle: existing.isBackupVehicle
    }]);
  }

  const now = new Date();

  const [updated] = await db
    .update(entry)
    .set({
      acceptanceStatus: input.acceptanceStatus,
      ...(input.acceptanceStatus === 'withdrawn'
        ? {
            withdrawnReason: input.withdrawalReason,
            withdrawnAt: now,
            withdrawnBy: actorUserId
          }
        : {}),
      updatedAt: now
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
      to: input.acceptanceStatus,
      withdrawalReason: input.acceptanceStatus === 'withdrawn' ? input.withdrawalReason : undefined,
      withdrawnAt: input.acceptanceStatus === 'withdrawn' ? now.toISOString() : undefined
    }
  });

  await recalculateInvoices(
    existing.eventId,
    {
      driverPersonId: existing.driverPersonId
    },
    actorUserId
  );

  if (input.acceptanceStatus === 'withdrawn') {
    await db.execute(sql`
      update ${emailOutbox}
      set status = 'failed',
          error_last = 'SUPPRESSED_ENTRY_WITHDRAWN',
          updated_at = now()
      where event_id = ${existing.eventId}
        and status in ('queued', 'sending')
        and (
          template_data->>'entryId' = ${entryId}
          or (
            ${existing.registrationGroupId}::text is not null
            and template_data->>'registrationGroupId' = ${existing.registrationGroupId}::text
            and not exists (
              select 1
              from ${entry} active
              where active.registration_group_id = ${existing.registrationGroupId}
                and active.deleted_at is null
                and active.acceptance_status <> 'withdrawn'
            )
          )
        )
    `);
  }

  if (shouldQueueLifecycleMail) {
    if (!lifecycleEventType) {
      throw new Error('LIFECYCLE_EVENT_TYPE_REQUIRED');
    }
    await queueLifecycleMail(
      {
        eventId: existing.eventId,
        entryId,
        eventType: lifecycleEventType,
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
        backupClassId: entry.backupClassId,
        driverPersonId: entry.driverPersonId,
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
        backupClassId: entry.backupClassId,
        driverPersonId: entry.driverPersonId,
        isBackupVehicle: entry.isBackupVehicle,
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
    await assertActiveDriverEntryRules(
      tx,
      existing.eventId,
      existing.driverPersonId,
      updateRows.map((row) => ({
        id: row.id,
        driverPersonId: row.driverPersonId,
        classId: input.classId,
        backupClassId: row.backupClassId,
        isBackupVehicle: row.isBackupVehicle
      }))
    );
    const ignoredEntryIds = new Set(updateIds);

    for (const targetRow of targetRows) {
      if (!updateEntryIds.has(targetRow.id)) {
        continue;
      }
      if (!targetRow.startNumberNorm) {
        continue;
      }
      await assertStartNumberReservationsAvailable(
        tx,
        existing.eventId,
        targetRow.id,
        input.classId,
        targetRow.backupClassId,
        targetRow.startNumberNorm,
        ignoredEntryIds
      );
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

export const patchEntryBackupClass = async (
  entryId: string,
  input: z.infer<typeof entryBackupClassPatchSchema>,
  actorUserId: string | null
) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        classId: entry.classId,
        backupClassId: entry.backupClassId,
        backupVehicleId: entry.backupVehicleId,
        startNumberNorm: entry.startNumberNorm,
        deletedAt: entry.deletedAt
      })
      .from(entry)
      .where(eq(entry.id, entryId))
      .limit(1);
    if (!existing) return null;
    if (existing.deletedAt || !existing.backupVehicleId || !existing.backupClassId) {
      throw new Error('INVALID_STATE');
    }
    await assertEventStatusAllowed(existing.eventId, ['open', 'closed']);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${existing.eventId}))`);

    const classes = await tx
      .select({
        id: eventClass.id,
        eventId: eventClass.eventId,
        runGroupId: eventClass.runGroupId,
        registrationClosed: eventClass.registrationClosed,
        vehicleType: eventClass.vehicleType
      })
      .from(eventClass)
      .where(inArray(eventClass.id, [existing.classId, input.backupClassId]));
    const primaryClass = classes.find((item: { id: string }) => item.id === existing.classId);
    const backupClass = classes.find((item: { id: string }) => item.id === input.backupClassId);
    if (!primaryClass || !backupClass) throw new Error('CLASS_NOT_FOUND');
    assertBackupClassCompatible(primaryClass, backupClass, { requireOpen: true });

    await assertStartNumberReservationsAvailable(
      tx,
      existing.eventId,
      entryId,
      existing.classId,
      input.backupClassId,
      existing.startNumberNorm,
      new Set([entryId])
    );
    await tx.update(vehicle).set({ vehicleType: backupClass.vehicleType, updatedAt: new Date() }).where(eq(vehicle.id, existing.backupVehicleId));
    const [updated] = await tx
      .update(entry)
      .set({ backupClassId: input.backupClassId, updatedAt: new Date() })
      .where(eq(entry.id, entryId))
      .returning({ id: entry.id, backupClassId: entry.backupClassId });
    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'entry_backup_class_updated',
      entityType: 'entry',
      entityId: entryId,
      payload: { previousBackupClassId: existing.backupClassId, backupClassId: input.backupClassId }
    });
    return { ...updated, backupVehicleType: backupClass.vehicleType };
  });
};

const CODRIVER_FIELD_LIST = [
  'Vorname',
  'Nachname',
  'Geburtsdatum',
  'Land',
  'Straße',
  'PLZ',
  'Ort',
  'E-Mail-Adresse',
  'Telefonnummer'
] as const;

export const buildAssignmentMailBody = (requestCodriverData: boolean) => {
  const assignmentText =
    'Ihre Nennung für {{eventName}} wurde neu zugeordnet.\n\n' +
    'Neue Klasse: {{className}}\n' +
    'Neue Startnummer: {{startNumber}}';
  const codriverText = requestCodriverData
    ? '\n\nBitte senden Sie uns für die manuelle Ergänzung Ihres Beifahrers folgende Angaben:\n' +
      CODRIVER_FIELD_LIST.map((field) => `- ${field}`).join('\n')
    : '';
  const closing =
    '\n\nBei Fragen wenden Sie sich bitte an nennung@msc-oberlausitzer-dreilaendereck.eu.' +
    '\n\nMit freundlichen Grüßen\nMSC Oberlausitzer Dreiländereck e.V.';
  const text = `Hallo {{driverName}},\n\n${assignmentText}${codriverText}${closing}`;
  const htmlFields = requestCodriverData
    ? `<p>Bitte senden Sie uns für die manuelle Ergänzung Ihres Beifahrers folgende Angaben:</p><ul>${CODRIVER_FIELD_LIST.map((field) => `<li>${field}</li>`).join('')}</ul>`
    : '';
  const html =
    '<p>Hallo {{driverName}},</p>' +
    '<p>Ihre Nennung für <strong>{{eventName}}</strong> wurde neu zugeordnet.</p>' +
    '<p><strong>Neue Klasse:</strong> {{className}}<br><strong>Neue Startnummer:</strong> {{startNumber}}</p>' +
    htmlFields +
    '<p>Bei Fragen wenden Sie sich bitte an <a href="mailto:nennung@msc-oberlausitzer-dreilaendereck.eu">nennung@msc-oberlausitzer-dreilaendereck.eu</a>.</p>' +
    '<p>Mit freundlichen Grüßen<br>MSC Oberlausitzer Dreiländereck e.V.</p>';
  return { text, html };
};

export const buildEntryAssignmentIdempotencyKey = (
  entryId: string,
  classId: string,
  startNumber: string,
  requestCodriverData: boolean,
  applyToBackupVehicle = false,
  allowVehicleTypeChange = true
) => [
  'entry-assignment',
  entryId,
  classId,
  startNumber,
  requestCodriverData ? 'codriver' : 'standard',
  applyToBackupVehicle ? 'backup' : 'primary',
  allowVehicleTypeChange ? 'align-vehicle' : 'preserve-vehicle'
].join(':');

export const patchEntryAssignment = async (
  entryId: string,
  input: EntryAssignmentPatch,
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        eventName: event.name,
        classId: entry.classId,
        backupClassId: entry.backupClassId,
        driverPersonId: entry.driverPersonId,
        codriverPersonId: entry.codriverPersonId,
        isBackupVehicle: entry.isBackupVehicle,
        backupOfEntryId: entry.backupOfEntryId,
        startNumberNorm: entry.startNumberNorm,
        vehicleType: vehicle.vehicleType,
        driverEmail: person.email,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        processingRestricted: person.processingRestricted,
        objectionFlag: person.objectionFlag,
        deletedAt: entry.deletedAt
      })
      .from(entry)
      .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(event, eq(entry.eventId, event.id))
      .where(eq(entry.id, entryId))
      .limit(1)
      .for('update');

    const existing = rows[0];
    if (!existing) {
      return null;
    }
    if (existing.deletedAt) {
      throw new Error('INVALID_STATE');
    }
    const statusRows = await tx.select({ status: event.status }).from(event).where(eq(event.id, existing.eventId)).limit(1);
    if (!statusRows[0] || !['open', 'closed'].includes(statusRows[0].status)) {
      throw new Error(statusRows[0] ? 'EVENT_STATUS_FORBIDDEN' : 'EVENT_NOT_FOUND');
    }

    const targetClassRows = await tx
      .select({
        id: eventClass.id,
        eventId: eventClass.eventId,
        name: eventClass.name,
        vehicleType: eventClass.vehicleType,
        allowsCodriver: eventClass.allowsCodriver
      })
      .from(eventClass)
      .where(eq(eventClass.id, input.classId))
      .limit(1);
    const targetClass = targetClassRows[0];
    if (!targetClass || targetClass.eventId !== existing.eventId) {
      throw new Error('CLASS_NOT_FOUND');
    }
    if (input.requestCodriverData && !targetClass.allowsCodriver) {
      throw new Error('CODRIVER_NOT_ALLOWED');
    }
    if (input.requestCodriverData && existing.codriverPersonId) {
      throw new Error('CODRIVER_ALREADY_ASSIGNED');
    }
    if (!existing.driverEmail || existing.processingRestricted || existing.objectionFlag) {
      throw new Error('DRIVER_MAIL_UNAVAILABLE');
    }

    const idempotencyKey = buildEntryAssignmentIdempotencyKey(
      entryId,
      input.classId,
      input.startNumber,
      input.requestCodriverData,
      input.applyToBackupVehicle,
      input.allowVehicleTypeChange
    );
    const duplicateRows = await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    if (duplicateRows[0]) {
      if (existing.classId !== input.classId || existing.startNumberNorm !== input.startNumber) {
        throw new Error('ASSIGNMENT_NOTIFICATION_ALREADY_QUEUED');
      }
      return {
        id: entryId,
        classId: input.classId,
        startNumber: input.startNumber,
        vehicleTypeBefore: existing.vehicleType,
        vehicleTypeAfter: input.allowVehicleTypeChange ? targetClass.vehicleType : existing.vehicleType,
        backupVehicleUpdated: false,
        warnings: [] as string[],
        outboxId: duplicateRows[0].id,
        mailQueued: false,
        idempotent: true
      };
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
        backupEntryId = linkedRows[0]?.id ?? null;
      }
      if (backupEntryId) {
        updateEntryIds.add(backupEntryId);
      } else {
        warnings.push('No linked backup entry found to update.');
      }
    }

    const targetRows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        driverPersonId: entry.driverPersonId,
        backupClassId: entry.backupClassId,
        isBackupVehicle: entry.isBackupVehicle,
        vehicleId: entry.vehicleId,
        startNumberNorm: entry.startNumberNorm,
        deletedAt: entry.deletedAt
      })
      .from(entry)
      .where(inArray(entry.id, Array.from(updateEntryIds)));
    const activeTargetRows = targetRows.filter((row) => {
      if (!row.deletedAt && row.eventId === existing.eventId) {
        return true;
      }
      if (row.id !== entryId) {
        warnings.push('Linked backup entry was skipped because it is not active.');
        updateEntryIds.delete(row.id);
      }
      return false;
    });
    if (!activeTargetRows.some((row) => row.id === entryId)) {
      throw new Error('INVALID_STATE');
    }

    await assertActiveDriverEntryRules(
      tx,
      existing.eventId,
      existing.driverPersonId,
      activeTargetRows.map((row) => ({
        id: row.id,
        driverPersonId: row.driverPersonId,
        classId: input.classId,
        backupClassId: row.backupClassId,
        isBackupVehicle: row.isBackupVehicle
      }))
    );

    const nextStartNumberById = new Map(
      activeTargetRows.map((row) => [row.id, row.id === entryId ? input.startNumber : row.startNumberNorm])
    );
    for (const targetRow of activeTargetRows) {
      const nextStartNumber = nextStartNumberById.get(targetRow.id);
      if (!nextStartNumber) {
        continue;
      }
      await assertStartNumberReservationsAvailable(
        tx,
        existing.eventId,
        targetRow.id,
        input.classId,
        targetRow.backupClassId,
        nextStartNumber,
        updateEntryIds
      );
    }

    await tx
      .update(entry)
      .set({
        classId: input.classId,
        startNumberNorm: sql`case when ${entry.id} = ${entryId} then ${input.startNumber} else ${entry.startNumberNorm} end`,
        updatedAt: now
      })
      .where(inArray(entry.id, activeTargetRows.map((row) => row.id)));

    let vehicleTypeAfter = existing.vehicleType;
    if (input.allowVehicleTypeChange) {
      await tx
        .update(vehicle)
        .set({ vehicleType: targetClass.vehicleType, updatedAt: now })
        .where(inArray(vehicle.id, activeTargetRows.map((row) => row.vehicleId)));
      vehicleTypeAfter = targetClass.vehicleType;
    } else if (existing.vehicleType !== targetClass.vehicleType) {
      warnings.push('Vehicle type change skipped by request; class and vehicle type now differ.');
    }

    const affectedPricingRows = existing.classId === input.classId
      ? []
      : await tx
          .select({ classId: classPricingRule.classId, baseFeeCents: classPricingRule.baseFeeCents })
          .from(classPricingRule)
          .where(and(
            eq(classPricingRule.eventId, existing.eventId),
            inArray(classPricingRule.classId, [existing.classId, input.classId])
          ));
    const feeByClass = new Map(affectedPricingRows.map((row) => [row.classId, row.baseFeeCents]));
    if ((feeByClass.get(existing.classId) ?? 0) !== (feeByClass.get(input.classId) ?? 0)) {
      await recalculateInvoicesInTransaction(tx, existing.eventId, { driverPersonId: existing.driverPersonId }, actorUserId);
    }

    const body = buildAssignmentMailBody(input.requestCodriverData);
    const [outbox] = await tx
      .insert(emailOutbox)
      .values({
        eventId: existing.eventId,
        toEmail: existing.driverEmail,
        subject: 'Neue Klasseneinteilung und Startnummer – {{eventName}}',
        templateId: 'entry_assignment_changed',
        templateVersion: 1,
        templateData: {
          entryId,
          driverPersonId: existing.driverPersonId,
          driverName: `${existing.driverFirstName} ${existing.driverLastName}`.trim(),
          eventName: existing.eventName,
          className: targetClass.name,
          startNumber: input.startNumber,
          requestCodriverData: input.requestCodriverData,
          requestedCodriverFields: input.requestCodriverData ? [...CODRIVER_FIELD_LIST] : [],
          bodyTextOverride: body.text,
          bodyHtmlOverride: body.html,
          renderOptions: { showBadge: false, mailLabel: 'Systemnachricht', includeEntryContext: true }
        },
        status: 'queued',
        sendAfter: now,
        idempotencyKey,
        maxAttempts: 5
      })
      .returning({ id: emailOutbox.id });
    if (!outbox) {
      throw new Error('OUTBOX_INSERT_FAILED');
    }

    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'entry_assignment_updated',
      entityType: 'entry',
      entityId: entryId,
      payload: {
        previousClassId: existing.classId,
        classId: input.classId,
        previousStartNumber: existing.startNumberNorm,
        startNumber: input.startNumber,
        requestCodriverData: input.requestCodriverData,
        outboxId: outbox.id
      }
    });

    return {
      id: entryId,
      classId: input.classId,
      startNumber: input.startNumber,
      vehicleTypeBefore: existing.vehicleType,
      vehicleTypeAfter,
      backupVehicleUpdated: Boolean(backupEntryId && updateEntryIds.has(backupEntryId)),
      warnings,
      outboxId: outbox.id,
      mailQueued: true,
      idempotent: false
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
      inspectionNote: entry.inspectionNote,
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
  const nextInspectionNote = input.inspectionNote === undefined ? existing.inspectionNote : input.inspectionNote;
  if (
    nextInternalNote === existing.internalNote &&
    nextDriverNote === existing.driverNote &&
    nextInspectionNote === existing.inspectionNote
  ) {
    return {
      id: existing.id,
      eventId: existing.eventId,
      internalNote: existing.internalNote,
      driverNote: existing.driverNote,
      inspectionNote: existing.inspectionNote,
      updatedAt: existing.updatedAt
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(entry)
    .set({
      internalNote: nextInternalNote,
      driverNote: nextDriverNote,
      inspectionNote: nextInspectionNote,
      updatedAt: now
    })
    .where(eq(entry.id, entryId))
    .returning({
      id: entry.id,
      eventId: entry.eventId,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      inspectionNote: entry.inspectionNote,
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
      driverNoteUpdated: input.driverNote !== undefined,
      inspectionNoteUpdated: input.inspectionNote !== undefined
    }
  });

  return updated ?? null;
};

export const patchEntryDriverEmail = async (
  entryId: string,
  newEmail: string,
  actorUserId: string | null
) => {
  const db = await getDb();
  const normalizedEmail = newEmail.toLowerCase();

  try {
    return await db.transaction(async (tx) => {
      const entryRows = await tx
        .select({
          id: entry.id,
          eventId: entry.eventId,
          registrationGroupId: entry.registrationGroupId
        })
        .from(entry)
        .where(and(eq(entry.id, entryId), sql`${entry.deletedAt} is null`))
        .limit(1);
      const existingEntry = entryRows[0];
      if (!existingEntry?.registrationGroupId) {
        return null;
      }

      const groupRows = await tx
        .select({
          id: registrationGroup.id,
          driverPersonId: registrationGroup.driverPersonId
        })
        .from(registrationGroup)
        .where(eq(registrationGroup.id, existingEntry.registrationGroupId))
        .limit(1);
      const group = groupRows[0];
      if (!group) {
        return null;
      }

      const currentPersonRows = await tx
        .select({ email: person.email })
        .from(person)
        .where(eq(person.id, group.driverPersonId))
        .limit(1);
      const currentPerson = currentPersonRows[0];
      if (!currentPerson) {
        return null;
      }

      const blockingPersonRows = await tx
        .select({ id: person.id })
        .from(person)
        .where(
          and(
            sql`lower(${person.email}) = ${normalizedEmail}`,
            ne(person.id, group.driverPersonId)
          )
        )
        .limit(1);
      const blockingPerson = blockingPersonRows[0];

      if (blockingPerson) {
        const activeEntryRows = await tx
          .select({ id: entry.id })
          .from(entry)
          .where(
            and(
              eq(entry.driverPersonId, blockingPerson.id),
              sql`${entry.deletedAt} is null`
            )
          )
          .limit(1);
        if (activeEntryRows.length > 0) {
          throw new Error('EMAIL_IN_USE');
        }

        await tx
          .update(person)
          .set({ email: null, updatedAt: new Date() })
          .where(eq(person.id, blockingPerson.id));
      }

      const now = new Date();
      await tx
        .update(person)
        .set({ email: newEmail, updatedAt: now })
        .where(eq(person.id, group.driverPersonId));
      await tx
        .update(entry)
        .set({ driverEmailNorm: normalizedEmail, updatedAt: now })
        .where(eq(entry.id, entryId));
      await tx
        .update(registrationGroup)
        .set({ driverEmailNorm: normalizedEmail, updatedAt: now })
        .where(eq(registrationGroup.id, group.id));
      await tx
        .delete(registrationGroupEmailVerification)
        .where(eq(registrationGroupEmailVerification.registrationGroupId, group.id));

      await writeAuditLog(tx as never, {
        eventId: existingEntry.eventId,
        actorUserId,
        action: 'driver_email_updated',
        entityType: 'entry',
        entityId: entryId,
        payload: {
          oldEmail: currentPerson.email,
          newEmail
        }
      });

      return {
        entryId,
        personId: group.driverPersonId,
        oldEmail: currentPerson.email,
        newEmail
      };
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('EMAIL_IN_USE');
    }
    throw error;
  }
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
      acceptanceStatus: entry.acceptanceStatus,
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
  if (current.acceptanceStatus !== 'accepted') {
    throw new Error('PRE_ACCEPTANCE_PAYMENT_NOT_ALLOWED');
  }

  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  const now = new Date();
  await recalculateInvoices(
    current.eventId,
    {
      driverPersonId: current.driverPersonId
    },
    actorUserId
  );
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
        paymentStatus: deriveInvoicePaymentStatus(current.entryFeeCents ?? 0, 0),
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
      acceptanceStatus: entry.acceptanceStatus,
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
  if (current.acceptanceStatus !== 'accepted' && (input.paidAmountCents ?? 0) > 0) {
    throw new Error('PRE_ACCEPTANCE_PAYMENT_NOT_ALLOWED');
  }

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
        totalCents: 0,
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

  await db
    .update(invoice)
    .set({
      pricingSnapshot: {
        ...existingSnapshot,
        manualOverrides: existingManualOverrides
      },
      recordedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(invoice.id, currentInvoice.id));

  await recalculateInvoices(
    current.eventId,
    {
      driverPersonId: current.driverPersonId
    },
    actorUserId
  );

  const recalculatedInvoiceRows = await db
    .select({
      id: invoice.id,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      pricingSnapshot: invoice.pricingSnapshot,
      paymentStatus: invoice.paymentStatus
    })
    .from(invoice)
    .where(and(eq(invoice.eventId, current.eventId), eq(invoice.driverPersonId, current.driverPersonId)))
    .limit(1);
  const recalculatedInvoice = recalculatedInvoiceRows[0];
  if (!recalculatedInvoice) {
    throw new Error('INVOICE_NOT_FOUND');
  }

  const nextTotalCents = recalculatedInvoice.totalCents ?? 0;
  const nextPaidAmountCents = input.paidAmountCents ?? recalculatedInvoice.paidAmountCents ?? 0;
  if (current.acceptanceStatus !== 'accepted' && nextPaidAmountCents > 0) {
    throw new Error('PRE_ACCEPTANCE_PAYMENT_NOT_ALLOWED');
  }
  if (nextPaidAmountCents > nextTotalCents) {
    throw new Error('PAID_AMOUNT_EXCEEDS_TOTAL');
  }

  if (input.paidAmountCents !== undefined) {
    await db.delete(invoicePayment).where(eq(invoicePayment.invoiceId, recalculatedInvoice.id));
    if (nextPaidAmountCents > 0) {
      await db.insert(invoicePayment).values({
        invoiceId: recalculatedInvoice.id,
        amountCents: nextPaidAmountCents,
        paidAt: now,
        method: 'other',
        recordedBy: actorUserId,
        note: input.note ?? 'manual payment amount adjustment',
        createdAt: now
      });
    }
  }

  const paymentStatus = deriveInvoicePaymentStatus(
    nextTotalCents,
    nextPaidAmountCents,
    recalculatedInvoice.paymentStatus === 'not_required'
  );
  const amountOpenCents = Math.max(0, nextTotalCents - nextPaidAmountCents);

  await db
    .update(invoice)
    .set({
      paidAmountCents: nextPaidAmountCents,
      paymentStatus,
      paidAt: paymentStatus === 'paid' ? now : null,
      recordedBy: actorUserId,
      updatedAt: now
    })
    .where(eq(invoice.id, recalculatedInvoice.id));

  await writeAuditLog(db as never, {
    eventId: current.eventId,
    actorUserId,
    action: 'entry_payment_amounts_set',
    entityType: 'entry',
    entityId: entryId,
    payload: {
      invoiceId: recalculatedInvoice.id,
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
        driverEmailNorm: entry.driverEmailNorm,
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
    } else if (existing.driverEmailNorm) {
      // Fallback: entry has no registrationGroupId (e.g. legacy or admin-created entry).
      // Check for orphaned groups matching event + email and soft-delete them if they
      // have no remaining active entries.
      const orphanedGroupRows = await tx
        .select({ id: registrationGroup.id })
        .from(registrationGroup)
        .where(
          and(
            eq(registrationGroup.eventId, existing.eventId),
            eq(registrationGroup.driverEmailNorm, existing.driverEmailNorm),
            sql`${registrationGroup.deletedAt} is null`
          )
        )
        .limit(1);
      if (orphanedGroupRows[0]) {
        const orphanedGroupActiveCountRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(entry)
          .where(and(eq(entry.registrationGroupId, orphanedGroupRows[0].id), sql`${entry.deletedAt} is null`))
          .limit(1);
        if (Number(orphanedGroupActiveCountRows[0]?.count ?? 0) === 0) {
          await tx
            .update(registrationGroup)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(registrationGroup.id, orphanedGroupRows[0].id));
        }
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

export const revokeCharityCodriver = async (
  entryId: string,
  registrationId: string,
  input: CharityCodriverRevocationInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();
  const [updated] = await db
    .update(entryCharityCodriver)
    .set({
      status: 'revoked',
      revokedAt: now,
      revokedBy: actorUserId,
      revocationReason: input.reason,
      updatedAt: now
    })
    .where(
      and(
        eq(entryCharityCodriver.id, registrationId),
        eq(entryCharityCodriver.entryId, entryId),
        eq(entryCharityCodriver.status, 'active')
      )
    )
    .returning();
  if (!updated) {
    return null;
  }
  await writeAuditLog(db as never, {
    eventId: updated.eventId,
    actorUserId,
    action: 'charity_codriver_revoked',
    entityType: 'entry_charity_codriver',
    entityId: updated.id,
    payload: { entryId, personId: updated.personId, reason: input.reason }
  });
  return updated;
};

export const restoreEntry = async (entryId: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
      registrationGroupId: entry.registrationGroupId,
      classId: entry.classId,
      backupClassId: entry.backupClassId,
      isBackupVehicle: entry.isBackupVehicle,
      startNumberNorm: entry.startNumberNorm,
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
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${existing.eventId}))`);
      await assertActiveDriverEntryRules(tx, existing.eventId, existing.driverPersonId, [{
        id: entryId,
        driverPersonId: existing.driverPersonId,
        classId: existing.classId,
        backupClassId: existing.backupClassId,
        isBackupVehicle: existing.isBackupVehicle
      }]);
      await assertStartNumberReservationsAvailable(
        tx,
        existing.eventId,
        entryId,
        existing.classId,
        existing.backupClassId,
        existing.startNumberNorm,
        new Set([entryId])
      );
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
    if (
      isPgUniqueViolation(error) ||
      (error instanceof Error && ['RUN_GROUP_CONFLICT', 'BACKUP_CLASS_INVALID', 'START_NUMBER_CONFLICT'].includes(error.message))
    ) {
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
export const validateEntryBackupClassPatchInput = (payload: unknown) => entryBackupClassPatchSchema.parse(payload);
export const validateEntryAssignmentPatchInput = (payload: unknown) => entryAssignmentPatchSchema.parse(payload);
export const validateEntryNotesPatchInput = (payload: unknown) => entryNotesPatchSchema.parse(payload);
export const validateDriverEmailPatchInput = (payload: unknown): DriverEmailPatch => driverEmailPatchSchema.parse(payload);
export const validateEntryPaymentStatusPatchInput = (payload: unknown) => entryPaymentStatusPatchSchema.parse(payload);
export const validateEntryPaymentAmountsPatchInput = (payload: unknown) => entryPaymentAmountsPatchSchema.parse(payload);
export const validateEntryDeleteInput = (payload: unknown) => entryDeleteSchema.parse(payload);
export const validateCharityCodriverRevocationInput = (payload: unknown) => charityCodriverRevocationSchema.parse(payload);
