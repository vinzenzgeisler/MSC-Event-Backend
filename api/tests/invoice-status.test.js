const assert = require('node:assert/strict');

const {
  deriveEntryPaymentStatus,
  deriveInvoicePaymentStatus,
  resolveEntryTotalCents
} = require('../dist/domain/invoiceStatus.js');

assert.equal(deriveInvoicePaymentStatus(15000, 0), 'due');
assert.equal(deriveInvoicePaymentStatus(15000, 14999), 'due');
assert.equal(deriveInvoicePaymentStatus(15000, 15000), 'paid');
assert.equal(deriveInvoicePaymentStatus(15000, 20000), 'paid');

assert.equal(deriveInvoicePaymentStatus(0, 0), 'due');
assert.equal(deriveInvoicePaymentStatus(0, 15000), 'due');
assert.equal(deriveInvoicePaymentStatus(null, 0), 'due');

assert.equal(deriveEntryPaymentStatus(0, 'pending', 'due'), 'paid');
assert.equal(deriveEntryPaymentStatus(0, 'accepted', 'due'), 'paid');
assert.equal(deriveEntryPaymentStatus(null, 'pending', 'due'), 'due');
assert.equal(deriveEntryPaymentStatus(undefined, 'accepted', 'paid'), 'due');
assert.equal(deriveEntryPaymentStatus(7000, 'pending', 'paid'), 'due');
assert.equal(deriveEntryPaymentStatus(7000, 'accepted', 'due'), 'due');
assert.equal(deriveEntryPaymentStatus(7000, 'accepted', 'paid'), 'paid');

assert.equal(
  resolveEntryTotalCents({
    acceptanceStatus: 'pending',
    focusedBillableTotalCents: null,
    focusedForecastTotalCents: null,
    manualOverrideCents: null,
    acceptedDriverEntryCount: 0,
    invoiceTotalCents: null,
    provisionalTotalCents: 15000
  }),
  15000
);
assert.equal(
  resolveEntryTotalCents({
    acceptanceStatus: 'pending',
    focusedBillableTotalCents: null,
    focusedForecastTotalCents: null,
    manualOverrideCents: null,
    acceptedDriverEntryCount: 0,
    invoiceTotalCents: null,
    provisionalTotalCents: null
  }),
  null
);
assert.equal(
  resolveEntryTotalCents({
    acceptanceStatus: 'accepted',
    focusedBillableTotalCents: 0,
    focusedForecastTotalCents: 15000,
    manualOverrideCents: null,
    acceptedDriverEntryCount: 1,
    invoiceTotalCents: 15000,
    provisionalTotalCents: 15000
  }),
  0
);

console.log('invoice-status.test.js: ok');
