type BuildPaymentReferenceInput = {
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

  return ['Nennung', normalizeReferencePart(input.orgaCode), fullName]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' ');
};
