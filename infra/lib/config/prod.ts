import { StageConfig } from './types';
import { parseNotificationRecipients } from './notification-recipients';

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
  const orgaNotificationRecipients = parseNotificationRecipients(requireEnv('ORGA_NOTIFICATION_RECIPIENTS'));
  if (orgaNotificationRecipients.length === 0) {
    throw new Error('ORGA_NOTIFICATION_RECIPIENTS must contain at least one email address.');
  }

  return {
    stage: 'prod',
    prefix: 'dreiecksrennen-prod',
    cognitoCallbackUrls: [`${prodPublicBaseUrl}/admin/login`],
    cognitoLogoutUrls: [`${prodPublicBaseUrl}/admin/login`],
    cognitoDomainPrefix: prodCognitoDomainPrefix,
    cognitoRefreshTokenDays: 90,
    sesFromEmail: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
    newsletterFromEmail: 'newsletter@msc-oberlausitz.de',
    newsletterPublicBaseUrl: 'https://www.msc-oberlausitz.de/newsletter',
    orgaNotificationRecipients,
    publicVerifyBaseUrl: `${prodPublicBaseUrl}/anmeldung/verify`,
    assetsCorsAllowedOrigins: [
      prodPublicBaseUrl,
      'https://signing.event.msc-oberlausitz.de',
      'https://sim.event.msc-oberlausitz.de',
      'https://www.msc-oberlausitz.de',
      'https://msc-oberlausitz.de'
    ],
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
    dbUseIamAuth: false,
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
    removalPolicy: 'retain',
    // RacePic bleibt aus, bis Paket 1-9 abgeschlossen und Paket 0 (Rechtstexte) formal freigegeben
    // sind (siehe docs/memory-bank/racepic-progress.md). Aktivierung ueber PROD_ENABLE_RACEPIC=true
    // als bewusster, separater Schritt vor dem Piloten (Paket 10).
    enableRacePic: (process.env.PROD_ENABLE_RACEPIC ?? '').trim().toLowerCase() === 'true',
    racepicMediaCorsAllowedOrigins: [prodPublicBaseUrl, 'https://www.msc-oberlausitz.de', 'https://msc-oberlausitz.de'],
    racepicPhotographerRelyingPartyId: (process.env.PROD_RACEPIC_RELYING_PARTY_ID ?? 'msc-oberlausitz.de').trim(),
    racepicSigningPublicKeyPem: (process.env.PROD_RACEPIC_SIGNING_PUBLIC_KEY_PEM ?? '').trim() || undefined,
    racepicWebsiteBaseUrl: (process.env.PROD_RACEPIC_WEBSITE_BASE_URL ?? 'https://www.msc-oberlausitz.de').replace(/\/$/, ''),
    racepicMonthlyBudgetUsd: Number(process.env.PROD_RACEPIC_MONTHLY_BUDGET_USD ?? '50')
  };
};
