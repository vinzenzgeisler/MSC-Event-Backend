export type PaymentStatus = 'due' | 'paid' | 'not_required';

export const deriveInvoicePaymentStatus = (
  totalCents: number | null | undefined,
  paidAmountCents: number | null | undefined,
  hasAcceptedEntries = true
): PaymentStatus => {
  if (totalCents === null || totalCents === undefined) {
    return 'due';
  }
  const effectiveTotalCents = Math.max(0, totalCents ?? 0);
  const effectivePaidAmountCents = Math.max(0, paidAmountCents ?? 0);

  if (effectiveTotalCents === 0) {
    return hasAcceptedEntries && effectivePaidAmountCents === 0 ? 'not_required' : 'due';
  }

  return effectivePaidAmountCents >= effectiveTotalCents ? 'paid' : 'due';
};

export const deriveEntryPaymentStatus = (
  entryTotalCents: number | null | undefined,
  acceptanceStatus: string | null | undefined,
  invoicePaymentStatus: string | null | undefined
): PaymentStatus | null => {
  if (acceptanceStatus === 'rejected' || acceptanceStatus === 'withdrawn') {
    return null;
  }
  if (entryTotalCents === null || entryTotalCents === undefined) {
    return 'due';
  }
  if (Math.max(0, entryTotalCents ?? 0) === 0) {
    return 'not_required';
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
  if (input.acceptanceStatus === 'rejected' || input.acceptanceStatus === 'withdrawn') {
    return null;
  }
  return input.focusedForecastTotalCents ?? input.manualOverrideCents ?? input.provisionalTotalCents;
};
