#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { devConfig } from '../lib/config/dev';
import { prodConfig } from '../lib/config/prod';
import { StageConfig } from '../lib/config/types';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { MigrationRunnerStack } from '../lib/stacks/migration-runner-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

const stageContext = (app.node.tryGetContext('stage') as string | undefined) ?? process.env.STAGE ?? 'dev';

const config: StageConfig = stageContext === 'prod' ? prodConfig : devConfig;

const authStack = new AuthStack(app, `${config.prefix}-auth-stack`, {
  env: config.env,
  prefix: config.prefix
});

const dataStack = new DataStack(app, `${config.prefix}-data-stack`, {
  env: config.env,
  config
});

const storageStack = new StorageStack(app, `${config.prefix}-storage-stack`, {
  env: config.env,
  config
});

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

const migrationRunnerStack = new MigrationRunnerStack(app, `${config.prefix}-migration-runner-stack`, {
  env: config.env,
  config,
  dataStack
});

migrationRunnerStack.addDependency(dataStack);
