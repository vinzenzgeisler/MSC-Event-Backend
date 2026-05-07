import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { emailOutbox, entry, event, eventClass, exportJob, geoLocationCache, invoice, person, vehicle } from '../db/schema';

const dashboardSummaryQuerySchema = z.object({
  eventId: z.string().uuid()
});

const RECENT_ENTRIES_LIMIT = 10;
const DRIVER_LOCATION_MAX_POINTS = 250;
const DRIVER_LOCATION_PREVIEW_LIMIT = 5;

const toAgeYears = (birthdate: Date | string | null, referenceDate: Date): number | null => {
  if (!birthdate) {
    return null;
  }
  const date = birthdate instanceof Date ? birthdate : new Date(birthdate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  let age = referenceDate.getUTCFullYear() - date.getUTCFullYear();
  const m = referenceDate.getUTCMonth() - date.getUTCMonth();
  if (m < 0 || (m === 0 && referenceDate.getUTCDate() < date.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
};

const normalizeLocationPart = (value: string | null | undefined): string => {
  return (value ?? '').trim().replace(/\s+/g, ' ');
};

const normalizeLocationKeyPart = (value: string | null | undefined): string => {
  return normalizeLocationPart(value).toLowerCase();
};

const buildLocationKey = (input: { country?: string | null; zip?: string | null; city?: string | null }): string => {
  return [input.country, input.zip, input.city].map(normalizeLocationKeyPart).join('|');
};

const hasUsableLocation = (input: { country?: string | null; zip?: string | null; city?: string | null }): boolean => {
  return Boolean(normalizeLocationPart(input.country) || normalizeLocationPart(input.zip) || normalizeLocationPart(input.city));
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const vehicleLabelFromParts = (row: { vehicleMake: string | null; vehicleModel: string | null; vehicleYear: number | null }): string => {
  const label = [row.vehicleMake, row.vehicleModel].filter(Boolean).join(' ').trim();
  if (label) {
    return row.vehicleYear ? `${label} (${row.vehicleYear})` : label;
  }
  return 'Fahrzeug';
};

export const getDashboardSummary = async (eventId: string) => {
  const db = await getDb();

  const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (eventRows.length === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const [
    entriesTotalRows,
    paymentSummaryRows,
    checkinPendingTotalRows,
    mailFailedTotalRows,
    mailQueuedTotalRows,
    exportsQueuedTotalRows,
    exportsProcessingTotalRows,
    classDistribution,
    recentEntryRows,
    driverAgeRows
  ] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`)),
    db
      .select({
        eligibleTotal: sql<number>`count(${entry.id})::int`,
        paidTotal: sql<number>`count(${entry.id}) filter (where ${invoice.paymentStatus} = 'paid')::int`,
        dueTotal: sql<number>`count(${entry.id}) filter (where ${invoice.id} is null or ${invoice.paymentStatus} != 'paid')::int`
      })
      .from(entry)
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`, eq(entry.acceptanceStatus, 'accepted'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`, eq(entry.checkinIdVerified, false))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'failed'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'processing'))),
    db
      .select({
        classId: eventClass.id,
        className: eventClass.name,
        count: sql<number>`count(${entry.id})::int`
      })
      .from(eventClass)
      .leftJoin(entry, and(eq(entry.classId, eventClass.id), eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
      .where(eq(eventClass.eventId, eventId))
      .groupBy(eventClass.id, eventClass.name)
      .orderBy(asc(eventClass.name)),
    db
      .select({
        entryId: entry.id,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        createdAt: entry.createdAt
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
      .orderBy(desc(entry.createdAt))
      .limit(RECENT_ENTRIES_LIMIT),
    db
      .select({
        driverPersonId: entry.driverPersonId,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        birthdate: person.birthdate
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
  ]);

  const activityResult = await db.execute(sql`
    with days as (
      select generate_series(
        (timezone('Europe/Berlin', now())::date - interval '6 days'),
        timezone('Europe/Berlin', now())::date,
        interval '1 day'
      )::date as day
    )
    select
      to_char(days.day, 'YYYY-MM-DD') as day,
      count(e.id)::int as count
    from days
    left join ${entry} e
      on e.event_id = ${eventId}
      and e.deleted_at is null
      and (timezone('Europe/Berlin', e.created_at))::date = days.day
    group by days.day
    order by days.day
  `);
  const dailyActivity = activityResult.rows.map((row) => ({
    day: String(row.day),
    count: Number(row.count) || 0
  }));
  const entriesLast7DaysTotal = dailyActivity.reduce((sum, item) => sum + item.count, 0);

  const now = new Date();
  const ageRowsByDriver = new Map<string, { age: number; driverLabel: string; className: string }>();
  driverAgeRows.forEach((row) => {
    if (ageRowsByDriver.has(row.driverPersonId)) {
      return;
    }
    const age = toAgeYears(row.birthdate, now);
    if (age === null) {
      return;
    }
    ageRowsByDriver.set(row.driverPersonId, {
      age,
      driverLabel: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className
    });
  });
  const ageRows = Array.from(ageRowsByDriver.values());

  const sortedAgeRows = [...ageRows].sort((a, b) => a.age - b.age);
  const youngestDriverAge = sortedAgeRows.length > 0 ? sortedAgeRows[0].age : null;
  const youngestRow = sortedAgeRows.length > 0 ? sortedAgeRows[0] : null;
  const oldestRow = sortedAgeRows.length > 0 ? sortedAgeRows[sortedAgeRows.length - 1] : null;
  const youngestDriverLabel = youngestRow ? `${youngestRow.driverLabel} (${youngestRow.className})` : '';
  const oldestDriverAge = oldestRow ? oldestRow.age : null;
  const oldestDriverLabel = oldestRow ? `${oldestRow.driverLabel} (${oldestRow.className})` : '';

  let medianDriverAge: number | null = null;
  if (sortedAgeRows.length > 0) {
    const mid = Math.floor(sortedAgeRows.length / 2);
    if (sortedAgeRows.length % 2 === 1) {
      medianDriverAge = sortedAgeRows[mid].age;
    } else {
      medianDriverAge = (sortedAgeRows[mid - 1].age + sortedAgeRows[mid].age) / 2;
    }
  }

  return {
    summary: {
      entriesTotal: entriesTotalRows[0]?.value ?? 0,
      paymentsDueTotal: paymentSummaryRows[0]?.dueTotal ?? 0,
      paymentsPaidTotal: paymentSummaryRows[0]?.paidTotal ?? 0,
      paymentRelevantTotal: paymentSummaryRows[0]?.eligibleTotal ?? 0,
      entriesLast7DaysTotal,
      checkinPendingTotal: checkinPendingTotalRows[0]?.value ?? 0,
      mailFailedTotal: mailFailedTotalRows[0]?.value ?? 0,
      mailQueuedTotal: mailQueuedTotalRows[0]?.value ?? 0,
      exportsQueuedTotal: exportsQueuedTotalRows[0]?.value ?? 0,
      exportsProcessingTotal: exportsProcessingTotalRows[0]?.value ?? 0,
      driverAgeStats: {
        oldestDriverAge,
        oldestDriverLabel,
        youngestDriverAge,
        youngestDriverLabel,
        medianDriverAge
      }
    },
    classDistribution,
    recentEntries: recentEntryRows.map((row) => ({
      entryId: row.entryId,
      driverName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className,
      createdAt: row.createdAt
    })),
    dailyActivity
  };
};

export const getDashboardDriverLocations = async (eventId: string) => {
  const db = await getDb();

  const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (eventRows.length === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const rows = await db
    .select({
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      country: person.country,
      zip: person.zip,
      city: person.city,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      createdAt: entry.createdAt
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(and(eq(entry.eventId, eventId), sql`${entry.deletedAt} is null`))
    .orderBy(desc(entry.createdAt));

  const groups = new Map<
    string,
    {
      locationKey: string;
      country: string;
      zip: string;
      city: string;
      entryCount: number;
      drivers: Map<
        string,
        {
          entryId: string;
          driverName: string;
          className: string;
          startNumber: string;
          vehicleLabel: string;
        }
      >;
    }
  >();

  for (const row of rows) {
    if (!hasUsableLocation(row)) {
      continue;
    }

    const locationKey = buildLocationKey(row);
    const existing =
      groups.get(locationKey) ??
      {
        locationKey,
        country: normalizeLocationPart(row.country),
        zip: normalizeLocationPart(row.zip),
        city: normalizeLocationPart(row.city),
        entryCount: 0,
        drivers: new Map()
      };

    existing.entryCount += 1;
    if (!existing.drivers.has(row.driverPersonId)) {
      existing.drivers.set(row.driverPersonId, {
        entryId: row.entryId,
        driverName: `${row.driverFirstName} ${row.driverLastName}`.trim() || 'Fahrer',
        className: row.className,
        startNumber: row.startNumber ?? '-',
        vehicleLabel: vehicleLabelFromParts(row)
      });
    }
    groups.set(locationKey, existing);
  }

  const locationKeys = Array.from(groups.keys());
  const cacheRows =
    locationKeys.length > 0
      ? await db
          .select({
            locationKey: geoLocationCache.locationKey,
            lat: geoLocationCache.lat,
            lng: geoLocationCache.lng,
            status: geoLocationCache.status
          })
          .from(geoLocationCache)
          .where(inArray(geoLocationCache.locationKey, locationKeys))
      : [];
  const cacheByKey = new Map(cacheRows.map((row) => [row.locationKey, row]));

  let missingLocationsTotal = 0;
  let missingEntriesTotal = 0;
  const locations = Array.from(groups.values())
    .map((group) => {
      const cached = cacheByKey.get(group.locationKey);
      const lat = cached?.status === 'resolved' ? toFiniteNumber(cached.lat) : null;
      const lng = cached?.status === 'resolved' ? toFiniteNumber(cached.lng) : null;
      const driverCount = group.drivers.size;

      if (lat === null || lng === null) {
        missingLocationsTotal += 1;
        missingEntriesTotal += driverCount;
        return null;
      }

      return {
        locationKey: group.locationKey,
        country: group.country,
        zip: group.zip,
        city: group.city,
        lat,
        lng,
        driverCount,
        entryCount: group.entryCount,
        driversPreview: Array.from(group.drivers.values())
          .slice(0, DRIVER_LOCATION_PREVIEW_LIMIT)
          .map((driver) => ({
            entryId: driver.entryId,
            driverName: driver.driverName,
            className: driver.className,
            startNumber: driver.startNumber,
            vehicleLabel: driver.vehicleLabel
          }))
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.driverCount - left.driverCount)
    .slice(0, DRIVER_LOCATION_MAX_POINTS);

  return {
    locations,
    totalLocations: groups.size,
    totalDrivers: Array.from(groups.values()).reduce((sum, group) => sum + group.drivers.size, 0),
    missingLocationsTotal,
    missingEntriesTotal,
    maxPoints: DRIVER_LOCATION_MAX_POINTS
  };
};

export const validateDashboardSummaryQuery = (query: Record<string, string | undefined>) =>
  dashboardSummaryQuerySchema.parse({
    eventId: query.eventId
  });

export const validateDashboardDriverLocationsQuery = validateDashboardSummaryQuery;
