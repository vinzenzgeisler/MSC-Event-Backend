import { StageConfig } from './types';

export const prodConfig: StageConfig = {
  stage: 'prod',
  prefix: 'dreiecksrennen-prod',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1'
  },
  maxAzs: 2,
  enableNatGateway: false,
  enableRds: true,
  enableApi: true,
  enableMigrationRunner: false,
  apiInVpc: false,
  dbConnectivityMode: 'public_budget',
  dbUseIamAuth: true,
  dbRequireTls: true,
  dbName: 'eventdb',
  dbUsername: 'eventadmin',
  dbInstanceType: {
    instanceClass: 'BURSTABLE3',
    instanceSize: 'MICRO'
  },
  dbAllocatedStorage: 20,
  dbMaxAllocatedStorage: 100,
  dbBackupRetentionDays: 7,
  dbPublicAccess: true,
  removalPolicy: 'retain'
};
