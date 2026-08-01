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
  public readonly supportUserPoolClient: cognito.UserPoolClient;
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

    const supportScopeDefinitions: Array<{ name: string; description: string }> = [
      { name: 'dashboard.read',        description: 'Read dashboard data' },
      { name: 'entries.read',          description: 'Read registration entries' },
      { name: 'entries.status.write',  description: 'Update entry acceptance status' },
      { name: 'entries.checkin.write', description: 'Update entry check-in status' },
      { name: 'entries.payment.write', description: 'Update entry payment status' },
      { name: 'entries.notes.write',   description: 'Update entry notes' },
      { name: 'entries.delete',        description: 'Soft-delete and restore entries' },
      { name: 'communication.read',    description: 'Read communication data' },
      { name: 'communication.write',   description: 'Send communications' },
      { name: 'exports.read',          description: 'Read export data' },
      { name: 'exports.write',         description: 'Trigger exports' },
      { name: 'settings.read',         description: 'Read event settings' },
      { name: 'settings.write',        description: 'Update event settings' },
      { name: 'iam.read',              description: 'Read IAM accounts' },
      { name: 'iam.write',             description: 'Manage IAM accounts' },
      { name: 'inspection.read',       description: 'Read technical inspection data' },
      { name: 'inspection.write',      description: 'Update technical inspection data' },
    ];
    const supportScopes = supportScopeDefinitions.map(
      (def) =>
        new cognito.ResourceServerScope({
          scopeName: def.name,
          scopeDescription: def.description
        })
    );
    const supportResourceServer = this.userPool.addResourceServer('SupportResourceServer', {
      identifier: 'msc-support',
      userPoolResourceServerName: `${props.config.prefix}-support-api`,
      scopes: supportScopes
    });
    this.supportUserPoolClient = new cognito.UserPoolClient(this, 'SupportUserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${props.config.prefix}-support-machine-client`,
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true
        },
        scopes: supportScopes.map((s) =>
          cognito.OAuthScope.resourceServer(supportResourceServer, s)
        )
      },
      accessTokenValidity: Duration.minutes(15),
      enableTokenRevocation: true
    });

    const userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix
      }
    });

    ['admin', 'editor', 'viewer', 'technical_inspector', 'marshal_manager'].forEach((groupName) => {
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

    new CfnOutput(this, 'SupportUserPoolClientId', {
      value: this.supportUserPoolClient.userPoolClientId,
      exportName: `${props.config.prefix}-support-user-pool-client-id`
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
