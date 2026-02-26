import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import { StageConfig } from '../config/types';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';
import { StorageStack } from './storage-stack';

interface ApiStackProps extends StackProps {
  config: StageConfig;
  authStack: AuthStack;
  dataStack: DataStack;
  storageStack: StorageStack;
}

class SharedPermissionHttpLambdaIntegration extends apigwv2.HttpRouteIntegration {
  constructor(id: string, private readonly handler: lambda.IFunction) {
    super(id);
  }

  bind(): apigwv2.HttpRouteIntegrationConfig {
    return {
      type: apigwv2.HttpIntegrationType.AWS_PROXY,
      uri: this.handler.functionArn,
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0
    };
  }
}

export class ApiStack extends Stack {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const sslRejectUnauthorized = props.config.dbRequireTls ? 'true' : 'false';
    if (!props.dataStack.dbSecret) {
      throw new Error('DataStack DB secret is missing. Enable RDS before enabling the API stack.');
    }
    if (!props.dataStack.dbInstance) {
      throw new Error('DataStack DB instance is missing. Enable RDS before enabling the API stack.');
    }
    if (props.config.apiInVpc && !props.dataStack.apiLambdaSecurityGroup) {
      throw new Error('DataStack API Lambda security group is missing for VPC mode.');
    }
    const dbSecretArn = props.dataStack.dbSecret.secretArn;
    const dbHost = props.dataStack.dbInstance.instanceEndpoint.hostname;
    const dbPort = props.dataStack.dbInstance.instanceEndpoint.port.toString();
    const dbRegion = Stack.of(this).region;
    const dbUser = props.config.dbUsername;
    const dbResourceId = props.dataStack.dbInstance.instanceResourceId;
    const dbConnectArn = `arn:aws:rds-db:${dbRegion}:${Stack.of(this).account}:dbuser:${dbResourceId}/${dbUser}`;
    const sesFromEmail = props.config.sesFromEmail;
    const publicVerifyBaseUrl = props.config.publicVerifyBaseUrl;
    if (!publicVerifyBaseUrl && props.config.stage === 'prod') {
      throw new Error('Missing publicVerifyBaseUrl in infra/lib/config/prod.ts.');
    }
    const lambdaVpcConfig = props.config.apiInVpc
      ? {
          vpc: props.dataStack.vpc,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
          },
          securityGroups: [props.dataStack.apiLambdaSecurityGroup!]
        }
      : {};

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../api/src/handler.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-api-handler`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: dbSecretArn,
        DB_HOST: dbHost,
        DB_PORT: dbPort,
        DB_NAME: props.config.dbName,
        DB_USER: dbUser,
        DB_REGION: dbRegion,
        DB_IAM_AUTH: props.config.dbUseIamAuth ? 'true' : 'false',
        DB_SSL: props.config.dbRequireTls ? 'true' : 'false',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        DB_SSL_CA_BUNDLE_URL: 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
        ASSETS_BUCKET: props.storageStack.assetsBucket.bucketName,
        DOCUMENTS_BUCKET: props.storageStack.documentsBucket.bucketName,
        COGNITO_ISSUER: props.authStack.userPoolIssuerUrl,
        COGNITO_USER_POOL_ID: props.authStack.userPool.userPoolId,
        SES_FROM_EMAIL: sesFromEmail,
        PAYMENT_IBAN: process.env.PAYMENT_IBAN ?? '',
        PAYMENT_BIC: process.env.PAYMENT_BIC ?? '',
        PAYMENT_RECIPIENT: process.env.PAYMENT_RECIPIENT ?? '',
        PUBLIC_VERIFY_BASE_URL: publicVerifyBaseUrl
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      ...lambdaVpcConfig
    });

    const emailWorker = new NodejsFunction(this, 'EmailWorker', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../api/src/jobs/emailWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-email-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: dbSecretArn,
        DB_HOST: dbHost,
        DB_PORT: dbPort,
        DB_NAME: props.config.dbName,
        DB_USER: dbUser,
        DB_REGION: dbRegion,
        DB_IAM_AUTH: props.config.dbUseIamAuth ? 'true' : 'false',
        DB_SSL: props.config.dbRequireTls ? 'true' : 'false',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        DB_SSL_CA_BUNDLE_URL: 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
        SES_FROM_EMAIL: sesFromEmail,
        EMAIL_WORKER_BATCH_SIZE: '20'
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      ...lambdaVpcConfig
    });

    const privacyRetentionWorker = new NodejsFunction(this, 'PrivacyRetentionWorker', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../api/src/jobs/privacyRetentionWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-privacy-retention-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: dbSecretArn,
        DB_HOST: dbHost,
        DB_PORT: dbPort,
        DB_NAME: props.config.dbName,
        DB_USER: dbUser,
        DB_REGION: dbRegion,
        DB_IAM_AUTH: props.config.dbUseIamAuth ? 'true' : 'false',
        DB_SSL: props.config.dbRequireTls ? 'true' : 'false',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        DB_SSL_CA_BUNDLE_URL: 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
        RETENTION_VERIFICATION_DAYS: '30',
        RETENTION_IDEMPOTENCY_DAYS: '30',
        RETENTION_UPLOAD_DAYS: '30',
        RETENTION_EXPORT_DAYS: '90',
        RETENTION_OUTBOX_DAYS: '365',
        RETENTION_AUDIT_DAYS: '730',
        RETENTION_NOTES_DAYS: '365'
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      ...lambdaVpcConfig
    });

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dbSecretArn]
      })
    );

    [apiHandler, emailWorker, privacyRetentionWorker].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: [dbConnectArn]
        })
      );
    });

    [props.storageStack.assetsBucket, props.storageStack.documentsBucket].forEach((bucket) => {
      apiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [bucket.bucketArn]
        })
      );
      apiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [`${bucket.bucketArn}/*`]
        })
      );
    });

    [apiHandler, emailWorker].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: ['*']
        })
      );
    });

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser'
        ],
        resources: [props.authStack.userPool.userPoolArn]
      })
    );

    [emailWorker, privacyRetentionWorker].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [dbSecretArn]
        })
      );
    });

    new events.Rule(this, 'EmailWorkerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(emailWorker)]
    });

    new events.Rule(this, 'PrivacyRetentionSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new targets.LambdaFunction(privacyRetentionWorker)]
    });

    const integration = new SharedPermissionHttpLambdaIntegration('ApiIntegration', apiHandler);

    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.config.prefix}-http-api`
    });

    apiHandler.addPermission('HttpApiInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: this.formatArn({
        service: 'execute-api',
        resource: this.api.apiId,
        resourceName: '*/*/*'
      })
    });

    this.api.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/{id}/entries',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/{id}/entries/batch',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/current',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/{id}/start-number/validate',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/uploads/vehicle-image/init',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/uploads/vehicle-image/finalize',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/entries/{id}/verify-email',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', props.authStack.userPoolIssuerUrl, {
      jwtAudience: [props.authStack.userPoolClient.userPoolClientId]
    });

    this.api.addRoutes({
      path: '/admin/ping',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/auth/me',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/dashboard/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/db/ping',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/db/schema',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/queue',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/classes',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/classes/{id}',
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/current',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/activate',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/close',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/archive',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/lifecycle/queue',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/broadcast/queue',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/payment/reminders/queue',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/checkin/id-verify',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/waiver',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/tech-check',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/waiver/batch',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/tech-check/batch',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/{id}/download',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/entry/{id}/download',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/pricing-rules',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/invoices/recalculate',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/invoices',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/invoices/{id}/payments',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/deleted',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/restore',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/checkin/entries',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/payment-status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/payment-amounts',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/tech-status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/notes',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/exports/entries',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/exports',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/exports/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/exports/{id}/download',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/outbox',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/outbox/{id}/retry',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/roles',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/users',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/users/{id}/roles',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/users/{id}/status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? 'n/a',
      exportName: `${props.config.prefix}-api-url`
    });
  }
}
