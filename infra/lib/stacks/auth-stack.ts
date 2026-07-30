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

    const supportReadScope = new cognito.ResourceServerScope({
      scopeName: 'entries.read',
      scopeDescription: 'Read current-event registration data for the MSC support workflow'
    });
    const supportResourceServer = this.userPool.addResourceServer('SupportResourceServer', {
      identifier: 'msc-support',
      userPoolResourceServerName: `${props.config.prefix}-support-api`,
      scopes: [supportReadScope]
    });
    const automationScopeDefinitions = [
      ['dashboard.read', 'Read dashboard aggregates'],
      ['entries.read', 'Read registration and participant data'],
      ['entries.payment.read', 'Read invoices and payment history'],
      ['entries.status.write', 'Change registration and acceptance status'],
      ['entries.checkin.write', 'Change check-in identity state'],
      ['entries.payment.write', 'Change payment state and amounts'],
      ['entries.notes.write', 'Change registration notes and class assignment'],
      ['entries.delete', 'Soft-delete and restore registrations'],
      ['communication.read', 'Read communication configuration and outbox state'],
      ['communication.write', 'Create or retry communication actions'],
      ['exports.read', 'Read export metadata'],
      ['exports.write', 'Create exports'],
      ['settings.read', 'Read event, class, pricing and system settings'],
      ['settings.write', 'Change event, class, pricing and system settings'],
      ['iam.read', 'Read roles and users'],
      ['iam.write', 'Change users, roles and account status'],
      ['inspection.read', 'Read technical inspection data'],
      ['inspection.write', 'Change technical inspection data']
    ] as const;
    const automationScopes = automationScopeDefinitions.map(
      ([scopeName, scopeDescription]) => new cognito.ResourceServerScope({
        scopeName,
        scopeDescription
      })
    );
    const automationResourceServer = this.userPool.addResourceServer(
      'AutomationResourceServer',
      {
        identifier: 'msc-automation',
        userPoolResourceServerName: `${props.config.prefix}-automation-api`,
        scopes: automationScopes
      }
    );
    this.supportUserPoolClient = new cognito.UserPoolClient(
      this,
      'SupportUserPoolClient',
      {
        userPool: this.userPool,
        userPoolClientName: `${props.config.prefix}-support-machine-client`,
        generateSecret: true,
        oAuth: {
          flows: {
            clientCredentials: true
          },
          scopes: [
            cognito.OAuthScope.resourceServer(
              supportResourceServer,
              supportReadScope
            ),
            ...automationScopes.map((scope) =>
              cognito.OAuthScope.resourceServer(
                automationResourceServer,
                scope
              ))
          ]
        },
        accessTokenValidity: Duration.minutes(5),
        enableTokenRevocation: true
      }
    );

    const userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix
      }
    });

    ['admin', 'editor', 'viewer', 'technical_inspector'].forEach((groupName) => {
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
