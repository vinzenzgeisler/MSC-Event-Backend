type BuildPaymentReferenceInput = {
  prefix?: string | null;
  orgaCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

const normalizeReferencePart = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 40);
};

export const buildPaymentReference = (input: BuildPaymentReferenceInput): string => {
  const fullName = [normalizeReferencePart(input.firstName), normalizeReferencePart(input.lastName)]
    .filter((value): value is string => Boolean(value))
    .join(' ');
  const prefix = normalizeReferencePart(input.prefix);
  const orgaCode = normalizeReferencePart(input.orgaCode);
  const prefixedOrgaCode = prefix && orgaCode ? `${prefix}-${orgaCode}` : orgaCode;

  return ['Nennung', prefixedOrgaCode, fullName]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' ');
};
