import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface DataStackProps extends StackProps {
  config: StageConfig;
}

export class DataStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly apiLambdaSecurityGroup?: ec2.SecurityGroup;
  public readonly dbSecret?: rds.DatabaseSecret;
  public readonly dbInstance?: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const devCleanupEnabled = props.config.devCleanupEnabled;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.config.prefix}-vpc`,
      maxAzs: props.config.maxAzs,
      natGateways: props.config.enableNatGateway ? 1 : 0,
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

    if (props.config.apiInVpc && props.config.enableApi) {
      this.apiLambdaSecurityGroup = new ec2.SecurityGroup(this, 'ApiLambdaSecurityGroup', {
        vpc: this.vpc,
        securityGroupName: `${props.config.prefix}-api-lambda-sg`,
        description: 'Security Group for API Lambda function'
      });
    }

    if (props.config.stage === 'dev' && devCleanupEnabled) {
      const cleanupFunction = new lambda.Function(this, 'DevCostCleanupFunction', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        timeout: Duration.minutes(2),
        code: lambda.Code.fromInline(`
import boto3

def handler(event, context):
    ec2 = boto3.client('ec2')
    rds = boto3.client('rds')

    # Release unattached Elastic IPs that are marked for AutoCleanup.
    addresses = ec2.describe_addresses().get('Addresses', [])
    for address in addresses:
        tags = {tag.get('Key'): tag.get('Value') for tag in address.get('Tags', [])}
        if tags.get('AutoCleanup') == 'true' and tags.get('Project') == '${props.config.prefix}' and not address.get('AssociationId'):
            allocation_id = address.get('AllocationId')
            if allocation_id:
                ec2.release_address(AllocationId=allocation_id)

    # Stop tagged dev RDS instances to avoid always-on compute.
    instances = rds.describe_db_instances().get('DBInstances', [])
    for instance in instances:
        arn = instance.get('DBInstanceArn')
        if not arn:
            continue
        tag_list = rds.list_tags_for_resource(ResourceName=arn).get('TagList', [])
        tags = {tag.get('Key'): tag.get('Value') for tag in tag_list}
        if tags.get('AutoCleanup') == 'true' and tags.get('Project') == '${props.config.prefix}' and instance.get('DBInstanceStatus') == 'available':
            rds.stop_db_instance(DBInstanceIdentifier=instance['DBInstanceIdentifier'])
`),
      });

      cleanupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:DescribeAddresses', 'ec2:ReleaseAddress'],
          resources: ['*']
        })
      );
      cleanupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['rds:DescribeDBInstances', 'rds:ListTagsForResource', 'rds:StopDBInstance'],
          resources: ['*']
        })
      );

      new events.Rule(this, 'DevCostCleanupSchedule', {
        schedule: events.Schedule.rate(Duration.hours(6)),
        targets: [new targets.LambdaFunction(cleanupFunction)]
      });
    }

    if (!props.config.enableRds) {
      return;
    }

    if (props.config.dbConnectivityMode === 'public_budget') {
      this.dbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'Budget mode: allow public PostgreSQL access');
      this.dbSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(5432), 'Budget mode: allow public PostgreSQL access (IPv6)');
    } else if (this.apiLambdaSecurityGroup) {
      this.dbSecurityGroup.addIngressRule(
        this.apiLambdaSecurityGroup,
        ec2.Port.tcp(5432),
        'Allow API Lambda to connect to PostgreSQL'
      );
    }

    this.dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
      username: props.config.dbUsername,
      secretName: `${props.config.prefix}/rds/postgres`
    });

    const instanceType = ec2.InstanceType.of(
      ec2.InstanceClass[props.config.dbInstanceType.instanceClass as keyof typeof ec2.InstanceClass],
      ec2.InstanceSize[props.config.dbInstanceType.instanceSize as keyof typeof ec2.InstanceSize]
    );

    const dbSubnetGroup = new rds.SubnetGroup(
      this,
      props.config.dbPublicAccess ? 'DbSubnetGroupPublic' : 'DbSubnetGroupPrivate',
      {
        description: 'Subnet group for PostgreSQL RDS',
        vpc: this.vpc,
        vpcSubnets: {
          subnetType: props.config.dbPublicAccess ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_ISOLATED
        }
      }
    );

    const dbParameterGroup = new rds.ParameterGroup(this, 'PostgresParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16
      }),
      parameters: {
        'rds.force_ssl': props.config.dbRequireTls ? '1' : '0'
      }
    });

    this.dbInstance = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: props.config.dbPublicAccess
        ? `${props.config.prefix}-postgres-public`
        : `${props.config.prefix}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16
      }),
      vpc: this.vpc,
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      iamAuthentication: props.config.dbUseIamAuth,
      parameterGroup: dbParameterGroup,
      subnetGroup: dbSubnetGroup,
      securityGroups: [this.dbSecurityGroup],
      allocatedStorage: props.config.dbAllocatedStorage,
      maxAllocatedStorage: props.config.dbMaxAllocatedStorage,
      databaseName: props.config.dbName,
      instanceType,
      backupRetention: Duration.days(props.config.dbBackupRetentionDays),
      removalPolicy: props.config.removalPolicy === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      deleteAutomatedBackups: props.config.removalPolicy === 'destroy',
      deletionProtection: props.config.removalPolicy !== 'destroy',
      publiclyAccessible: props.config.dbPublicAccess,
      storageEncrypted: true
    });

    if (props.config.stage === 'dev') {
      Tags.of(this.dbInstance).add('AutoCleanup', 'true');
      if (props.config.ttlHours !== undefined) {
        Tags.of(this.dbInstance).add('TTLHours', String(props.config.ttlHours));
      }
    }

    new CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      exportName: `${props.config.prefix}-db-secret-arn`
    });

    new CfnOutput(this, 'DbEndpoint', {
      value: this.dbInstance.instanceEndpoint.hostname,
      exportName: `${props.config.prefix}-db-endpoint`
    });

    new CfnOutput(this, 'DbInstanceIdentifier', {
      value: this.dbInstance.instanceIdentifier,
      exportName: `${props.config.prefix}-db-instance-identifier`
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
