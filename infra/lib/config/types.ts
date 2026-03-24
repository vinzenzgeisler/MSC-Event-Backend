export interface StageConfig {
  stage: 'dev' | 'prod';
  prefix: string;
  cognitoCallbackUrls: string[];
  cognitoLogoutUrls: string[];
  cognitoDomainPrefix: string;
  sesFromEmail: string;
  aiBedrockModelId?: string;
  aiInboxImapSecretArn?: string;
  aiInboxImapMailbox?: string;
  aiInboxImapMailboxKey?: string;
  publicVerifyBaseUrl: string;
  assetsCorsAllowedOrigins: string[];
  devCleanupEnabled: boolean;
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
