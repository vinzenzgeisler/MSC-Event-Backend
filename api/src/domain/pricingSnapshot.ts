type PricingSnapshotLine = {
  entryId?: unknown;
  lineTotalCents?: unknown;
};

type PricingSnapshot = {
  lines?: unknown;
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
