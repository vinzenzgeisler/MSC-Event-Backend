import { StageConfig } from './types';

const requireEnv = (name: string): string => {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const accountSuffix = (process.env.CDK_DEFAULT_ACCOUNT ?? '').trim().slice(-6).toLowerCase();

export const resolveProdConfig = (): StageConfig => {
  const prodPublicBaseUrl = requireEnv('PROD_PUBLIC_BASE_URL').replace(/\/$/, '');
  const prodCognitoDomainPrefix =
    (process.env.PROD_COGNITO_DOMAIN_PREFIX ?? '').trim().toLowerCase() ||
    `dreiecksrennen-prod-auth${accountSuffix ? `-${accountSuffix}` : ''}`;

  return {
    stage: 'prod',
    prefix: 'dreiecksrennen-prod',
    cognitoCallbackUrls: [`${prodPublicBaseUrl}/admin/login`],
    cognitoLogoutUrls: [`${prodPublicBaseUrl}/admin/login`],
    cognitoDomainPrefix: prodCognitoDomainPrefix,
    sesFromEmail: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
    publicVerifyBaseUrl: `${prodPublicBaseUrl}/anmeldung/verify`,
    assetsCorsAllowedOrigins: [prodPublicBaseUrl],
    devCleanupEnabled: false,
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
    dbBackupRetentionDays: 30,
    dbPublicAccess: true,
    removalPolicy: 'retain'
  };
};
