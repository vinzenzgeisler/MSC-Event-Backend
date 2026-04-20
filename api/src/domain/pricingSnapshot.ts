type PricingSnapshotLine = {
  entryId?: unknown;
  classId?: unknown;
  baseFeeCents?: unknown;
  lateFeeCents?: unknown;
  secondVehicleDiscountCents?: unknown;
  manualOverrideCents?: unknown;
  lineTotalCents?: unknown;
  submittedAt?: unknown;
  acceptanceStatus?: unknown;
};

type PricingSnapshot = {
  lines?: unknown;
  forecastLines?: unknown;
  manualOverrides?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asLines = (value: unknown): PricingSnapshotLine[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (asRecord(item) ?? {}) as PricingSnapshotLine);
};

export const getEntryLineTotalCents = (pricingSnapshot: unknown, entryId: string): number | null => {
  const snapshot = asRecord(pricingSnapshot) as PricingSnapshot | null;
  if (!snapshot) {
    return null;
  }
  const line = asLines(snapshot.lines).find((item) => item.entryId === entryId);
  if (!line) {
    return null;
  }
  const cents = Number(line.lineTotalCents);
  return Number.isFinite(cents) ? cents : null;
};

export const getForecastEntryLineTotalCents = (pricingSnapshot: unknown, entryId: string): number | null => {
  const snapshot = asRecord(pricingSnapshot) as PricingSnapshot | null;
  if (!snapshot) {
    return null;
  }
  const line = asLines(snapshot.forecastLines).find((item) => item.entryId === entryId);
  if (!line) {
    return null;
  }
  const cents = Number(line.lineTotalCents);
  return Number.isFinite(cents) ? cents : null;
};

export const getManualEntryTotalOverrideCents = (pricingSnapshot: unknown, entryId: string): number | null => {
  const snapshot = asRecord(pricingSnapshot) as PricingSnapshot | null;
  if (!snapshot) {
    return null;
  }
  const overrides = asRecord(snapshot.manualOverrides);
  if (!overrides) {
    return null;
  }
  const cents = Number(overrides[entryId]);
  return Number.isFinite(cents) ? cents : null;
};

export const listManualEntryTotalOverrides = (pricingSnapshot: unknown): Map<string, number> => {
  const snapshot = asRecord(pricingSnapshot) as PricingSnapshot | null;
  if (!snapshot) {
    return new Map();
  }
  const overrides = asRecord(snapshot.manualOverrides);
  if (!overrides) {
    return new Map();
  }
  const entries = Object.entries(overrides)
    .map(([entryId, value]) => [entryId, Number(value)] as const)
    .filter(([, cents]) => Number.isFinite(cents));
  return new Map(entries);
};

export const sumEntryLineTotalCents = (pricingSnapshot: unknown, entryIds: string[]): number => {
  const snapshot = asRecord(pricingSnapshot) as PricingSnapshot | null;
  if (!snapshot) {
    return 0;
  }
  const wanted = new Set(entryIds);
  return asLines(snapshot.lines).reduce((sum, line) => {
    if (!wanted.has(String(line.entryId ?? ''))) {
      return sum;
    }
    const cents = Number(line.lineTotalCents);
    return Number.isFinite(cents) ? sum + cents : sum;
  }, 0);
};
