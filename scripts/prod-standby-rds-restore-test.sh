#!/usr/bin/env bash
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
snapshot="${RESTORE_SNAPSHOT_ID:?RESTORE_SNAPSHOT_ID is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account" ]] || exit 1

source_id='dreiecksrennen-prod-postgres-public'
restore_id="dreiecksrennen-restore-${run_id}"
sg_name="dreiecksrennen-restore-${run_id}"
manifest='production-standby-rds-restore-manifest.json'
created=false
security_group=''
verified=false
counts='null'

cleanup() {
  local status=$?
  local cleaned=true
  trap - EXIT
  set +e
  if [[ "$created" == false ]] && aws rds describe-db-instances \
      --db-instance-identifier "$restore_id" --region "$region" >/dev/null 2>&1; then
    created=true
  fi
  if [[ "$created" == true ]]; then
    aws rds delete-db-instance --db-instance-identifier "$restore_id" \
      --skip-final-snapshot --delete-automated-backups --region "$region" >/dev/null
    if [[ $? -ne 0 ]]; then
      status=1
      cleaned=false
    else
      aws rds wait db-instance-deleted --db-instance-identifier "$restore_id" --region "$region"
      if [[ $? -ne 0 ]]; then status=1; cleaned=false; fi
    fi
  fi
  if [[ -n "$security_group" && "$cleaned" == true ]]; then
    local removed=false
    for attempt in 1 2 3 4 5; do
      if aws ec2 delete-security-group --group-id "$security_group" --region "$region" >/dev/null 2>&1; then
        removed=true
        break
      fi
      sleep 10
    done
    if [[ "$removed" != true ]]; then status=1; cleaned=false; fi
  fi
  jq -n --arg at "$(date -u +%FT%TZ)" --arg snapshot "$snapshot" \
    --arg restore "$restore_id" --argjson counts "$counts" \
    --argjson verified "$verified" --argjson cleaned "$cleaned" \
    '{checkedAt:$at,snapshotId:$snapshot,temporaryInstanceId:$restore,sqlVerified:$verified,counts:$counts,temporaryResourcesCleaned:$cleaned}' > "$manifest"
  cat "$manifest"
  exit "$status"
}
trap cleanup EXIT

details="$(aws rds describe-db-snapshots --db-snapshot-identifier "$snapshot" \
  --region "$region" --query 'DBSnapshots[0]' --output json)"
[[ "$(jq -r '.DBInstanceIdentifier' <<< "$details")" == "$source_id" ]] || {
  echo 'Snapshot belongs to a different database' >&2; exit 1;
}
[[ "$(jq -r '.Status' <<< "$details")" == 'available' ]] || {
  echo 'Snapshot is not available' >&2; exit 1;
}
[[ "$(jq -r '.Encrypted' <<< "$details")" == 'true' ]] || {
  echo 'Snapshot is not encrypted' >&2; exit 1;
}

source="$(aws rds describe-db-instances --db-instance-identifier "$source_id" \
  --region "$region" --query 'DBInstances[0]' --output json)"
subnet="$(jq -r '.DBSubnetGroup.DBSubnetGroupName' <<< "$source")"
vpc="$(jq -r '.DBSubnetGroup.VpcId' <<< "$source")"
[[ -n "$subnet" && "$subnet" != null && -n "$vpc" && "$vpc" != null ]] || exit 1
runner_ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '\r\n')"
[[ "$runner_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1

security_group="$(aws ec2 create-security-group --group-name "$sg_name" \
  --description 'Temporary encrypted RDS restore rehearsal' --vpc-id "$vpc" \
  --region "$region" --query GroupId --output text)"
aws ec2 authorize-security-group-ingress --group-id "$security_group" \
  --protocol tcp --port 5432 --cidr "${runner_ip}/32" --region "$region" >/dev/null

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$restore_id" --db-snapshot-identifier "$snapshot" \
  --db-instance-class db.t3.micro --db-subnet-group-name "$subnet" \
  --vpc-security-group-ids "$security_group" --publicly-accessible \
  --no-deletion-protection --no-multi-az --region "$region" >/dev/null
created=true
aws rds wait db-instance-available --db-instance-identifier "$restore_id" --region "$region"

export DB_HOST
DB_HOST="$(aws rds describe-db-instances --db-instance-identifier "$restore_id" \
  --region "$region" --query 'DBInstances[0].Endpoint.Address' --output text)"
export DB_PORT=5432 DB_NAME=eventdb DB_USER=eventadmin DB_SSL=true DB_SSL_REJECT_UNAUTHORIZED=true
counts="$(node api/dist/standbyNewsletter/restoreCheck.js)"
jq -e 'all(.[]; type == "number" and . >= 0)' <<< "$counts" >/dev/null
verified=true
