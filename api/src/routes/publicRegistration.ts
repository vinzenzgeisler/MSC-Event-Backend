import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, entryEmailVerification, event, eventClass, person, vehicle, vehicleImageUpload } from '../db/schema';
import { getPresignedAssetsUploadUrl, doesAssetObjectExist } from '../docs/storage';
import { normalizeStartNumber } from '../domain/startNumber';
import { isPgUniqueViolation } from '../http/dbErrors';
import { queueMail } from './adminMail';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonEmptySchema = z.string().trim().min(1);
const zipSchema = z.string().regex(/^\d{5}$/);

const normalizePhone = (value: string): string => value.replace(/\D+/g, '');
const phoneSchema = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine((value) => value.length >= 6 && value.length <= 15, 'Phone must have 6 to 15 digits');

const parseNumericDigits = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return Number(trimmed);
};

const parseCylinders = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toUpperCase();
  const match = trimmed.match(/^V?([1-9]\d?)$/);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
};

const codriverInputSchema = z.object({
  email: z.string().email().optional(),
  firstName: nonEmptySchema.optional(),
  lastName: nonEmptySchema.optional(),
  birthdate: isoDateSchema.optional(),
  nationality: z.string().trim().optional(),
  street: z.string().trim().optional(),
  zip: zipSchema.optional(),
  city: z.string().trim().optional(),
  phone: phoneSchema.optional()
});

const driverInputSchema = z.object({
  email: z.string().email(),
  firstName: nonEmptySchema,
  lastName: nonEmptySchema,
  birthdate: isoDateSchema,
  nationality: z.string().trim().optional(),
  street: nonEmptySchema,
  zip: zipSchema,
  city: nonEmptySchema,
  phone: phoneSchema,
  emergencyContactName: nonEmptySchema,
  emergencyContactPhone: phoneSchema,
  motorsportHistory: nonEmptySchema,
  specialNotes: nonEmptySchema.optional()
});

const vehicleInputSchema = z.object({
  vehicleType: z.enum(['moto', 'auto']).optional(),
  make: nonEmptySchema,
  model: nonEmptySchema,
  year: z
    .preprocess(parseNumericDigits, z.number().int().min(1900).max(new Date().getUTCFullYear() + 1))
    .optional(),
  displacementCcm: z
    .preprocess(parseNumericDigits, z.number().int().min(10).max(99999)),
  engineType: nonEmptySchema,
  cylinders: z.preprocess(parseCylinders, z.number().int().min(1).max(99)),
  brakes: nonEmptySchema,
  vehicleHistory: nonEmptySchema,
  ownerName: nonEmptySchema.optional(),
  startNumberRaw: z.string().regex(/^[a-zA-Z0-9]{1,6}$/).optional(),
  imageS3Key: z.string().optional(),
  imageUploadId: z.string().uuid().optional()
});

const createEntrySchema = z
  .object({
    eventId: z.string().uuid(),
    classId: z.string().uuid(),
    driver: driverInputSchema,
    codriverEnabled: z.boolean().optional(),
    codriver: codriverInputSchema.optional(),
    vehicle: vehicleInputSchema,
    specialNotes: nonEmptySchema.optional(),
    backupOfEntryId: z.string().uuid().optional(),
    startNumber: z.string().regex(/^[a-zA-Z0-9]{1,6}$/),
    isBackupVehicle: z.boolean().optional(),
    consent: z.object({
      termsAccepted: z.literal(true),
      privacyAccepted: z.literal(true),
      mediaAccepted: z.literal(true),
      consentVersion: nonEmptySchema,
      consentCapturedAt: z.string().datetime()
    })
  })
  .superRefine((value, ctx) => {
    const codriverIsRequired = value.codriverEnabled === true || value.codriver !== undefined;
    if (!codriverIsRequired) {
      return;
    }
    if (!value.codriver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver'],
        message: 'codriver is required when codriverEnabled=true'
      });
      return;
    }
    if (!value.codriver.firstName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver', 'firstName'],
        message: 'firstName is required'
      });
    }
    if (!value.codriver.lastName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver', 'lastName'],
        message: 'lastName is required'
      });
    }
    if (!value.codriver.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver', 'email'],
        message: 'email is required'
      });
    }
  });

const verifySchema = z.object({
  token: z.string().min(16)
});

const validateStartNumberSchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid(),
  startNumber: z.string().min(1).max(6)
});

const uploadInitSchema = z.object({
  eventId: z.string().uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileName: z.string().min(1).max(255).optional(),
  fileSizeBytes: z.number().int().min(1).max(8 * 1024 * 1024)
});

const uploadFinalizeSchema = z.object({
  uploadId: z.string().uuid()
});

type CreateEntryInput = z.infer<typeof createEntrySchema>;
type VerifyInput = z.infer<typeof verifySchema>;
type ValidateStartNumberInput = z.infer<typeof validateStartNumberSchema>;
type UploadInitInput = z.infer<typeof uploadInitSchema>;
type UploadFinalizeInput = z.infer<typeof uploadFinalizeSchema>;
type DriverInput = z.infer<typeof driverInputSchema>;
type CodriverInput = z.infer<typeof codriverInputSchema>;

const assertRegistrationOpen = async (eventId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      status: event.status,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt
    })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  const ev = rows[0];
  if (!ev) {
    throw new Error('EVENT_NOT_FOUND');
  }
  if (ev.status !== 'open') {
    throw new Error('EVENT_NOT_OPEN');
  }
  const now = new Date();
  if (ev.registrationOpenAt && now < ev.registrationOpenAt) {
    throw new Error('REGISTRATION_NOT_OPEN');
  }
  if (ev.registrationCloseAt && now > ev.registrationCloseAt) {
    throw new Error('REGISTRATION_CLOSED');
  }
};

export const createPublicEntry = async (input: CreateEntryInput) => {
  await assertRegistrationOpen(input.eventId);
  const db = await getDb();
  const now = new Date();
  const normalizedStartNumber = normalizeStartNumber(input.startNumber);
  if (!normalizedStartNumber) {
    throw new Error('START_NUMBER_INVALID_FORMAT');
  }
  const token = createHash('sha256').update(`${randomUUID()}:${input.driver.email}:${Date.now()}`).digest('hex');
  const tokenExpiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24);

  try {
    const created = await db.transaction(async (tx) => {
      const upsertPersonByEmail = async (personInput: DriverInput | CodriverInput) => {
        const extra = personInput as Partial<DriverInput>;
        const existingRows = await tx
          .select()
          .from(person)
          .where(sql`lower(${person.email}) = lower(${personInput.email as string})`)
          .limit(1);
        const existing = existingRows[0];
        if (existing) {
          const [updated] = await tx
            .update(person)
            .set({
              firstName: personInput.firstName ?? existing.firstName,
              lastName: personInput.lastName ?? existing.lastName,
              birthdate: personInput.birthdate ?? null,
              nationality: personInput.nationality ?? null,
              street: personInput.street ?? null,
              zip: personInput.zip ?? null,
              city: personInput.city ?? null,
              phone: personInput.phone ?? null,
              emergencyContactName: extra.emergencyContactName ?? null,
              emergencyContactPhone: extra.emergencyContactPhone ?? null,
              motorsportHistory: extra.motorsportHistory ?? null,
              updatedAt: now
            })
            .where(eq(person.id, existing.id))
            .returning();
          return updated;
        }

        const [inserted] = await tx
          .insert(person)
          .values({
            email: personInput.email as string,
            firstName: personInput.firstName as string,
            lastName: personInput.lastName as string,
            birthdate: personInput.birthdate ?? null,
            nationality: personInput.nationality ?? null,
            street: personInput.street ?? null,
            zip: personInput.zip ?? null,
            city: personInput.city ?? null,
            phone: personInput.phone ?? null,
            emergencyContactName: extra.emergencyContactName ?? null,
            emergencyContactPhone: extra.emergencyContactPhone ?? null,
            motorsportHistory: extra.motorsportHistory ?? null,
            createdAt: now,
            updatedAt: now
          })
          .returning();
        return inserted;
      };

      const classRows = await tx
        .select({ id: eventClass.id, eventId: eventClass.eventId, vehicleType: eventClass.vehicleType })
        .from(eventClass)
        .where(eq(eventClass.id, input.classId))
        .limit(1);
      const clazz = classRows[0];
      if (!clazz || clazz.eventId !== input.eventId) {
        throw new Error('CLASS_NOT_FOUND');
      }
      if (input.vehicle.vehicleType && clazz.vehicleType !== input.vehicle.vehicleType) {
        throw new Error('CLASS_VEHICLE_TYPE_MISMATCH');
      }

      const driver = await upsertPersonByEmail(input.driver);

      let codriverId: string | null = null;
      if (input.codriver) {
        const codriver = await upsertPersonByEmail(input.codriver);
        codriverId = codriver.id;
      }

      let imageS3Key: string | null = input.vehicle.imageS3Key ?? null;
      if (input.vehicle.imageUploadId) {
        const uploadRows = await tx
          .select({
            id: vehicleImageUpload.id,
            eventId: vehicleImageUpload.eventId,
            s3Key: vehicleImageUpload.s3Key,
            status: vehicleImageUpload.status
          })
          .from(vehicleImageUpload)
          .where(eq(vehicleImageUpload.id, input.vehicle.imageUploadId))
          .limit(1);
        const upload = uploadRows[0];
        if (!upload || upload.eventId !== input.eventId || upload.status !== 'finalized') {
          throw new Error('IMAGE_UPLOAD_INVALID');
        }
        imageS3Key = upload.s3Key;
      }

      const [createdVehicle] = await tx
        .insert(vehicle)
        .values({
          ownerPersonId: driver.id,
          vehicleType: clazz.vehicleType,
          make: input.vehicle.make,
          model: input.vehicle.model,
          year: input.vehicle.year ?? null,
          displacementCcm: input.vehicle.displacementCcm,
          engineType: input.vehicle.engineType,
          cylinders: input.vehicle.cylinders,
          brakes: input.vehicle.brakes,
          ownerName: input.vehicle.ownerName ?? null,
          vehicleHistory: input.vehicle.vehicleHistory,
          startNumberRaw: normalizedStartNumber,
          imageS3Key,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      if (input.isBackupVehicle === true && !input.backupOfEntryId) {
        throw new Error('BACKUP_LINK_REQUIRED');
      }

      let backupOfEntryId: string | null = null;
      if (input.backupOfEntryId) {
        const backupRows = await tx
          .select({
            id: entry.id,
            eventId: entry.eventId,
            classId: entry.classId,
            driverPersonId: entry.driverPersonId
          })
          .from(entry)
          .where(eq(entry.id, input.backupOfEntryId))
          .limit(1);
        const backup = backupRows[0];
        if (!backup) {
          throw new Error('BACKUP_ENTRY_NOT_FOUND');
        }
        if (backup.eventId !== input.eventId || backup.classId !== input.classId || backup.driverPersonId !== driver.id) {
          throw new Error('BACKUP_ENTRY_INVALID_LINK');
        }
        backupOfEntryId = backup.id;
      }

      const [createdEntry] = await tx
        .insert(entry)
        .values({
          eventId: input.eventId,
          classId: input.classId,
          driverPersonId: driver.id,
          codriverPersonId: codriverId,
          vehicleId: createdVehicle.id,
          isBackupVehicle: backupOfEntryId !== null || input.isBackupVehicle === true,
          backupOfEntryId,
          startNumberNorm: normalizedStartNumber,
          registrationStatus: 'submitted_unverified',
          acceptanceStatus: 'pending',
          checkinIdVerified: false,
          techStatus: 'pending',
          specialNotes: input.driver.specialNotes ?? input.specialNotes ?? null,
          consentTermsAccepted: input.consent.termsAccepted,
          consentPrivacyAccepted: input.consent.privacyAccepted,
          consentMediaAccepted: input.consent.mediaAccepted,
          consentVersion: input.consent.consentVersion,
          consentCapturedAt: new Date(input.consent.consentCapturedAt),
          createdAt: now,
          updatedAt: now
        })
        .returning();

      await tx
        .insert(entryEmailVerification)
        .values({
          entryId: createdEntry.id,
          token,
          expiresAt: tokenExpiresAt,
          createdAt: now
        })
        .onConflictDoUpdate({
          target: entryEmailVerification.entryId,
          set: {
            token,
            expiresAt: tokenExpiresAt,
            verifiedAt: null,
            createdAt: now
          }
        });

      await writeAuditLog(tx as never, {
        eventId: input.eventId,
        actorUserId: null,
        action: 'public_entry_created',
        entityType: 'entry',
        entityId: createdEntry.id,
        payload: {
          registrationStatus: 'submitted_unverified'
        }
      });

      return {
        entryId: createdEntry.id,
        registrationStatus: createdEntry.registrationStatus
      };
    });

    let confirmationMailSent = false;
    try {
      const queued = await queueMail(
        {
          eventId: input.eventId,
          templateId: 'registration_received',
          recipientEmails: [input.driver.email],
          templateData: {
            entryId: created.entryId,
            verificationToken: token
          }
        },
        null
      );
      if (queued.queued > 0) {
        confirmationMailSent = true;
        await db
          .update(entry)
          .set({
            confirmationMailSentAt: now,
            updatedAt: now
          })
          .where(eq(entry.id, created.entryId));
      }
    } catch {
      confirmationMailSent = false;
    }

    return {
      ...created,
      verificationToken: token,
      confirmationMailSent
    };
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }
};

export const getPublicCurrentEventWithClasses = async () => {
  const db = await getDb();
  const eventRows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      isCurrent: event.isCurrent,
      registrationOpenAt: event.registrationOpenAt,
      registrationCloseAt: event.registrationCloseAt
    })
    .from(event)
    .where(eq(event.isCurrent, true))
    .limit(1);

  const current = eventRows[0];
  if (!current) {
    return null;
  }

  const classRows = await db
    .select({
      id: eventClass.id,
      eventId: eventClass.eventId,
      name: eventClass.name,
      vehicleType: eventClass.vehicleType
    })
    .from(eventClass)
    .where(eq(eventClass.eventId, current.id))
    .orderBy(asc(eventClass.name));

  const now = new Date();
  let reason: 'event_not_open' | 'before_window' | 'after_window' | null = null;
  if (current.status !== 'open') {
    reason = 'event_not_open';
  } else if (current.registrationOpenAt && now < current.registrationOpenAt) {
    reason = 'before_window';
  } else if (current.registrationCloseAt && now > current.registrationCloseAt) {
    reason = 'after_window';
  }

  return {
    event: current,
    classes: classRows,
    registration: {
      isOpen: reason === null,
      reason
    }
  };
};

export const validatePublicStartNumber = async (input: ValidateStartNumberInput) => {
  const db = await getDb();
  const normalizedStartNumber = normalizeStartNumber(input.startNumber);
  if (!normalizedStartNumber) {
    return {
      normalizedStartNumber: null,
      validFormat: false,
      available: false,
      conflictEntryId: null,
      conflictType: 'invalid_format' as const
    };
  }

  const classRows = await db
    .select({
      id: eventClass.id,
      eventId: eventClass.eventId
    })
    .from(eventClass)
    .where(eq(eventClass.id, input.classId))
    .limit(1);
  const clazz = classRows[0];
  if (!clazz || clazz.eventId !== input.eventId) {
    throw new Error('CLASS_NOT_FOUND');
  }

  const conflictRows = await db
    .select({
      id: entry.id
    })
    .from(entry)
    .where(
      and(
        eq(entry.eventId, input.eventId),
        eq(entry.classId, input.classId),
        eq(entry.startNumberNorm, normalizedStartNumber)
      )
    )
    .limit(1);
  const conflict = conflictRows[0];

  return {
    normalizedStartNumber,
    validFormat: true,
    available: !conflict,
    conflictEntryId: conflict?.id ?? null,
    conflictType: conflict ? ('same_class_taken' as const) : ('none' as const)
  };
};

export const initVehicleImageUpload = async (input: UploadInitInput) => {
  await assertRegistrationOpen(input.eventId);
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 15);
  const key = `uploads/${input.eventId}/vehicle-images/${randomUUID()}`;

  const [created] = await db
    .insert(vehicleImageUpload)
    .values({
      eventId: input.eventId,
      s3Key: key,
      contentType: input.contentType,
      fileName: input.fileName ?? null,
      fileSizeBytes: input.fileSizeBytes,
      status: 'initiated',
      expiresAt,
      createdAt: now,
      updatedAt: now
    })
    .returning();

  if (!created) {
    throw new Error('UPLOAD_INIT_FAILED');
  }

  const upload = await getPresignedAssetsUploadUrl(key, input.contentType, 900);
  return {
    uploadId: created.id,
    key,
    uploadUrl: upload.url,
    requiredHeaders: upload.requiredHeaders,
    expiresAt: expiresAt.toISOString()
  };
};

export const finalizeVehicleImageUpload = async (input: UploadFinalizeInput) => {
  const db = await getDb();
  const now = new Date();
  const rows = await db.select().from(vehicleImageUpload).where(eq(vehicleImageUpload.id, input.uploadId)).limit(1);
  const upload = rows[0];
  if (!upload) {
    throw new Error('UPLOAD_NOT_FOUND');
  }
  if (upload.status === 'finalized') {
    return {
      uploadId: upload.id,
      imageS3Key: upload.s3Key,
      finalizedAt: upload.finalizedAt?.toISOString() ?? null
    };
  }
  if (upload.expiresAt < now) {
    await db
      .update(vehicleImageUpload)
      .set({
        status: 'expired',
        updatedAt: now
      })
      .where(eq(vehicleImageUpload.id, upload.id));
    throw new Error('UPLOAD_EXPIRED');
  }

  const exists = await doesAssetObjectExist(upload.s3Key);
  if (!exists) {
    throw new Error('UPLOAD_OBJECT_MISSING');
  }

  const [updated] = await db
    .update(vehicleImageUpload)
    .set({
      status: 'finalized',
      finalizedAt: now,
      updatedAt: now
    })
    .where(eq(vehicleImageUpload.id, upload.id))
    .returning();

  return {
    uploadId: updated?.id ?? upload.id,
    imageS3Key: updated?.s3Key ?? upload.s3Key,
    finalizedAt: (updated?.finalizedAt ?? now).toISOString()
  };
};

export const verifyPublicEntryEmail = async (entryId: string, input: VerifyInput) => {
  const db = await getDb();
  const now = new Date();

  const rows = await db
    .select({
      id: entryEmailVerification.id,
      eventId: entry.eventId,
      expiresAt: entryEmailVerification.expiresAt,
      verifiedAt: entryEmailVerification.verifiedAt,
      token: entryEmailVerification.token
    })
    .from(entryEmailVerification)
    .innerJoin(entry, eq(entryEmailVerification.entryId, entry.id))
    .where(and(eq(entryEmailVerification.entryId, entryId), eq(entryEmailVerification.token, input.token)))
    .limit(1);
  const verification = rows[0];
  if (!verification) {
    throw new Error('VERIFY_TOKEN_INVALID');
  }
  if (verification.verifiedAt) {
    return { alreadyVerified: true };
  }
  if (verification.expiresAt < now) {
    throw new Error('VERIFY_TOKEN_EXPIRED');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(entryEmailVerification)
      .set({
        verifiedAt: now
      })
      .where(eq(entryEmailVerification.id, verification.id));

    await tx
      .update(entry)
      .set({
        registrationStatus: 'submitted_verified',
        confirmationMailVerifiedAt: now,
        updatedAt: now
      })
      .where(eq(entry.id, entryId));

    await writeAuditLog(tx as never, {
      eventId: verification.eventId,
      actorUserId: null,
      action: 'public_entry_verified',
      entityType: 'entry',
      entityId: entryId,
      payload: {
        registrationStatus: 'submitted_verified'
      }
    });
  });

  return { verified: true };
};

export const validateCreatePublicEntryInput = (payload: unknown) => createEntrySchema.parse(payload);
export const validateVerifyPublicEntryInput = (payload: unknown) => verifySchema.parse(payload);
export const validatePublicStartNumberInput = (payload: unknown) => validateStartNumberSchema.parse(payload);
export const validateVehicleImageUploadInitInput = (payload: unknown) => uploadInitSchema.parse(payload);
export const validateVehicleImageUploadFinalizeInput = (payload: unknown) => uploadFinalizeSchema.parse(payload);
