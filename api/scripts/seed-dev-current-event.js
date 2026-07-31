const fs = require('node:fs');
const https = require('node:https');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const defaultCaPath = '/tmp/rds-global-bundle.pem';
const defaultCaUrl = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

const parseDate = (date) => date.toISOString().slice(0, 10);

const devDrivers = [
  { firstName: 'Anna', lastName: 'Testfahrer', birthdate: '1992-04-12', vehicleType: 'moto', make: 'MZ', model: 'ETZ 250', year: 1988, registrationStatus: 'submitted_verified', acceptanceStatus: 'pending', mailVerified: true },
  { firstName: 'Bernd', lastName: 'Doppelnennung', birthdate: '1984-09-03', vehicleType: 'auto', make: 'Trabant', model: '601', year: 1987, codriver: true, registrationStatus: 'submitted_verified', acceptanceStatus: 'accepted', mailVerified: true, extraEntries: [{ vehicleType: 'moto', make: 'MZ', model: 'TS 150', year: 1979 }] },
  { firstName: 'Carla', lastName: 'Jugendstart', birthdate: '2011-06-21', vehicleType: 'moto', make: 'Simson', model: 'S51', year: 1985, registrationStatus: 'submitted_verified', acceptanceStatus: 'accepted', mailVerified: true, guardian: true },
  { firstName: 'Dieter', lastName: 'Seniorlauf', birthdate: '1948-01-17', vehicleType: 'auto', make: 'Wartburg', model: '353', year: 1978, codriver: true, registrationStatus: 'submitted_verified', acceptanceStatus: 'accepted', mailVerified: true },
  { firstName: 'Eva', lastName: 'Rallyetest', birthdate: '1997-11-30', vehicleType: 'auto', make: 'Skoda', model: 'Favorit', year: 1991, registrationStatus: 'submitted_unverified', acceptanceStatus: 'pending', mailVerified: false },
  { firstName: 'Frank', lastName: 'Gelaende', birthdate: '1976-03-05', vehicleType: 'moto', make: 'Jawa', model: '350', year: 1974, registrationStatus: 'submitted_verified', acceptanceStatus: 'shortlist', mailVerified: true },
  { firstName: 'Gina', lastName: 'Startklar', birthdate: '2001-08-19', vehicleType: 'auto', make: 'Lada', model: '2105', year: 1984, codriver: true, registrationStatus: 'submitted_verified', acceptanceStatus: 'accepted', mailVerified: true },
  { firstName: 'Henry', lastName: 'Boxenstop', birthdate: '1968-12-24', vehicleType: 'moto', make: 'Honda', model: 'XL 250', year: 1982, registrationStatus: 'submitted_verified', acceptanceStatus: 'rejected', mailVerified: true },
  { firstName: 'Iris', lastName: 'Mehrfachstart', birthdate: '1990-02-14', vehicleType: 'auto', make: 'VW', model: 'Golf II', year: 1989, registrationStatus: 'submitted_verified', acceptanceStatus: 'pending', mailVerified: true, extraEntries: [{ vehicleType: 'auto', make: 'BMW', model: '318is', year: 1990, codriver: true }] },
  { firstName: 'Jonas', lastName: 'Nachwuchs', birthdate: '2010-10-09', vehicleType: 'moto', make: 'KTM', model: 'SX 85', year: 2019, registrationStatus: 'submitted_verified', acceptanceStatus: 'pending', mailVerified: true, guardian: true }
];

const parseSecretJson = (raw) => {
  if (!raw) {
    throw new Error('SecretString is empty.');
  }
  const secret = JSON.parse(raw);
  return {
    host: secret.host,
    port: Number(secret.port ?? 5432),
    username: secret.username,
    password: secret.password,
    database: secret.dbname ?? secret.database
  };
};

const getStageEnv = (name, stage) => process.env[`${name}_${stage.toUpperCase()}`] ?? process.env[name];

const downloadFile = async (url, destination) =>
  new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destination, () => undefined);
          reject(new Error(`Failed to download CA bundle: HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (error) => {
        file.close();
        fs.unlink(destination, () => undefined);
        reject(error);
      });
  });

const resolveSslConfig = async () => {
  if (process.env.DB_SSL === 'false') {
    return undefined;
  }

  const explicitPath = process.env.DB_SSL_CA_PATH;
  const caPath = explicitPath && explicitPath.trim().length > 0 ? explicitPath : defaultCaPath;

  if (!fs.existsSync(caPath)) {
    const caUrl = process.env.DB_SSL_CA_BUNDLE_URL ?? defaultCaUrl;
    await downloadFile(caUrl, caPath);
  }

  return {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    ca: fs.readFileSync(caPath, 'utf8')
  };
};

const resolveConnection = async () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: await resolveSslConfig()
    };
  }

  const stage = process.env.STAGE ?? 'dev';
  const secretArn =
    getStageEnv('SEED_DB_SECRET_ARN', stage) ??
    process.env.DB_SECRET_ARN ??
    process.env.SEED_DB_SECRET_ARN ??
    process.env.DB_SECRET_ARN_DEV;

  if (!secretArn) {
    throw new Error(
      'DATABASE_URL or SEED_DB_SECRET_ARN/DB_SECRET_ARN is required. Example: SEED_DB_SECRET_ARN_DEV=arn:aws:secretsmanager:...'
    );
  }

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1';
  const client = new SecretsManagerClient({ region });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const secret = parseSecretJson(response.SecretString);
  const user = encodeURIComponent(secret.username);
  const pass = encodeURIComponent(secret.password);
  const db = encodeURIComponent(secret.database);
  const connectionString = `postgresql://${user}:${pass}@${secret.host}:${secret.port}/${db}`;

  return {
    connectionString,
    ssl: await resolveSslConfig()
  };
};

const findOrCreatePerson = async (client, input) => {
  const email = input.email.toLowerCase();
  const existing = await client.query(`select "id" from "person" where lower("email") = $1 limit 1`, [email]);
  if (existing.rows[0]?.id) {
    await client.query(
      `update "person"
       set "first_name" = $2,
           "last_name" = $3,
           "birthdate" = $4,
           "nationality" = 'DE',
           "country" = 'DE',
           "street" = 'Teststrasse 1',
           "zip" = '02763',
           "city" = 'Zittau',
           "phone" = '+491700000000',
           "updated_at" = now()
       where "id" = $1`,
      [existing.rows[0].id, input.firstName, input.lastName, input.birthdate]
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `insert into "person" (
       "email",
       "first_name",
       "last_name",
       "birthdate",
       "nationality",
       "country",
       "street",
       "zip",
       "city",
       "phone",
       "emergency_contact_name",
       "emergency_contact_phone",
       "created_at",
       "updated_at"
     ) values ($1, $2, $3, $4, 'DE', 'DE', 'Teststrasse 1', '02763', 'Zittau', '+491700000000', 'Dev Kontakt', '+491700000001', now(), now())
     returning "id"`,
    [email, input.firstName, input.lastName, input.birthdate]
  );
  return inserted.rows[0].id;
};

const findOrCreateRegistrationGroup = async (client, eventId, driverPersonId, email) => {
  const emailNorm = email.toLowerCase();
  const existing = await client.query(
    `select "id"
     from "registration_group"
     where "event_id" = $1 and "driver_email_norm" = $2 and "deleted_at" is null
     limit 1`,
    [eventId, emailNorm]
  );
  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `insert into "registration_group" ("event_id", "driver_person_id", "driver_email_norm", "created_at", "updated_at")
     values ($1, $2, $3, now(), now())
     returning "id"`,
    [eventId, driverPersonId, emailNorm]
  );
  return inserted.rows[0].id;
};

const seedDevEntries = async (client, eventId) => {
  const classRows = await client.query(
    `select "id", "vehicle_type"
     from "class"
     where "event_id" = $1 and "name" in ('Moto Open', 'Auto Open')`,
    [eventId]
  );
  const classByVehicleType = new Map(classRows.rows.map((row) => [row.vehicle_type, row.id]));

  for (const [index, driver] of devDrivers.entries()) {
    const number = String(index + 1).padStart(2, '0');
    const email = `dev-signing-driver-${number}@example.test`;
    const driverId = await findOrCreatePerson(client, {
      email,
      firstName: driver.firstName,
      lastName: driver.lastName,
      birthdate: driver.birthdate
    });
    const registrationGroupId = await findOrCreateRegistrationGroup(client, eventId, driverId, email);

    const seedEntries = [
      { suffix: 'A', vehicleType: driver.vehicleType, make: driver.make, model: driver.model, year: driver.year, codriver: driver.codriver },
      ...(driver.extraEntries ?? []).map((entry, extraIndex) => ({ suffix: String.fromCharCode(66 + extraIndex), ...entry }))
    ];
    let codriverId = null;
    if (seedEntries.some((entry) => entry.codriver)) {
      codriverId = await findOrCreatePerson(client, {
        email: `dev-signing-codriver-${number}@example.test`,
        firstName: `Co${number}`,
        lastName: 'Testbeifahrer',
        birthdate: '1991-05-15'
      });
    }

    for (const [entryIndex, seedEntry] of seedEntries.entries()) {
      const isPrimary = entryIndex === 0;
      const orgaCode = isPrimary ? `DEV-SIGN-${number}` : `DEV-SIGN-${number}-${seedEntry.suffix}`;
      const startNumber = isPrimary ? `T${number}` : `T${number}${seedEntry.suffix}`;
      const entryClassId = classByVehicleType.get(seedEntry.vehicleType);
      if (!entryClassId) {
        throw new Error(`Missing class for vehicle type ${seedEntry.vehicleType}.`);
      }
      const vehicle = await client.query(
        `insert into "vehicle" (
           "owner_person_id",
           "vehicle_type",
           "make",
           "model",
           "year",
           "description",
           "owner_name",
           "start_number_raw",
           "created_at",
           "updated_at"
         ) values ($1, $2, $3, $4, $5, 'Dev-Testfahrzeug fuer Signing-Prototyp', $6, $7, now(), now())
         returning "id"`,
        [
          driverId,
          seedEntry.vehicleType,
          seedEntry.make,
          seedEntry.model,
          seedEntry.year,
          `${driver.firstName} ${driver.lastName}`,
          startNumber
        ]
      );

      const existingEntry = await client.query(
        `select "id" from "entry" where "event_id" = $1 and "orga_code" = $2 and "deleted_at" is null limit 1`,
        [eventId, orgaCode]
      );

      const confirmationMailSentAt = driver.mailVerified || driver.registrationStatus === 'submitted_unverified' ? 'now()' : 'null';
      const confirmationMailVerifiedAt = driver.mailVerified ? 'now()' : 'null';
      const targetCodriverId = seedEntry.codriver ? codriverId : null;

      if (existingEntry.rows[0]?.id) {
        await client.query(
          `update "entry"
           set "class_id" = $2,
               "driver_person_id" = $3,
               "registration_group_id" = $4,
               "codriver_person_id" = $5,
               "vehicle_id" = $6,
               "start_number_norm" = $7,
               "driver_email_norm" = $8,
               "registration_status" = $9,
               "acceptance_status" = $10,
               "tech_status" = 'pending',
               "confirmation_mail_sent_at" = ${confirmationMailSentAt},
               "confirmation_mail_verified_at" = ${confirmationMailVerifiedAt},
               "consent_terms_accepted" = true,
               "consent_privacy_accepted" = true,
               "consent_media_accepted" = false,
               "consent_version" = 'dev-seed-2026-05',
               "consent_captured_at" = now(),
               "updated_at" = now()
           where "id" = $1`,
          [
            existingEntry.rows[0].id,
            entryClassId,
            driverId,
            registrationGroupId,
            targetCodriverId,
            vehicle.rows[0].id,
            startNumber,
            email,
            driver.registrationStatus,
            driver.acceptanceStatus
          ]
        );
      } else {
        await client.query(
          `insert into "entry" (
             "event_id",
             "class_id",
             "driver_person_id",
             "registration_group_id",
             "codriver_person_id",
             "vehicle_id",
             "start_number_norm",
             "driver_email_norm",
             "registration_status",
             "acceptance_status",
             "tech_status",
             "confirmation_mail_sent_at",
             "confirmation_mail_verified_at",
             "consent_terms_accepted",
             "consent_privacy_accepted",
             "consent_media_accepted",
             "consent_version",
             "consent_captured_at",
             "entry_fee_cents",
             "orga_code",
             "created_at",
             "updated_at"
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', ${confirmationMailSentAt}, ${confirmationMailVerifiedAt}, true, true, false, 'dev-seed-2026-05', now(), 0, $11, now(), now())`,
          [eventId, entryClassId, driverId, registrationGroupId, targetCodriverId, vehicle.rows[0].id, startNumber, email, driver.registrationStatus, driver.acceptanceStatus, orgaCode]
        );
      }

      const entryId = existingEntry.rows[0]?.id ?? (await client.query(`select "id" from "entry" where "event_id" = $1 and "orga_code" = $2 limit 1`, [eventId, orgaCode])).rows[0].id;
      await client.query(`delete from "consent_evidence" where "entry_id" = $1 and "consent_source" = 'admin_ui'`, [entryId]);
      await client.query(
        `insert into "consent_evidence" (
           "entry_id",
           "consent_version",
           "consent_text_hash",
           "locale",
           "consent_source",
           "terms_accepted",
           "privacy_accepted",
           "waiver_accepted",
           "media_accepted",
           "club_info_accepted",
           "guardian_full_name",
           "guardian_email",
           "guardian_phone",
           "guardian_consent_accepted",
           "captured_at",
           "created_at"
         ) values ($1, 'dev-seed-2026-05', 'dev-seed-consent-hash', 'de-DE', 'admin_ui', true, true, true, false, false, $2, $3, $4, $5, now(), now())`,
        [
          entryId,
          driver.guardian ? `Elternteil ${driver.lastName}` : null,
          driver.guardian ? `guardian-${number}@example.test` : null,
          driver.guardian ? '+491700000099' : null,
          Boolean(driver.guardian)
        ]
      );
    }
  }
};

const seedCurrentEvent = async () => {
  const { connectionString, ssl } = await resolveConnection();
  const client = new Client({
    connectionString,
    ssl
  });

  await client.connect();
  try {
    await client.query('begin');

    const now = new Date();
    const startsAt = new Date(now);
    startsAt.setDate(startsAt.getDate() - 1);
    const endsAt = new Date(now);
    endsAt.setDate(endsAt.getDate() + 7);
    const registrationOpenAt = new Date(now);
    registrationOpenAt.setDate(registrationOpenAt.getDate() - 2);
    const registrationCloseAt = new Date(now);
    registrationCloseAt.setDate(registrationCloseAt.getDate() + 14);

    const currentEventRow = await client.query(
      `select id
       from "event"
       where "is_current" = true
       limit 1`
    );

    let eventId = currentEventRow.rows[0]?.id ?? null;
    if (!eventId) {
      const inserted = await client.query(
        `insert into "event" (
          "name",
          "starts_at",
          "ends_at",
          "status",
          "is_current",
          "registration_open_at",
          "registration_close_at",
          "opened_at",
          "created_at",
          "updated_at"
        ) values ($1, $2, $3, 'open', true, $4, $5, now(), now(), now())
        returning "id"`,
        [
          `Dev Event ${parseDate(now)}`,
          parseDate(startsAt),
          parseDate(endsAt),
          registrationOpenAt.toISOString(),
          registrationCloseAt.toISOString()
        ]
      );
      eventId = inserted.rows[0]?.id ?? null;
    } else {
      await client.query(
        `update "event"
         set "status" = 'open',
             "registration_open_at" = coalesce("registration_open_at", $2),
             "registration_close_at" = coalesce("registration_close_at", $3),
             "opened_at" = coalesce("opened_at", now()),
             "updated_at" = now()
         where "id" = $1`,
        [eventId, registrationOpenAt.toISOString(), registrationCloseAt.toISOString()]
      );
    }

    if (!eventId) {
      throw new Error('Failed to create or resolve current event.');
    }

    await client.query(
      `update "event"
       set "is_current" = case when "id" = $1 then true else false end,
           "updated_at" = now()
       where "is_current" = true or "id" = $1`,
      [eventId]
    );

    await client.query(
      `insert into "class" ("event_id", "name", "vehicle_type")
       values ($1, 'Moto Open', 'moto')
       on conflict ("event_id", "name") do nothing`,
      [eventId]
    );

    await client.query(
      `insert into "class" ("event_id", "name", "vehicle_type")
       values ($1, 'Auto Open', 'auto')
       on conflict ("event_id", "name") do nothing`,
      [eventId]
    );

    await client.query(
      `update "class"
       set "allows_codriver" = true,
           "updated_at" = now()
       where "event_id" = $1 and "name" = 'Auto Open'`,
      [eventId]
    );

    await seedDevEntries(client, eventId);

    await client.query('commit');
    console.log(`Current event ready: ${eventId}`);
    console.log(`Dev signing entries ready: ${devDrivers.length}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
};

seedCurrentEvent().catch((error) => {
  console.error(error);
  process.exit(1);
});
