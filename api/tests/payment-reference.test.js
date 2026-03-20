const assert = require('node:assert/strict');

const { buildPaymentReference } = require('../dist/domain/paymentReference.js');

{
  const value = buildPaymentReference({
    orgaCode: 'MSC-7K4P9',
    firstName: 'Max',
    lastName: 'Musterfahrer'
  });
  assert.equal(value, 'Nennung MSC-7K4P9 Max Musterfahrer');
}

{
  const value = buildPaymentReference({
    orgaCode: '11OLD-7K4P9',
    firstName: 'Max',
    lastName: 'Musterfahrer'
  });
  assert.equal(value, 'Nennung 11OLD-7K4P9 Max Musterfahrer');
}

console.log('payment-reference.test.js: ok');
