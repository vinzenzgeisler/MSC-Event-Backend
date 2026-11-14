import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StageConfig } from '../config/types';

interface StandbyArchiveStackProps extends StackProps { config: StageConfig }

export class StandbyArchiveStack extends Stack {
  constructor(scope: Construct, id: string, props: StandbyArchiveStackProps) {
    super(scope, id, props);
    const vault = new backup.BackupVault(this, 'EventStandbyBackupVault', {
      backupVaultName: `${props.config.prefix}-standby-archive`,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const role = new iam.Role(this, 'EventStandbyS3BackupRole', {
      roleName: `${props.config.prefix}-standby-s3-backup-role`,
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Backup'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Restore')
      ]
    });
    new CfnOutput(this, 'StandbyBackupVaultName', { value: vault.backupVaultName });
    new CfnOutput(this, 'StandbyBackupRoleArn', { value: role.roleArn });
  }
}
