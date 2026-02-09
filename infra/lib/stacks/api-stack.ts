import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'ApiLambdaSecurityGroup', {
      vpc: props.dataStack.vpc,
      securityGroupName: `${props.config.prefix}-api-lambda-sg`,
      description: 'Security Group for API Lambda function'
    });

    props.dataStack.dbSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(5432), 'Allow API Lambda to connect to PostgreSQL');

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../services/api/src/handler.ts'),
      handler: 'handler',
      functionName: `${props.config.prefix}-api-handler`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        STAGE: props.config.stage,
        DB_SECRET_ARN: props.dataStack.dbSecret.secretArn,
        ASSETS_BUCKET: props.storageStack.assetsBucket.bucketName,
        DOCUMENTS_BUCKET: props.storageStack.documentsBucket.bucketName,
        COGNITO_ISSUER: props.authStack.userPoolIssuerUrl
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

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? 'n/a',
      exportName: `${props.config.prefix}-api-url`
    });
  }
}
