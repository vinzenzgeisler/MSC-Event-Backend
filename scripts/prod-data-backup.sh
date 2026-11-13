#!/usr/bin/env bash
set -euo pipefail

# This is a metadata audit, not a database export. Never print database secrets or subscriber data.
mode="${BACKUP_MODE:?BACKUP_MODE is required}"
region="${AWS_REGION:?AWS_REGION is required}"
expected_account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
run_id="${BACKUP_RUN_ID:?BACKUP_RUN_ID is required}"
run_attempt="${BACKUP_RUN_ATTEMPT:?BACKUP_RUN_ATTEMPT is required}"
db_id='dreiecksrennen-prod-postgres-public'

if [[ "$mode" != audit && "$mode" != snapshot ]]; then
  echo 'BACKUP_MODE must be audit or snapshot' >&2
  exit 2
fi

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_account" != "$expected_account" ]]; then
  echo 'AWS account does not match the production environment' >&2
  exit 1
fi

db_json="$(aws rds describe-db-instances --db-instance-identifier "$db_id" --region "$region" --output json)"
db_status="$(jq -r '.DBInstances[0].DBInstanceStatus' <<< "$db_json")"
retention="$(jq -r '.DBInstances[0].BackupRetentionPeriod' <<< "$db_json")"
latest_restore="$(jq -r '.DBInstances[0].LatestRestorableTime // empty' <<< "$db_json")"
deletion_protection="$(jq -r '.DBInstances[0].DeletionProtection' <<< "$db_json")"

if [[ ! "$retention" =~ ^[0-9]+$ ]]; then
  echo 'Could not read production backup retention' >&2
  exit 1
fi
if [[ "$db_status" != available || "$retention" -lt 1 || -z "$latest_restore" || "$deletion_protection" != true ]]; then
  echo 'Production database is not available, has no verified point-in-time recovery, or lacks deletion protection' >&2
  exit 1
fi

latest_restore_age_seconds="$(( $(date -u +%s) - $(date -u -d "$latest_restore" +%s) ))"
if (( latest_restore_age_seconds < 0 || latest_restore_age_seconds > 86400 )); then
  echo 'Latest restorable time is older than 24 hours or lies in the future' >&2
  exit 1
fi

for bucket in "dreiecksrennen-prod-assets-${expected_account}" "dreiecksrennen-prod-documents-${expected_account}"; do
  aws s3api head-bucket --bucket "$bucket" --region "$region"
  versioning="$(aws s3api get-bucket-versioning --bucket "$bucket" --region "$region" --query Status --output text)"
  if [[ "$versioning" != Enabled ]]; then
    echo "Bucket $bucket does not have versioning enabled" >&2
    exit 1
  fi
done

snapshot_id=''
snapshot_arn=''
if [[ "$mode" == snapshot ]]; then
  snapshot_id="${db_id}-manual-${run_id}-${run_attempt}"
  aws rds create-db-snapshot --db-instance-identifier "$db_id" --db-snapshot-identifier "$snapshot_id" --region "$region" >/dev/null
  aws rds wait db-snapshot-available --db-snapshot-identifier "$snapshot_id" --region "$region"
  snapshot_json="$(aws rds describe-db-snapshots --db-snapshot-identifier "$snapshot_id" --region "$region" --output json)"
  snapshot_arn="$(jq -r '.DBSnapshots[0].DBSnapshotArn' <<< "$snapshot_json")"
  if [[ "$(jq -r '.DBSnapshots[0].Status' <<< "$snapshot_json")" != available || "$(jq -r '.DBSnapshots[0].Encrypted' <<< "$snapshot_json")" != true ]]; then
    echo 'Manual snapshot is not available and encrypted' >&2
    exit 1
  fi
fi

jq -n \
  --arg generatedAt "$(date -u +%FT%TZ)" \
  --arg region "$region" \
  --arg account "$expected_account" \
  --arg dbId "$db_id" \
  --arg dbStatus "$db_status" \
  --argjson backupRetentionDays "$retention" \
  --arg latestRestorableTime "$latest_restore" \
  --arg snapshotId "$snapshot_id" \
  --arg snapshotArn "$snapshot_arn" \
  --arg mode "$mode" \
  '{generatedAt:$generatedAt,region:$region,account:$account,mode:$mode,database:{id:$dbId,status:$dbStatus,backupRetentionDays:$backupRetentionDays,latestRestorableTime:$latestRestorableTime},manualSnapshot:{id:$snapshotId,arn:$snapshotArn},s3:{assetsVersioning:"Enabled",documentsVersioning:"Enabled"}}' \
  > production-backup-manifest.json

echo "Production backup $mode verified for $db_id; retention: $retention days; latest restorable time: $latest_restore"
if [[ -n "$snapshot_id" ]]; then
  echo "Manual snapshot available: $snapshot_id"
fi
