const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const requireEnv = (name) => {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const runCommand = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    }).trim();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const detail = stderr || stdout;
    if (detail) {
      throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
    }
    throw error;
  }
};

const readStackOutputs = (stackName, region) => {
  const raw = runCommand('aws', [
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
    '--region',
    region,
    '--query',
    'Stacks[0].Outputs',
    '--output',
    'json'
  ]);
  const outputs = JSON.parse(raw);
  if (!Array.isArray(outputs)) {
    throw new Error(`No CloudFormation outputs found on stack ${stackName}.`);
  }
  return outputs;
};

const getOutput = (outputs, key) => {
  const match = outputs.find((output) => output.OutputKey === key);
  const value = typeof match?.OutputValue === 'string' ? match.OutputValue.trim() : '';
  if (!value || value === 'None') {
    throw new Error(`CloudFormation output ${key} is missing.`);
  }
  return value;
};

const readSecret = (secretArn, region) => {
  const raw = runCommand('aws', [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    secretArn,
    '--region',
    region,
    '--query',
    'SecretString',
    '--output',
    'text'
  ]);
  const secret = JSON.parse(raw);
  if (!secret || typeof secret !== 'object') {
    throw new Error(`Secret ${secretArn} does not contain a JSON object.`);
  }
  return secret;
};

const getSecretField = (secret, key, fallback) => {
  const value = typeof secret[key] === 'string' ? secret[key].trim() : '';
  if (value) {
    return value;
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  throw new Error(`Database secret field ${key} is missing.`);
};

const getDbStatus = (identifier, region) =>
  runCommand('aws', [
    'rds',
    'describe-db-instances',
    '--db-instance-identifier',
    identifier,
    '--region',
    region,
    '--query',
    'DBInstances[0].DBInstanceStatus',
    '--output',
    'text'
  ]);

const ensureDbAvailable = (identifier, region) => {
  const status = getDbStatus(identifier, region);
  console.log(`DB instance ${identifier} status: ${status}`);

  if (status === 'stopped') {
    console.log(`Starting DB instance ${identifier}...`);
    runCommand('aws', [
      'rds',
      'start-db-instance',
      '--db-instance-identifier',
      identifier,
      '--region',
      region
    ]);
  }

  if (status !== 'available') {
    console.log(`Waiting for DB instance ${identifier} to become available...`);
  }
  execFileSync(
    'aws',
    ['rds', 'wait', 'db-instance-available', '--db-instance-identifier', identifier, '--region', region],
    { stdio: 'inherit' }
  );
};

const downloadFile = (url, destination) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with status ${response.statusCode}.`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (error) => {
        fs.unlink(destination, () => reject(error));
      });
    });

    request.on('error', reject);
  });

const runMigrations = (databaseUrl, caPath) => {
  execFileSync('npm', ['--workspace', 'api', 'run', 'db:migrate'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DB_SSL_CA_PATH: caPath
    }
  });
};

const main = async () => {
  const stackPrefix = requireEnv('STACK_PREFIX');
  const region = requireEnv('AWS_REGION');
  const dataStackName = `${stackPrefix}-data-stack`;

  const outputs = readStackOutputs(dataStackName, region);
  const secretArn = getOutput(outputs, 'DbSecretArn');
  const dbName = getOutput(outputs, 'DbName');
  const dbInstanceIdentifier = getOutput(outputs, 'DbInstanceIdentifier');

  ensureDbAvailable(dbInstanceIdentifier, region);

  const secret = readSecret(secretArn, region);
  const dbUser = encodeURIComponent(getSecretField(secret, 'username'));
  const dbPass = encodeURIComponent(getSecretField(secret, 'password'));
  const dbHost = getSecretField(secret, 'host');
  const dbPort = getSecretField(secret, 'port');
  const resolvedDbName = getSecretField(secret, 'dbname', dbName);

  const caPath = path.join(os.tmpdir(), 'rds-global-bundle.pem');
  console.log(`Downloading RDS CA bundle to ${caPath}...`);
  await downloadFile('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', caPath);

  try {
    const databaseUrl = `postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${resolvedDbName}`;
    runMigrations(databaseUrl, caPath);
  } finally {
    fs.rmSync(caPath, { force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
