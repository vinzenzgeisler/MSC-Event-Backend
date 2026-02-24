#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib';
import { resolveDevConfig } from '../lib/config/dev';
import { prodConfig } from '../lib/config/prod';
import { StageConfig } from '../lib/config/types';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { MigrationRunnerStack } from '../lib/stacks/migration-runner-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

const stageContext = (app.node.tryGetContext('stage') as string | undefined) ?? process.env.STAGE ?? 'dev';
const devProfileContext =
  (app.node.tryGetContext('devProfile') as string | undefined) ?? process.env.DEV_PROFILE ?? 'idle';

const config: StageConfig = stageContext === 'prod' ? prodConfig : resolveDevConfig(devProfileContext);
const needsDataStack = config.stage === 'dev' || config.enableRds || config.enableApi || config.enableMigrationRunner;

if (config.enableApi && !config.enableRds) {
  throw new Error('Invalid config: enableApi requires enableRds=true.');
}
if (config.enableMigrationRunner && !config.enableRds) {
  throw new Error('Invalid config: enableMigrationRunner requires enableRds=true.');
}
if (config.enableMigrationRunner && !config.enableNatGateway) {
  throw new Error('Invalid config: enableMigrationRunner requires enableNatGateway=true for outbound internet access.');
}
if (config.dbConnectivityMode === 'public_budget' && !config.dbPublicAccess) {
  throw new Error('Invalid config: dbConnectivityMode=public_budget requires dbPublicAccess=true.');
}
if (config.dbConnectivityMode === 'private' && config.dbPublicAccess) {
  throw new Error('Invalid config: dbConnectivityMode=private requires dbPublicAccess=false.');
}

const authStack = new AuthStack(app, `${config.prefix}-auth-stack`, {
  env: config.env,
  config
});

const dataStack = needsDataStack
  ? new DataStack(app, `${config.prefix}-data-stack`, {
      env: config.env,
      config
    })
  : undefined;

const storageStack = new StorageStack(app, `${config.prefix}-storage-stack`, {
  env: config.env,
  config
});

if (config.stage === 'dev') {
  for (const stack of [authStack, storageStack, ...(needsDataStack ? [dataStack] : [])]) {
    if (!stack) {
      continue;
    }
    Tags.of(stack).add('Project', config.prefix);
    Tags.of(stack).add('Environment', config.stage);
    Tags.of(stack).add('AutoCleanup', 'true');
    if (config.ttlHours !== undefined) {
      Tags.of(stack).add('TTLHours', String(config.ttlHours));
    }
  }
}

if (config.enableApi && dataStack) {
  const apiStack = new ApiStack(app, `${config.prefix}-api-stack`, {
    env: config.env,
    config,
    authStack,
    dataStack,
    storageStack
  });

  apiStack.addDependency(authStack);
  apiStack.addDependency(dataStack);
  apiStack.addDependency(storageStack);

  if (config.stage === 'dev') {
    Tags.of(apiStack).add('Project', config.prefix);
    Tags.of(apiStack).add('Environment', config.stage);
    Tags.of(apiStack).add('AutoCleanup', 'true');
    if (config.ttlHours !== undefined) {
      Tags.of(apiStack).add('TTLHours', String(config.ttlHours));
    }
  }
}

if (config.enableMigrationRunner && dataStack) {
  const migrationRunnerStack = new MigrationRunnerStack(app, `${config.prefix}-migration-runner-stack`, {
    env: config.env,
    config,
    dataStack
  });

  migrationRunnerStack.addDependency(dataStack);

  if (config.stage === 'dev') {
    Tags.of(migrationRunnerStack).add('Project', config.prefix);
    Tags.of(migrationRunnerStack).add('Environment', config.stage);
    Tags.of(migrationRunnerStack).add('AutoCleanup', 'true');
    if (config.ttlHours !== undefined) {
      Tags.of(migrationRunnerStack).add('TTLHours', String(config.ttlHours));
    }
  }
}
