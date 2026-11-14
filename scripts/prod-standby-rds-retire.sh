#!/usr/bin/env bash
# Retire the Event PostgreSQL instance after the newsletter runs independently.
# Preconditions are verified in AWS; the instance is deleted only with a final snapshot.
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
snapshot="${RETIRE_SNAPSHOT_ID:?RETIRE_SNAPSHOT_ID is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account" ]] || exit 1

source_id='dreiecksrennen-prod-postgres-public'
table='dreiecksrennen-prod-newsletter-standby'
final_snapshot="${source_id}-final-retire-${run_id}"
manifest='production-standby-rds-retire-manifest.json'

cutover="$(aws dynamodb get-item --table-name "$table" \
  --key '{"pk":{"S":"META#cutover"},"sk":{"S":"STATE"}}' --consistent-read \
  --query 'Item.activatedAt.S' --output text --region "$region")"
[[ -n "$cutover" && "$cutover" != 'None' ]]
[[ "$(aws lambda get-function-configuration --function-name dreiecksrennen-prod-newsletter-standby-api \
  --region "$region" --query 'Environment.Variables.NEWSLETTER_WRITE_ENABLED' --output text)" == 'true' ]]
for function in dreiecksrennen-prod-api-handler dreiecksrennen-prod-privacy-retention-worker dreiecksrennen-prod-ses-feedback-worker; do
  [[ "$(aws lambda get-function-configuration --function-name "$function" --region "$region" \
    --query 'Environment.Variables.NEWSLETTER_LEGACY_WRITES_ENABLED' --output text)" == 'false' ]]
done

read -r snap_status snap_source snap_encrypted snap_created < <(aws rds describe-db-snapshots \
  --db-snapshot-identifier "$snapshot" --region "$region" \
  --query 'DBSnapshots[0].[Status,DBInstanceIdentifier,Encrypted,SnapshotCreateTime]' --output text)
[[ "$snap_status" == 'available' && "$snap_source" == "$source_id" && "$snap_encrypted" == 'True' ]]
# The snapshot must postdate activation so it holds every legacy row.
[[ "$(date -u -d "$snap_created" +%s)" -gt "$(date -u -d "$cutover" +%s)" ]]

# Stop Event schedules that would only fail without the database.
for rule in $(aws events list-rules --name-prefix dreiecksrennen-prod-api-stack --region "$region" \
    --query "Rules[?contains(Name,'EmailWorkerSchedule') || contains(Name,'PrivacyRetentionSchedule') || contains(Name,'EventHubMaintenanceSchedule') || contains(Name,'RacePicUploadReconcilerSchedule')].Name" --output text); do
  aws events disable-rule --name "$rule" --region "$region"
done

aws rds modify-db-instance --db-instance-identifier "$source_id" --no-deletion-protection \
  --apply-immediately --region "$region" >/dev/null
aws rds delete-db-instance --db-instance-identifier "$source_id" \
  --final-db-snapshot-identifier "$final_snapshot" --no-delete-automated-backups --region "$region" >/dev/null
aws rds wait db-instance-deleted --db-instance-identifier "$source_id" --region "$region"
aws rds wait db-snapshot-available --db-snapshot-identifier "$final_snapshot" --region "$region"

jq -n --arg at "$(date -u +%FT%TZ)" --arg verified "$snapshot" --arg final "$final_snapshot" \
  '{retiredAt:$at,verifiedSnapshot:$verified,finalSnapshot:$final,instance:"dreiecksrennen-prod-postgres-public",automatedBackupsRetained:true}' > "$manifest"
