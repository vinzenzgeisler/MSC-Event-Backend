import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  entry,
  event as eventTable,
  eventClass,
  eventHubCandidateOverride,
  eventHubConfig,
  eventVote,
  eventVoteChallenge,
  eventVoteResultSnapshot,
  geoLocationCache,
  person,
  vehicle
} from '../db/schema';
import { buildLocationKey, toFiniteNumber } from './adminDashboard';
import {
  computeEventHubFacts,
  filterPublicCandidates,
  type EventHubCandidateRow
} from '../domain/eventHubFacts';

const CHALLENGE_TTL_SECONDS = 120;

export type VotingStatus = 'not_open' | 'open' | 'closed';

export const resolveVotingStatus = (
  config: { votingMode: string; votingOpensAt: Date | string | null; votingClosesAt: Date | string | null } | null,
  now: Date
): VotingStatus => {
  if (!config) {
    return 'not_open';
  }
  if (config.votingMode === 'forced_open') {
    return 'open';
  }
  if (config.votingMode === 'forced_closed') {
    return 'closed';
  }
  const opensAt = config.votingOpensAt ? new Date(config.votingOpensAt) : null;
  const closesAt = config.votingClosesAt ? new Date(config.votingClosesAt) : null;
  if (opensAt && now < opensAt) {
    return 'not_open';
  }
  if (closesAt && now >= closesAt) {
    return 'closed';
  }
  return opensAt ? 'open' : 'not_open';
};

export const loadCandidateRows = async (db: Awaited<ReturnType<typeof getDb>>, eventId: string): Promise<EventHubCandidateRow[]> => {
  const rows = await db
    .select({
      entryId: entry.id,
      classId: entry.classId,
      startNumberNorm: entry.startNumberNorm,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      driverProcessingRestricted: person.processingRestricted,
      driverObjectionFlag: person.objectionFlag,
      driverBirthdate: person.birthdate,
      driverCountry: person.country,
      driverZip: person.zip,
      driverCity: person.city,
      consentMediaAccepted: entry.consentMediaAccepted,
      vehicleImageS3Key: vehicle.imageS3Key,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      displacementCcm: vehicle.displacementCcm,
      powerPs: vehicle.powerPs,
      cylinders: vehicle.cylinders,
      overrideState: eventHubCandidateOverride.state
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(
      eventHubCandidateOverride,
      and(eq(eventHubCandidateOverride.eventId, entry.eventId), eq(eventHubCandidateOverride.entryId, entry.id))
    )
    .where(
      and(
        eq(entry.eventId, eventId),
        sql`${entry.deletedAt} is null`,
        eq(entry.registrationStatus, 'submitted_verified'),
        eq(entry.acceptanceStatus, 'accepted')
      )
    );
  return rows as EventHubCandidateRow[];
};

const loadDriverGeo = async (
  db: Awaited<ReturnType<typeof getDb>>,
  rows: EventHubCandidateRow[]
): Promise<Map<string, { lat: number; lng: number }>> => {
  const keyed = rows
    .map((row) => ({
      entryId: row.entryId,
      key: buildLocationKey({ country: row.driverCountry, zip: row.driverZip, city: row.driverCity })
    }))
    .filter((item) => item.key !== '||');
  if (keyed.length === 0) {
    return new Map();
  }
  const cacheRows = await db
    .select({ locationKey: geoLocationCache.locationKey, lat: geoLocationCache.lat, lng: geoLocationCache.lng, status: geoLocationCache.status })
    .from(geoLocationCache)
    .where(inArray(geoLocationCache.locationKey, Array.from(new Set(keyed.map((item) => item.key)))));
  const resolvedByKey = new Map(
    cacheRows
      .filter((row) => row.status === 'resolved')
      .map((row) => [row.locationKey, { lat: toFiniteNumber(row.lat), lng: toFiniteNumber(row.lng) }])
  );
  const result = new Map<string, { lat: number; lng: number }>();
  for (const item of keyed) {
    const resolved = resolvedByKey.get(item.key);
    if (resolved?.lat !== null && resolved?.lng !== null && resolved?.lat !== undefined && resolved?.lng !== undefined) {
      result.set(item.entryId, { lat: resolved.lat, lng: resolved.lng });
    }
  }
  return result;
};

export const getPublicEventHub = async (eventId: string) => {
  const db = await getDb();
  const [eventRow] = await db
    .select({ id: eventTable.id, name: eventTable.name, startsAt: eventTable.startsAt, endsAt: eventTable.endsAt })
    .from(eventTable)
    .where(eq(eventTable.id, eventId))
    .limit(1);
  if (!eventRow) {
    return null;
  }

  const [config] = await db.select().from(eventHubConfig).where(eq(eventHubConfig.eventId, eventId)).limit(1);
  const classRows = await db
    .select({ id: eventClass.id, name: eventClass.name, vehicleType: eventClass.vehicleType })
    .from(eventClass)
    .where(eq(eventClass.eventId, eventId))
    .orderBy(asc(eventClass.name));

  const now = new Date();
  const votingStatus = resolveVotingStatus(config ?? null, now);
  const candidateRows = await loadCandidateRows(db, eventId);
  const candidates = filterPublicCandidates(candidateRows);

  const venue =
    config?.venueLat && config?.venueLng
      ? { lat: Number(config.venueLat), lng: Number(config.venueLng) }
      : null;
  const driverGeo = venue ? await loadDriverGeo(db, candidateRows) : new Map();
  const facts = computeEventHubFacts(candidateRows, eventRow.startsAt, venue, driverGeo);

  let results: Array<{ classId: string; entries: Array<{ entryId: string; driverName: string; voteCount: number; percent: number }> }> | null =
    null;
  if (votingStatus === 'closed') {
    let voteCountRows = await db
      .select({ classId: eventVote.classId, entryId: eventVote.entryId, voteCount: sql<number>`count(*)::int` })
      .from(eventVote)
      .where(eq(eventVote.eventId, eventId))
      .groupBy(eventVote.classId, eventVote.entryId);
    if (voteCountRows.length === 0) {
      voteCountRows = await db
        .select({ classId: eventVoteResultSnapshot.classId, entryId: eventVoteResultSnapshot.entryId, voteCount: eventVoteResultSnapshot.voteCount })
        .from(eventVoteResultSnapshot)
        .where(eq(eventVoteResultSnapshot.eventId, eventId));
    }
    const nameByEntryId = new Map(candidates.map((c) => [c.entryId, c.driverName]));
    const byClass = new Map<string, Array<{ entryId: string; driverName: string; voteCount: number }>>();
    for (const row of voteCountRows) {
      const list = byClass.get(row.classId) ?? [];
      list.push({ entryId: row.entryId, driverName: nameByEntryId.get(row.entryId) ?? 'Unbekannt', voteCount: row.voteCount });
      byClass.set(row.classId, list);
    }
    results = Array.from(byClass.entries()).map(([classId, entries]) => {
      const total = entries.reduce((sum, item) => sum + item.voteCount, 0);
      return {
        classId,
        entries: entries
          .map((item) => ({ ...item, percent: total > 0 ? Math.round((item.voteCount / total) * 1000) / 10 : 0 }))
          .sort((a, b) => b.voteCount - a.voteCount)
      };
    });
  }

  return {
    event: { id: eventRow.id, name: eventRow.name, startsAt: eventRow.startsAt, endsAt: eventRow.endsAt },
    votingStatus,
    classes: classRows,
    candidates,
    facts,
    results
  };
};

const challengeSchema = z.object({ publicKey: z.string().min(1).max(2000) });
export const validateChallengeInput = (payload: unknown) => challengeSchema.parse(payload);

export const createVoteChallenge = async (eventId: string, input: z.infer<typeof challengeSchema>) => {
  const db = await getDb();
  const nonce = randomBytes(24).toString('base64url');
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
  const [challenge] = await db
    .insert(eventVoteChallenge)
    .values({ eventId, nonceHash, expiresAt })
    .returning({ id: eventVoteChallenge.id, expiresAt: eventVoteChallenge.expiresAt });
  return { challengeId: challenge.id, nonce, expiresAt: challenge.expiresAt };
};

const voteSchema = z.object({
  classId: z.string().uuid(),
  entryId: z.string().uuid(),
  challengeId: z.string().uuid(),
  nonce: z.string().min(1),
  publicKey: z.string().min(1).max(2000),
  signature: z.string().min(1),
  clientSubmissionKey: z.string().uuid()
});
export type SubmitVoteInput = z.infer<typeof voteSchema>;
export const validateVoteInput = (payload: unknown): SubmitVoteInput => voteSchema.parse(payload);

const base64ToBuffer = (value: string): Buffer => Buffer.from(value, 'base64');
// node:crypto's webcrypto types and lib.dom's BufferSource types conflict; both accept a plain Buffer at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toBufferSource = (buffer: Buffer): any => buffer;

const verifyVoteSignature = async (input: SubmitVoteInput, eventId: string): Promise<boolean> => {
  try {
    const publicKeyBytes = toBufferSource(base64ToBuffer(input.publicKey));
    const key = await webcrypto.subtle.importKey(
      'spki',
      publicKeyBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const message = toBufferSource(
      Buffer.from(
        `${input.challengeId}.${eventId}.${input.classId}.${input.entryId}.${input.clientSubmissionKey}.${input.nonce}`,
        'utf8'
      )
    );
    const signature = toBufferSource(base64ToBuffer(input.signature));
    return await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
  } catch {
    return false;
  }
};

export class VoteError extends Error {
  constructor(public code: 'INVALID_CHALLENGE' | 'INVALID_SIGNATURE' | 'VOTING_CLOSED' | 'ALREADY_VOTED' | 'CANDIDATE_NOT_ELIGIBLE') {
    super(code);
  }
}

export const submitVote = async (eventId: string, input: SubmitVoteInput) => {
  const db = await getDb();

  const [config] = await db.select().from(eventHubConfig).where(eq(eventHubConfig.eventId, eventId)).limit(1);
  if (resolveVotingStatus(config ?? null, new Date()) !== 'open') {
    throw new VoteError('VOTING_CLOSED');
  }

  const [challenge] = await db
    .select()
    .from(eventVoteChallenge)
    .where(and(eq(eventVoteChallenge.id, input.challengeId), eq(eventVoteChallenge.eventId, eventId)))
    .limit(1);
  if (!challenge || challenge.usedAt || challenge.expiresAt < new Date()) {
    throw new VoteError('INVALID_CHALLENGE');
  }
  const expectedNonceHash = createHash('sha256').update(input.nonce).digest('hex');
  if (expectedNonceHash !== challenge.nonceHash) {
    throw new VoteError('INVALID_CHALLENGE');
  }

  const candidateRows = await loadCandidateRows(db, eventId);
  const eligibleEntryIds = new Set(filterPublicCandidates(candidateRows).map((c) => c.entryId));
  if (!eligibleEntryIds.has(input.entryId)) {
    throw new VoteError('CANDIDATE_NOT_ELIGIBLE');
  }

  const signatureValid = await verifyVoteSignature(input, eventId);
  if (!signatureValid) {
    throw new VoteError('INVALID_SIGNATURE');
  }

  const voterKeyHash = createHash('sha256').update(base64ToBuffer(input.publicKey)).digest('hex');

  const existingBySubmission = await db
    .select({ id: eventVote.id })
    .from(eventVote)
    .where(eq(eventVote.clientSubmissionKey, input.clientSubmissionKey))
    .limit(1);
  if (existingBySubmission.length > 0) {
    await db
      .update(eventVoteChallenge)
      .set({ usedAt: new Date() })
      .where(and(eq(eventVoteChallenge.id, input.challengeId), sql`${eventVoteChallenge.usedAt} is null`));
    return { alreadySubmitted: true };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(eventVote).values({
        eventId,
        classId: input.classId,
        entryId: input.entryId,
        voterKeyHash,
        clientSubmissionKey: input.clientSubmissionKey
      });
      await tx.update(eventVoteChallenge).set({ usedAt: new Date() }).where(eq(eventVoteChallenge.id, input.challengeId));
    });
  } catch (error) {
    if (error instanceof Error && /event_vote_event_class_voter_unique/.test(error.message)) {
      throw new VoteError('ALREADY_VOTED');
    }
    throw error;
  }
  return { alreadySubmitted: false };
};

const deviceStatusSchema = z.object({ publicKey: z.string().min(1).max(2000) });
export const validateDeviceStatusInput = (payload: unknown) => deviceStatusSchema.parse(payload);

export const getDeviceVoteStatus = async (eventId: string, input: z.infer<typeof deviceStatusSchema>) => {
  const db = await getDb();
  const voterKeyHash = createHash('sha256').update(base64ToBuffer(input.publicKey)).digest('hex');
  const rows = await db
    .select({ classId: eventVote.classId })
    .from(eventVote)
    .where(and(eq(eventVote.eventId, eventId), eq(eventVote.voterKeyHash, voterKeyHash)));
  return { votedClassIds: rows.map((row) => row.classId) };
};

export const buildDeviceRateLimitKey = (input: { publicKey: string }): string =>
  createHash('sha256').update(input.publicKey).digest('hex');

export const generateClientSubmissionKey = (): string => randomUUID();

export { eventVoteResultSnapshot };
