import { getPool } from '../db/client';

// A restore is not proven by RDS status alone. Query only table existence and
// aggregate counts; no addresses, token hashes or registration data enter logs.
const main = async () => {
  const pool = await getPool();
  try {
    const result = await pool.query(`select
      (select count(*)::int from event) as events,
      (select count(*)::int from entry) as entries,
      (select count(*)::int from newsletter_subscriber) as newsletter_subscribers,
      (select count(*)::int from newsletter_consent_event) as newsletter_consent_events`);
    console.log(JSON.stringify(result.rows[0]));
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Restore query failed', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
