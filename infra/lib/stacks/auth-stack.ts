import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

interface AuthStackProps extends StackProps {
  prefix: string;
  stage: 'dev' | 'prod';
}

const parseCsvEnv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const getStageEnv = (name: string, stage: 'dev' | 'prod'): string | undefined => {
  const stageValue = process.env[`${name}_${stage.toUpperCase()}`];
  if (stageValue && stageValue.trim().length > 0) {
    return stageValue;
  }
  const fallback = process.env[name];
  if (fallback && fallback.trim().length > 0) {
    return fallback;
  }
  return undefined;
};

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

    const callbackUrls = parseCsvEnv(getStageEnv('COGNITO_CALLBACK_URLS', props.stage));
    const logoutUrls = parseCsvEnv(getStageEnv('COGNITO_LOGOUT_URLS', props.stage));
    if (callbackUrls.length === 0) {
      throw new Error(`Missing Cognito callback URLs for stage ${props.stage}. Set COGNITO_CALLBACK_URLS_${props.stage.toUpperCase()} or COGNITO_CALLBACK_URLS.`);
    }
    if (logoutUrls.length === 0) {
      throw new Error(`Missing Cognito logout URLs for stage ${props.stage}. Set COGNITO_LOGOUT_URLS_${props.stage.toUpperCase()} or COGNITO_LOGOUT_URLS.`);
    }

    const defaultDomainPrefix = `${props.prefix}-auth`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 63);
    const configuredDomainPrefix = getStageEnv('COGNITO_DOMAIN_PREFIX', props.stage);
    const domainPrefix = (configuredDomainPrefix ?? defaultDomainPrefix).toLowerCase();
    if (!/^[a-z0-9-]{1,63}$/.test(domainPrefix)) {
      throw new Error(`Invalid Cognito domain prefix "${domainPrefix}". Use lowercase letters, numbers and hyphens (1-63 chars).`);
    }

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${props.prefix}-admin-client`,
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
      preventUserExistenceErrors: true
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

    new CfnOutput(this, 'HostedUiBaseUrl', {
      value: hostedUiBaseUrl,
      exportName: `${props.prefix}-hosted-ui-base-url`
    });

    new CfnOutput(this, 'HostedUiAuthorizeUrl', {
      value: `${hostedUiBaseUrl}/oauth2/authorize`,
      exportName: `${props.prefix}-hosted-ui-authorize-url`
    });

    new CfnOutput(this, 'HostedUiTokenUrl', {
      value: `${hostedUiBaseUrl}/oauth2/token`,
      exportName: `${props.prefix}-hosted-ui-token-url`
    });

    new CfnOutput(this, 'HostedUiLogoutUrl', {
      value: `${hostedUiBaseUrl}/logout`,
      exportName: `${props.prefix}-hosted-ui-logout-url`
    });
  }
}
