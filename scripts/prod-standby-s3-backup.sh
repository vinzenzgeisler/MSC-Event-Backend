#!/usr/bin/env bash
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
actual="$(aws sts get-caller-identity --query Account --output text)"
[[ "$actual" == "$account" ]] || { echo 'Wrong AWS account' >&2; exit 1; }

outputs="$(aws cloudformation describe-stacks --stack-name dreiecksrennen-prod-standby-archive-stack \
  --region "$region" --query 'Stacks[0].Outputs' --output json)"
vault="$(jq -r '.[] | select(.OutputKey == "StandbyBackupVaultName") | .OutputValue' <<< "$outputs")"
role="$(jq -r '.[] | select(.OutputKey == "StandbyBackupRoleArn") | .OutputValue' <<< "$outputs")"
[[ -n "$vault" && -n "$role" ]] || { echo 'Backup vault or role output is missing' >&2; exit 1; }

manifest='[]'
for kind in assets documents; do
  bucket="dreiecksrennen-prod-${kind}-${account}"
  versioning="$(aws s3api get-bucket-versioning --bucket "$bucket" --region "$region" --query Status --output text)"
  [[ "$versioning" == 'Enabled' ]] || { echo "Versioning is not enabled for $kind" >&2; exit 1; }
  job="$(aws backup start-backup-job --backup-vault-name "$vault" \
    --resource-arn "arn:aws:s3:::${bucket}" --iam-role-arn "$role" \
    --idempotency-token "msc-${run_id}-${kind}" --region "$region" \
    --query BackupJobId --output text)"
  [[ -n "$job" && "$job" != 'None' ]] || { echo "Backup job did not start for $kind" >&2; exit 1; }
  manifest="$(jq -cn --argjson prior "$manifest" --arg kind "$kind" --arg job "$job" \
    '$prior + [{kind:$kind,jobId:$job}]')"
done
jq -n --arg generatedAt "$(date -u +%FT%TZ)" --arg vault "$vault" --argjson backups "$manifest" \
  '{generatedAt:$generatedAt,backupVault:$vault,backups:$backups}' > production-standby-s3-backup-manifest.json

for kind in assets documents; do
  job="$(jq -r --arg kind "$kind" '.[] | select(.kind == $kind) | .jobId' <<< "$manifest")"
  completed=false
  for attempt in $(seq 1 100); do
    details="$(aws backup describe-backup-job --backup-job-id "$job" --region "$region" --output json)"
    state="$(jq -r '.State' <<< "$details")"
    if [[ "$state" == 'COMPLETED' ]]; then
      recovery="$(jq -r '.RecoveryPointArn // empty' <<< "$details")"
      [[ -n "$recovery" ]] || { echo "No recovery point ARN for $kind" >&2; exit 1; }
      manifest="$(jq -cn --argjson prior "$manifest" --arg kind "$kind" --arg recovery "$recovery" \
        --argjson bytes "$(jq -r '.BackupSizeInBytes // 0' <<< "$details")" \
        '[ $prior[] | if .kind == $kind then . + {state:"COMPLETED",recoveryPointArn:$recovery,backupSizeBytes:$bytes} else . end ]')"
      completed=true
      break
    fi
    if [[ "$state" == 'FAILED' || "$state" == 'ABORTED' || "$state" == 'EXPIRED' || "$state" == 'PARTIAL' ]]; then
      echo "S3 backup $kind ended in $state" >&2
      exit 1
    fi
    sleep 30
  done
  [[ "$completed" == true ]] || { echo "S3 backup $kind timed out" >&2; exit 1; }
done

jq -n --arg generatedAt "$(date -u +%FT%TZ)" --arg vault "$vault" --argjson backups "$manifest" \
  '{generatedAt:$generatedAt,backupVault:$vault,backups:$backups}' > production-standby-s3-backup-manifest.json
cat production-standby-s3-backup-manifest.json
