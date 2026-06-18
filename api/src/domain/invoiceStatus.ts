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

export const deriveEntryPaymentStatus = (
  entryTotalCents: number | null | undefined,
  acceptanceStatus: string | null | undefined,
  invoicePaymentStatus: string | null | undefined
): 'due' | 'paid' => {
  if (Math.max(0, entryTotalCents ?? 0) === 0) {
    return 'paid';
  }
  if (acceptanceStatus !== 'accepted') {
    return 'due';
  }
  return invoicePaymentStatus === 'paid' ? 'paid' : 'due';
};
