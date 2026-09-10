'use strict';
const assert = require('node:assert/strict');

const { formatAlarmNotification } = require('../dist/jobs/criticalAlertEmail');

const alarm = formatAlarmNotification({
  AlarmName: 'dreiecksrennen-prod-critical-workflows',
  NewStateValue: 'ALARM',
  NewStateReason: 'ALARM("dreiecksrennen-prod-signing-mail-queue-failed")',
  StateChangeTime: '2026-09-10T13:12:20.000Z'
}, 'prod');

assert.match(alarm.subject, /STÖRUNG.*Haftverzicht/);
assert.match(alarm.text, /keinen Mailauftrag/);
assert.match(alarm.text, /Mail erneut senden/);
assert.match(alarm.html, /Alarm in AWS öffnen/);

const recovery = formatAlarmNotification({
  AlarmName: 'dreiecksrennen-prod-critical-mail',
  NewStateValue: 'OK',
  NewStateReason: 'Composite alarm returned to OK'
}, 'prod');

assert.match(recovery.subject, /ENTWARNUNG/);
assert.match(recovery.text, /keine unmittelbare Aktion erforderlich/);

console.log('critical alert email tests passed');
