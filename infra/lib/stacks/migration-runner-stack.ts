import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';
import { DataStack } from './data-stack';

interface MigrationRunnerStackProps extends StackProps {
  config: StageConfig;
  dataStack: DataStack;
}

export class MigrationRunnerStack extends Stack {
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: MigrationRunnerStackProps) {
    super(scope, id, props);

    const migrationSecurityGroup = new ec2.SecurityGroup(this, 'MigrationRunnerSecurityGroup', {
      vpc: props.dataStack.vpc,
      securityGroupName: `${props.config.prefix}-migration-runner-sg`,
      description: 'Security Group for CodeBuild DB migrations'
    });

    new ec2.CfnSecurityGroupIngress(this, 'MigrationRunnerToDbIngress', {
      groupId: props.dataStack.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: migrationSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Allow CodeBuild migrations to connect to PostgreSQL'
    });

    this.project = new codebuild.Project(this, 'MigrationRunnerProject', {
      projectName: `${props.config.prefix}-migration-runner`,
      timeout: Duration.minutes(15),
      vpc: props.dataStack.vpc,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      securityGroups: [migrationSecurityGroup],
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL
      },
      source: codebuild.Source.gitHub({
        owner: 'VinzenzGeisler',
        repo: 'MSC-Event-Backend',
        branchOrRef: 'main',
        cloneDepth: 1,
        webhook: false
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: {
          'secrets-manager': {
            DB_USERNAME: `${props.dataStack.dbSecret.secretArn}:username`,
            DB_PASSWORD: `${props.dataStack.dbSecret.secretArn}:password`,
            DB_HOST: `${props.dataStack.dbSecret.secretArn}:host`,
            DB_PORT: `${props.dataStack.dbSecret.secretArn}:port`,
            DB_NAME: `${props.dataStack.dbSecret.secretArn}:dbname`
          }
        },
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 20
            }
          },
          pre_build: {
            commands: ['cd api', 'npm ci']
          },
          build: {
            commands: [
              'cd api',
              "USER_ENC=$(node -e \"process.stdout.write(encodeURIComponent(process.env.DB_USERNAME || ''))\")",
              "PASS_ENC=$(node -e \"process.stdout.write(encodeURIComponent(process.env.DB_PASSWORD || ''))\")",
              'export DATABASE_URL="postgres://$USER_ENC:$PASS_ENC@$DB_HOST:$DB_PORT/$DB_NAME"',
              'npm run db:migrate'
            ]
          }
        }
      })
    });

    props.dataStack.dbSecret.grantRead(this.project);

    new CfnOutput(this, 'MigrationRunnerProjectName', {
      value: this.project.projectName,
      exportName: `${props.config.prefix}-migration-runner-project-name`
    });

    new CfnOutput(this, 'MigrationRunnerProjectArn', {
      value: this.project.projectArn,
      exportName: `${props.config.prefix}-migration-runner-project-arn`
    });
  }
}
