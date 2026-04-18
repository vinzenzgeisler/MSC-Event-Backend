import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface AuthStackProps extends StackProps {
  config: StageConfig;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolIssuerUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.config.prefix}-user-pool`,
      selfSignUpEnabled: false,
      mfa: cognito.Mfa.OFF,
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

    const callbackUrls = props.config.cognitoCallbackUrls;
    const logoutUrls = props.config.cognitoLogoutUrls;
    if (callbackUrls.length === 0) {
      throw new Error(
        `Missing cognitoCallbackUrls in infra/lib/config/${props.config.stage}.ts.`
      );
    }
    if (logoutUrls.length === 0) {
      throw new Error(
        `Missing cognitoLogoutUrls in infra/lib/config/${props.config.stage}.ts.`
      );
    }

    const domainPrefix = props.config.cognitoDomainPrefix.toLowerCase();
    if (!/^[a-z0-9-]{1,63}$/.test(domainPrefix)) {
      throw new Error(`Invalid Cognito domain prefix "${domainPrefix}". Use lowercase letters, numbers and hyphens (1-63 chars).`);
    }

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${props.config.prefix}-admin-client`,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(props.config.cognitoRefreshTokenDays ?? 30),
      enableTokenRevocation: true
    });

    const userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix
      }
    });

    ['admin', 'editor', 'viewer'].forEach((groupName) => {
      new cognito.CfnUserPoolGroup(this, `${groupName}Group`, {
        groupName,
        userPoolId: this.userPool.userPoolId
      });
    });

    this.userPoolIssuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;
    const hostedUiBaseUrl = userPoolDomain.baseUrl();

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${props.config.prefix}-user-pool-id`
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${props.config.prefix}-user-pool-client-id`
    });

    new CfnOutput(this, 'UserPoolIssuerUrl', {
      value: this.userPoolIssuerUrl,
      exportName: `${props.config.prefix}-user-pool-issuer-url`
    });

    new CfnOutput(this, 'HostedUiBaseUrl', {
      value: hostedUiBaseUrl,
      exportName: `${props.config.prefix}-hosted-ui-base-url`
    });

    new CfnOutput(this, 'HostedUiAuthorizeUrl', {
      value: `${hostedUiBaseUrl}/oauth2/authorize`,
      exportName: `${props.config.prefix}-hosted-ui-authorize-url`
    });

    new CfnOutput(this, 'HostedUiTokenUrl', {
      value: `${hostedUiBaseUrl}/oauth2/token`,
      exportName: `${props.config.prefix}-hosted-ui-token-url`
    });

    new CfnOutput(this, 'HostedUiLogoutUrl', {
      value: `${hostedUiBaseUrl}/logout`,
      exportName: `${props.config.prefix}-hosted-ui-logout-url`
    });
  }
}
