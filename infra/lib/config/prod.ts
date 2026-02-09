import { StageConfig } from './types';

export const prodConfig: StageConfig = {
  stage: 'prod',
  prefix: 'dreiecksrennen-prod',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1'
  },
  dbName: 'eventdb',
  dbInstanceType: {
    instanceClass: 'BURSTABLE3',
    instanceSize: 'MICRO'
  },
  removalPolicy: 'retain'
};
