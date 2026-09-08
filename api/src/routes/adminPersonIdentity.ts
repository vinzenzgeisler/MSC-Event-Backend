import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { emailOutbox, entry, entryCharityCodriver, exportJob, exportJobPerson, person } from '../db/schema';
import { collapseIdentityWhitespace, legalFullName, replaceLegalNameInText, sanitizeProtectedStructuredData, standardPersonIdentity } from '../domain/personIdentity';
import { deleteDocumentObject, deleteLegacyStampCardObjects } from '../docs/storage';

const publicationNamePatchSchema = z
  .object({
    publicationName: z.string().max(100).nullable(),
    confirmLegalNameExposure: z.literal(true).optional(),
    reason: z.string().trim().min(5).max(500).optional()
  })
  .superRefine((value, context) => {
    if (value.publicationName === null) {
      if (value.confirmLegalNameExposure !== true) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmLegalNameExposure'], message: 'Explicit confirmation is required.' });
      }
      if (!value.reason) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required.' });
      }
      return;
    }
    const normalized = collapseIdentityWhitespace(value.publicationName);
    if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['publicationName'], message: 'Publication name is invalid.' });
    }
  });

export type PublicationNamePatchInput = z.infer<typeof publicationNamePatchSchema>;

export const patchPersonPublicationName = async (
  personId: string,
  input: PublicationNamePatchInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const normalizedName = input.publicationName === null ? null : collapseIdentityWhitespace(input.publicationName);

  const result = await db.transaction(async (tx) => {
    const currentRows = await tx
      .select({
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        publicationName: person.publicationName,
        publicationNameVersion: person.publicationNameVersion
      })
      .from(person)
      .where(eq(person.id, personId))
      .for('update')
      .limit(1);
    const current = currentRows[0];
    if (!current) return null;

    if (normalizedName && normalizedName.toLocaleLowerCase('de-DE') === legalFullName(current).toLocaleLowerCase('de-DE')) {
      throw new Error('PUBLICATION_NAME_EQUALS_LEGAL_NAME');
    }
    if ((current.publicationName ?? null) === normalizedName) {
      const identity = standardPersonIdentity({ ...current, publicationName: normalizedName });
      return {
        person: { id: current.id, ...identity, publicationName: normalizedName, publicationNameVersion: current.publicationNameVersion },
        invalidatedExportCount: 0,
        invalidatedKeys: [] as string[],
        affectedEventIds: [] as string[]
      };
    }

    const now = new Date();
    const [regularEvents, charityEvents] = await Promise.all([
      tx.select({ eventId: entry.eventId }).from(entry).where(or(eq(entry.driverPersonId, personId), eq(entry.codriverPersonId, personId))),
      tx.select({ eventId: entryCharityCodriver.eventId }).from(entryCharityCodriver).where(eq(entryCharityCodriver.personId, personId))
    ]);
    const affectedEventIds = Array.from(new Set([...regularEvents, ...charityEvents].map((item) => item.eventId)));
    const updatedRows = await tx
      .update(person)
      .set({
        publicationName: normalizedName,
        publicationNameVersion: sql`${person.publicationNameVersion} + 1`,
        publicationNameUpdatedAt: now,
        publicationNameUpdatedBy: actorUserId,
        updatedAt: now
      })
      .where(eq(person.id, personId))
      .returning({
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        publicationName: person.publicationName,
        publicationNameVersion: person.publicationNameVersion
      });
    const updated = updatedRows[0];

    const affectedJobs = await tx
      .select({ id: exportJob.id, s3Key: exportJob.s3Key })
      .from(exportJobPerson)
      .innerJoin(exportJob, eq(exportJobPerson.exportJobId, exportJob.id))
      .where(and(eq(exportJobPerson.personId, personId), inArray(exportJob.status, ['processing', 'succeeded'])));
    const affectedIds = affectedJobs.map((job) => job.id);
    if (affectedIds.length > 0) {
      await tx
        .update(exportJob)
        .set({ status: 'invalidated', errorLast: 'PUBLICATION_NAME_CHANGED', completedAt: now })
        .where(inArray(exportJob.id, affectedIds));
    }

    if (normalizedName) {
      const queuedMails = await tx
        .select({ id: emailOutbox.id, subject: emailOutbox.subject, templateData: emailOutbox.templateData })
        .from(emailOutbox)
        .where(and(
          or(
            sql`${emailOutbox.templateData}->>'driverPersonId' = ${personId}`,
            current.email ? sql`lower(${emailOutbox.toEmail}) = ${current.email.toLowerCase()}` : sql`false`
          ),
          inArray(emailOutbox.status, ['queued', 'failed'])
        ));
      const protectedSource = { ...current, publicationName: normalizedName };
      for (const mail of queuedMails) {
        await tx.update(emailOutbox).set({
          subject: replaceLegalNameInText(mail.subject, protectedSource),
          templateData: sanitizeProtectedStructuredData(mail.templateData ?? {}, protectedSource),
          updatedAt: now
        }).where(eq(emailOutbox.id, mail.id));
      }
    }

    await writeAuditLog(tx as never, {
      eventId: null,
      actorUserId,
      action: 'person_publication_name_changed',
      entityType: 'person',
      entityId: personId,
      payload: {
        previousProtected: Boolean(current.publicationName),
        identityProtected: Boolean(normalizedName),
        publicationName: normalizedName,
        publicationNameVersion: updated.publicationNameVersion,
        reason: input.reason,
        invalidatedExportCount: affectedJobs.length
      }
    });

    const identity = standardPersonIdentity(updated);
    return {
      person: { id: updated.id, ...identity, publicationName: updated.publicationName, publicationNameVersion: updated.publicationNameVersion },
      invalidatedExportCount: affectedJobs.length,
      invalidatedKeys: affectedJobs.flatMap((job) => job.s3Key ? [job.s3Key] : []),
      affectedEventIds
    };
  });

  if (!result) return null;
  const cleanup = await Promise.allSettled([
    ...result.invalidatedKeys.map((key) => deleteDocumentObject(key).then(() => 1)),
    ...result.affectedEventIds.map((eventId) => deleteLegacyStampCardObjects(eventId))
  ]);
  return {
    person: result.person,
    invalidation: {
      invalidatedExportCount: result.invalidatedExportCount,
      deletedObjectCount: cleanup.reduce((sum, item) => sum + (item.status === 'fulfilled' ? item.value : 0), 0),
      cleanupPendingCount: cleanup.filter((item) => item.status === 'rejected').length
    }
  };
};

export const validatePublicationNamePatchInput = (payload: unknown) => publicationNamePatchSchema.parse(payload);
