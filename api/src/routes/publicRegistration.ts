import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, entryEmailVerification, event, eventClass, person, vehicle } from '../db/schema';
import { isPgUniqueViolation } from '../http/dbErrors';
import { queueMail } from './adminMail';

const personInputSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nationality: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  phone: z.string().optional()
});

const vehicleInputSchema = z.object({
  vehicleType: z.enum(['moto', 'auto']),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  startNumberRaw: z.string().min(1).max(6).optional(),
  imageS3Key: z.string().optional()
});

const createEntrySchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid(),
  driver: personInputSchema,
  codriver: personInputSchema.optional(),
  vehicle: vehicleInputSchema,
  startNumber: z
    .string()
    .regex(/^[A-Z0-9]{1,6}$/)
    .optional(),
  isBackupVehicle: z.boolean().optional()
});

const verifySchema = z.object({
  token: z.string().min(16)
});

type CreateEntryInput = z.infer<typeof createEntrySchema>;
type VerifyInput = z.infer<typeof verifySchema>;

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
  const token = createHash('sha256').update(`${randomUUID()}:${input.driver.email}:${Date.now()}`).digest('hex');
  const tokenExpiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24);

  try {
    return await db.transaction(async (tx) => {
    const upsertPersonByEmail = async (personInput: z.infer<typeof personInputSchema>) => {
      const existingRows = await tx
        .select()
        .from(person)
        .where(sql`lower(${person.email}) = lower(${personInput.email})`)
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        const [updated] = await tx
          .update(person)
          .set({
            firstName: personInput.firstName,
            lastName: personInput.lastName,
            birthdate: personInput.birthdate ?? null,
            nationality: personInput.nationality ?? null,
            street: personInput.street ?? null,
            zip: personInput.zip ?? null,
            city: personInput.city ?? null,
            phone: personInput.phone ?? null,
            updatedAt: now
          })
          .where(eq(person.id, existing.id))
          .returning();
        return updated;
      }

      const [created] = await tx
        .insert(person)
        .values({
          email: personInput.email,
          firstName: personInput.firstName,
          lastName: personInput.lastName,
          birthdate: personInput.birthdate ?? null,
          nationality: personInput.nationality ?? null,
          street: personInput.street ?? null,
          zip: personInput.zip ?? null,
          city: personInput.city ?? null,
          phone: personInput.phone ?? null,
          createdAt: now,
          updatedAt: now
        })
        .returning();
      return created;
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
    if (clazz.vehicleType !== input.vehicle.vehicleType) {
      throw new Error('CLASS_VEHICLE_TYPE_MISMATCH');
    }

    const driver = await upsertPersonByEmail(input.driver);

    let codriverId: string | null = null;
    if (input.codriver) {
      const codriver = await upsertPersonByEmail(input.codriver);
      codriverId = codriver.id;
    }

    const [createdVehicle] = await tx
      .insert(vehicle)
      .values({
        ownerPersonId: driver.id,
        vehicleType: input.vehicle.vehicleType,
        make: input.vehicle.make ?? null,
        model: input.vehicle.model ?? null,
        year: input.vehicle.year ?? null,
        startNumberRaw: input.vehicle.startNumberRaw ?? input.startNumber ?? null,
        imageS3Key: input.vehicle.imageS3Key ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    const [createdEntry] = await tx
      .insert(entry)
      .values({
        eventId: input.eventId,
        classId: input.classId,
        driverPersonId: driver.id,
        codriverPersonId: codriverId,
        vehicleId: createdVehicle.id,
        isBackupVehicle: input.isBackupVehicle ?? false,
        startNumberNorm: input.startNumber ?? null,
        registrationStatus: 'submitted_unverified',
        acceptanceStatus: 'pending',
        checkinIdVerified: false,
        techStatus: 'pending',
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

    await queueMail(
      {
        eventId: input.eventId,
        templateId: 'registration_received',
        recipientEmails: [input.driver.email],
        templateData: {
          entryId: createdEntry.id,
          verificationToken: token
        }
      },
      null
    );

    return {
      entryId: createdEntry.id,
      registrationStatus: createdEntry.registrationStatus,
      verificationToken: token
    };
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }
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
