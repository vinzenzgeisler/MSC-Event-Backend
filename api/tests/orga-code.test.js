const assert = require('node:assert/strict');

const { buildOrgaCode } = require('../dist/domain/orgaCode.js');

{
  const value = buildOrgaCode({
    eventId: '00000000-0000-0000-0000-000000000011',
    driverPersonId: '00000000-0000-0000-0000-000000000022',
    prefix: '11OLD'
  });
  assert.match(value, /^11OLD-[0-9A-Z]{5}$/);
}

{
  const value = buildOrgaCode({
    eventId: '00000000-0000-0000-0000-000000000011',
    driverPersonId: '00000000-0000-0000-0000-000000000022'
  });
  assert.match(value, /^[0-9A-Z]{5}$/);
}

console.log('orga-code.test.js: ok');
