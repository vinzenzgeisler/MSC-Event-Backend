#!/usr/bin/env bash
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
stack='dreiecksrennen-prod-standby-archive-stack'
vault='dreiecksrennen-prod-standby-archive'

status="$(aws cloudformation list-stacks --region "$region" \
  --stack-status-filter ROLLBACK_COMPLETE \
  --query "StackSummaries[?StackName=='${stack}'].StackStatus | [0]" --output text)"
[[ "$status" == 'ROLLBACK_COMPLETE' ]] || exit 0

# A retained vault can survive the failed first creation. Never delete a vault
# containing recovery points, and never touch a healthy stack.
count="$(aws backup list-recovery-points-by-backup-vault --region "$region" \
  --backup-vault-name "$vault" --query 'length(RecoveryPoints)' --output text)"
[[ "$count" == '0' ]] || { echo "Refusing to remove nonempty backup vault: $vault" >&2; exit 1; }

aws cloudformation delete-stack --stack-name "$stack" --region "$region"
aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$region"
aws backup delete-backup-vault --backup-vault-name "$vault" --region "$region"
