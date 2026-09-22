import { StageConfig } from './types';
import { parseNotificationRecipients } from './notification-recipients';

export type DevProfile = 'idle' | 'test';

const accountSuffix = (process.env.CDK_DEFAULT_ACCOUNT ?? '').trim().slice(-6).toLowerCase();
const devCognitoDomainPrefix =
  (process.env.DEV_COGNITO_DOMAIN_PREFIX ?? '').trim().toLowerCase() ||
  `dreiecksrennen-dev-auth${accountSuffix ? `-${accountSuffix}` : ''}`;
const devPublicBaseUrl = (process.env.DEV_PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
const devAdminLoginUrl = devPublicBaseUrl ? `${devPublicBaseUrl}/admin/login` : null;
const devVerifyUrl = devPublicBaseUrl ? `${devPublicBaseUrl}/anmeldung/verify` : 'http://localhost:5173/anmeldung/verify';
const orgaNotificationRecipients = parseNotificationRecipients(process.env.ORGA_NOTIFICATION_RECIPIENTS);

const devRacePicSigningPublicKeyPem = (process.env.DEV_RACEPIC_SIGNING_PUBLIC_KEY_PEM ?? '').trim() || undefined;

const baseDevConfig: Omit<StageConfig, 'enableRds' | 'enableApi' | 'enableMigrationRunner' | 'apiInVpc' | 'dbConnectivityMode' | 'dbUseIamAuth' | 'dbPublicAccess'> = {
  stage: 'dev',
  prefix: 'dreiecksrennen-dev',
  cognitoCallbackUrls: ['http://localhost:5173/admin/login', ...(devAdminLoginUrl ? [devAdminLoginUrl] : [])],
  cognitoLogoutUrls: ['http://localhost:5173/admin/login', ...(devAdminLoginUrl ? [devAdminLoginUrl] : [])],
  cognitoDomainPrefix: devCognitoDomainPrefix,
  sesFromEmail: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
  newsletterFromEmail: 'newsletter@msc-oberlausitz.de',
  newsletterPublicBaseUrl: (process.env.DEV_NEWSLETTER_PUBLIC_BASE_URL ?? 'http://localhost:8080/newsletter').replace(/\/$/, ''),
  orgaNotificationRecipients,
  publicVerifyBaseUrl: devVerifyUrl,
  assetsCorsAllowedOrigins: [...(devPublicBaseUrl ? [devPublicBaseUrl] : []), 'http://localhost:5173', 'http://localhost:4173'],
  devCleanupEnabled: false,
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
  removalPolicy: 'destroy',
  // RacePic bleibt in dev per Default aus (siehe Paket 1 in racepic-progress.md); ueber
  // DEV_ENABLE_RACEPIC=true gezielt fuer den Test-Profil-Deploy einschaltbar.
  enableRacePic: (process.env.DEV_ENABLE_RACEPIC ?? '').trim().toLowerCase() === 'true',
  racepicMediaCorsAllowedOrigins: [...(devPublicBaseUrl ? [devPublicBaseUrl] : []), 'http://localhost:5173', 'http://localhost:4173'],
  // ACHTUNG: `??` faengt nur `undefined`/`null` ab, nicht einen von GitHub Actions gesetzten,
  // aber leeren String - `${{ vars.X }}` liefert bei einer nicht gesetzten Environment-Variable
  // IMMER einen leeren String (siehe Bug-Fund + ausfuehrlicher Kommentar in prod.ts).
  racepicPhotographerRelyingPartyId: (process.env.DEV_RACEPIC_RELYING_PARTY_ID ?? '').trim() || 'localhost',
  racepicSigningPublicKeyPem: devRacePicSigningPublicKeyPem,
  racepicWebsiteBaseUrl: ((process.env.DEV_RACEPIC_WEBSITE_BASE_URL ?? '').trim() || 'http://localhost:8080').replace(/\/$/, ''),
  racepicMonthlyBudgetUsd: Number((process.env.DEV_RACEPIC_MONTHLY_BUDGET_USD ?? '').trim() || '20')
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
