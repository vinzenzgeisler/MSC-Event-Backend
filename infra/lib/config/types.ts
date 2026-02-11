export interface StageConfig {
  stage: 'dev' | 'prod';
  prefix: string;
  env?: {
    account?: string;
    region?: string;
  };
  dbName: string;
  dbInstanceType: {
    instanceClass: string;
    instanceSize: string;
  };
  dbPublicAccess: boolean;
  removalPolicy: 'destroy' | 'retain';
}
