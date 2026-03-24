export const deriveInvoicePaymentStatus = (
  totalCents: number | null | undefined,
  paidAmountCents: number | null | undefined
): 'due' | 'paid' => {
  const effectiveTotalCents = Math.max(0, totalCents ?? 0);
  const effectivePaidAmountCents = Math.max(0, paidAmountCents ?? 0);

  if (effectiveTotalCents === 0) {
    return 'due';
  }

  return effectivePaidAmountCents >= effectiveTotalCents ? 'paid' : 'due';
};
