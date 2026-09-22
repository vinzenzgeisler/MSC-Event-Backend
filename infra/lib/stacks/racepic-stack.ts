import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface RacePicStackProps extends StackProps {
  config: StageConfig;
}

function buildBucketName(base: string, account?: string): string {
  const suffix = (account ?? '').trim().toLowerCase();
  const full = suffix ? `${base}-${suffix}` : base;
  return full.slice(0, 63);
}

/**
 * RacePic Paket 1 (Fundament): Media-Bucket + CloudFront-CDN, Verarbeitungs-Queues und der
 * Fotografen-Cognito-Pool. Siehe docs/memory-bank/racepic-architecture.md Abschnitt B/E/F/G.
 *
 * Bewusst als eigener Stack (nicht Teil von StorageStack/AuthStack): RacePic ist ein optionales,
 * unabhaengig einschaltbares Modul (config.enableRacePic), das keine bestehenden Ressourcen
 * veraendert. Er wird von ApiStack referenziert, sobald RacePicApiHandler-Routen dazukommen
 * (siehe api-stack.ts).
 */
export class RacePicStack extends Stack {
  public readonly mediaBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly ingestQueue: sqs.Queue;
  public readonly analyzeQueue: sqs.Queue;
  public readonly matchQueue: sqs.Queue;
  public readonly photographerUserPool: cognito.UserPool;
  public readonly photographerUserPoolClientId: string;
  public readonly photographerUserPoolIssuerUrl: string;

  constructor(scope: Construct, id: string, props: RacePicStackProps) {
    super(scope, id, props);

    const removalPolicy = props.config.removalPolicy === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const account = props.config.env?.account;
    const corsOrigins = props.config.racepicMediaCorsAllowedOrigins;

    // --- Media-Bucket (Abschnitt G: Storage) -----------------------------------------------
    // Keine Versionierung (Kosten; Originale sind unveraendlich, siehe Architekturplan).
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: buildBucketName(`${props.config.prefix}-racepic-media`, account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: props.config.removalPolicy === 'destroy',
      lifecycleRules: [
        {
          id: 'expire-incoming-uploads',
          prefix: 'incoming/',
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(3)
        },
        {
          id: 'abort-incomplete-multipart-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(3)
        },
        {
          id: 'originals-to-glacier-ir',
          prefix: 'originals/',
          transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(30) }]
        },
        {
          id: 'derived-to-infrequent-access',
          prefix: 'derived/',
          transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) }]
        }
      ],
      ...(corsOrigins.length > 0
        ? {
            cors: [
              {
                allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.POST],
                allowedOrigins: corsOrigins,
                allowedHeaders: ['*'],
                exposedHeaders: ['ETag'],
                maxAge: 3600
              }
            ]
          }
        : {})
    });

    // --- CloudFront (Abschnitt G: /m/*, /p/* oeffentlich; /d/* signiert) -------------------
    // TODO vor Go-Live (Paket 4/9): racepicSigningPublicKeyPem in der Stage-Config setzen
    // (einmalig per `openssl genrsa`/`openssl rsa -pubout` erzeugtes Schluesselpaar, privater
    // Schluessel in Secrets Manager, siehe Architekturplan Abschnitt I "Originale"). Bis dahin
    // sind originals/ und derived/ zwar nicht oeffentlich (Bucket bleibt BLOCK_ALL + OAC), aber
    // noch nicht per Signed-URL/Cookie geschuetzt - kein Downloadendpunkt darf vorher live gehen.
    const signingPublicKeyPem = props.config.racepicSigningPublicKeyPem;
    let trustedKeyGroups: cloudfront.IKeyGroup[] | undefined;
    if (signingPublicKeyPem) {
      const publicKey = new cloudfront.PublicKey(this, 'DownloadSigningPublicKey', {
        encodedKey: signingPublicKeyPem,
        comment: 'RacePic download URL signing key (originals/derived)'
      });
      trustedKeyGroups = [new cloudfront.KeyGroup(this, 'DownloadSigningKeyGroup', { items: [publicKey] })];
    }

    const oacOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket);

    // CORS-Antwort-Header fuer die oeffentlichen Manifest-/Bild-Pfade (Luecke, gefunden bei der
    // Entwicklungsumgebungs-Vorbereitung am 2026-09-22): der Website-Client liest Manifeste per
    // `fetch()` (siehe publicClient.ts im msc-website-Repo) - das ist ein Cross-Origin-Request
    // (die Website laeuft auf einer anderen Domain als das CDN), Browser verlangen dafuer
    // `Access-Control-Allow-Origin` in der CloudFront-Antwort. `<img>`-Tags fuer `public/*`
    // brauchen das eigentlich nicht, bekommen die Policy hier aber ebenfalls (kein Mehraufwand,
    // zukunftssicher falls Bilder einmal per fetch/canvas verarbeitet werden). Nutzt dieselbe
    // Origin-Liste wie das S3-Bucket-CORS oben (`racepicMediaCorsAllowedOrigins`), auch wenn die
    // beiden technisch unabhaengig sind (S3-CORS gilt nur bei direktem S3-Zugriff, hier geht der
    // Browser aber immer ueber CloudFront/OAC).
    const manifestCorsResponseHeadersPolicy =
      corsOrigins.length > 0
        ? new cloudfront.ResponseHeadersPolicy(this, 'ManifestCorsPolicy', {
            responseHeadersPolicyName: `${props.config.prefix}-racepic-manifest-cors`,
            corsBehavior: {
              accessControlAllowOrigins: corsOrigins,
              accessControlAllowMethods: ['GET', 'HEAD'],
              accessControlAllowHeaders: ['*'],
              accessControlAllowCredentials: false,
              originOverride: true
            }
          })
        : undefined;

    this.distribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      comment: `${props.config.prefix}-racepic-media`,
      // Default: alles, was nicht explizit als oeffentlich gelistet ist (u.a. originals/, derived/,
      // analysis/), verlangt eine gueltige Signatur. Sicherer Default statt Opt-in pro Pfad.
      defaultBehavior: {
        origin: oacOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        trustedKeyGroups
      },
      additionalBehaviors: {
        // Event-/Teilnehmer-Manifeste (Abschnitt H): kurze TTL, damit Publish-Updates schnell sichtbar sind.
        'manifests/*': {
          origin: oacOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: new cloudfront.CachePolicy(this, 'ManifestCachePolicy', {
            cachePolicyName: `${props.config.prefix}-racepic-manifest-cache`,
            defaultTtl: Duration.seconds(60),
            minTtl: Duration.seconds(0),
            maxTtl: Duration.minutes(5)
          }),
          responseHeadersPolicy: manifestCorsResponseHeadersPolicy
        },
        // Veroeffentlichte Thumbnails/Previews: oeffentlich, lange Cache-TTL.
        'public/*': {
          origin: oacOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: manifestCorsResponseHeadersPolicy
        }
      }
    });

    // --- Verarbeitungs-Queues (Abschnitt F: Pipeline-Mechanik) ------------------------------
    // Worker-Lambdas (Ingest/Analyze/Match/Publish) folgen in Paket 4/6; hier nur die Warteschlangen,
    // damit RacePicApiHandler (Paket 1/3) bereits Upload-Abschluesse einreihen kann.
    const makeStage = (name: 'Ingest' | 'Analyze' | 'Match') => {
      const dlq = new sqs.Queue(this, `${name}DeadLetterQueue`, {
        queueName: `${props.config.prefix}-racepic-${name.toLowerCase()}-dlq`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(14)
      });
      // Kein SNS-Alarmziel: das Projekt hat aktuell keine zentrale Ops-Alarmierung (siehe restlicher
      // infra-Code). Alarm ist als CloudWatch-Metrik/-Zustand sichtbar; Aktion nachruesten, sobald
      // eine Ops-Benachrichtigung (z. B. gemeinsam mit anderen Workern) eingefuehrt wird.
      new cloudwatch.Alarm(this, `${name}DeadLetterAlarm`, {
        alarmName: `${props.config.prefix}-racepic-${name.toLowerCase()}-dlq-not-empty`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });
      return new sqs.Queue(this, `${name}Queue`, {
        queueName: `${props.config.prefix}-racepic-${name.toLowerCase()}`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        visibilityTimeout: Duration.minutes(5),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 }
      });
    };
    this.ingestQueue = makeStage('Ingest');
    this.analyzeQueue = makeStage('Analyze');
    this.matchQueue = makeStage('Match');

    // --- Fotografen-Identitaet (Abschnitt E) ------------------------------------------------
    // Eigener Pool statt Gruppe im Staff-Pool: Blast-Radius-Trennung, siehe Architekturplan.
    // Passwordless: EMAIL_OTP + Passkey. `password: true` bleibt aus AWS-API-Sicht Pflichtfeld
    // (siehe CDK-Doku zu AllowedFirstAuthFactors); Fotografen erhalten praktisch nie ein Passwort,
    // da Profile ausschliesslich ueber den Einladungs-/Claim-Flow (Paket 2) angelegt werden.
    this.photographerUserPool = new cognito.UserPool(this, 'PhotographerUserPool', {
      userPoolName: `${props.config.prefix}-racepic-photographer-pool`,
      selfSignUpEnabled: true,
      mfa: cognito.Mfa.OPTIONAL,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true }
      },
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true,
          emailOtp: true,
          passkey: true
        }
      },
      passkeyRelyingPartyId: props.config.racepicPhotographerRelyingPartyId,
      passkeyUserVerification: cognito.PasskeyUserVerification.PREFERRED,
      removalPolicy
    });

    // L1-Client: die L2-`UserPoolClient`-Props kennen `ALLOW_USER_AUTH` (choice-based sign-in)
    // in dieser CDK-Version noch nicht, siehe aws-cognito/lib/user-pool-client.d.ts.
    const photographerClient = new cognito.CfnUserPoolClient(this, 'PhotographerUserPoolClient', {
      clientName: `${props.config.prefix}-racepic-photographer-client`,
      userPoolId: this.photographerUserPool.userPoolId,
      generateSecret: false,
      explicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      preventUserExistenceErrors: 'ENABLED',
      accessTokenValidity: 15,
      idTokenValidity: 15,
      refreshTokenValidity: 30,
      tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'days' }
    });
    this.photographerUserPoolClientId = photographerClient.ref;
    this.photographerUserPoolIssuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.photographerUserPool.userPoolId}`;

    // --- Budget (Paket 9: Betrieb) -----------------------------------------------------------
    // Abschnitt M des Architekturplans nennt Rekognition/Bedrock/CloudFront als groesste
    // Kostentreiber - dieses Budget filtert gezielt auf diese Services statt auf das gesamte
    // AWS-Konto, damit ein Kostenschub in RacePic nicht in anderen Budgets untergeht. Keine
    // Cost-Anomaly-Detection (aws-ce) hier: brauchte eine SNS-Topic-Abo-Bestaetigung, die in dieser
    // Umgebung nicht verifizierbar war - siehe offener Punkt in der Progress-Datei.
    if (props.config.orgaNotificationRecipients.length > 0) {
      new budgets.CfnBudget(this, 'RacePicMonthlyBudget', {
        budget: {
          budgetName: `${props.config.prefix}-racepic-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.config.racepicMonthlyBudgetUsd, unit: 'USD' },
          costFilters: { Service: ['Amazon Rekognition', 'Amazon Bedrock', 'Amazon CloudFront'] }
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
            subscribers: props.config.orgaNotificationRecipients.map((email) => ({ subscriptionType: 'EMAIL', address: email }))
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
            subscribers: props.config.orgaNotificationRecipients.map((email) => ({ subscriptionType: 'EMAIL', address: email }))
          }
        ]
      });
    }

    new CfnOutput(this, 'MediaBucketName', { value: this.mediaBucket.bucketName });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'IngestQueueUrl', { value: this.ingestQueue.queueUrl });
    new CfnOutput(this, 'AnalyzeQueueUrl', { value: this.analyzeQueue.queueUrl });
    new CfnOutput(this, 'MatchQueueUrl', { value: this.matchQueue.queueUrl });
    new CfnOutput(this, 'PhotographerUserPoolId', { value: this.photographerUserPool.userPoolId });
    new CfnOutput(this, 'PhotographerUserPoolClientId', { value: this.photographerUserPoolClientId });
  }
}
