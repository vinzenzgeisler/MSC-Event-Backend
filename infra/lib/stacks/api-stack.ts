import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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

export class ApiStack extends Stack {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaSecurityGroup = props.dataStack.apiLambdaSecurityGroup;
    const sslRejectUnauthorized = props.config.stage === 'prod' ? 'true' : 'false';

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../api/src/handler.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-api-handler`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: props.dataStack.dbSecret.secretArn,
        DB_SSL: 'true',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        ASSETS_BUCKET: props.storageStack.assetsBucket.bucketName,
        DOCUMENTS_BUCKET: props.storageStack.documentsBucket.bucketName,
        COGNITO_ISSUER: props.authStack.userPoolIssuerUrl,
        SES_FROM_EMAIL: process.env.SES_FROM_EMAIL ?? ''
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      vpc: props.dataStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroups: [lambdaSecurityGroup]
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
        DB_SECRET_ARN: props.dataStack.dbSecret.secretArn,
        DB_SSL: 'true',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        SES_FROM_EMAIL: process.env.SES_FROM_EMAIL ?? '',
        EMAIL_WORKER_BATCH_SIZE: '20'
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      vpc: props.dataStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroups: [lambdaSecurityGroup]
    });

    const paymentReminderScheduler = new NodejsFunction(this, 'PaymentReminderScheduler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../api/src/jobs/paymentReminderScheduler.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-payment-reminder`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: props.dataStack.dbSecret.secretArn,
        DB_SSL: 'true',
        DB_SSL_REJECT_UNAUTHORIZED: sslRejectUnauthorized,
        PAYMENT_REMINDER_TEMPLATE_ID: process.env.PAYMENT_REMINDER_TEMPLATE_ID ?? 'payment-reminder',
        PAYMENT_REMINDER_SUBJECT: process.env.PAYMENT_REMINDER_SUBJECT ?? 'Zahlungserinnerung'
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: false
      },
      vpc: props.dataStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroups: [lambdaSecurityGroup]
    });

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.dataStack.dbSecret.secretArn]
      })
    );

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

    [apiHandler, emailWorker, paymentReminderScheduler].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: ['*']
        })
      );
    });

    [emailWorker, paymentReminderScheduler].forEach((fn) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.dataStack.dbSecret.secretArn]
        })
      );
    });

    new events.Rule(this, 'EmailWorkerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(emailWorker)]
    });

    new events.Rule(this, 'PaymentReminderSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new targets.LambdaFunction(paymentReminderScheduler)]
    });

    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', apiHandler);

    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.config.prefix}-http-api`
    });

    this.api.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
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
      path: '/admin/payment/reminders/queue',
      methods: [apigwv2.HttpMethod.POST],
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
      path: '/admin/documents/{id}/download',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? 'n/a',
      exportName: `${props.config.prefix}-api-url`
    });
  }
}
