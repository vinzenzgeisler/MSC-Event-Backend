import { distanceKm } from './geoDistance';

export type EventHubCandidateRow = {
  entryId: string;
  classId: string;
  startNumberNorm: string | null;
  driverFirstName: string;
  driverLastName: string;
  driverPublicationName: string | null;
  driverProcessingRestricted: boolean;
  driverObjectionFlag: boolean;
  driverBirthdate: string | null;
  driverCountry: string | null;
  driverZip: string | null;
  driverCity: string | null;
  consentMediaAccepted: boolean;
  vehicleImageS3Key: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  displacementCcm: number | null;
  powerPs: number | null;
  cylinders: number | null;
  overrideState: 'auto' | 'pinned' | 'hidden' | null;
  featured: boolean | null;
};

export type EventHubCandidate = {
  entryId: string;
  classId: string;
  startNumberNorm: string | null;
  driverName: string;
  vehicleImageS3Key: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  pinned: boolean;
  featured: boolean;
};

/**
 * A driver is publicly eligible only when not protected in any way and not
 * administratively hidden. This mirrors the export redaction rules in
 * adminExports.ts so the voting surface never leaks protected identities.
 */
export const isPubliclyEligible = (row: EventHubCandidateRow): boolean =>
  row.overrideState !== 'hidden' &&
  !row.driverProcessingRestricted &&
  !row.driverObjectionFlag &&
  !row.driverPublicationName;

export const toPublicCandidate = (row: EventHubCandidateRow): EventHubCandidate => ({
  entryId: row.entryId,
  classId: row.classId,
  startNumberNorm: row.startNumberNorm,
  driverName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
  vehicleImageS3Key: row.consentMediaAccepted ? row.vehicleImageS3Key : null,
  vehicleMake: row.vehicleMake,
  vehicleModel: row.vehicleModel,
  vehicleYear: row.vehicleYear,
  pinned: false,
  featured: Boolean(row.featured)
});

export const filterPublicCandidates = (rows: EventHubCandidateRow[]): EventHubCandidate[] =>
  rows
    .filter(isPubliclyEligible)
    .map(toPublicCandidate)
    .sort((a, b) => (a.startNumberNorm ?? '').localeCompare(b.startNumberNorm ?? '', undefined, { numeric: true }));

const ageAt = (birthdate: string, referenceDate: Date): number => {
  const dob = new Date(birthdate);
  let age = referenceDate.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = referenceDate.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
};

export type EventHubFactEntry = { entryId: string; driverName: string; value: number };
export type EventHubFacts = {
  farthestTravelKm: EventHubFactEntry[] | null;
  youngestDriver: EventHubFactEntry[] | null;
  oldestDriver: EventHubFactEntry[] | null;
  oldestVehicle: EventHubFactEntry[] | null;
  largestDisplacementCcm: EventHubFactEntry[] | null;
  highestPowerPs: EventHubFactEntry[] | null;
  mostCylinders: EventHubFactEntry[] | null;
};

const pickExtreme = <T>(
  rows: EventHubCandidateRow[],
  valueOf: (row: EventHubCandidateRow) => number | null,
  direction: 'min' | 'max'
): EventHubFactEntry[] | null => {
  const withValues = rows
    .map((row) => ({ row, value: valueOf(row) }))
    .filter((item): item is { row: EventHubCandidateRow; value: number } => item.value !== null);
  if (withValues.length === 0) {
    return null;
  }
  const best = withValues.reduce((acc, item) =>
    direction === 'max' ? (item.value > acc ? item.value : acc) : item.value < acc ? item.value : acc,
  withValues[0].value);
  return withValues
    .filter((item) => item.value === best)
    .map((item) => ({
      entryId: item.row.entryId,
      driverName: `${item.row.driverFirstName} ${item.row.driverLastName}`.trim(),
      value: item.value
    }));
};

export const computeEventHubFacts = (
  rows: EventHubCandidateRow[],
  eventStartsAt: string,
  venue: { lat: number; lng: number } | null,
  driverGeo: Map<string, { lat: number; lng: number }>
): EventHubFacts => {
  const eligible = rows.filter(isPubliclyEligible);
  const referenceDate = new Date(eventStartsAt);

  const farthestTravelKm =
    venue &&
    pickExtreme(
      eligible.filter((row) => driverGeo.has(row.entryId)),
      (row) => {
        const geo = driverGeo.get(row.entryId);
        return geo ? Math.round(distanceKm(venue.lat, venue.lng, geo.lat, geo.lng)) : null;
      },
      'max'
    );

  return {
    farthestTravelKm: farthestTravelKm || null,
    youngestDriver: pickExtreme(
      eligible.filter((row) => row.driverBirthdate),
      (row) => (row.driverBirthdate ? ageAt(row.driverBirthdate, referenceDate) : null),
      'min'
    ),
    oldestDriver: pickExtreme(
      eligible.filter((row) => row.driverBirthdate),
      (row) => (row.driverBirthdate ? ageAt(row.driverBirthdate, referenceDate) : null),
      'max'
    ),
    oldestVehicle: pickExtreme(eligible, (row) => row.vehicleYear, 'min'),
    largestDisplacementCcm: pickExtreme(eligible, (row) => row.displacementCcm, 'max'),
    highestPowerPs: pickExtreme(eligible, (row) => row.powerPs, 'max'),
    mostCylinders: pickExtreme(eligible, (row) => row.cylinders, 'max')
  };
};
