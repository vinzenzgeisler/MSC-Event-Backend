import { StageConfig } from './types';

export type DevProfile = 'idle' | 'test';

const baseDevConfig: Omit<StageConfig, 'enableRds' | 'enableApi' | 'enableMigrationRunner' | 'apiInVpc' | 'dbConnectivityMode' | 'dbUseIamAuth' | 'dbPublicAccess'> = {
  stage: 'dev',
  prefix: 'dreiecksrennen-dev',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1'
  },
  maxAzs: 2,
  enableNatGateway: false,
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
  removalPolicy: 'destroy'
};

const devIdleConfig: StageConfig = {
  ...baseDevConfig,
  enableRds: false,
  enableApi: false,
  enableMigrationRunner: false,
  apiInVpc: true,
  dbConnectivityMode: 'private',
  dbUseIamAuth: false,
  dbPublicAccess: false
};

const devTestConfig: StageConfig = {
  ...baseDevConfig,
  enableRds: true,
  enableApi: true,
  enableMigrationRunner: false,
  apiInVpc: false,
  dbConnectivityMode: 'public_budget',
  dbUseIamAuth: false,
  dbPublicAccess: true
};

export const resolveDevConfig = (profile?: string): StageConfig => {
  const normalized = (profile ?? 'idle').toLowerCase() as DevProfile;
  if (normalized === 'test') {
    return devTestConfig;
  }
  return devIdleConfig;
};
