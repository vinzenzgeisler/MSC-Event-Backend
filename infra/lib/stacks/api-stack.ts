import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import { StageConfig } from '../config/types';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';
import { RacePicStack } from './racepic-stack';
import { StorageStack } from './storage-stack';

interface ApiStackProps extends StackProps {
  config: StageConfig;
  authStack: AuthStack;
  dataStack: DataStack;
  storageStack: StorageStack;
  // RacePic (Paket 1): optional, nur gesetzt wenn config.enableRacePic. Siehe app.ts.
  racePicStack?: RacePicStack;
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
    const newsletterFromEmail = props.config.newsletterFromEmail;
    const orgaNotificationRecipients = props.config.orgaNotificationRecipients.join(',');
    const sesFeedbackTopic = new sns.Topic(this, 'SesFeedbackTopic', {
      topicName: `${props.config.prefix}-ses-feedback`
    });
    const sesFeedbackDeadLetterQueue = new sqs.Queue(this, 'SesFeedbackDeadLetterQueue', {
      queueName: `${props.config.prefix}-ses-feedback-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14)
    });
    const sesConfigurationSet = new ses.ConfigurationSet(this, 'SesConfigurationSet', {
      configurationSetName: `${props.config.prefix}-mail-events`,
      reputationMetrics: true
    });
    sesConfigurationSet.addEventDestination('SesFeedbackDestination', {
      destination: ses.EventDestination.snsTopic(sesFeedbackTopic),
      events: [
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.DELIVERY_DELAY
      ]
    });
    const publicVerifyBaseUrl = props.config.publicVerifyBaseUrl;
    if (!publicVerifyBaseUrl && props.config.stage === 'prod') {
      throw new Error('Missing publicVerifyBaseUrl in infra/lib/config/prod.ts.');
    }
    const mailPublicBaseUrl = (() => {
      if (!publicVerifyBaseUrl) {
        return '';
      }
      try {
        const parsed = new URL(publicVerifyBaseUrl);
        return `${parsed.protocol}//${parsed.host}`;
      } catch {
        if (props.config.stage === 'prod') {
          throw new Error('Invalid publicVerifyBaseUrl format in stage config.');
        }
        return '';
      }
    })();
    const lambdaVpcConfig = props.config.apiInVpc
      ? {
          vpc: props.dataStack.vpc,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
          },
          securityGroups: [props.dataStack.apiLambdaSecurityGroup!]
        }
      : {};
    const depsLockFilePath = path.join(__dirname, '../../../package-lock.json');

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/handler.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-api-handler`,
      // Bulk stamp-card PDFs render many personalized QR codes. More memory also
      // assigns proportionally more CPU and keeps the synchronous API below the gateway
      // integration timeout without moving the user-facing download async.
      memorySize: 1024,
      // Campaign preparation resolves and renders several hundred personalized
      // recipients before atomically inserting the outbox batch.
      timeout: cdk.Duration.seconds(29),
      depsLockFilePath,
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
        SES_CONFIGURATION_SET: sesConfigurationSet.configurationSetName,
        ORGA_NOTIFICATION_RECIPIENTS: orgaNotificationRecipients,
        PUBLIC_VERIFY_BASE_URL: publicVerifyBaseUrl,
        MAIL_PUBLIC_BASE_URL: mailPublicBaseUrl,
        NENNUNGSTOOL_URL: mailPublicBaseUrl,
        EMAIL_VERIFICATION_TOKEN_TTL_DAYS: '30',
        REQUIRE_ADMIN_MFA: 'false',
        NEWSLETTER_ENABLED: 'true',
        NEWSLETTER_PUBLIC_BASE_URL: props.config.newsletterPublicBaseUrl,
        NEWSLETTER_FROM_EMAIL: newsletterFromEmail
      },
      bundling: {
        target: 'node24',
        sourceMap: true,
        minify: false,
        nodeModules: ['pdfkit', 'exceljs']
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });

    const emailWorker = new NodejsFunction(this, 'EmailWorker', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/emailWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-email-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath,
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
        SES_FROM_EMAIL: sesFromEmail,
        SES_CONFIGURATION_SET: sesConfigurationSet.configurationSetName,
        ORGA_NOTIFICATION_RECIPIENTS: orgaNotificationRecipients,
        PUBLIC_VERIFY_BASE_URL: publicVerifyBaseUrl,
        MAIL_PUBLIC_BASE_URL: mailPublicBaseUrl,
        NENNUNGSTOOL_URL: mailPublicBaseUrl,
        EMAIL_VERIFICATION_TOKEN_TTL_DAYS: '30',
        REQUIRE_ADMIN_MFA: 'false',
        EMAIL_WORKER_BATCH_SIZE: '20',
        AUTOMATIC_REMINDERS_ENABLED: 'false',
        PAYMENT_REMINDER_FIRST_DAYS: '5',
        PAYMENT_REMINDER_REPEAT_DAYS: '5',
        NEWSLETTER_FROM_EMAIL: newsletterFromEmail
      },
      bundling: {
        target: 'node24',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });

    const privacyRetentionWorker = new NodejsFunction(this, 'PrivacyRetentionWorker', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/privacyRetentionWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-privacy-retention-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      depsLockFilePath,
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
        RETENTION_RATE_LIMIT_DAYS: '7',
        RETENTION_EXPORT_DAYS: '90',
        RETENTION_OUTBOX_DAYS: '365',
        RETENTION_EMAIL_DELIVERY_DAYS: '365',
        RETENTION_AUDIT_DAYS: '730',
        RETENTION_EVENT_OPERATIONAL_DAYS: '365',
        RETENTION_DOCUMENT_DAYS: '2190',
        RETENTION_INVOICE_DAYS: '3650',
        ASSETS_BUCKET: props.storageStack.assetsBucket.bucketName,
        // Paket 9 (RacePic-Datenschutz): erlaubt racepic/publish.ts's regenerateManifestsForEvent
        // aufzurufen, falls RacePic aktiviert ist. Ohne racePicStack bleiben diese Variablen unset -
        // der dynamische Import in privacyRetentionWorker.ts faengt das ab (siehe dortiger Kommentar).
        ...(props.racePicStack
          ? {
              RACEPIC_MEDIA_BUCKET: props.racePicStack.mediaBucket.bucketName,
              RACEPIC_CDN_DISTRIBUTION_ID: props.racePicStack.distribution.distributionId
            }
          : {})
      },
      bundling: {
        target: 'node24',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });
    privacyRetentionWorker.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: [`${props.storageStack.assetsBucket.bucketArn}/*`] })
    );
    if (props.racePicStack) {
      privacyRetentionWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [`${props.racePicStack.mediaBucket.bucketArn}/*`]
        })
      );
      privacyRetentionWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.racePicStack.distribution.distributionId}`]
        })
      );
    }

    const eventHubMaintenanceWorker = new NodejsFunction(this, 'EventHubMaintenanceWorker', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/eventHubMaintenanceWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-event-hub-maintenance-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      depsLockFilePath,
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
        RETENTION_EVENT_HUB_RESULT_DAYS: '90'
      },
      bundling: {
        target: 'node24',
        sourceMap: true,
        minify: false
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });

    const sesFeedbackWorker = new NodejsFunction(this, 'SesFeedbackWorker', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/sesFeedbackWorker.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-ses-feedback-worker`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath,
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
        DB_SSL_CA_BUNDLE_URL: 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
      },
      bundling: { target: 'node24', sourceMap: true, minify: false },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });
    sesFeedbackWorker.addEventSource(new lambdaEventSources.SnsEventSource(sesFeedbackTopic, {
      deadLetterQueue: sesFeedbackDeadLetterQueue
    }));

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dbSecretArn]
      })
    );

    [apiHandler, emailWorker, privacyRetentionWorker, eventHubMaintenanceWorker, sesFeedbackWorker].forEach((fn) => {
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
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [`${bucket.bucketArn}/*`]
        })
      );
    });

    emailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.storageStack.assetsBucket.bucketArn]
      })
    );

    emailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.storageStack.assetsBucket.bucketArn}/*`]
      })
    );
    emailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.storageStack.documentsBucket.bucketArn]
      })
    );
    emailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.storageStack.documentsBucket.bucketArn}/*`]
      })
    );

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

    [emailWorker, privacyRetentionWorker, eventHubMaintenanceWorker, sesFeedbackWorker].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [dbSecretArn]
        })
      );
    });

    new events.Rule(this, 'EmailWorkerSchedule', {
      // Verification and password-style action mails are user-facing and must
      // leave the transactional outbox promptly after the request.
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(emailWorker)]
    });

    new events.Rule(this, 'PrivacyRetentionSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new targets.LambdaFunction(privacyRetentionWorker)]
    });

    new events.Rule(this, 'EventHubMaintenanceSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(eventHubMaintenanceWorker)]
    });

    const integration = new SharedPermissionHttpLambdaIntegration('ApiIntegration', apiHandler);

    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${props.config.prefix}-http-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: props.config.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.config.prefix}-http-api`,
      ...(props.config.assetsCorsAllowedOrigins.length > 0
        ? {
            corsPreflight: {
              allowOrigins: props.config.assetsCorsAllowedOrigins,
              allowMethods: [
                apigwv2.CorsHttpMethod.GET,
                apigwv2.CorsHttpMethod.POST,
                apigwv2.CorsHttpMethod.PUT,
                apigwv2.CorsHttpMethod.PATCH,
                apigwv2.CorsHttpMethod.DELETE,
                apigwv2.CorsHttpMethod.OPTIONS
              ],
              allowHeaders: [
                'content-type',
                'authorization',
                'accept',
                'x-requested-with',
                'x-amz-date',
                'x-amz-security-token',
                'x-api-key',
                'x-signing-device-token',
                'x-msc-admin-email'
              ],
              maxAge: cdk.Duration.seconds(600)
            }
          }
        : {})
    });

    const defaultStage = this.api.defaultStage;
    if (!defaultStage) {
      throw new Error('HTTP API default stage is missing.');
    }
    const defaultCfnStage = defaultStage.node.defaultChild as apigwv2.CfnStage;
    defaultCfnStage.accessLogSettings = {
      destinationArn: apiAccessLogGroup.logGroupArn,
      format: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId',
          requestTime: '$context.requestTime',
          routeKey: '$context.routeKey',
          method: '$context.httpMethod',
          path: '$context.path',
          status: '$context.status',
          responseLatencyMs: '$context.responseLatency',
          integrationLatencyMs: '$context.integrationLatency',
          integrationError: '$context.integrationErrorMessage'
      })).toString()
    };
    defaultCfnStage.defaultRouteSettings = { detailedMetricsEnabled: false };

    const mailLogoUrl = `${this.api.apiEndpoint}/public/mail/logo`;
    apiHandler.addEnvironment('MAIL_LOGO_URL', mailLogoUrl);
    emailWorker.addEnvironment('MAIL_LOGO_URL', mailLogoUrl);

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
      path: '/public/mail/logo',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/public/legal/current',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({ path: '/public/newsletter/config', methods: [apigwv2.HttpMethod.GET], integration });
    this.api.addRoutes({ path: '/public/newsletter/subscriptions', methods: [apigwv2.HttpMethod.POST], integration });
    this.api.addRoutes({ path: '/public/newsletter/confirm', methods: [apigwv2.HttpMethod.POST], integration });
    this.api.addRoutes({ path: '/public/newsletter/unsubscribe-request', methods: [apigwv2.HttpMethod.POST], integration });
    this.api.addRoutes({ path: '/public/newsletter/unsubscribe', methods: [apigwv2.HttpMethod.POST], integration });

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

    this.api.addRoutes({
      path: '/public/entries/{id}/verification-resend',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/signing/device/claim',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/signing/device/current-session',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/terminal/device/claim',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/terminal/device/current-session',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/terminal/sessions/{id}/draft',
      methods: [apigwv2.HttpMethod.PUT],
      integration
    });

    this.api.addRoutes({
      path: '/terminal/sessions/{id}/complete',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/signing/sessions/{id}/complete',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/codriver-invitations/{token}',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/public/codriver-invitations/{token}/complete',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', props.authStack.userPoolIssuerUrl, {
      jwtAudience: [
        props.authStack.userPoolClient.userPoolClientId,
        props.authStack.supportUserPoolClient.userPoolClientId
      ]
    });
    const supportJwtAuthorizer = new authorizers.HttpJwtAuthorizer('SupportCognitoAuthorizer', props.authStack.userPoolIssuerUrl, {
      jwtAudience: [
        props.authStack.userPoolClient.userPoolClientId,
        props.authStack.supportUserPoolClient.userPoolClientId
      ]
    });

    this.api.addRoutes({
      path: '/admin/ping',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({ path: '/admin/newsletter/overview', methods: [apigwv2.HttpMethod.GET], integration, authorizer: jwtAuthorizer });
    this.api.addRoutes({ path: '/admin/newsletter/subscribers', methods: [apigwv2.HttpMethod.GET], integration, authorizer: jwtAuthorizer });
    this.api.addRoutes({ path: '/admin/newsletter/subscribers/{id}/unsubscribe', methods: [apigwv2.HttpMethod.POST], integration, authorizer: jwtAuthorizer });
    this.api.addRoutes({ path: '/admin/newsletter/subscribers/{id}/resend-verification', methods: [apigwv2.HttpMethod.POST], integration, authorizer: jwtAuthorizer });

    this.api.addRoutes({
      path: '/admin/auth/me',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/dashboard/overview',
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
      path: '/admin/dashboard/warnings',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });
    this.api.addRoutes({
      path: '/admin/dashboard/actions/queue-missing-lifecycle-mails',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/dashboard/driver-locations',
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
      path: '/admin/mail/send',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates/{id}',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates/{id}/versions',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates/{id}/versions',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates/preview',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/attachments/init',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/attachments/finalize',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/templates/{id}/placeholders',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/broadcast/resolve-recipients',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/mail/recipients/search',
      methods: [apigwv2.HttpMethod.GET],
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
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
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
      path: '/admin/events/{eventId}/run-groups',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{eventId}/registration-invitations',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/registration-invitations/{id}/revoke',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/run-groups/{id}',
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/backup-class',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/current',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: supportJwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/config/entry-confirmation-defaults',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
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
      path: '/admin/signing/devices/pairing-code',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/devices',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/devices/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/entries/{id}/requirements',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/entries/{id}/signed-waiver',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/sessions',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/sessions/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/signing/sessions/{id}/cancel',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/sessions',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/devices/pairing-code',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/devices',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/devices/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/sessions/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/sessions/{id}/approve',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/sessions/{id}/return-to-form',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/terminal/sessions/{id}/cancel',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/codriver-invitations',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/codriver-invitations/{id}/revoke',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/charity-codrivers/{registrationId}/revoke',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/codriver',
      methods: [apigwv2.HttpMethod.DELETE],
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
      authorizer: supportJwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/deleted',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: supportJwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: supportJwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/mail-history',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
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
      path: '/admin/entries/{id}/class',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/assignment',
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
      path: '/admin/entries/{id}/driver-email',
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
      path: '/admin/exports/programmheft',
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
      path: '/admin/marshals/workspace',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/events',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/persons',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/persons/{id}',
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/area-assignments/{personId}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/shift-assignments/{personId}',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/events/{eventId}/reset',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/assignments/{id}',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/config',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/config/areas',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/trainings',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/trainings/{sessionId}/participants/{personId}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/import/preview',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/import/commit',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/marshals/print',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/users/{id}/profile',
      methods: [apigwv2.HttpMethod.PATCH],
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

    this.api.addRoutes({
      path: '/admin/iam/technical-inspector-assignments',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/iam/users/{id}/technical-inspector-assignment',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/context',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/entries',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/entries/{id}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/entries/{id}/history',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/entries/{id}/note',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/access-check',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/overview',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/persons/{id}/publication-name',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/documents/{id}/resend-waiver-mail',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/inspection/participants/{eventId}/{personId}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/entries/{id}/inspection-qr',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/inspection-qr-export',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{eventId}/participants/{personId}/inspection-qr',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/stamp-cards/export',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/waiver/paper-export',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/waiver/blank-export',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    // --- Simulator Leaderboard ---
    this.api.addRoutes({
      path: '/public/sim/config',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/admin/sim/config',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/public/sim/leaderboard',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    this.api.addRoutes({
      path: '/admin/sim/entries',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/sim/entries/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/public/events/current/event-hub',
      methods: [apigwv2.HttpMethod.GET],
      integration
    });
    this.api.addRoutes({ path: '/public/events/current/event-hub/summary', methods: [apigwv2.HttpMethod.GET], integration });
    this.api.addRoutes({ path: '/public/events/current/event-hub/classes/{classId}', methods: [apigwv2.HttpMethod.GET], integration });

    this.api.addRoutes({ path: '/public/events/current/auction', methods: [apigwv2.HttpMethod.GET], integration });
    this.api.addRoutes({ path: '/public/events/{id}/auction/bids', methods: [apigwv2.HttpMethod.POST], integration });

    this.api.addRoutes({
      path: '/public/events/{id}/voting/challenge',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/{id}/votes',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/public/events/{id}/voting/device-status',
      methods: [apigwv2.HttpMethod.POST],
      integration
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/event-hub',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/event-hub/candidates',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/event-hub/candidates/{entryId}',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/voting/results',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/voting/results/{entryId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });

    this.api.addRoutes({
      path: '/admin/events/{id}/auction',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });
    this.api.addRoutes({
      path: '/admin/events/{id}/auction/media-upload',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });
    this.api.addRoutes({
      path: '/admin/events/{id}/auction/bids',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });
    this.api.addRoutes({
      path: '/admin/events/{id}/auction/bids/{bidId}',
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });

    new logs.QueryDefinition(this, 'OperationalErrorsQuery', {
      queryDefinitionName: `${props.config.prefix}/operational-errors`,
      logGroups: [apiHandler.logGroup, emailWorker.logGroup, sesFeedbackWorker.logGroup],
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@log', 'message.eventType', 'message.requestId', 'message.route', 'message.eventId', 'message.entryId', 'message.sessionId', 'message.status', 'message.errorCode'],
        filterStatements: ['level = "ERROR" or message.eventType like /failed|missing|unhandled|unavailable|stuck|delay/'],
        sort: '@timestamp desc',
        limit: 500
      })
    });
    new logs.QueryDefinition(this, 'ApiRequestsQuery', {
      queryDefinitionName: `${props.config.prefix}/api-requests`,
      logGroups: [apiAccessLogGroup],
      queryString: new logs.QueryString({
        fields: ['@timestamp', 'requestId', 'method', 'path', 'status', 'responseLatencyMs', 'integrationLatencyMs', 'integrationError'],
        sort: '@timestamp desc',
        limit: 500
      })
    });

    // --- RacePic (Paket 1: Fundament) -------------------------------------------------------
    // Eigener Lambda-Handler statt Erweiterung von ApiHandler (siehe racepic-architecture.md
    // Abschnitt B: getrennte Speicher-/Timeout-/Concurrency-Einstellungen, ohne einen neuen Service
    // zu betreiben). Routen laufen ueber dieselbe HttpApi wie der bestehende ApiHandler.
    if (props.racePicStack) {
      const racePicStack = props.racePicStack;

      const racePicApiHandler = new NodejsFunction(this, 'RacePicApiHandler', {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: path.join(__dirname, '../../../api/src/racepic/handler.ts'),
        handler: 'handler',
        functionName: `${props.config.prefix}-racepic-api-handler`,
        memorySize: 512,
        timeout: cdk.Duration.seconds(29),
        depsLockFilePath,
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
          RACEPIC_MEDIA_BUCKET: racePicStack.mediaBucket.bucketName,
          RACEPIC_CDN_DOMAIN: racePicStack.distribution.distributionDomainName,
          RACEPIC_CDN_DISTRIBUTION_ID: racePicStack.distribution.distributionId,
          RACEPIC_INGEST_QUEUE_URL: racePicStack.ingestQueue.queueUrl,
          RACEPIC_ANALYZE_QUEUE_URL: racePicStack.analyzeQueue.queueUrl,
          RACEPIC_MATCH_QUEUE_URL: racePicStack.matchQueue.queueUrl,
          RACEPIC_PHOTOGRAPHER_POOL_ID: racePicStack.photographerUserPool.userPoolId,
          RACEPIC_PHOTOGRAPHER_POOL_CLIENT_ID: racePicStack.photographerUserPoolClientId,
          RACEPIC_PHOTOGRAPHER_POOL_ISSUER: racePicStack.photographerUserPoolIssuerUrl,
          RACEPIC_WEBSITE_BASE_URL: props.config.racepicWebsiteBaseUrl
        },
        ...(props.config.apiInVpc ? lambdaVpcConfig : {})
      });

      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [dbSecretArn]
        })
      );
      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: [dbConnectArn]
        })
      );
      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [racePicStack.mediaBucket.bucketArn]
        })
      );
      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          // Paket 3: Multipart-Aktionen zusaetzlich zu Get/Put/Delete fuer den Presign- und
          // Abschluss-/Abbruch-Flow (api/src/racepic/s3.ts).
          actions: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
            's3:CreateMultipartUpload',
            's3:UploadPart',
            's3:ListMultipartUploadParts',
            's3:CompleteMultipartUpload',
            's3:AbortMultipartUpload'
          ],
          resources: [`${racePicStack.mediaBucket.bucketArn}/*`]
        })
      );
      [racePicStack.ingestQueue, racePicStack.analyzeQueue, racePicStack.matchQueue].forEach((queue) => queue.grantSendMessages(racePicApiHandler));

      // Paket 2 (Identitaet): AdminCreateUser/AdminGetUser fuer den Claim-Flow, siehe
      // api/src/racepic/cognito.ts. Nur der Photographer-Pool, nicht der Staff-Pool.
      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser'],
          resources: [racePicStack.photographerUserPool.userPoolArn]
        })
      );
      // Paket 4 (Publish-Worker, api/src/racepic/publish.ts): Invalidation nach Veroeffentlichen/
      // Verbergen/Entfernen eines Bildes oder Manifests. Best-effort im Code, aber die Permission
      // muss trotzdem existieren, sonst schlaegt jeder Aufruf hart fehl.
      racePicApiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${this.account}:distribution/${racePicStack.distribution.distributionId}`]
        })
      );

      const racePicIntegration = new SharedPermissionHttpLambdaIntegration('RacePicApiIntegration', racePicApiHandler);

      racePicApiHandler.addPermission('RacePicHttpApiInvokePermission', {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: this.formatArn({
          service: 'execute-api',
          resource: this.api.apiId,
          resourceName: '*/*/*'
        })
      });

      // Zweiter JWT-Authorizer fuer den eigenstaendigen Fotografen-Pool (Abschnitt E: Blast-Radius-
      // Trennung vom Staff-Pool). `jwtAuthorizer`/Staff-Gruppen bleiben fuer /admin/racepic/* zustaendig.
      const photographerJwtAuthorizer = new authorizers.HttpJwtAuthorizer(
        'PhotographerCognitoAuthorizer',
        racePicStack.photographerUserPoolIssuerUrl,
        { jwtAudience: [racePicStack.photographerUserPoolClientId] }
      );

      // Health-Check ohne Auth, damit Deploy/Monitoring den neuen Handler unabhaengig vom
      // Fotografen-/Staff-Login pruefen kann.
      this.api.addRoutes({
        path: '/racepic/health',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration
      });

      // Paket 2 (Identitaet): Einladung/Claim/Profil, siehe api/src/racepic/handler.ts.
      this.api.addRoutes({
        path: '/photographer/me',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/claim',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      // Oeffentlich, kein Authorizer: Einladungslink gewaehrt keinen Zugriff, nur den Start des
      // Email-OTP-Flows fuer die eingeladene Adresse (siehe Architekturplan Abschnitt I "Einladung").
      this.api.addRoutes({
        path: '/public/racepic/invitations/{token}',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration
      });
      this.api.addRoutes({
        path: '/public/racepic/invitations/{token}/start',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration
      });
      // Paket 8: oeffentlicher Download. Kein Authorizer (bewusst oeffentlich, siehe Abschnitt J
      // MVP-Scope: "Login nur fuer administrative/fotografenspezifische Funktionen"). TODO vor
      // Go-Live: Rate-Limiting analog `http/publicRateLimit.ts` des Haupt-Handlers ergaenzen -
      // hier noch nicht verdrahtet (siehe Progress-Notiz).
      this.api.addRoutes({
        path: '/public/racepic/images/{imageId}/download',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration
      });
      this.api.addRoutes({
        path: '/admin/racepic/ping',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/photographers',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 5 (Admin-Basis): Event-Konfiguration und Statistik.
      this.api.addRoutes({
        path: '/admin/racepic/events',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}',
        methods: [apigwv2.HttpMethod.PUT],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/stats',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      // Paket 11: allgemeine Bildliste je Event, siehe api/src/racepic/adminEvents.ts.
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/images',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/licenses',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 6 (KI-Pipeline): Matching-Config und Re-Runs, siehe api/src/racepic/{matchingConfig,handler}.ts.
      this.api.addRoutes({
        path: '/admin/racepic/matching-configs',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/rematch',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/images/{imageId}/reanalyze',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 10 (Pilot-Kalibrierung): Qualitaetsreport, siehe api/src/racepic/matchQuality.ts.
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/matching-quality-report',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 7 (Review-Queue), siehe api/src/racepic/reviewQueue.ts.
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/review-queue',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/events/{eventId}/entries/search',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/assignments/{assignmentId}/confirm',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/assignments/{assignmentId}/reject',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/assignments/{assignmentId}/correct',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/images/{imageId}/assignments',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      this.api.addRoutes({
        path: '/admin/racepic/participants/{entryId}/images',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });
      // Paket 9 (Datenschutz): Teilnehmer ausblenden.
      this.api.addRoutes({
        path: '/admin/racepic/participants/{entryId}/hide',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 3b: Event-/Lizenzauswahl fuer den Studio-Uploader.
      this.api.addRoutes({
        path: '/photographer/events',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/licenses',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });

      // Paket 3 (Upload), siehe api/src/racepic/{uploads,s3}.ts und Architekturplan Abschnitt D.
      this.api.addRoutes({
        path: '/photographer/events/{eventId}/batches',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/batches/{batchId}/uploads',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/uploads/{uploadId}/parts',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/uploads/{uploadId}/complete',
        methods: [apigwv2.HttpMethod.POST],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/uploads/{uploadId}',
        methods: [apigwv2.HttpMethod.DELETE],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });
      this.api.addRoutes({
        path: '/photographer/images',
        methods: [apigwv2.HttpMethod.GET],
        integration: racePicIntegration,
        authorizer: photographerJwtAuthorizer
      });

      // Paket 4 (Publish-Worker): Veroeffentlichen/Verbergen/Entfernen, siehe api/src/racepic/publish.ts.
      this.api.addRoutes({
        path: '/admin/racepic/images/{imageId}',
        methods: [apigwv2.HttpMethod.PATCH],
        integration: racePicIntegration,
        authorizer: jwtAuthorizer
      });

      // Paket 3: Upload-Reconciler (haengengebliebene Presign-Fenster), siehe
      // api/src/racepic/reconcileUploads.ts. Laeuft alle 15 Minuten - lang genug, um den
      // 15-Minuten-Presign-Ablauf sicher hinter sich zu haben, kurz genug, um S3-Reste zeitnah
      // aufzuraeumen.
      const racePicUploadReconciler = new NodejsFunction(this, 'RacePicUploadReconciler', {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: path.join(__dirname, '../../../api/src/racepic/reconcileUploads.ts'),
        handler: 'handler',
        functionName: `${props.config.prefix}-racepic-upload-reconciler`,
        memorySize: 512,
        timeout: cdk.Duration.minutes(2),
        depsLockFilePath,
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
          RACEPIC_MEDIA_BUCKET: racePicStack.mediaBucket.bucketName
        },
        ...(props.config.apiInVpc ? lambdaVpcConfig : {})
      });
      racePicUploadReconciler.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [dbSecretArn] })
      );
      racePicUploadReconciler.addToRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbConnectArn] }));
      racePicUploadReconciler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
          resources: [`${racePicStack.mediaBucket.bucketArn}/*`]
        })
      );
      new events.Rule(this, 'RacePicUploadReconcilerSchedule', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        targets: [new targets.LambdaFunction(racePicUploadReconciler)]
      });

      // Paket 4: Ingest-Worker (sharp/EXIF/sha256/Varianten), konsumiert die Ingest-Queue.
      // Architecture.X86_64 bewusst statt ARM_64 (siehe Architekturplan Abschnitt M, wo ARM64 als
      // Kostenoptimierung genannt wird): `sharp` ist ein natives Modul, das beim Bundling via
      // `bundling.nodeModules` mit der npm-Version des Buildrechners installiert wird. Die
      // GitHub-Actions-Runner in der CI/CD-Pipeline sind x86_64-Linux; bei ARM64 muesste npm
      // gezielt fuer eine andere CPU-Architektur installieren (Cross-Install), was fehleranfaelliger
      // ist als einfach dieselbe Architektur wie der Build-Runner zu nutzen. Kann nachtraeglich auf
      // ARM64 umgestellt werden, sobald der CI-Bundlingschritt entsprechend abgesichert ist.
      const racePicIngestWorker = new NodejsFunction(this, 'RacePicIngestWorker', {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        entry: path.join(__dirname, '../../../api/src/racepic/ingestWorker.ts'),
        handler: 'handler',
        functionName: `${props.config.prefix}-racepic-ingest-worker`,
        memorySize: 1536,
        timeout: cdk.Duration.seconds(60),
        depsLockFilePath,
        bundling: {
          // sharp enthaelt native Bindings, die esbuild nicht inlinen kann - stattdessen wird das
          // Modul unveraendert aus node_modules in das Bundle kopiert (per npm install waehrend
          // des Bundlings, siehe Kommentar oben zur Architekturwahl).
          nodeModules: ['sharp']
        },
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
          RACEPIC_MEDIA_BUCKET: racePicStack.mediaBucket.bucketName,
          RACEPIC_ANALYZE_QUEUE_URL: racePicStack.analyzeQueue.queueUrl
        },
        ...(props.config.apiInVpc ? lambdaVpcConfig : {})
      });
      racePicIngestWorker.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [dbSecretArn] })
      );
      racePicIngestWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbConnectArn] }));
      racePicIngestWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [`${racePicStack.mediaBucket.bucketArn}/*`]
        })
      );
      racePicStack.analyzeQueue.grantSendMessages(racePicIngestWorker);
      racePicIngestWorker.addEventSource(
        new lambdaEventSources.SqsEventSource(racePicStack.ingestQueue, {
          batchSize: 1,
          reportBatchItemFailures: true
        })
      );

      new CfnOutput(this, 'RacePicApiHandlerName', { value: racePicApiHandler.functionName });
      new CfnOutput(this, 'RacePicIngestWorkerName', { value: racePicIngestWorker.functionName });

      // Paket 6: Analyze-Worker (Rekognition DetectText/DetectLabels + Bedrock-Embedding je
      // Fahrzeug-Crop), konsumiert die Analyze-Queue.
      const racePicAnalyzeWorker = new NodejsFunction(this, 'RacePicAnalyzeWorker', {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64, // gleiche Begruendung wie RacePicIngestWorker (sharp).
        entry: path.join(__dirname, '../../../api/src/racepic/analyzeWorker.ts'),
        handler: 'handler',
        functionName: `${props.config.prefix}-racepic-analyze-worker`,
        memorySize: 1536,
        timeout: cdk.Duration.seconds(90),
        depsLockFilePath,
        bundling: { nodeModules: ['sharp'] },
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
          RACEPIC_MEDIA_BUCKET: racePicStack.mediaBucket.bucketName,
          RACEPIC_MATCH_QUEUE_URL: racePicStack.matchQueue.queueUrl,
          // Cross-Region-Aufruf (Abschnitt F/Region-Check Paket 1): Cohere Embed v4 laeuft nur in
          // eu-west-1 (Irland), nicht in eu-central-1.
          RACEPIC_EMBEDDING_REGION: 'eu-west-1'
        },
        ...(props.config.apiInVpc ? lambdaVpcConfig : {})
      });
      racePicAnalyzeWorker.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [dbSecretArn] })
      );
      racePicAnalyzeWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbConnectArn] }));
      racePicAnalyzeWorker.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [`${racePicStack.mediaBucket.bucketArn}/*`] })
      );
      racePicAnalyzeWorker.addToRolePolicy(
        // Rekognition unterstuetzt keine ressourcenbasierte Einschraenkung fuer DetectText/DetectLabels.
        // Bewusst KEIN DetectFaces/IndexFaces/... (Abschnitt "Datenschutz": keine Gesichtserkennung).
        new iam.PolicyStatement({ actions: ['rekognition:DetectText', 'rekognition:DetectLabels'], resources: ['*'] })
      );
      racePicAnalyzeWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['arn:aws:bedrock:eu-west-1::foundation-model/cohere.*']
        })
      );
      racePicStack.matchQueue.grantSendMessages(racePicAnalyzeWorker);
      racePicAnalyzeWorker.addEventSource(
        new lambdaEventSources.SqsEventSource(racePicStack.analyzeQueue, { batchSize: 1, reportBatchItemFailures: true })
      );

      // Paket 6: Match-Worker (Kandidaten-Scoring, Assignment-Erzeugung), konsumiert die Match-Queue.
      // Braucht zusaetzlich Lesezugriff auf den bestehenden Assets-Bucket des Nennungstools
      // (Fahrzeug-Referenzfotos, siehe api/src/racepic/vehicleReference.ts) - nur lesend, kein
      // Schreibzugriff auf Nennungstool-Daten.
      const racePicMatchWorker = new NodejsFunction(this, 'RacePicMatchWorker', {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        entry: path.join(__dirname, '../../../api/src/racepic/matchWorker.ts'),
        handler: 'handler',
        functionName: `${props.config.prefix}-racepic-match-worker`,
        memorySize: 1024,
        timeout: cdk.Duration.seconds(90),
        depsLockFilePath,
        bundling: { nodeModules: ['sharp'] },
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
          RACEPIC_EMBEDDING_REGION: 'eu-west-1'
        },
        ...(props.config.apiInVpc ? lambdaVpcConfig : {})
      });
      racePicMatchWorker.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [dbSecretArn] })
      );
      racePicMatchWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbConnectArn] }));
      racePicMatchWorker.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.storageStack.assetsBucket.bucketArn}/*`] })
      );
      racePicMatchWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['arn:aws:bedrock:eu-west-1::foundation-model/cohere.*']
        })
      );
      racePicMatchWorker.addEventSource(
        new lambdaEventSources.SqsEventSource(racePicStack.matchQueue, { batchSize: 1, reportBatchItemFailures: true })
      );

      new CfnOutput(this, 'RacePicAnalyzeWorkerName', { value: racePicAnalyzeWorker.functionName });
      new CfnOutput(this, 'RacePicMatchWorkerName', { value: racePicMatchWorker.functionName });
    }

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? 'n/a',
      exportName: `${props.config.prefix}-api-url`
    });
  }
}
