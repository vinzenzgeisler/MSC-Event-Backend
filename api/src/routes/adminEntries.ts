import { and, asc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { auditLog, document, entry, eventClass, invoice, invoicePayment, person, vehicle } from '../db/schema';
import { getPresignedAssetsDownloadUrl } from '../docs/storage';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { isPgUniqueViolation } from '../http/dbErrors';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';
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

type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type EntryStatusPatch = z.infer<typeof entryStatusPatchSchema>;
type TechStatusPatch = z.infer<typeof techStatusPatchSchema>;
type EntryNotesPatch = z.infer<typeof entryNotesPatchSchema>;
type EntryPaymentStatusPatch = z.infer<typeof entryPaymentStatusPatchSchema>;
type EntryPaymentAmountsPatch = z.infer<typeof entryPaymentAmountsPatchSchema>;

const toVehicleLabel = (make: string | null, model: string | null, startNumberNorm: string | null): string => {
  const label = [make, model].filter((part) => !!part && part.trim().length > 0).join(' ');
  if (label) {
    return label;
  }
  return startNumberNorm ? `#${startNumberNorm}` : 'Unknown vehicle';
};

const getVehicleThumbUrl = async (imageS3Key: string | null): Promise<string | null> => {
  if (!imageS3Key) {
    return null;
  }
  try {
    return await getPresignedAssetsDownloadUrl(imageS3Key, 300);
  } catch {
    return null;
  }
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

const listEntriesByDeleteState = async (
  query: ListEntriesQuery,
  redactSensitiveFields: boolean,
  deleted: boolean
) => {
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
    const pattern = `%${query.q}%`;
    conditions.push(
      or(
        ilike(person.firstName, pattern),
        ilike(person.lastName, pattern),
        ilike(entry.startNumberNorm, pattern)
      ) as SQL<unknown>
    );
  }

  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      classId: entry.classId,
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
      confirmationMailSentAt: entry.confirmationMailSentAt,
      confirmationMailVerifiedAt: entry.confirmationMailVerifiedAt,
      deletedAt: entry.deletedAt,
      deletedBy: entry.deletedBy,
      deleteReason: entry.deleteReason,
      internalNote: entry.internalNote,
      driverNote: entry.driverNote,
      driverPersonId: entry.driverPersonId,
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
    .orderBy(asc(eventClass.name), asc(person.lastName), asc(person.firstName));

  const mapped = await Promise.all(rows.map(async (row) => {
    const completed = row.acceptanceStatus === 'accepted' && row.paymentStatus === 'paid';
    const vehicleLabel = toVehicleLabel(row.vehicleMake, row.vehicleModel, row.startNumberNorm);
    const vehicleThumbUrl = await getVehicleThumbUrl(row.vehicleImageS3Key);
    return {
      ...row,
      completionStatus: completed ? 'completed' : 'open',
      vehicleLabel,
      vehicleThumbUrl,
      confirmationMailSent: row.confirmationMailSentAt !== null,
      confirmationMailVerified: row.confirmationMailVerifiedAt !== null,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      deleteReason: row.deleteReason,
      driverFirstName: redactSensitiveFields ? null : row.driverFirstName,
      driverLastName: redactSensitiveFields ? null : row.driverLastName,
      driverEmail: redactSensitiveFields ? null : row.driverEmail
    };
  }));

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
  return paginateAndSortRows(mapped, paginationQuery);
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
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverEmail: person.email,
      driverBirthdate: person.birthdate,
      driverNationality: person.nationality,
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
            firstName: person.firstName,
            lastName: person.lastName,
            email: person.email,
            birthdate: person.birthdate,
            nationality: person.nationality,
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

  const documentRows = await db
    .select({
      id: document.id,
      type: document.type,
      status: document.status,
      createdAt: document.createdAt
    })
    .from(document)
    .where(eq(document.entryId, entryId));

  const relatedRows = await db
    .select({
      id: entry.id
    })
    .from(entry)
    .where(and(eq(entry.eventId, current.eventId), eq(entry.driverPersonId, current.driverPersonId)));

  const relatedEntryIds = relatedRows.map((row) => row.id).filter((id) => id !== entryId);

  const totalCents = current.invoiceTotalCents ?? 0;
  const paidAmountCents = current.invoicePaidAmountCents ?? 0;
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
  const vehicleThumbUrl = await getVehicleThumbUrl(current.vehicleImageS3Key);

  return {
    entry: {
      ids: {
        entryId: current.id,
        eventId: current.eventId,
        classId: current.classId,
        driverPersonId: current.driverPersonId,
        codriverPersonId: current.codriverPersonId,
        vehicleId: current.vehicleId,
        backupOfEntryId: current.backupOfEntryId
      },
      className: current.className,
      registrationStatus: current.registrationStatus,
      acceptanceStatus: current.acceptanceStatus,
      startNumberNorm: current.startNumberNorm,
      isBackupVehicle: current.isBackupVehicle,
      relatedEntryIds,
      vehicleLabel,
      vehicleThumbUrl,
      confirmationMailSent: current.confirmationMailSentAt !== null,
      confirmationMailVerified: current.confirmationMailVerifiedAt !== null,
      person: {
        driver: {
          firstName: redactSensitiveFields ? null : current.driverFirstName,
          lastName: redactSensitiveFields ? null : current.driverLastName,
          email: redactSensitiveFields ? null : current.driverEmail,
          birthdate: redactSensitiveFields ? null : current.driverBirthdate,
          nationality: redactSensitiveFields ? null : current.driverNationality,
          street: redactSensitiveFields ? null : current.driverStreet,
          zip: redactSensitiveFields ? null : current.driverZip,
          city: redactSensitiveFields ? null : current.driverCity,
          phone: redactSensitiveFields ? null : current.driverPhone,
          emergencyContactName: redactSensitiveFields ? null : current.driverEmergencyContactName,
          emergencyContactFirstName: redactSensitiveFields ? null : current.driverEmergencyContactFirstName,
          emergencyContactLastName: redactSensitiveFields ? null : current.driverEmergencyContactLastName,
          emergencyContactPhone: redactSensitiveFields ? null : current.driverEmergencyContactPhone,
          motorsportHistory: redactSensitiveFields ? null : current.driverMotorsportHistory
        },
        codriver: codriver
          ? {
              firstName: redactSensitiveFields ? null : codriver.firstName,
              lastName: redactSensitiveFields ? null : codriver.lastName,
              email: redactSensitiveFields ? null : codriver.email,
              birthdate: redactSensitiveFields ? null : codriver.birthdate,
              nationality: redactSensitiveFields ? null : codriver.nationality,
              street: redactSensitiveFields ? null : codriver.street,
              zip: redactSensitiveFields ? null : codriver.zip,
              city: redactSensitiveFields ? null : codriver.city,
              phone: redactSensitiveFields ? null : codriver.phone,
              emergencyContactName: redactSensitiveFields ? null : codriver.emergencyContactName,
              emergencyContactFirstName: redactSensitiveFields ? null : codriver.emergencyContactFirstName,
              emergencyContactLastName: redactSensitiveFields ? null : codriver.emergencyContactLastName,
              emergencyContactPhone: redactSensitiveFields ? null : codriver.emergencyContactPhone,
              motorsportHistory: redactSensitiveFields ? null : codriver.motorsportHistory
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
        mediaAccepted: current.consentMediaAccepted,
        consentVersion: current.consentVersion,
        consentCapturedAt: current.consentCapturedAt
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
      acceptanceStatus: entry.acceptanceStatus
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
        allowDuplicate: false
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
  const effectiveStatus: 'paid' | 'due' = amountOpenCents === 0 ? 'paid' : 'due';

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
      paidAmountCents: invoice.paidAmountCents
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
          entryId: current.id
        },
        paymentStatus: 'due',
        paidAmountCents: 0,
        updatedAt: now
      })
      .returning({
        id: invoice.id,
        totalCents: invoice.totalCents,
        paidAmountCents: invoice.paidAmountCents
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

  const paymentStatus: 'paid' | 'due' = nextPaidAmountCents >= nextTotalCents ? 'paid' : 'due';
  const amountOpenCents = Math.max(0, nextTotalCents - nextPaidAmountCents);

  await db
    .update(invoice)
    .set({
      totalCents: nextTotalCents,
      paidAmountCents: nextPaidAmountCents,
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

export const deleteEntry = async (entryId: string, actorUserId: string | null) => {
  const db = await getDb();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: entry.id,
        eventId: entry.eventId,
        driverPersonId: entry.driverPersonId,
        classId: entry.classId,
        startNumberNorm: entry.startNumberNorm,
        registrationStatus: entry.registrationStatus,
        acceptanceStatus: entry.acceptanceStatus,
        checkinIdVerified: entry.checkinIdVerified,
        techStatus: entry.techStatus,
        deletedAt: entry.deletedAt,
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
      return { deletedEntryId: entryId };
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
        deleteReason: null,
        updatedAt: new Date()
      })
      .where(eq(entry.id, entryId));

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
        startNumberNorm: existing.startNumberNorm
      }
    });

    return { deletedEntryId: entryId };
  });
};

export const restoreEntry = async (entryId: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
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
    await db
      .update(entry)
      .set({
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        updatedAt: new Date()
      })
      .where(eq(entry.id, entryId));
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
export const validateEntryNotesPatchInput = (payload: unknown) => entryNotesPatchSchema.parse(payload);
export const validateEntryPaymentStatusPatchInput = (payload: unknown) => entryPaymentStatusPatchSchema.parse(payload);
export const validateEntryPaymentAmountsPatchInput = (payload: unknown) => entryPaymentAmountsPatchSchema.parse(payload);
