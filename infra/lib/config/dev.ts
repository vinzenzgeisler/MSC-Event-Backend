import { StageConfig } from './types';

export const devConfig: StageConfig = {
  stage: 'dev',
  prefix: 'dreiecksrennen-dev',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1'
  },
  maxAzs: 2,
  enableNatGateway: false,
  enableRds: false,
  enableApi: false,
  enableMigrationRunner: false,
  apiInVpc: true,
  dbConnectivityMode: 'private',
  dbUseIamAuth: false,
  dbRequireTls: true,
  ttlHours: 24,
  dbName: 'eventdb',
  dbUsername: 'eventadmin',
  dbInstanceType: {
    instanceClass: 'BURSTABLE3',
    instanceSize: 'MICRO'
  },
  dbAllocatedStorage: 20,
  dbMaxAllocatedStorage: 20,
  dbBackupRetentionDays: 1,
  dbPublicAccess: false,
  removalPolicy: 'destroy'
};
