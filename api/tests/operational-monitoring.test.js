const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseNotificationRecipients } = require('../dist/observability/recipients');
const { statusFor } = require('../dist/jobs/sesFeedbackWorker');

assert.deepEqual(
  parseNotificationRecipients(' Orga@Example.test,orga@example.test; second@example.test  '),
  ['orga@example.test', 'second@example.test']
);
assert.deepEqual(parseNotificationRecipients(''), []);
assert.equal(statusFor('Delivery'), 'sent');
assert.equal(statusFor('Bounce'), 'bounced');
assert.equal(statusFor('Complaint'), 'complaint');
assert.equal(statusFor('Reject'), 'failed');
assert.equal(statusFor('Rendering Failure'), 'failed');
assert.equal(statusFor('DeliveryDelay'), null);

const repositoryRoot = path.resolve(__dirname, '..', '..');
const dashboardSource = fs.readFileSync(path.join(repositoryRoot, 'api/src/routes/adminDashboard.ts'), 'utf8');
assert.match(dashboardSource, /const shouldRefresh = explicitRefresh;/);
assert.doesNotMatch(dashboardSource, /const shouldRefresh = true;/);

const registrationSource = fs.readFileSync(path.join(repositoryRoot, 'api/src/routes/publicRegistration.ts'), 'utf8');
assert.doesNotMatch(registrationSource, /geisler10@gmx\.net/i);
assert.match(registrationSource, /templateId: 'orga_registration_received'/);

const inspectionSource = fs.readFileSync(path.join(repositoryRoot, 'api/src/routes/technicalInspection.ts'), 'utf8');
assert.match(inspectionSource, /templateId: 'technical_inspection_decision'/);
assert.match(inspectionSource, /queueOperationalMails\(tx,/);

console.log('operational monitoring tests passed');
