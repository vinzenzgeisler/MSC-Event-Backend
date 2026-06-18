const assert = require('node:assert/strict');

const { deriveEntryPaymentStatus, deriveInvoicePaymentStatus } = require('../dist/domain/invoiceStatus.js');

assert.equal(deriveInvoicePaymentStatus(15000, 0), 'due');
assert.equal(deriveInvoicePaymentStatus(15000, 14999), 'due');
assert.equal(deriveInvoicePaymentStatus(15000, 15000), 'paid');
assert.equal(deriveInvoicePaymentStatus(15000, 20000), 'paid');

assert.equal(deriveInvoicePaymentStatus(0, 0), 'due');
assert.equal(deriveInvoicePaymentStatus(0, 15000), 'due');
assert.equal(deriveInvoicePaymentStatus(null, 0), 'due');

assert.equal(deriveEntryPaymentStatus(0, 'pending', 'due'), 'paid');
assert.equal(deriveEntryPaymentStatus(0, 'accepted', 'due'), 'paid');
assert.equal(deriveEntryPaymentStatus(7000, 'pending', 'paid'), 'due');
assert.equal(deriveEntryPaymentStatus(7000, 'accepted', 'due'), 'due');
assert.equal(deriveEntryPaymentStatus(7000, 'accepted', 'paid'), 'paid');

console.log('invoice-status.test.js: ok');
