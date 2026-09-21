export interface StageConfig {
  stage: 'dev' | 'prod';
  prefix: string;
  cognitoCallbackUrls: string[];
  cognitoLogoutUrls: string[];
  cognitoDomainPrefix: string;
  cognitoRefreshTokenDays?: number;
  sesFromEmail: string;
  newsletterFromEmail: string;
  newsletterPublicBaseUrl: string;
  orgaNotificationRecipients: string[];
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
  // RacePic (docs/memory-bank/racepic-architecture.md). Opt-in-Flag analog zu enableApi/enableMigrationRunner,
  // damit RacePicStack ohne Risiko fuer bestehende Deploys eingefuehrt werden kann (Paket 1).
  enableRacePic: boolean;
  // Herkuenfte fuer CORS auf dem RacePic-Media-Bucket (Studio-Uploads) - i. d. R. dieselben wie
  // assetsCorsAllowedOrigins, separat gehalten, damit RacePic-spezifische Domains unabhaengig
  // erweitert werden koennen.
  racepicMediaCorsAllowedOrigins: string[];
  // Relying-Party-ID fuer Passkeys im Fotografen-Pool; muss die Domain sein, auf der /racepic/studio
  // laeuft (siehe Architekturplan Abschnitt E).
  racepicPhotographerRelyingPartyId: string;
  // PEM-kodierter oeffentlicher Schluessel fuer CloudFront Signed URLs/Cookies (Downloads).
  // Undefined bis das Schluesselpaar einmalig erzeugt wurde, siehe TODO in racepic-stack.ts.
  racepicSigningPublicKeyPem?: string;
  // Basis-URL der Website fuer Links in RacePic-Systemmails (Einladung/Claim), z. B.
  // https://www.msc-oberlausitz.de - dort liegt das Fotografen-Studio (Abschnitt E), nicht im
  // Nennungstool-Frontend.
  racepicWebsiteBaseUrl: string;
}
