import { and, asc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { auditLog, document, entry, eventClass, invoice, person, vehicle } from '../db/schema';
import { getPresignedAssetsDownloadUrl } from '../docs/storage';
import { assertEventStatusAllowed } from '../domain/eventStatus';
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
    .enum(['className', 'driverLastName', 'driverFirstName', 'createdAt', 'updatedAt', 'startNumberNorm'])
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

type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type EntryStatusPatch = z.infer<typeof entryStatusPatchSchema>;
type TechStatusPatch = z.infer<typeof techStatusPatchSchema>;
type EntryNotesPatch = z.infer<typeof entryNotesPatchSchema>;

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
    pending: ['pending', 'shortlist', 'accepted', 'rejected'],
    shortlist: ['pending', 'shortlist', 'accepted', 'rejected'],
    accepted: ['accepted', 'shortlist', 'rejected'],
    rejected: ['rejected', 'shortlist', 'accepted']
  };
  if (!allowed[from].includes(to)) {
    throw new Error('INVALID_STATUS_TRANSITION');
  }
};

export const listEntries = async (query: ListEntriesQuery, redactSensitiveFields: boolean) => {
  const db = await getDb();
  const conditions: SQL<unknown>[] = [eq(entry.eventId, query.eventId)];
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
    ['className', 'driverLastName', 'driverFirstName', 'createdAt', 'updatedAt', 'startNumberNorm'],
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

  if (input.sendLifecycleMail) {
    if (!input.lifecycleEventType) {
      throw new Error('LIFECYCLE_EVENT_TYPE_REQUIRED');
    }
    await queueLifecycleMail(
      {
        eventId: existing.eventId,
        entryId,
        eventType: input.lifecycleEventType
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
      driverNote: entry.driverNote
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
      internalNote: input.internalNote === undefined ? existing.internalNote : input.internalNote,
      driverNote: input.driverNote === undefined ? existing.driverNote : input.driverNote,
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
