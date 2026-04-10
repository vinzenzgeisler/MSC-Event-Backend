import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import {
  classPricingRule,
  entry,
  event,
  eventClass,
  eventPricingRule,
  person,
  consentEvidence,
  publicEntrySubmission,
  registrationGroup,
  registrationGroupEmailVerification,
  vehicle,
  vehicleImageUpload
} from '../db/schema';
import { getPresignedAssetsUploadUrl, getAssetObjectBuffer, getAssetObjectMetadata } from '../docs/storage';
import { validateImageBuffer } from '../domain/imageValidation';
import { normalizeStartNumber } from '../domain/startNumber';
import { buildOrgaCode } from '../domain/orgaCode';
import { isPgUniqueViolation } from '../http/dbErrors';
import { getPublicLegalCurrent, resolvePublicLegalLocale } from './publicLegal';
import { DuplicateRequestError, queueLifecycleMail, queueMail } from './adminMail';
import { recalculateInvoices } from './adminFinance';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonEmptySchema = z.string().trim().min(1);
const zipSchema = z.string().regex(/^\d{5}$/);

const normalizePhone = (value: string): string => value.replace(/\D+/g, '');
const normalizeEmail = (value: string): string => value.trim().toLowerCase();
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

const parseIsoDate = (value: string): Date | null => {
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

const calculateAgeFromIsoDate = (value: string, now: Date): number | null => {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return null;
  }
  const birthYear = parsed.getUTCFullYear();
  const birthMonth = parsed.getUTCMonth();
  const birthDay = parsed.getUTCDate();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth();
  const nowDay = now.getUTCDate();
  let age = nowYear - birthYear;
  const birthdayPassed = nowMonth > birthMonth || (nowMonth === birthMonth && nowDay >= birthDay);
  if (!birthdayPassed) {
    age -= 1;
  }
  return age;
};

const birthdateSchema = isoDateSchema.refine((value) => {
  const age = calculateAgeFromIsoDate(value, new Date());
  return age !== null && age >= 6 && age <= 100;
}, 'Birthdate must represent an age between 6 and 100 years');

const isMinorBirthdate = (value: string): boolean => {
  const age = calculateAgeFromIsoDate(value, new Date());
  return age !== null && age < 18;
};

const codriverInputSchema = z.object({
  email: z.string().email(),
  firstName: nonEmptySchema,
  lastName: nonEmptySchema,
  birthdate: birthdateSchema,
  nationality: nonEmptySchema,
  street: nonEmptySchema,
  zip: zipSchema,
  city: nonEmptySchema,
  phone: phoneSchema
});

const driverInputSchema = z.object({
  email: z.string().email(),
  firstName: nonEmptySchema,
  lastName: nonEmptySchema,
  birthdate: birthdateSchema,
  nationality: z.string().trim().optional(),
  street: nonEmptySchema,
  zip: zipSchema,
  city: nonEmptySchema,
  phone: phoneSchema,
  emergencyContactName: nonEmptySchema.optional(),
  emergencyContactFirstName: nonEmptySchema.optional(),
  emergencyContactLastName: nonEmptySchema.optional(),
  emergencyContactPhone: phoneSchema,
  motorsportHistory: nonEmptySchema,
  specialNotes: nonEmptySchema.optional(),
  guardianFullName: nonEmptySchema.optional(),
  guardianEmail: z.string().email().optional(),
  guardianPhone: phoneSchema.optional(),
  guardianConsentAccepted: z.literal(true).optional()
}).superRefine((value, ctx) => {
  const hasLegacyName = !!value.emergencyContactName;
  const hasSplitName = !!value.emergencyContactFirstName && !!value.emergencyContactLastName;
  if (hasLegacyName || hasSplitName) {
    // continue with minor guardian checks
  } else {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['emergencyContactFirstName'],
      message: 'Provide emergencyContactName or emergencyContactFirstName + emergencyContactLastName'
    });
  }

  if (isMinorBirthdate(value.birthdate)) {
    if (!value.guardianFullName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianFullName'],
        message: 'guardianFullName is required for participants under 18'
      });
    }
    if (!value.guardianEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianEmail'],
        message: 'guardianEmail is required for participants under 18'
      });
    }
    if (!value.guardianPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianPhone'],
        message: 'guardianPhone is required for participants under 18'
      });
    }
    if (value.guardianConsentAccepted !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianConsentAccepted'],
        message: 'guardianConsentAccepted must be true for participants under 18'
      });
    }
  }
});

const vehicleInputSchema = z
  .object({
    vehicleType: z.enum(['moto', 'auto']).optional(),
    make: nonEmptySchema,
    model: nonEmptySchema,
    year: z
      .preprocess(parseNumericDigits, z.number().int().min(1900).max(new Date().getUTCFullYear() + 1))
      .optional(),
    displacementCcm: z
      .preprocess(parseNumericDigits, z.number().int().min(10).max(99999)),
    cylinders: z.preprocess(parseCylinders, z.number().int().min(1).max(99)),
    vehicleHistory: nonEmptySchema,
    ownerName: nonEmptySchema.optional(),
    startNumberRaw: z.string().regex(/^[a-zA-Z0-9]{1,6}$/).optional(),
    imageS3Key: z.string().optional(),
    imageUploadId: z.string().uuid().optional(),
    imageUploadToken: z.string().uuid().optional()
  })
  .superRefine((value, ctx) => {
    // Public clients must reference finalized uploads by id; direct S3 keys are not accepted.
    if (value.imageS3Key !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageS3Key'],
        message: 'imageS3Key is not allowed; use imageUploadId from /public/uploads/vehicle-image/finalize'
      });
    }
    if ((value.imageUploadId && !value.imageUploadToken) || (!value.imageUploadId && value.imageUploadToken)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageUploadToken'],
        message: 'imageUploadId and imageUploadToken must be provided together'
      });
    }
  });

const consentInputSchema = z.object({
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  waiverAccepted: z.literal(true),
  mediaAccepted: z.boolean().optional().default(false),
  clubInfoAccepted: z.boolean().optional().default(false),
  consentVersion: nonEmptySchema,
  consentTextHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/),
  locale: z.string().trim().min(2).max(16),
  consentSource: z.enum(['public_form', 'admin_ui']).optional().default('public_form'),
  consentCapturedAt: z.string().datetime()
});

const createEntryItemBaseSchema = z.object({
  classId: z.string().uuid(),
  codriverEnabled: z.boolean().optional(),
  codriver: codriverInputSchema.optional(),
  vehicle: vehicleInputSchema,
  backupVehicle: vehicleInputSchema.optional(),
  specialNotes: nonEmptySchema.optional(),
  backupOfEntryId: z.string().uuid().optional(),
  startNumber: z.string().regex(/^[a-zA-Z0-9]{1,6}$/),
  isBackupVehicle: z.boolean().optional()
});

const createEntryItemSchema = createEntryItemBaseSchema
  .superRefine((value, ctx) => {
    if (value.codriverEnabled === true && !value.codriver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver'],
        message: 'codriver is required when codriverEnabled=true'
      });
    }
  });

const createEntrySchema = z
  .object({
    eventId: z.string().uuid(),
    driver: driverInputSchema,
    consent: consentInputSchema,
    classId: createEntryItemBaseSchema.shape.classId,
    codriverEnabled: createEntryItemBaseSchema.shape.codriverEnabled,
    codriver: createEntryItemBaseSchema.shape.codriver,
    vehicle: createEntryItemBaseSchema.shape.vehicle,
    backupVehicle: createEntryItemBaseSchema.shape.backupVehicle,
    specialNotes: createEntryItemBaseSchema.shape.specialNotes,
    backupOfEntryId: createEntryItemBaseSchema.shape.backupOfEntryId,
    startNumber: createEntryItemBaseSchema.shape.startNumber,
    isBackupVehicle: createEntryItemBaseSchema.shape.isBackupVehicle
  })
  .superRefine((value, ctx) => {
    if (value.codriverEnabled === true && !value.codriver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codriver'],
        message: 'codriver is required when codriverEnabled=true'
      });
    }
  });

const createBatchSchema = z.object({
  eventId: z.string().uuid(),
  clientSubmissionKey: nonEmptySchema.max(128),
  driver: driverInputSchema,
  consent: consentInputSchema,
  entries: z.array(createEntryItemSchema).min(1).max(10)
});

const createBatchWithoutIdempotencySchema = z.object({
  eventId: z.string().uuid(),
  driver: driverInputSchema,
  consent: consentInputSchema,
  entries: z.array(createEntryItemSchema).min(1).max(10)
});

const createBatchInternalSchema = z.union([createBatchSchema, createBatchWithoutIdempotencySchema]);

const batchResponseSchema = z.object({
  groupId: z.string().uuid(),
  entryIds: z.array(z.string().uuid()),
  entryCount: z.number().int().min(1),
  registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']),
  verificationToken: z.string(),
  confirmationMailSent: z.boolean()
});

const verifySchema = z.object({
  token: z.string().min(16)
});

const resendVerificationSchema = z.object({});

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
  uploadId: z.string().uuid(),
  uploadToken: z.string().uuid()
});

type CreateEntryInput = z.infer<typeof createEntrySchema>;
type VerifyInput = z.infer<typeof verifySchema>;
type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
type ValidateStartNumberInput = z.infer<typeof validateStartNumberSchema>;
type UploadInitInput = z.infer<typeof uploadInitSchema>;
type UploadFinalizeInput = z.infer<typeof uploadFinalizeSchema>;
type DriverInput = z.infer<typeof driverInputSchema>;
type CodriverInput = z.infer<typeof codriverInputSchema>;
type VehicleInput = z.infer<typeof vehicleInputSchema>;
type CreateEntryItemInput = z.infer<typeof createEntryItemSchema>;
type CreateBatchInput = z.infer<typeof createBatchSchema>;
type CreateBatchWithoutIdempotencyInput = z.infer<typeof createBatchWithoutIdempotencySchema>;
type CreateBatchInternalInput = z.infer<typeof createBatchInternalSchema>;
type BatchResponse = z.infer<typeof batchResponseSchema>;

const VEHICLE_IMAGE_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const VEHICLE_IMAGE_MAX_DIMENSION_PIXELS = 6000;

const hashUploadToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const buildEmergencyContactName = (input: Partial<DriverInput>): string | null => {
  if (input.emergencyContactName) {
    return input.emergencyContactName;
  }
  const first = input.emergencyContactFirstName?.trim() ?? '';
  const last = input.emergencyContactLastName?.trim() ?? '';
  const joined = [first, last].filter((part) => part.length > 0).join(' ').trim();
  return joined || null;
};

const splitEmergencyContactName = (name: string | null | undefined): { firstName: string | null; lastName: string | null } => {
  if (!name) {
    return { firstName: null, lastName: null };
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return { firstName: null, lastName: null };
  }
  const [first, ...rest] = trimmed.split(/\s+/);
  return {
    firstName: first ?? null,
    lastName: rest.length > 0 ? rest.join(' ') : null
  };
};

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
  if (!ev.registrationOpenAt) {
    throw new Error('REGISTRATION_NOT_OPEN');
  }
  const now = new Date();
  if (now < ev.registrationOpenAt) {
    throw new Error('REGISTRATION_NOT_OPEN');
  }
  if (ev.registrationCloseAt && now > ev.registrationCloseAt) {
    throw new Error('REGISTRATION_CLOSED');
  }
};

const canonicalizePayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizePayload(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'consentCapturedAt')
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, current]) => [key, canonicalizePayload(current)]));
  }
  return value;
};

const createPayloadHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonicalizePayload(value))).digest('hex');

const verificationTokenExpiry = (now = new Date()): Date => {
  const rawDays = Number.parseInt(process.env.EMAIL_VERIFICATION_TOKEN_TTL_DAYS ?? '30', 10);
  const ttlDays = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 30;
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
};

const assertConsentMetadataMatchesPublishedLegalTexts = async (
  consent: Pick<z.infer<typeof consentInputSchema>, 'locale' | 'consentVersion' | 'consentTextHash'>
) => {
  const normalizedLocale = resolvePublicLegalLocale(consent.locale);
  if (normalizedLocale !== consent.locale) {
    throw new Error('CONSENT_LOCALE_INVALID');
  }
  const legal = await getPublicLegalCurrent({ locale: consent.locale });
  if (legal.consent.consentVersion !== consent.consentVersion) {
    throw new Error('CONSENT_VERSION_MISMATCH');
  }
  if (legal.consent.consentTextHash.toLowerCase() !== consent.consentTextHash.toLowerCase()) {
    throw new Error('CONSENT_TEXT_HASH_MISMATCH');
  }
};

export const createPublicEntriesBatch = async (input: CreateBatchInput) => {
  return createPublicEntriesBatchInternal(input);
};

const createPublicEntriesBatchInternal = async (input: CreateBatchInternalInput): Promise<BatchResponse> => {
  await assertRegistrationOpen(input.eventId);
  await assertConsentMetadataMatchesPublishedLegalTexts(input.consent);
  const db = await getDb();
  const now = new Date();
  const token = createHash('sha256').update(`${randomUUID()}:${input.driver.email}:${Date.now()}`).digest('hex');
  const tokenExpiresAt = verificationTokenExpiry(now);
  const normalizedDriverEmail = normalizeEmail(input.driver.email);
  const payloadHash = createPayloadHash(input);

  try {
    const created = await db.transaction(async (tx) => {
      const existingSubmission =
        'clientSubmissionKey' in input
          ? await tx
              .select({
                payloadHash: publicEntrySubmission.payloadHash,
                responsePayload: publicEntrySubmission.responsePayload
              })
              .from(publicEntrySubmission)
              .where(and(eq(publicEntrySubmission.eventId, input.eventId), eq(publicEntrySubmission.clientSubmissionKey, input.clientSubmissionKey)))
              .limit(1)
          : [];
      if (existingSubmission[0]) {
        if (existingSubmission[0].payloadHash !== payloadHash) {
          throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
        }
        const parsedReplay = batchResponseSchema.safeParse(existingSubmission[0].responsePayload);
        if (!parsedReplay.success) {
          throw new Error('IDEMPOTENT_RESPONSE_INVALID');
        }
        return {
          replay: true as const,
          response: parsedReplay.data,
          eventName: null as string | null,
          driverPersonId: null as string | null
        };
      }

      const activeGroupRows = await tx
        .select({ id: registrationGroup.id })
        .from(registrationGroup)
        .where(
          and(
            eq(registrationGroup.eventId, input.eventId),
            eq(registrationGroup.driverEmailNorm, normalizedDriverEmail),
            sql`${registrationGroup.deletedAt} is null`
          )
        )
        .limit(1);
      if (activeGroupRows[0]) {
        throw new Error('EMAIL_ALREADY_IN_USE_ACTIVE_ENTRY');
      }

      const upsertPersonByEmail = async (personInput: DriverInput | CodriverInput) => {
        const extra = personInput as Partial<DriverInput>;
        const emergencyName = buildEmergencyContactName(extra);
        const splitEmergencyName = emergencyName
          ? splitEmergencyContactName(emergencyName)
          : { firstName: extra.emergencyContactFirstName ?? null, lastName: extra.emergencyContactLastName ?? null };
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
              emergencyContactName: emergencyName,
              emergencyContactFirstName: splitEmergencyName.firstName,
              emergencyContactLastName: splitEmergencyName.lastName,
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
            emergencyContactName: emergencyName,
            emergencyContactFirstName: splitEmergencyName.firstName,
            emergencyContactLastName: splitEmergencyName.lastName,
            emergencyContactPhone: extra.emergencyContactPhone ?? null,
            motorsportHistory: extra.motorsportHistory ?? null,
            createdAt: now,
            updatedAt: now
          })
          .returning();
        return inserted;
      };

      const eventRows = await tx
        .select({
          id: event.id,
          name: event.name,
          entryConfirmationConfig: event.entryConfirmationConfig
        })
        .from(event)
        .where(eq(event.id, input.eventId))
        .limit(1);
      const currentEvent = eventRows[0];
      if (!currentEvent) {
        throw new Error('EVENT_NOT_FOUND');
      }

      const driver = await upsertPersonByEmail(input.driver);

      const [createdGroup] = await tx
        .insert(registrationGroup)
        .values({
          eventId: input.eventId,
          driverPersonId: driver.id,
          driverEmailNorm: normalizedDriverEmail,
          createdAt: now,
          updatedAt: now
        })
        .returning({
          id: registrationGroup.id
        });
      if (!createdGroup) {
        throw new Error('GROUP_CREATE_FAILED');
      }

      const entryIds: string[] = [];
      const seenUploadIds = new Set<string>();
      for (const item of input.entries) {
        const normalizedStartNumber = normalizeStartNumber(item.startNumber);
        if (!normalizedStartNumber) {
          throw new Error('START_NUMBER_INVALID_FORMAT');
        }

        const classRows = await tx
          .select({ id: eventClass.id, eventId: eventClass.eventId, vehicleType: eventClass.vehicleType })
          .from(eventClass)
          .where(eq(eventClass.id, item.classId))
          .limit(1);
        const clazz = classRows[0];
        if (!clazz || clazz.eventId !== input.eventId) {
          throw new Error('CLASS_NOT_FOUND');
        }
        if (item.vehicle.vehicleType && clazz.vehicleType !== item.vehicle.vehicleType) {
          throw new Error('CLASS_VEHICLE_TYPE_MISMATCH');
        }

        const activeStartNumberConflict = await tx
          .select({ id: entry.id })
          .from(entry)
          .where(
            and(
              eq(entry.eventId, input.eventId),
              eq(entry.classId, item.classId),
              eq(entry.startNumberNorm, normalizedStartNumber),
              sql`${entry.deletedAt} is null`
            )
          )
          .limit(1);
        if (activeStartNumberConflict[0]) {
          throw new Error('UNIQUE_VIOLATION');
        }

        let codriverId: string | null = null;
        if (item.codriver) {
          const codriver = await upsertPersonByEmail(item.codriver);
          codriverId = codriver.id;
        }

        const resolveVehicleImageS3Key = async (vehicleInput: VehicleInput): Promise<string | null> => {
          if (!vehicleInput.imageUploadId || !vehicleInput.imageUploadToken) {
            return null;
          }
          if (seenUploadIds.has(vehicleInput.imageUploadId)) {
            throw new Error('IMAGE_UPLOAD_INVALID');
          }
          seenUploadIds.add(vehicleInput.imageUploadId);

          const [consumedUpload] = await tx
            .update(vehicleImageUpload)
            .set({
              consumedAt: now,
              consumedByRegistrationGroupId: createdGroup.id,
              updatedAt: now
            })
            .where(
              and(
                eq(vehicleImageUpload.id, vehicleInput.imageUploadId),
                eq(vehicleImageUpload.eventId, input.eventId),
                eq(vehicleImageUpload.status, 'finalized'),
                eq(vehicleImageUpload.uploadTokenHash, hashUploadToken(vehicleInput.imageUploadToken)),
                sql`${vehicleImageUpload.expiresAt} >= ${now}`,
                sql`${vehicleImageUpload.consumedAt} is null`
              )
            )
            .returning({
              s3Key: vehicleImageUpload.s3Key
            });

          if (!consumedUpload) {
            throw new Error('IMAGE_UPLOAD_INVALID');
          }

          return consumedUpload.s3Key;
        };

        const createVehicleRecord = async (vehicleInput: VehicleInput, resolvedStartNumberRaw: string | null) => {
          const imageS3Key = await resolveVehicleImageS3Key(vehicleInput);
          const [createdVehicle] = await tx
            .insert(vehicle)
            .values({
              ownerPersonId: driver.id,
              vehicleType: clazz.vehicleType,
              make: vehicleInput.make,
              model: vehicleInput.model,
              year: vehicleInput.year ?? null,
              displacementCcm: vehicleInput.displacementCcm,
              cylinders: vehicleInput.cylinders,
              ownerName: vehicleInput.ownerName ?? null,
              vehicleHistory: vehicleInput.vehicleHistory,
              startNumberRaw: resolvedStartNumberRaw,
              imageS3Key,
              createdAt: now,
              updatedAt: now
            })
            .returning();
          return createdVehicle;
        };

        const normalizedBackupVehicleStartNumber = item.backupVehicle?.startNumberRaw
          ? normalizeStartNumber(item.backupVehicle.startNumberRaw)
          : null;
        const createdVehicle = await createVehicleRecord(item.vehicle, normalizedStartNumber);
        const createdBackupVehicle = item.backupVehicle
          ? await createVehicleRecord(item.backupVehicle, normalizedBackupVehicleStartNumber)
          : null;

        if (item.isBackupVehicle === true && !item.backupOfEntryId) {
          throw new Error('BACKUP_LINK_REQUIRED');
        }

        let backupOfEntryId: string | null = null;
        if (item.backupOfEntryId) {
          const backupRows = await tx
            .select({
              id: entry.id,
              eventId: entry.eventId,
              classId: entry.classId,
              driverPersonId: entry.driverPersonId
            })
            .from(entry)
            .where(eq(entry.id, item.backupOfEntryId))
            .limit(1);
          const backup = backupRows[0];
          if (!backup) {
            throw new Error('BACKUP_ENTRY_NOT_FOUND');
          }
          if (backup.eventId !== input.eventId || backup.classId !== item.classId || backup.driverPersonId !== driver.id) {
            throw new Error('BACKUP_ENTRY_INVALID_LINK');
          }
          backupOfEntryId = backup.id;
        }

        const orgaCode = buildOrgaCode({
          eventId: input.eventId,
          driverPersonId: driver.id,
          prefix: currentEvent.entryConfirmationConfig?.orgaCodePrefix ?? null
        });

        const [createdEntry] = await tx
          .insert(entry)
          .values({
            eventId: input.eventId,
            classId: item.classId,
            driverPersonId: driver.id,
            registrationGroupId: createdGroup.id,
            codriverPersonId: codriverId,
            vehicleId: createdVehicle.id,
            backupVehicleId: createdBackupVehicle?.id ?? null,
            isBackupVehicle: backupOfEntryId !== null || item.isBackupVehicle === true,
            backupOfEntryId,
            startNumberNorm: normalizedStartNumber,
            driverEmailNorm: normalizedDriverEmail,
            registrationStatus: 'submitted_unverified',
            acceptanceStatus: 'pending',
            checkinIdVerified: false,
            techStatus: 'pending',
            specialNotes: input.driver.specialNotes ?? item.specialNotes ?? null,
            confirmationMailSentAt: null,
            confirmationMailVerifiedAt: null,
            consentTermsAccepted: input.consent.termsAccepted,
            consentPrivacyAccepted: input.consent.privacyAccepted,
            consentMediaAccepted: input.consent.mediaAccepted,
            consentVersion: input.consent.consentVersion,
            consentCapturedAt: new Date(input.consent.consentCapturedAt),
            orgaCode,
            createdAt: now,
            updatedAt: now
          })
          .returning({
            id: entry.id
          });
        if (!createdEntry) {
          throw new Error('ENTRY_CREATE_FAILED');
        }

        await tx.insert(consentEvidence).values({
          entryId: createdEntry.id,
          consentVersion: input.consent.consentVersion,
          consentTextHash: input.consent.consentTextHash.toLowerCase(),
          locale: input.consent.locale,
          consentSource: input.consent.consentSource,
          termsAccepted: input.consent.termsAccepted,
          privacyAccepted: input.consent.privacyAccepted,
          waiverAccepted: input.consent.waiverAccepted,
          mediaAccepted: input.consent.mediaAccepted,
          clubInfoAccepted: input.consent.clubInfoAccepted,
          guardianFullName: input.driver.guardianFullName ?? null,
          guardianEmail: input.driver.guardianEmail ? normalizeEmail(input.driver.guardianEmail) : null,
          guardianPhone: input.driver.guardianPhone ?? null,
          guardianConsentAccepted: input.driver.guardianConsentAccepted === true,
          capturedAt: new Date(input.consent.consentCapturedAt),
          isLegacy: false,
          createdAt: now
        });

        entryIds.push(createdEntry.id);

        await writeAuditLog(tx as never, {
          eventId: input.eventId,
          actorUserId: null,
          action: 'public_entry_created',
          entityType: 'entry',
          entityId: createdEntry.id,
          payload: {
            registrationStatus: 'submitted_unverified',
            registrationGroupId: createdGroup.id
          }
        });
      }

      await tx
        .insert(registrationGroupEmailVerification)
        .values({
          registrationGroupId: createdGroup.id,
          token,
          expiresAt: tokenExpiresAt,
          createdAt: now
        })
        .onConflictDoUpdate({
          target: registrationGroupEmailVerification.registrationGroupId,
          set: {
            token,
            expiresAt: tokenExpiresAt,
            verifiedAt: null,
            createdAt: now
          }
        });

      const response: BatchResponse = {
        groupId: createdGroup.id,
        entryIds,
        entryCount: entryIds.length,
        registrationStatus: 'submitted_unverified',
        verificationToken: token,
        confirmationMailSent: false
      };

      if ('clientSubmissionKey' in input) {
        await tx.insert(publicEntrySubmission).values({
          eventId: input.eventId,
          clientSubmissionKey: input.clientSubmissionKey,
          payloadHash,
          responsePayload: response,
          createdAt: now,
          updatedAt: now
        });
      }

      return {
        replay: false as const,
        response,
        eventName: currentEvent.name,
        driverPersonId: driver.id
      };
    });

    const driverName = `${input.driver.firstName} ${input.driver.lastName}`.trim();

    if (created.replay && created.response.confirmationMailSent) {
      try {
        await queueCodriverInfoMails(input.eventId, created.response.groupId, driverName, input.driver.email);
      } catch {
        // Do not fail replay responses because codriver info mail is optional.
      }
      return created.response;
    }

    if (created.driverPersonId) {
      await recalculateInvoices(
        input.eventId,
        {
          driverPersonId: created.driverPersonId
        },
        null
      );
    }

    const primaryEntryId = created.response.entryIds[0];
    if (!primaryEntryId) {
      throw new Error('REGISTRATION_CONFIRMATION_QUEUE_FAILED');
    }

    try {
      await queueLifecycleMail(
        {
          eventId: input.eventId,
          entryId: primaryEntryId,
          eventType: 'registration_received',
          includeDriverNote: false,
          allowDuplicate: false
        },
        null
      );
    } catch (error) {
      if (!(error instanceof DuplicateRequestError)) {
        throw new Error('REGISTRATION_CONFIRMATION_QUEUE_FAILED');
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(entry)
        .set({
          confirmationMailSentAt: now,
          updatedAt: now
        })
        .where(eq(entry.registrationGroupId, created.response.groupId));
      if ('clientSubmissionKey' in input) {
        await tx
          .update(publicEntrySubmission)
          .set({
            responsePayload: {
              ...created.response,
              confirmationMailSent: true
            },
            updatedAt: now
          })
          .where(and(eq(publicEntrySubmission.eventId, input.eventId), eq(publicEntrySubmission.clientSubmissionKey, input.clientSubmissionKey)));
      }
    });

    try {
      await queueCodriverInfoMails(input.eventId, created.response.groupId, driverName, input.driver.email);
    } catch {
      // Codriver mail is informational only and must not block registration completion.
    }

    return {
      ...created.response,
      confirmationMailSent: true
    };
  } catch (error) {
    if (
      isPgUniqueViolation(error) &&
      typeof error === 'object' &&
      error !== null &&
      'constraint' in error &&
      (error as { constraint?: string }).constraint === 'registration_group_event_driver_email_active_unique'
    ) {
      throw new Error('EMAIL_ALREADY_IN_USE_ACTIVE_ENTRY');
    }
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }
};

const queueCodriverInfoMails = async (
  eventId: string,
  groupId: string,
  driverName: string,
  driverEmail: string
) => {
  const db = await getDb();
  const codriverEntryRows = await db
    .select({
      codriverPersonId: entry.codriverPersonId,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      eventName: event.name,
      contactEmail: event.contactEmail
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(event, eq(entry.eventId, event.id))
    .where(and(eq(entry.eventId, eventId), eq(entry.registrationGroupId, groupId), sql`${entry.deletedAt} is null`, sql`${entry.codriverPersonId} is not null`));

  const codriverIds = Array.from(
    new Set(
      codriverEntryRows
        .map((row) => row.codriverPersonId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
  if (codriverIds.length === 0) {
    return;
  }

  const codriverRows = await db
    .select({
      id: person.id,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName
    })
    .from(person)
    .where(inArray(person.id, codriverIds));

  const codriverById = new Map(
    codriverRows.map((row) => [
      row.id,
      {
        email: row.email,
        codriverName: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'Beifahrer'
      }
    ])
  );

  const recipients = new Map<
    string,
    {
      email: string;
      codriverName: string;
      eventName: string | null;
      contactEmail: string | null;
      className: string | null;
      startNumber: string | null;
      entryCount: number;
    }
  >();

  for (const row of codriverEntryRows) {
    if (!row.codriverPersonId) {
      continue;
    }
    const codriver = codriverById.get(row.codriverPersonId);
    if (!codriver?.email) {
      continue;
    }
    if (codriver.email.toLowerCase() === driverEmail.toLowerCase()) {
      continue;
    }
    const key = codriver.email.toLowerCase();
    const existing = recipients.get(key);
    if (existing) {
      existing.entryCount += 1;
      continue;
    }
    recipients.set(key, {
      email: codriver.email,
      codriverName: codriver.codriverName,
      eventName: row.eventName ?? null,
      contactEmail: row.contactEmail ?? null,
      className: row.className ?? null,
      startNumber: row.startNumber ?? null,
      entryCount: 1
    });
  }

  for (const recipient of recipients.values()) {
    try {
      await queueMail(
        {
          eventId,
          templateId: 'codriver_info',
          recipientEmails: [recipient.email],
          templateData: {
            eventName: recipient.eventName,
            codriverName: recipient.codriverName,
            driverName,
            className: recipient.className,
            startNumber: recipient.startNumber,
            headerTitle: 'Information zur Beifahrer-Eintragung',
            preheader: 'Du wurdest als Beifahrer eingetragen',
            ...(recipient.contactEmail && recipient.contactEmail.trim().length > 0 ? { contactEmail: recipient.contactEmail } : {}),
            entryCount: recipient.entryCount
          }
        },
        null
      );
    } catch {
      // Keep processing other codriver recipients.
    }
  }
};

export const createPublicEntry = async (input: CreateEntryInput) => {
  const batchResult = await createPublicEntriesBatchInternal({
    eventId: input.eventId,
    driver: input.driver,
    consent: input.consent,
    entries: [
      {
        classId: input.classId,
        codriverEnabled: input.codriverEnabled,
        codriver: input.codriver,
        vehicle: input.vehicle,
        backupVehicle: input.backupVehicle,
        specialNotes: input.specialNotes,
        backupOfEntryId: input.backupOfEntryId,
        startNumber: input.startNumber,
        isBackupVehicle: input.isBackupVehicle
      }
    ]
  });
  return {
    groupId: batchResult.groupId,
    entryId: batchResult.entryIds[0],
    entryCount: batchResult.entryCount,
    registrationStatus: batchResult.registrationStatus,
    verificationToken: batchResult.verificationToken,
    confirmationMailSent: batchResult.confirmationMailSent
  };
};

export const getPublicCurrentEventWithClasses = async () => {
  const db = await getDb();
  const eventRows = await db
    .select({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      contactEmail: event.contactEmail,
      websiteUrl: event.websiteUrl,
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

  const pricingRuleRows = await db
    .select({
      earlyDeadline: eventPricingRule.earlyDeadline,
      lateFeeCents: eventPricingRule.lateFeeCents,
      secondVehicleDiscountCents: eventPricingRule.secondVehicleDiscountCents,
      currency: eventPricingRule.currency
    })
    .from(eventPricingRule)
    .where(eq(eventPricingRule.eventId, current.id))
    .limit(1);
  const pricingRule = pricingRuleRows[0] ?? null;

  const pricingClassRows = pricingRule
    ? await db
        .select({
          classId: eventClass.id,
          className: eventClass.name,
          baseFeeCents: classPricingRule.baseFeeCents
        })
        .from(eventClass)
        .leftJoin(classPricingRule, and(eq(classPricingRule.eventId, current.id), eq(classPricingRule.classId, eventClass.id)))
        .where(eq(eventClass.eventId, current.id))
        .orderBy(asc(eventClass.name))
    : [];

  const now = new Date();
  let reason: 'event_not_open' | 'before_window' | 'after_window' | null = null;
  if (current.status !== 'open') {
    reason = 'event_not_open';
  } else if (!current.registrationOpenAt || now < current.registrationOpenAt) {
    reason = 'before_window';
  } else if (current.registrationCloseAt && now > current.registrationCloseAt) {
    reason = 'after_window';
  }

  return {
    event: current,
    classes: classRows,
    pricingRules: pricingRule
      ? {
          earlyDeadline: pricingRule.earlyDeadline,
          lateFeeCents: pricingRule.lateFeeCents,
          secondVehicleDiscountCents: pricingRule.secondVehicleDiscountCents,
          currency: pricingRule.currency,
          classRules: pricingClassRows.map((row) => ({
            classId: row.classId,
            className: row.className,
            baseFeeCents: row.baseFeeCents ?? 0
          }))
        }
      : null,
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
        eq(entry.startNumberNorm, normalizedStartNumber),
        sql`${entry.deletedAt} is null`
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
  const uploadToken = randomUUID();

  const [created] = await db
    .insert(vehicleImageUpload)
    .values({
      eventId: input.eventId,
      s3Key: key,
      contentType: input.contentType,
      uploadTokenHash: hashUploadToken(uploadToken),
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
    uploadToken,
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
    if (upload.uploadTokenHash !== hashUploadToken(input.uploadToken)) {
      throw new Error('UPLOAD_TOKEN_INVALID');
    }
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

  if (upload.uploadTokenHash !== hashUploadToken(input.uploadToken)) {
    throw new Error('UPLOAD_TOKEN_INVALID');
  }

  const [metadata, objectBuffer] = await Promise.all([getAssetObjectMetadata(upload.s3Key), getAssetObjectBuffer(upload.s3Key)]);
  if (!metadata || !objectBuffer) {
    throw new Error('UPLOAD_OBJECT_MISSING');
  }
  if ((metadata.contentLength ?? objectBuffer.length) > VEHICLE_IMAGE_MAX_FILE_SIZE_BYTES) {
    throw new Error('UPLOAD_FILE_TOO_LARGE');
  }

  const validatedImage = validateImageBuffer(objectBuffer, VEHICLE_IMAGE_MAX_FILE_SIZE_BYTES, VEHICLE_IMAGE_MAX_DIMENSION_PIXELS);
  if (!validatedImage) {
    throw new Error('UPLOAD_CONTENT_INVALID');
  }
  if (validatedImage.contentType !== upload.contentType) {
    throw new Error('UPLOAD_CONTENT_TYPE_MISMATCH');
  }

  const [updated] = await db
    .update(vehicleImageUpload)
    .set({
      contentType: validatedImage.contentType,
      fileSizeBytes: validatedImage.byteLength,
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

  const entryRows = await db
    .select({
      entryId: entry.id,
      groupId: entry.registrationGroupId,
      eventId: entry.eventId,
      groupDriverEmailNorm: registrationGroup.driverEmailNorm
    })
    .from(entry)
    .leftJoin(registrationGroup, eq(entry.registrationGroupId, registrationGroup.id))
    .where(eq(entry.id, entryId))
    .limit(1);
  const currentEntry = entryRows[0];
  if (!currentEntry || !currentEntry.groupId) {
    throw new Error('VERIFY_TOKEN_INVALID');
  }
  const groupId = currentEntry.groupId;

  const verificationRows = await db
    .select({
      id: registrationGroupEmailVerification.id,
      token: registrationGroupEmailVerification.token,
      expiresAt: registrationGroupEmailVerification.expiresAt,
      verifiedAt: registrationGroupEmailVerification.verifiedAt
    })
    .from(registrationGroupEmailVerification)
    .where(eq(registrationGroupEmailVerification.registrationGroupId, groupId))
    .limit(1);
  const verification = verificationRows[0];
  if (!verification || verification.token !== input.token) {
    throw new Error('VERIFY_TOKEN_INVALID');
  }
  if (verification.verifiedAt) {
    throw new Error('VERIFY_TOKEN_ALREADY_USED');
  }
  if (verification.expiresAt < now) {
    throw new Error('VERIFY_TOKEN_EXPIRED');
  }

  const conflictGroups = await db
    .select({
      id: registrationGroup.id
    })
    .from(registrationGroup)
    .where(
      and(
        eq(registrationGroup.eventId, currentEntry.eventId),
        eq(registrationGroup.driverEmailNorm, currentEntry.groupDriverEmailNorm ?? ''),
        sql`${registrationGroup.deletedAt} is null`,
        sql`${registrationGroup.id} != ${groupId}`
      )
    )
    .limit(1);
  if (conflictGroups[0]) {
    throw new Error('EMAIL_ALREADY_IN_USE_ACTIVE_ENTRY');
  }

  await db.transaction(async (tx) => {
    const updatedVerificationRows = await tx
      .update(registrationGroupEmailVerification)
      .set({
        verifiedAt: now
      })
      .where(
        and(
          eq(registrationGroupEmailVerification.id, verification.id),
          sql`${registrationGroupEmailVerification.verifiedAt} is null`
        )
      )
      .returning({
        id: registrationGroupEmailVerification.id
      });
    if (!updatedVerificationRows[0]) {
      throw new Error('VERIFY_TOKEN_ALREADY_USED');
    }

    const updatedEntries = await tx
      .update(entry)
      .set({
        registrationStatus: 'submitted_verified',
        confirmationMailVerifiedAt: now,
        updatedAt: now
      })
      .where(
        and(eq(entry.registrationGroupId, groupId), sql`${entry.deletedAt} is null`)
      )
      .returning({
        id: entry.id
      });

    for (const updated of updatedEntries) {
      await writeAuditLog(tx as never, {
        eventId: currentEntry.eventId,
        actorUserId: null,
        action: 'public_entry_verified',
        entityType: 'entry',
        entityId: updated.id,
        payload: {
          registrationStatus: 'submitted_verified',
          registrationGroupId: groupId
        }
      });
    }
  });

  return { verified: true, groupId };
};

export const resendPublicEntryVerification = async (entryId: string, _input: ResendVerificationInput) => {
  const db = await getDb();
  const now = new Date();
  const entryRows = await db
    .select({
      entryId: entry.id,
      eventId: entry.eventId,
      registrationStatus: entry.registrationStatus,
      registrationGroupId: entry.registrationGroupId,
      confirmationMailSentAt: entry.confirmationMailSentAt
    })
    .from(entry)
    .where(and(eq(entry.id, entryId), sql`${entry.deletedAt} is null`))
    .limit(1);
  const currentEntry = entryRows[0];
  if (!currentEntry?.registrationGroupId) {
    throw new Error('ENTRY_NOT_FOUND');
  }
  if (currentEntry.registrationStatus === 'submitted_verified') {
    throw new Error('VERIFY_ALREADY_COMPLETED');
  }

  await assertRegistrationOpen(currentEntry.eventId);

  const token = createHash('sha256').update(`${randomUUID()}:${currentEntry.registrationGroupId}:${Date.now()}`).digest('hex');
  await db
    .insert(registrationGroupEmailVerification)
    .values({
      registrationGroupId: currentEntry.registrationGroupId,
      token,
      expiresAt: verificationTokenExpiry(now),
      verifiedAt: null,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: registrationGroupEmailVerification.registrationGroupId,
      set: {
        token,
        expiresAt: verificationTokenExpiry(now),
        verifiedAt: null,
        createdAt: now
      }
    });

  try {
    await queueLifecycleMail(
      {
        eventId: currentEntry.eventId,
        entryId: currentEntry.entryId,
        eventType: 'email_confirmation_reminder',
        includeDriverNote: false,
        allowDuplicate: true
      },
      null
    );
  } catch {
    throw new Error('VERIFICATION_RESEND_QUEUE_FAILED');
  }

  if (!currentEntry.confirmationMailSentAt) {
    await db
      .update(entry)
      .set({
        confirmationMailSentAt: now,
        updatedAt: now
      })
      .where(eq(entry.id, currentEntry.entryId));
  }

  return { queued: true };
};

export const validateCreatePublicEntryInput = (payload: unknown) => createEntrySchema.parse(payload);
export const validateCreatePublicEntriesBatchInput = (payload: unknown) => createBatchSchema.parse(payload);
export const validateVerifyPublicEntryInput = (payload: unknown) => verifySchema.parse(payload);
export const validateResendPublicEntryVerificationInput = (payload: unknown) => resendVerificationSchema.parse(payload);
export const validatePublicStartNumberInput = (payload: unknown) => validateStartNumberSchema.parse(payload);
export const validateVehicleImageUploadInitInput = (payload: unknown) => uploadInitSchema.parse(payload);
export const validateVehicleImageUploadFinalizeInput = (payload: unknown) => uploadFinalizeSchema.parse(payload);
