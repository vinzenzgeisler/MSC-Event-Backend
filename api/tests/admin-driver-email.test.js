const assert = require('node:assert/strict');

const dbClient = require('../dist/db/client');
const audit = require('../dist/audit/log');
const schema = require('../dist/db/schema');
const {
  patchEntryDriverEmail,
  validateDriverEmailPatchInput
} = require('../dist/routes/adminEntries');

const originalGetDb = dbClient.getDb;
const originalWriteAuditLog = audit.writeAuditLog;

const makeThenable = (value) => ({
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject)
});

const createDb = (selectResults) => {
  const updates = [];
  const deletes = [];
  let selectIndex = 0;

  const tx = {
    select() {
      const result = selectResults[selectIndex++] ?? [];
      const builder = {
        from() { return builder; },
        where() { return builder; },
        limit() { return makeThenable(result); },
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      };
      return builder;
    },
    update(table) {
      const operation = { table, values: undefined };
      updates.push(operation);
      const builder = {
        set(values) {
          operation.values = values;
          return builder;
        },
        where() { return makeThenable(undefined); }
      };
      return builder;
    },
    delete(table) {
      deletes.push(table);
      return { where: () => makeThenable(undefined) };
    }
  };

  return {
    transaction: (run) => run(tx),
    updates,
    deletes
  };
};

const entryRow = {
  id: 'entry-1',
  eventId: 'event-1',
  registrationGroupId: 'group-1'
};
const groupRow = { id: 'group-1', driverPersonId: 'person-current' };

const runWithDb = async (db, run) => {
  const auditCalls = [];
  dbClient.getDb = async () => db;
  audit.writeAuditLog = async (_tx, input) => auditCalls.push(input);
  try {
    return await run(auditCalls);
  } finally {
    dbClient.getDb = originalGetDb;
    audit.writeAuditLog = originalWriteAuditLog;
  }
};

void (async () => {
  assert.deepEqual(validateDriverEmailPatchInput({ email: 'NEW@Example.ORG' }), {
    email: 'new@example.org'
  });

  // Successful update when the requested address is unused.
  const unusedDb = createDb([
    [entryRow],
    [groupRow],
    [{ email: 'old@example.org' }],
    []
  ]);
  await runWithDb(unusedDb, async (auditCalls) => {
    const result = await patchEntryDriverEmail('entry-1', 'new@example.org', 'admin-1');
    assert.deepEqual(result, {
      entryId: 'entry-1',
      personId: 'person-current',
      oldEmail: 'old@example.org',
      newEmail: 'new@example.org'
    });
    assert.equal(unusedDb.updates.length, 2);
    assert.equal(unusedDb.updates[0].table, schema.person);
    assert.equal(unusedDb.updates[0].values.email, 'new@example.org');
    assert.equal(unusedDb.updates[1].table, schema.registrationGroup);
    assert.equal(unusedDb.updates[1].values.driverEmailNorm, 'new@example.org');
    assert.deepEqual(unusedDb.deletes, [schema.registrationGroupEmailVerification]);
    assert.equal(auditCalls[0].action, 'driver_email_updated');
    assert.deepEqual(auditCalls[0].payload, {
      oldEmail: 'old@example.org',
      newEmail: 'new@example.org'
    });
  });

  // Successful update clears the email on an orphaned blocking person first.
  const orphanDb = createDb([
    [entryRow],
    [groupRow],
    [{ email: 'old@example.org' }],
    [{ id: 'person-orphan' }],
    []
  ]);
  await runWithDb(orphanDb, async () => {
    const result = await patchEntryDriverEmail('entry-1', 'reused@example.org', 'admin-1');
    assert.equal(result.newEmail, 'reused@example.org');
    assert.equal(orphanDb.updates.length, 3);
    assert.equal(orphanDb.updates[0].table, schema.person);
    assert.equal(orphanDb.updates[0].values.email, null);
    assert.equal(orphanDb.updates[1].values.email, 'reused@example.org');
  });

  // An address belonging to a person with an active entry maps to EMAIL_IN_USE (HTTP 409).
  const activeDb = createDb([
    [entryRow],
    [groupRow],
    [{ email: 'old@example.org' }],
    [{ id: 'person-active' }],
    [{ id: 'other-entry' }]
  ]);
  await runWithDb(activeDb, async () => {
    await assert.rejects(
      () => patchEntryDriverEmail('entry-1', 'used@example.org', 'admin-1'),
      (error) => error instanceof Error && error.message === 'EMAIL_IN_USE'
    );
    assert.equal(activeDb.updates.length, 0);
  });

  // Missing and soft-deleted entries are excluded by the active-entry query and map to HTTP 404.
  for (const label of ['missing', 'soft-deleted']) {
    const notFoundDb = createDb([[]]);
    await runWithDb(notFoundDb, async () => {
      assert.equal(
        await patchEntryDriverEmail(`${label}-entry`, 'new@example.org', 'admin-1'),
        null
      );
      assert.equal(notFoundDb.updates.length, 0);
    });
  }

  console.log('admin-driver-email.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
