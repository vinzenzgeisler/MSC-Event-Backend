export interface StageConfig {
  stage: 'dev' | 'prod';
  prefix: string;
  env?: {
    account?: string;
    region?: string;
  };
  maxAzs: number;
  enableNatGateway: boolean;
  enableRds: boolean;
  enableApi: boolean;
  enableMigrationRunner: boolean;
  apiInVpc: boolean;
  dbConnectivityMode: 'private' | 'public_budget';
  dbUseIamAuth: boolean;
  dbRequireTls: boolean;
  ttlHours?: number;
  dbName: string;
  dbUsername: string;
  dbInstanceType: {
    instanceClass: string;
    instanceSize: string;
  };
  dbAllocatedStorage: number;
  dbMaxAllocatedStorage: number;
  dbBackupRetentionDays: number;
  dbPublicAccess: boolean;
  removalPolicy: 'destroy' | 'retain';
}
