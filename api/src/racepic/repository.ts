import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import {
  event,
  racepicInvitation,
  racepicLicense,
  racepicPhotographer,
  racepicPhotographerEvent
} from '../db/schema';
import { getDb } from '../db/client';
import { slugify } from './slug';

const INVITATION_TTL_DAYS = 14;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export class RacePicError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

/**
 * Legt ein Fotografenprofil (falls noch keins existiert) an und erzeugt eine neue Einladung.
 * Ein bereits aktiver Fotograf (ACTIVE_FREE o.ae.) kann erneut eingeladen werden, um zusaetzlichen
 * Event-Zugang zu erhalten - der Profilstatus bleibt dabei unveraendert, nur die
 * racepic_photographer_event-Zeilen und eine neue Einladung kommen dazu.
 */
export const createPhotographerInvitation = async (input: {
  email: string;
  displayName: string;
  eventIds: string[];
  createdBy: string;
}) => {
  const emailNorm = normalizeEmail(input.email);
  const db = await getDb();

  return db.transaction(async (tx) => {
    const eventRows = await tx.select({ id: event.id, name: event.name }).from(event).where(inArray(event.id, input.eventIds));
    if (eventRows.length !== new Set(input.eventIds).size) {
      throw new RacePicError('RACEPIC_EVENT_NOT_FOUND');
    }

    const existing = await tx
      .select()
      .from(racepicPhotographer)
      .where(and(eq(racepicPhotographer.emailNorm, emailNorm), isNull(racepicPhotographer.deletedAt)))
      .limit(1);

    let photographer = existing[0];
    if (!photographer) {
      // Slug fuer das oeffentliche Profil (Paket 12) - bei Kollision mit einem numerischen Suffix
      // eindeutig machen, damit zwei Fotograf:innen mit gleichem Anzeigenamen nicht kollidieren.
      const baseSlug = slugify(input.displayName, 'fotograf');
      const takenSlugs = new Set(
        (await tx.select({ slug: racepicPhotographer.slug }).from(racepicPhotographer).where(like(racepicPhotographer.slug, `${baseSlug}%`))).map(
          (row) => row.slug
        )
      );
      let slug = baseSlug;
      let suffix = 2;
      while (takenSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      [photographer] = await tx
        .insert(racepicPhotographer)
        .values({
          email: input.email.trim(),
          emailNorm,
          displayName: input.displayName.trim(),
          slug,
          status: 'INVITED'
        })
        .returning();
    }

    if (!photographer) {
      throw new RacePicError('RACEPIC_PHOTOGRAPHER_CREATE_FAILED');
    }

    for (const eventRow of eventRows) {
      await tx
        .insert(racepicPhotographerEvent)
        .values({ photographerId: photographer.id, eventId: eventRow.id })
        .onConflictDoNothing();
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const [invitation] = await tx
      .insert(racepicInvitation)
      .values({
        photographerId: photographer.id,
        tokenHash: hashToken(token),
        email: input.email.trim(),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
        createdBy: input.createdBy
      })
      .returning();
    if (!invitation) {
      throw new RacePicError('RACEPIC_INVITATION_CREATE_FAILED');
    }

    return {
      photographer,
      invitation,
      token,
      eventNames: eventRows.map((row) => row.name)
    };
  });
};

export const listPhotographers = async () => {
  const db = await getDb();
  return db
    .select()
    .from(racepicPhotographer)
    .where(isNull(racepicPhotographer.deletedAt))
    .orderBy(racepicPhotographer.createdAt);
};

/** Fuer die oeffentliche Einladungsseite: nur Eventnamen + maskierte E-Mail, kein Fotografenname. */
export const getInvitationPreviewByToken = async (token: string) => {
  const db = await getDb();
  const tokenHash = hashToken(token);
  const [invitation] = await db.select().from(racepicInvitation).where(eq(racepicInvitation.tokenHash, tokenHash)).limit(1);
  if (!invitation) {
    return null;
  }
  const eventRows = await db
    .select({ name: event.name })
    .from(racepicPhotographerEvent)
    .innerJoin(event, eq(event.id, racepicPhotographerEvent.eventId))
    .where(eq(racepicPhotographerEvent.photographerId, invitation.photographerId));

  return {
    invitation,
    eventNames: eventRows.map((row) => row.name)
  };
};

/**
 * Startet den Claim-Flow: legt sicher, dass ein Cognito-Nutzer fuer die eingeladene E-Mail
 * existiert (siehe ./cognito.ts). Prueft nur Ablauf/Verbrauch, nicht die JWT-Identitaet - das
 * passiert erst in claimInvitation, sobald der Fotograf tatsaechlich eingeloggt ist.
 */
export const getConsumableInvitationByToken = async (token: string) => {
  const db = await getDb();
  const tokenHash = hashToken(token);
  const [invitation] = await db.select().from(racepicInvitation).where(eq(racepicInvitation.tokenHash, tokenHash)).limit(1);
  if (!invitation) {
    return null;
  }
  if (invitation.consumedAt) {
    throw new RacePicError('RACEPIC_INVITATION_ALREADY_CONSUMED');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new RacePicError('RACEPIC_INVITATION_EXPIRED');
  }
  return invitation;
};

/**
 * Schliesst das Claiming ab: bindet cognito_sub an das Profil, verbraucht die Einladung,
 * aktiviert das Profil. Race-sicher durch die WHERE-Bedingungen (consumed_at is null,
 * expires_at > now) in derselben Transaktion wie das Photographer-Update.
 */
export const claimInvitation = async (input: {
  token: string;
  cognitoSub: string;
  termsVersion: string;
}) => {
  const tokenHash = hashToken(input.token);
  const db = await getDb();

  return db.transaction(async (tx) => {
    const now = new Date();
    const [invitation] = await tx
      .update(racepicInvitation)
      .set({ consumedAt: now })
      .where(and(eq(racepicInvitation.tokenHash, tokenHash), isNull(racepicInvitation.consumedAt)))
      .returning();
    if (!invitation) {
      throw new RacePicError('RACEPIC_INVITATION_ALREADY_CONSUMED');
    }
    if (invitation.expiresAt.getTime() < now.getTime()) {
      throw new RacePicError('RACEPIC_INVITATION_EXPIRED');
    }

    const [photographer] = await tx
      .update(racepicPhotographer)
      .set({
        cognitoSub: input.cognitoSub,
        status: 'ACTIVE_FREE',
        termsAcceptedVersion: input.termsVersion,
        termsAcceptedAt: now,
        updatedAt: now
      })
      .where(and(eq(racepicPhotographer.id, invitation.photographerId), isNull(racepicPhotographer.cognitoSub)))
      .returning();
    if (!photographer) {
      // cognito_sub war schon gesetzt (Profil bereits geclaimt) - der Invitation-Verbrauch oben
      // greift trotzdem als Idempotenzschutz, hier zusaetzlich hart ablehnen.
      throw new RacePicError('RACEPIC_PHOTOGRAPHER_ALREADY_CLAIMED');
    }

    return photographer;
  });
};

export const getPhotographerByCognitoSub = async (cognitoSub: string) => {
  const db = await getDb();
  const [photographer] = await db
    .select()
    .from(racepicPhotographer)
    .where(and(eq(racepicPhotographer.cognitoSub, cognitoSub), isNull(racepicPhotographer.deletedAt)))
    .limit(1);
  return photographer ?? null;
};

export type PhotographerProfilePatch = Partial<{
  displayName: string;
  legalName: string | null;
  copyrightLine: string | null;
  website: string | null;
  social: Record<string, string>;
  avatarKey: string | null;
  defaultLicenseId: string | null;
}>;

export const updatePhotographerProfile = async (id: string, patch: PhotographerProfilePatch) => {
  const db = await getDb();
  const [updated] = await db
    .update(racepicPhotographer)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(racepicPhotographer.id, id))
    .returning();
  return updated ?? null;
};

/** Fuer die Event-Auswahl im Studio-Uploader (Paket 3b): Events, fuer die Upload-Zugang besteht. */
export const listMyEventAccess = async (photographerId: string) => {
  const db = await getDb();
  return db
    .select({
      eventId: event.id,
      eventName: event.name,
      uploadOpensAt: racepicPhotographerEvent.uploadOpensAt,
      uploadClosesAt: racepicPhotographerEvent.uploadClosesAt,
      quotaImages: racepicPhotographerEvent.quotaImages
    })
    .from(racepicPhotographerEvent)
    .innerJoin(event, eq(event.id, racepicPhotographerEvent.eventId))
    .where(eq(racepicPhotographerEvent.photographerId, photographerId));
};

/** Aktive Lizenzen fuer die Lizenzwahl beim Upload (Abschnitt C: `racepic_license`, siehe docs/racepic/licenses.md). */
export const listActiveLicenses = async () => {
  const db = await getDb();
  return db.select().from(racepicLicense).where(eq(racepicLicense.active, true)).orderBy(racepicLicense.code);
};
