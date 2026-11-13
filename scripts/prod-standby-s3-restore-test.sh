#!/usr/bin/env bash
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
kind="${RESTORE_BUCKET_KIND:?RESTORE_BUCKET_KIND is required}"
recovery="${RESTORE_RECOVERY_POINT_ARN:?RESTORE_RECOVERY_POINT_ARN is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
[[ "$kind" == assets || "$kind" == documents ]] || exit 1
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account" ]] || exit 1

source_bucket="dreiecksrennen-prod-${kind}-${account}"
destination="dreiecksrennen-restore-${kind}-${account}-${run_id}"
manifest='production-standby-s3-restore-manifest.json'
bucket_created=false
restore_started=false
verified=false
cleaned=false
versions=0
bytes=0

remove_temporary_bucket() {
  local listing deletion count
  listing="$(mktemp)"
  deletion="$(mktemp)"
  for attempt in $(seq 1 10000); do
    aws s3api list-object-versions --bucket "$destination" --max-keys 1000 --no-paginate \
      --region "$region" --output json > "$listing" || return 1
    jq '{Objects: ([.Versions[]?, .DeleteMarkers[]?] | map({Key,VersionId})), Quiet:true}' \
      "$listing" > "$deletion"
    count="$(jq '.Objects | length' "$deletion")"
    if [[ "$count" -eq 0 ]]; then break; fi
    aws s3api delete-objects --bucket "$destination" --delete "file://$deletion" \
      --region "$region" >/dev/null || return 1
  done
  [[ "$count" -eq 0 ]] || return 1
  rm -f "$listing" "$deletion"
  aws s3api delete-bucket --bucket "$destination" --region "$region" >/dev/null
}

finish() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$bucket_created" == true && ( "$restore_started" == false || "$verified" == true ) ]]; then
    if remove_temporary_bucket; then cleaned=true; else status=1; fi
  fi
  jq -n --arg at "$(date -u +%FT%TZ)" --arg kind "$kind" \
    --arg recovery "$recovery" --arg destination "$destination" \
    --argjson versions "$versions" --argjson bytes "$bytes" \
    --argjson verified "$verified" --argjson cleaned "$cleaned" \
    '{checkedAt:$at,kind:$kind,recoveryPointArn:$recovery,temporaryBucket:$destination,restoreVerified:$verified,restoredVersions:$versions,restoredVersionBytes:$bytes,temporaryResourcesCleaned:$cleaned}' > "$manifest"
  cat "$manifest"
  exit "$status"
}
trap finish EXIT

outputs="$(aws cloudformation describe-stacks --stack-name dreiecksrennen-prod-standby-archive-stack \
  --region "$region" --query 'Stacks[0].Outputs' --output json)"
vault="$(jq -r '.[] | select(.OutputKey == "StandbyBackupVaultName") | .OutputValue' <<< "$outputs")"
role="$(jq -r '.[] | select(.OutputKey == "StandbyBackupRoleArn") | .OutputValue' <<< "$outputs")"
[[ -n "$vault" && -n "$role" ]] || exit 1
point="$(aws backup describe-recovery-point --backup-vault-name "$vault" \
  --recovery-point-arn "$recovery" --region "$region" --output json)"
[[ "$(jq -r '.ResourceArn' <<< "$point")" == "arn:aws:s3:::${source_bucket}" ]] || {
  echo 'Recovery point belongs to another resource' >&2; exit 1;
}
[[ "$(jq -r '.Status' <<< "$point")" == 'COMPLETED' ]] || exit 1

aws s3api create-bucket --bucket "$destination" --region "$region" \
  --create-bucket-configuration "LocationConstraint=$region" >/dev/null
bucket_created=true
aws s3api put-public-access-block --bucket "$destination" --region "$region" \
  --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
aws s3api put-bucket-versioning --bucket "$destination" --region "$region" \
  --versioning-configuration Status=Enabled >/dev/null

job="$(aws backup start-restore-job --recovery-point-arn "$recovery" \
  --metadata "DestinationBucketName=$destination,RestoreACLs=false,RestoreLatestVersionsUpTo=all" \
  --iam-role-arn "$role" --idempotency-token "msc-restore-${run_id}-${kind}" \
  --region "$region" --query RestoreJobId --output text)"
[[ -n "$job" && "$job" != 'None' ]] || exit 1
restore_started=true
completed=false
for attempt in $(seq 1 200); do
  state="$(aws backup describe-restore-job --restore-job-id "$job" \
    --region "$region" --query Status --output text)"
  if [[ "$state" == 'COMPLETED' ]]; then completed=true; break; fi
  if [[ "$state" == 'FAILED' || "$state" == 'ABORTED' || "$state" == 'EXPIRED' ]]; then
    echo "S3 restore ended in $state" >&2; exit 1
  fi
  sleep 30
done
[[ "$completed" == true ]] || { echo 'S3 restore timed out' >&2; exit 1; }

summary="$(aws s3api list-object-versions --bucket "$destination" --region "$region" \
  --output json | jq '{versions:(.Versions // [] | length),bytes:(.Versions // [] | map(.Size // 0) | add // 0)}')"
versions="$(jq '.versions' <<< "$summary")"
bytes="$(jq '.bytes' <<< "$summary")"
if [[ "$(jq -r '.BackupSizeInBytes // 0' <<< "$point")" -gt 0 && "$versions" -eq 0 ]]; then
  echo 'Backup had data but restored bucket is empty' >&2
  exit 1
fi
verified=true
