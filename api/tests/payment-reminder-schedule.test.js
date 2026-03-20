const assert = require('node:assert/strict');

const { isDueForPaymentReminder } = require('../dist/jobs/emailWorker.js');

const now = new Date('2026-03-18T12:00:00.000Z');

{
  const due = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-1',
      accepted_mail_at: '2026-02-10T10:00:00.000Z',
      payment_due_date: '2026-02-15',
      last_reminder_at: null
    },
    30,
    14,
    now
  );
  assert.equal(due, true);
}

{
  const notDueYet = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-2',
      accepted_mail_at: '2026-03-01T10:00:00.000Z',
      payment_due_date: '2026-03-10',
      last_reminder_at: null
    },
    30,
    14,
    now
  );
  assert.equal(notDueYet, false);
}

{
  const followupDue = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-3',
      accepted_mail_at: '2026-01-10T10:00:00.000Z',
      payment_due_date: '2026-01-15',
      last_reminder_at: '2026-03-01T09:00:00.000Z'
    },
    30,
    14,
    now
  );
  assert.equal(followupDue, true);
}

{
  const followupNotDue = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-4',
      accepted_mail_at: '2026-01-10T10:00:00.000Z',
      payment_due_date: '2026-01-15',
      last_reminder_at: '2026-03-10T09:00:00.000Z'
    },
    30,
    14,
    now
  );
  assert.equal(followupNotDue, false);
}

console.log('payment-reminder-schedule.test.js: ok');
