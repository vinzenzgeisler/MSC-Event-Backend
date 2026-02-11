import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface DataStackProps extends StackProps {
  config: StageConfig;
}

export class DataStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly apiLambdaSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecret: rds.DatabaseSecret;
  public readonly dbInstance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.config.prefix}-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED
        }
      ]
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${props.config.prefix}-db-sg`,
      allowAllOutbound: false,
      description: 'Security Group for PostgreSQL RDS instance'
    });

    this.apiLambdaSecurityGroup = new ec2.SecurityGroup(this, 'ApiLambdaSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${props.config.prefix}-api-lambda-sg`,
      description: 'Security Group for API Lambda function'
    });

    this.dbSecurityGroup.addIngressRule(
      this.apiLambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow API Lambda to connect to PostgreSQL'
    );

    this.dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
      username: 'eventadmin',
      secretName: `${props.config.prefix}/rds/postgres`
    });

    const instanceType = ec2.InstanceType.of(
      ec2.InstanceClass[props.config.dbInstanceType.instanceClass as keyof typeof ec2.InstanceClass],
      ec2.InstanceSize[props.config.dbInstanceType.instanceSize as keyof typeof ec2.InstanceSize]
    );

    this.dbInstance = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: `${props.config.prefix}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16
      }),
      vpc: this.vpc,
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      vpcSubnets: {
        subnetType: props.config.dbPublicAccess ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_ISOLATED
      },
      securityGroups: [this.dbSecurityGroup],
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      databaseName: props.config.dbName,
      instanceType,
      backupRetention: Duration.days(7),
      removalPolicy: props.config.removalPolicy === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      deleteAutomatedBackups: props.config.removalPolicy === 'destroy',
      deletionProtection: props.config.removalPolicy !== 'destroy',
      publiclyAccessible: props.config.dbPublicAccess,
      storageEncrypted: true
    });

    new CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      exportName: `${props.config.prefix}-db-secret-arn`
    });

    new CfnOutput(this, 'DbEndpoint', {
      value: this.dbInstance.instanceEndpoint.hostname,
      exportName: `${props.config.prefix}-db-endpoint`
    });

    new CfnOutput(this, 'DbName', {
      value: props.config.dbName,
      exportName: `${props.config.prefix}-db-name`
    });

    new CfnOutput(this, 'DbSecurityGroupId', {
      value: this.dbSecurityGroup.securityGroupId,
      exportName: `${props.config.prefix}-db-security-group-id`
    });
  }
}
