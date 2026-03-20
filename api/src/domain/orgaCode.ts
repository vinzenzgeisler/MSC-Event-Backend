import { createHash } from 'node:crypto';

const ORGA_CODE_SUFFIX_MODULO = 36n ** 5n;

const normalizePart = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildOrgaCode = (input: {
  eventId: string;
  driverPersonId: string;
  prefix?: string | null;
}): string => {
  const digest = createHash('md5').update(`${input.eventId}:${input.driverPersonId}`).digest('hex').slice(0, 10);
  const suffix = (BigInt(`0x${digest}`) % ORGA_CODE_SUFFIX_MODULO).toString(36).toUpperCase().padStart(5, '0');
  const prefix = normalizePart(input.prefix);
  return prefix ? `${prefix}-${suffix}` : suffix;
};
