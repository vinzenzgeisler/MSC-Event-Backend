const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const getDatabaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL is not set');
  }
  return value;
};

const ensureMigrationsTable = async (client) => {
  await client.query(`
    create table if not exists schema_migrations (
      file_name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
};

const loadAppliedMigrations = async (client) => {
  const result = await client.query('select file_name from schema_migrations');
  return new Set(result.rows.map((row) => row.file_name));
};

const run = async () => {
  const client = new Client({
    connectionString: getDatabaseUrl()
  });

  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);

    const migrationsDir = path.resolve(__dirname, '..', 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      if (applied.has(fileName)) {
        console.log(`[skip] ${fileName}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
      console.log(`[apply] ${fileName}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (file_name) values ($1)', [fileName]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
