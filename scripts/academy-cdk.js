#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ACADEMY_ACCOUNT_ID = '274462863375';
const ACADEMY_REGION = 'us-east-1';
const PRIVATE_DEFAULT_REGION = 'eu-central-1';
const TARGETS = new Set(['academy', 'private']);
const ACTIONS = new Set(['deploy', 'diff', 'synth', 'bootstrap']);

const args = process.argv.slice(2);
let target;
let action;

if (args.length === 1 && ACTIONS.has(args[0])) {
  // Backward-compatible: default to academy if only action is provided.
  target = 'academy';
  action = args[0];
} else if (args.length === 2 && TARGETS.has(args[0]) && ACTIONS.has(args[1])) {
  target = args[0];
  action = args[1];
}

if (!target || !action) {
  console.error('Usage: node scripts/academy-cdk.js <academy|private> <deploy|diff|synth|bootstrap>');
  process.exit(1);
}

const infraDir = path.resolve(__dirname, '..', 'infra');
const repoRoot = path.resolve(__dirname, '..');

const loadEnvFromFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

if (target === 'academy') {
  loadEnvFromFile(path.join(repoRoot, '.env.academy.local'));
  loadEnvFromFile(path.join(repoRoot, '.env.local'));
  loadEnvFromFile(path.join(repoRoot, '.env'));
}

if (target === 'academy') {
  const requiredEnv = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const missing = requiredEnv.filter((name) => !process.env[name] || process.env[name].trim().length === 0);
  if (missing.length > 0) {
    console.error(`Missing required AWS env vars for academy target: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const region =
  target === 'academy'
    ? ACADEMY_REGION
    : process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.CDK_DEFAULT_REGION || PRIVATE_DEFAULT_REGION;

process.env.AWS_REGION = region;
process.env.AWS_DEFAULT_REGION = region;
process.env.CDK_DEFAULT_REGION = region;
if (target === 'academy') {
  process.env.CDK_DEFAULT_ACCOUNT = ACADEMY_ACCOUNT_ID;
}

const run = (command, args, cwd) => {
  const printable = [command, ...args].join(' ');
  console.log(`\n> ${printable}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runCaptureJson = (command, args, cwd) => {
  const printable = [command, ...args].join(' ');
  console.log(`\n> ${printable}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    console.error('Failed to parse JSON output.');
    process.exit(1);
  }
};

const shouldForceBootstrap = String(process.env.FORCE_BOOTSTRAP || '').toLowerCase() === 'true';

const isBootstrapPresent = () => {
  const result = spawnSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      'CDKToolkit',
      '--query',
      'Stacks[0].StackStatus',
      '--output',
      'text'
    ],
    {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      shell: process.platform === 'win32'
    }
  );

  if (result.status === 0) {
    const status = (result.stdout || '').trim();
    return status.length > 0 && status !== 'DELETE_COMPLETE';
  }

  const stderr = (result.stderr || '').toLowerCase();
  if (stderr.includes('does not exist') || stderr.includes('validationerror')) {
    return false;
  }

  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
};

const runBootstrapIfNeeded = (bootstrapAccount) => {
  if (shouldForceBootstrap) {
    console.log('\nFORCE_BOOTSTRAP=true -> running bootstrap.');
    run('npx', ['cdk', 'bootstrap', `aws://${bootstrapAccount}/${region}`], infraDir);
    return;
  }

  const present = isBootstrapPresent();
  if (present) {
    console.log('\nCDKToolkit already exists -> skipping bootstrap.');
    return;
  }

  console.log('\nCDKToolkit not found -> running bootstrap.');
  run('npx', ['cdk', 'bootstrap', `aws://${bootstrapAccount}/${region}`], infraDir);
};

if (action === 'deploy' || action === 'bootstrap') {
  const identity = runCaptureJson('aws', ['sts', 'get-caller-identity', '--output', 'json'], process.cwd());
  const detectedAccount = identity.Account;
  if (!detectedAccount || typeof detectedAccount !== 'string') {
    console.error('Unable to detect AWS account from sts get-caller-identity.');
    process.exit(1);
  }
  if (target === 'academy' && detectedAccount !== ACADEMY_ACCOUNT_ID) {
    console.error(`Academy target expects account ${ACADEMY_ACCOUNT_ID}, but got ${detectedAccount}.`);
    process.exit(1);
  }
  process.env.CDK_DEFAULT_ACCOUNT = detectedAccount;
  const bootstrapAccount = target === 'academy' ? ACADEMY_ACCOUNT_ID : detectedAccount;
  runBootstrapIfNeeded(bootstrapAccount);
  if (action === 'deploy') {
    run('npx', ['cdk', 'deploy', '--all'], infraDir);
  }
} else if (action === 'diff') {
  run('npx', ['cdk', 'diff'], infraDir);
} else {
  run('npx', ['cdk', 'synth'], infraDir);
}
