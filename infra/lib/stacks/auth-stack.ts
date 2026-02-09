import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

interface AuthStackProps extends StackProps {
  prefix: string;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolIssuerUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.prefix}-user-pool`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true
      }
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${props.prefix}-admin-client`,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      generateSecret: false,
      preventUserExistenceErrors: true
    });

    ['admin', 'checkin', 'viewer'].forEach((groupName) => {
      new cognito.CfnUserPoolGroup(this, `${groupName}Group`, {
        groupName,
        userPoolId: this.userPool.userPoolId
      });
    });

    this.userPoolIssuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${props.prefix}-user-pool-id`
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${props.prefix}-user-pool-client-id`
    });

    new CfnOutput(this, 'UserPoolIssuerUrl', {
      value: this.userPoolIssuerUrl,
      exportName: `${props.prefix}-user-pool-issuer-url`
    });
  }
}
