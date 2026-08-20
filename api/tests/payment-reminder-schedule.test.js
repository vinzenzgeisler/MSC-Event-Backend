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

{
  const disabledWithoutConfiguredDeadline = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-5',
      accepted_mail_at: '2026-01-10T10:00:00.000Z',
      payment_due_date: null,
      last_reminder_at: null
    },
    30,
    14,
    now
  );
  assert.equal(disabledWithoutConfiguredDeadline, false);
}

{
  const acceptanceAfterDeadlineDefinesFirstReminderBase = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-6',
      accepted_mail_at: '2026-03-01T10:00:00.000Z',
      payment_due_date: '2026-01-15T00:00:00.000Z',
      last_reminder_at: null
    },
    30,
    14,
    now
  );
  assert.equal(acceptanceAfterDeadlineDefinesFirstReminderBase, false);
}

{
  // Bug fix: payment due in future must not block the first reminder
  const futureDueButAccepted36DaysAgo = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-7',
      accepted_mail_at: '2026-07-15T10:00:00.000Z',
      payment_due_date: '2026-08-31T21:59:00.000Z',
      last_reminder_at: null
    },
    30,
    14,
    new Date('2026-08-20T10:00:00.000Z')
  );
  assert.equal(futureDueButAccepted36DaysAgo, true, 'entry accepted 36 days ago with future due date should be due for first reminder');
}

{
  // Not yet due: accepted 10 days ago, firstReminderDelayDays=30
  const acceptedRecentlyFutureDue = isDueForPaymentReminder(
    {
      event_id: 'event-1',
      entry_id: 'entry-8',
      accepted_mail_at: '2026-08-10T10:00:00.000Z',
      payment_due_date: '2026-08-31T21:59:00.000Z',
      last_reminder_at: null
    },
    30,
    14,
    new Date('2026-08-20T10:00:00.000Z')
  );
  assert.equal(acceptedRecentlyFutureDue, false, 'entry accepted only 10 days ago should not trigger yet with firstDelay=30');
}

console.log('payment-reminder-schedule.test.js: ok');
