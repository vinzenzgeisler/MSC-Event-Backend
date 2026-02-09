import { StageConfig } from './types';

export const devConfig: StageConfig = {
  stage: 'dev',
  prefix: 'dreiecksrennen-dev',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1'
  },
  dbName: 'eventdb',
  dbInstanceType: {
    instanceClass: 'BURSTABLE3',
    instanceSize: 'MICRO'
  },
  removalPolicy: 'destroy'
};
