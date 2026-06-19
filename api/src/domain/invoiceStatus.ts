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
  if (entryTotalCents === null || entryTotalCents === undefined) {
    return 'due';
  }
  if (Math.max(0, entryTotalCents ?? 0) === 0) {
    return 'paid';
  }
  if (acceptanceStatus !== 'accepted') {
    return 'due';
  }
  return invoicePaymentStatus === 'paid' ? 'paid' : 'due';
};

export const resolveEntryTotalCents = (input: {
  acceptanceStatus: string | null | undefined;
  focusedBillableTotalCents: number | null;
  focusedForecastTotalCents: number | null;
  manualOverrideCents: number | null;
  acceptedDriverEntryCount: number;
  invoiceTotalCents: number | null;
  provisionalTotalCents: number | null;
}): number | null => {
  if (input.acceptanceStatus === 'accepted') {
    return (
      input.focusedBillableTotalCents ??
      input.focusedForecastTotalCents ??
      input.manualOverrideCents ??
      (input.acceptedDriverEntryCount === 1 ? input.invoiceTotalCents : null) ??
      input.provisionalTotalCents ??
      input.invoiceTotalCents
    );
  }
  if (input.acceptanceStatus === 'rejected') {
    return 0;
  }
  return input.focusedForecastTotalCents ?? input.manualOverrideCents ?? input.provisionalTotalCents;
};
