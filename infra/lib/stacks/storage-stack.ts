import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface StorageStackProps extends StackProps {
  config: StageConfig;
}

export class StorageStack extends Stack {
  public readonly assetsBucket: s3.Bucket;
  public readonly documentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const removalPolicy = props.config.removalPolicy === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const assetsCorsOrigins = props.config.assetsCorsAllowedOrigins;

    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `${props.config.prefix}-assets`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: props.config.removalPolicy === 'destroy',
      lifecycleRules: [],
      ...(assetsCorsOrigins.length > 0
        ? {
            cors: [
              {
                allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
                allowedOrigins: assetsCorsOrigins,
                allowedHeaders: ['*'],
                exposedHeaders: ['ETag'],
                maxAge: 3600
              }
            ]
          }
        : {})
    });

    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `${props.config.prefix}-documents`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: props.config.removalPolicy === 'destroy',
      lifecycleRules: [
        {
          id: 'expire-export-artifacts',
          enabled: true,
          prefix: 'exports/',
          expiration: Duration.days(90)
        }
      ]
    });

    new CfnOutput(this, 'AssetsBucketName', {
      value: this.assetsBucket.bucketName,
      exportName: `${props.config.prefix}-assets-bucket-name`
    });

    new CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      exportName: `${props.config.prefix}-documents-bucket-name`
    });
  }
}
