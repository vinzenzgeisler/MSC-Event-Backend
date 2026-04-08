import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { Construct } from 'constructs';

export class AiModuleSnippet extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const apiHandler = new NodejsFunction(this, 'AiApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../src/example-handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        AI_BEDROCK_MODEL_ID: 'eu.amazon.nova-micro-v1:0',
        AI_BEDROCK_REGION: 'eu-central-1',
        AI_INBOX_IMAP_SECRET_ARN: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:project/dev/ai/inbox-imap',
        AI_INBOX_IMAP_MAILBOX: 'INBOX'
      }
    });

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*']
      })
    );

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*']
      })
    );

    const mailInboxPoller = new NodejsFunction(this, 'MailInboxPoller', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../src/mailInboxPoller.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(45),
      memorySize: 256,
      environment: {
        AI_INBOX_IMAP_SECRET_ARN: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:project/dev/ai/inbox-imap',
        AI_INBOX_IMAP_MAILBOX: 'INBOX',
        AI_INBOX_IMAP_MAILBOX_KEY: 'project-dev-imap'
      }
    });

    mailInboxPoller.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*']
      })
    );

    new events.Rule(this, 'MailInboxPollerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(mailInboxPoller)]
    });
  }
}
