import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as alarmActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';
import { AuthStack } from './auth-stack';

interface NewsletterStandbyStackProps extends StackProps {
  config: StageConfig;
  authStack: AuthStack;
  writeEnabled: boolean;
}

export class NewsletterStandbyStack extends Stack {
  readonly table: dynamodb.Table;
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: NewsletterStandbyStackProps) {
    super(scope, id, props);
    const { config, authStack } = props;
    const dependencies = path.join(__dirname, '../../../package-lock.json');
    this.table = new dynamodb.Table(this, 'NewsletterTable', {
      tableName: `${config.prefix}-newsletter-standby`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: config.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const deadLetters = new sqs.Queue(this, 'NewsletterDeadLetters', {
      queueName: `${config.prefix}-newsletter-standby-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14)
    });
    const alerts = new sns.Topic(this, 'NewsletterOpsAlerts', {
      topicName: `${config.prefix}-newsletter-standby-alerts`
    });
    for (const recipient of config.orgaNotificationRecipients) {
      alerts.addSubscription(new subscriptions.EmailSubscription(recipient));
    }
    const deadLetterAlarm = new cloudwatch.Alarm(this, 'NewsletterDeadLetterAlarm', {
      metric: deadLetters.metricApproximateNumberOfMessagesVisible(),
      threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    });
    deadLetterAlarm.addAlarmAction(new alarmActions.SnsAction(alerts));
    const feedbackTopic = new sns.Topic(this, 'NewsletterFeedbackTopic', {
      topicName: `${config.prefix}-newsletter-standby-feedback`
    });
    const configurationSet = new ses.ConfigurationSet(this, 'NewsletterConfigurationSet', {
      configurationSetName: `${config.prefix}-newsletter-standby-mail-events`
    });
    configurationSet.addEventDestination('NewsletterFeedbackDestination', {
      destination: ses.EventDestination.snsTopic(feedbackTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT]
    });
    const commonEnvironment = {
      NEWSLETTER_TABLE_NAME: this.table.tableName,
      NEWSLETTER_PUBLIC_BASE_URL: config.newsletterPublicBaseUrl,
      NEWSLETTER_FROM_EMAIL: config.newsletterFromEmail,
      NEWSLETTER_CONFIGURATION_SET: configurationSet.configurationSetName,
      NEWSLETTER_ALLOWED_ORIGINS: config.assetsCorsAllowedOrigins.join(','),
      NEWSLETTER_WRITE_ENABLED: props.writeEnabled ? 'true' : 'false'
    };
    const apiHandler = new NodejsFunction(this, 'NewsletterApiHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `${config.prefix}-newsletter-standby-api`,
      entry: path.join(__dirname, '../../../api/src/standbyNewsletter/handler.ts'),
      handler: 'handler', depsLockFilePath: dependencies,
      timeout: cdk.Duration.seconds(20), memorySize: 256,
      environment: commonEnvironment
    });
    const sender = new NodejsFunction(this, 'NewsletterMailSender', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/standbyNewsletter/mail.ts'),
      handler: 'mailStreamHandler', depsLockFilePath: dependencies,
      timeout: cdk.Duration.seconds(30), memorySize: 256,
      environment: commonEnvironment
    });
    const feedback = new NodejsFunction(this, 'NewsletterFeedbackHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/standbyNewsletter/mail.ts'),
      handler: 'feedbackHandler', depsLockFilePath: dependencies,
      timeout: cdk.Duration.seconds(30), memorySize: 256,
      environment: commonEnvironment
    });
    const retention = new NodejsFunction(this, 'NewsletterRetentionHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../../api/src/standbyNewsletter/retention.ts'),
      handler: 'retentionHandler', depsLockFilePath: dependencies,
      timeout: cdk.Duration.minutes(5), memorySize: 256,
      environment: commonEnvironment
    });
    for (const fn of [apiHandler, sender, feedback, retention]) this.table.grantReadWriteData(fn);
    new events.Rule(this, 'NewsletterRetentionSchedule', {
      schedule: events.Schedule.cron({ minute: '15', hour: '3' }),
      targets: [new targets.LambdaFunction(retention)]
    });
    sender.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'], resources: ['*']
    }));
    sender.addEventSource(new eventSources.DynamoEventSource(this.table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 1, retryAttempts: 5, onFailure: new eventSources.SqsDlq(deadLetters)
    }));
    feedback.addEventSource(new eventSources.SnsEventSource(feedbackTopic, {
      deadLetterQueue: deadLetters
    }));
    this.api = new apigwv2.HttpApi(this, 'NewsletterHttpApi', {
      apiName: `${config.prefix}-newsletter-standby-api`,
      corsPreflight: {
        allowOrigins: config.assetsCorsAllowedOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.seconds(600)
      }
    });
    const integration = new HttpLambdaIntegration('NewsletterIntegration', apiHandler);
    for (const [route, method] of [
      ['/public/newsletter/config', apigwv2.HttpMethod.GET],
      ['/public/newsletter/subscriptions', apigwv2.HttpMethod.POST],
      ['/public/newsletter/confirm', apigwv2.HttpMethod.POST],
      ['/public/newsletter/unsubscribe-request', apigwv2.HttpMethod.POST],
      ['/public/newsletter/unsubscribe', apigwv2.HttpMethod.POST]
    ] as const) this.api.addRoutes({ path: route, methods: [method], integration });
    const jwt = new authorizers.HttpJwtAuthorizer('NewsletterCognitoAuthorizer', authStack.userPoolIssuerUrl, {
      jwtAudience: [authStack.userPoolClient.userPoolClientId, authStack.supportUserPoolClient.userPoolClientId]
    });
    for (const [route, method] of [
      ['/admin/newsletter/overview', apigwv2.HttpMethod.GET],
      ['/admin/newsletter/subscribers', apigwv2.HttpMethod.GET],
      ['/admin/newsletter/subscribers/{id}/unsubscribe', apigwv2.HttpMethod.POST],
      ['/admin/newsletter/subscribers/{id}/resend-verification', apigwv2.HttpMethod.POST]
    ] as const) this.api.addRoutes({ path: route, methods: [method], integration, authorizer: jwt });
    new cdk.CfnOutput(this, 'NewsletterApiUrl', { value: this.api.apiEndpoint });
    new cdk.CfnOutput(this, 'NewsletterTableName', { value: this.table.tableName });
  }
}
