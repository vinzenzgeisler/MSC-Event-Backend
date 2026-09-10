import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
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
    const orgaNotificationRecipients = props.config.orgaNotificationRecipients.join(',');
    const criticalAlertsTopic = new sns.Topic(this, 'CriticalAlertsTopic', {
      topicName: `${props.config.prefix}-critical-alerts`,
      displayName: `${props.config.prefix} critical system alerts`
    });
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

    // CloudWatch's native SNS email is intentionally not sent straight to the
    // organisers: its raw JSON payload is difficult to understand during an
    // event. This independent formatter turns the same alarm into a concise,
    // actionable German email and lets SNS retry delivery through a DLQ.
    const criticalAlertEmailDeadLetterQueue = new sqs.Queue(this, 'CriticalAlertEmailDeadLetterQueue', {
      queueName: `${props.config.prefix}-critical-alert-email-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14)
    });
    const criticalAlertEmail = new NodejsFunction(this, 'CriticalAlertEmail', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/criticalAlertEmail.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-critical-alert-email`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath,
      environment: {
        STAGE: props.config.stage,
        SES_FROM_EMAIL: sesFromEmail,
        ORGA_NOTIFICATION_RECIPIENTS: orgaNotificationRecipients
      },
      bundling: { target: 'node24', sourceMap: true, minify: false },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN
    });
    criticalAlertEmail.addEventSource(new lambdaEventSources.SnsEventSource(criticalAlertsTopic, {
      deadLetterQueue: criticalAlertEmailDeadLetterQueue
    }));
    criticalAlertEmail.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*']
    }));

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
        REQUIRE_ADMIN_MFA: 'false'
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
        PAYMENT_REMINDER_FIRST_DAYS: '5',
        PAYMENT_REMINDER_REPEAT_DAYS: '5'
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
        RETENTION_INVOICE_DAYS: '3650'
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

    const operationalMonitor = new NodejsFunction(this, 'OperationalMonitor', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/jobs/operationalMonitor.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-operational-monitor`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(45),
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
        DOCUMENTS_BUCKET: props.storageStack.documentsBucket.bucketName,
        ORGA_NOTIFICATION_RECIPIENTS: orgaNotificationRecipients
      },
      bundling: { target: 'node24', sourceMap: true, minify: false },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      ...lambdaVpcConfig
    });

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dbSecretArn]
      })
    );

    [apiHandler, emailWorker, privacyRetentionWorker, sesFeedbackWorker, operationalMonitor].forEach((fn) => {
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

    operationalMonitor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.storageStack.documentsBucket.bucketArn}/*`]
      })
    );

    [sesFeedbackWorker, operationalMonitor].forEach((fn) => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': `MSCEvent/${props.config.stage}` } }
      }));
    });
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

    [emailWorker, privacyRetentionWorker, sesFeedbackWorker, operationalMonitor].forEach((fn) => {
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
    defaultCfnStage.defaultRouteSettings = { detailedMetricsEnabled: true };

    const mailLogoUrl = `${this.api.apiEndpoint}/public/mail/logo`;
    apiHandler.addEnvironment('MAIL_LOGO_URL', mailLogoUrl);
    emailWorker.addEnvironment('MAIL_LOGO_URL', mailLogoUrl);
    operationalMonitor.addEnvironment('API_HEALTH_URL', `${this.api.apiEndpoint}/health`);

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

    new events.Rule(this, 'OperationalMonitorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(operationalMonitor, { retryAttempts: 2 })]
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

    const fiveMinutes = cdk.Duration.minutes(5);
    const customMetric = (metricName: string) => new cloudwatch.Metric({
      namespace: `MSCEvent/${props.config.stage}`,
      metricName,
      statistic: 'Maximum',
      period: fiveMinutes
    });
    const positiveAlarm = (id: string, metric: cloudwatch.IMetric, description: string) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: `${props.config.prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });

    const apiLambdaErrors = positiveAlarm(
      'api-lambda-errors',
      apiHandler.metricErrors({ period: fiveMinutes, statistic: 'Sum' }),
      'API Lambda produced at least one error in five minutes.'
    );
    const apiGateway5xx = new cloudwatch.Alarm(this, 'ApiGateway5xxAlarm', {
      alarmName: `${props.config.prefix}-api-gateway-5xx`,
      alarmDescription: 'HTTP API returned three or more 5xx responses in five minutes.',
      metric: this.api.metricServerError({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });
    const apiUnavailable = positiveAlarm('api-health-unavailable', customMetric('apiUnavailable'), 'The external API health probe failed.');
    const apiThrottles = positiveAlarm('api-lambda-throttles', apiHandler.metricThrottles({ period: fiveMinutes, statistic: 'Sum' }), 'API Lambda was throttled.');

    const workflowAlarms = [
      positiveAlarm('signing-evidence-incomplete', customMetric('signingEvidenceIncomplete'), 'A completed signing session has incomplete evidence.'),
      positiveAlarm('signing-mail-queue-failed', customMetric('signingMailQueueFailed'), 'A waiver confirmation could not be queued.'),
      positiveAlarm('inspection-notification-missing', customMetric('inspectionNotificationMissing'), 'An inspection decision has no complete Orga notification set.'),
      positiveAlarm('registration-notification-missing', customMetric('registrationNotificationMissing'), 'A registration has no complete Orga notification set.'),
      positiveAlarm('s3-evidence-missing', customMetric('s3EvidenceMissing'), 'Recent signing evidence referenced in the database is absent in S3.')
    ];
    const mailAlarms = [
      positiveAlarm('email-worker-errors', emailWorker.metricErrors({ period: fiveMinutes, statistic: 'Sum' }), 'Email worker invocation failed.'),
      positiveAlarm('ses-feedback-worker-errors', sesFeedbackWorker.metricErrors({ period: fiveMinutes, statistic: 'Sum' }), 'SES feedback worker invocation failed.'),
      positiveAlarm('ses-feedback-dead-letter', sesFeedbackDeadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: fiveMinutes, statistic: 'Maximum' }), 'SES feedback could not be processed after all retries.'),
      positiveAlarm('outbox-failed', customMetric('outboxFailed'), 'Mail outbox contains a newly failed delivery.'),
      positiveAlarm('outbox-overdue', customMetric('outboxOverdue'), 'Queued mail is more than five minutes overdue.'),
      positiveAlarm('outbox-stuck-sending', customMetric('outboxStuckSending'), 'Mail remained in sending state for more than five minutes.'),
      positiveAlarm('mail-feedback-critical', customMetric('MailFeedbackCritical'), 'SES reported a bounce, complaint, reject, or rendering failure.')
    ];
    const heartbeatAlarm = new cloudwatch.Alarm(this, 'OperationalMonitorHeartbeatAlarm', {
      alarmName: `${props.config.prefix}-operational-monitor-heartbeat`,
      alarmDescription: 'The operational monitor has not published a heartbeat for three minutes.',
      metric: new cloudwatch.Metric({
        namespace: `MSCEvent/${props.config.stage}`,
        metricName: 'MonitorHeartbeat',
        statistic: 'Sum',
        period: cdk.Duration.minutes(1)
      }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    });

    const dbInstance = props.dataStack.dbInstance;
    const databaseAlarms = [
      new cloudwatch.Alarm(this, 'DatabaseCpuAlarm', {
        alarmName: `${props.config.prefix}-database-cpu`,
        metric: dbInstance.metricCPUUtilization({ period: fiveMinutes }),
        threshold: 85,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING
      }),
      new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
        alarmName: `${props.config.prefix}-database-connections`,
        metric: dbInstance.metricDatabaseConnections({ period: fiveMinutes }),
        threshold: 70,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING
      }),
      new cloudwatch.Alarm(this, 'DatabaseFreeStorageAlarm', {
        alarmName: `${props.config.prefix}-database-free-storage`,
        metric: dbInstance.metricFreeStorageSpace({ period: fiveMinutes }),
        threshold: 2 * 1024 * 1024 * 1024,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING
      }),
      new cloudwatch.Alarm(this, 'DatabaseFreeMemoryAlarm', {
        alarmName: `${props.config.prefix}-database-free-memory`,
        metric: dbInstance.metricFreeableMemory({ period: fiveMinutes }),
        threshold: 128 * 1024 * 1024,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING
      }),
      new cloudwatch.Alarm(this, 'DatabaseCpuCreditAlarm', {
        alarmName: `${props.config.prefix}-database-cpu-credit`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'CPUCreditBalance',
          dimensionsMap: { DBInstanceIdentifier: dbInstance.instanceIdentifier },
          statistic: 'Minimum',
          period: fiveMinutes
        }),
        threshold: 5,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      })
    ];

    const alertAction = new cloudwatchActions.SnsAction(criticalAlertsTopic);
    const compositeAlarms = [
      new cloudwatch.CompositeAlarm(this, 'AvailabilityCompositeAlarm', {
        compositeAlarmName: `${props.config.prefix}-critical-availability`,
        alarmDescription: 'API availability or monitor heartbeat is degraded.',
        alarmRule: cloudwatch.AlarmRule.anyOf(apiLambdaErrors, apiGateway5xx, apiUnavailable, apiThrottles, heartbeatAlarm)
      }),
      new cloudwatch.CompositeAlarm(this, 'WorkflowCompositeAlarm', {
        compositeAlarmName: `${props.config.prefix}-critical-workflows`,
        alarmDescription: 'Signing, registration, or inspection workflow integrity is degraded.',
        alarmRule: cloudwatch.AlarmRule.anyOf(...workflowAlarms)
      }),
      new cloudwatch.CompositeAlarm(this, 'MailCompositeAlarm', {
        compositeAlarmName: `${props.config.prefix}-critical-mail`,
        alarmDescription: 'Mail queuing, dispatch, or provider feedback is degraded.',
        alarmRule: cloudwatch.AlarmRule.anyOf(...mailAlarms)
      }),
      new cloudwatch.CompositeAlarm(this, 'DatabaseCompositeAlarm', {
        compositeAlarmName: `${props.config.prefix}-critical-database`,
        alarmDescription: 'Database capacity is degraded.',
        alarmRule: cloudwatch.AlarmRule.anyOf(...databaseAlarms)
      })
    ];
    compositeAlarms.forEach((alarm) => {
      alarm.addAlarmAction(alertAction);
      alarm.addOkAction(alertAction);
    });

    new logs.QueryDefinition(this, 'OperationalErrorsQuery', {
      queryDefinitionName: `${props.config.prefix}/operational-errors`,
      logGroups: [apiHandler.logGroup, emailWorker.logGroup, sesFeedbackWorker.logGroup, operationalMonitor.logGroup, criticalAlertEmail.logGroup],
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

    const dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${props.config.prefix}-operations`,
      periodOverride: cloudwatch.PeriodOverride.AUTO
    });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 2,
        markdown: `# ${props.config.prefix} Operations\nLive-Zustand von API, Haftverzicht, technischer Abnahme, Mail und Datenbank.`
      }),
      new cloudwatch.AlarmStatusWidget({ title: 'Kritische Bereiche', alarms: compositeAlarms, width: 24, height: 6 }),
      new cloudwatch.GraphWidget({
        title: 'API Traffic, Fehler und Laufzeit',
        left: [this.api.metricCount({ period: fiveMinutes }), this.api.metricServerError({ period: fiveMinutes })],
        right: [this.api.metricLatency({ period: fiveMinutes, statistic: 'p95' })],
        width: 12
      }),
      new cloudwatch.GraphWidget({
        title: 'Mail-Outbox und Zustellfeedback',
        left: ['outboxFailed', 'outboxOverdue', 'outboxStuckSending', 'MailFeedbackCritical'].map(customMetric),
        width: 12
      }),
      new cloudwatch.GraphWidget({
        title: 'Geschäftskritische Workflows',
        left: ['signingEvidenceIncomplete', 'signingMailQueueFailed', 'inspectionNotificationMissing', 'registrationNotificationMissing', 's3EvidenceMissing'].map(customMetric),
        width: 12
      }),
      new cloudwatch.GraphWidget({
        title: 'Datenbank',
        left: [dbInstance.metricCPUUtilization({ period: fiveMinutes }), dbInstance.metricDatabaseConnections({ period: fiveMinutes })],
        right: [dbInstance.metricFreeableMemory({ period: fiveMinutes }), dbInstance.metricFreeStorageSpace({ period: fiveMinutes })],
        width: 12
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Letzte API-Fehler',
        logGroupNames: [apiAccessLogGroup.logGroupName],
        queryString: 'fields @timestamp, requestId, method, path, status, responseLatencyMs, integrationError | filter status >= 500 | sort @timestamp desc | limit 50',
        width: 24,
        height: 6
      })
    );

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? 'n/a',
      exportName: `${props.config.prefix}-api-url`
    });
  }
}
