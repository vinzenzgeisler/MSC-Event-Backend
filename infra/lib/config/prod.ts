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
      'https://msc-oberlausitz.de',
      // 2026-09-22: die oeffentliche RacePic-Website (msc-website) laeuft bewusst noch nicht auf
      // der echten Domain (siehe racepic-progress.md), sondern nur lokal gegen das Prod-Backend -
      // ohne diesen Origin wuerde `POST /public/racepic/images/{id}/download` per CORS blockiert.
      // Entfernen, sobald die RacePic-Seiten auf www.msc-oberlausitz.de live sind.
      'http://localhost:8080',
      // 2026-09-23: Vercel-Preview-Deployment fuer eine erste, herumschickbare Vorschau (siehe
      // msc-website-Repo). Bewusst nur DIESE eine Deployment-URL, nicht generell alle
      // `*.vercel.app` (API Gateway CORS unterstuetzt ohnehin keine Teil-Wildcards) - Nutzerwunsch
      // war explizit "nur diese eine Preview-URL erlauben" statt die ganze API per `*` zu oeffnen.
      // Wird bei jedem neuen Preview-Deploy (neue URL) erneut stumpf brechen, bis die Website auf
      // der echten Domain live ist - dann faellt dieser Eintrag ohnehin weg.
      'https://msc-website-rl4gw5gag-msc-projects.vercel.app'
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
    // localhost:8080 siehe Kommentar bei assetsCorsAllowedOrigins oben - gilt hier fuer die
    // Manifest-/Bild-CORS-Policy auf dem CloudFront-Verhalten (racepic-stack.ts), nicht fuer
    // direkten S3-Zugriff (der Browser spricht immer mit CloudFront/OAC).
    racepicMediaCorsAllowedOrigins: [prodPublicBaseUrl, 'https://www.msc-oberlausitz.de', 'https://msc-oberlausitz.de', 'http://localhost:8080'],
    // ACHTUNG: `??` faengt nur `undefined`/`null` ab, nicht einen von GitHub Actions gesetzten,
    // aber leeren String - `${{ vars.X }}` liefert bei einer nicht gesetzten Environment-Variable
    // IMMER einen leeren String, nie "unset" (siehe .github/workflows/ci-cd.yml). Deshalb hier
    // durchgaengig erst trimmen und auf Leerheit pruefen, bevor der Default greift (Bug gefunden
    // beim ersten echten Prod-Deploy am 2026-09-22: `racepicPhotographerRelyingPartyId` landete
    // als leerer String im Cognito-Pool, was CDK mit "passkeyRelyingPartyId length must be
    // between 1 and 63, got 0" quittiert hat).
    racepicPhotographerRelyingPartyId: (process.env.PROD_RACEPIC_RELYING_PARTY_ID ?? '').trim() || 'msc-oberlausitz.de',
    racepicSigningPublicKeyPem: (process.env.PROD_RACEPIC_SIGNING_PUBLIC_KEY_PEM ?? '').trim() || undefined,
    racepicWebsiteBaseUrl: ((process.env.PROD_RACEPIC_WEBSITE_BASE_URL ?? '').trim() || 'https://www.msc-oberlausitz.de').replace(/\/$/, ''),
    racepicMonthlyBudgetUsd: Number((process.env.PROD_RACEPIC_MONTHLY_BUDGET_USD ?? '').trim() || '50')
  };
};
