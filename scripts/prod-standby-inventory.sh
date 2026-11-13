#!/usr/bin/env bash
set -euo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
expected_account="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_account" != "$expected_account" ]]; then
  echo 'Wrong AWS account' >&2
  exit 1
fi

instance="$(aws rds describe-db-instances \
  --db-instance-identifier dreiecksrennen-prod-postgres-public --region "$region" \
  --query 'DBInstances[0].{class:DBInstanceClass,allocatedGiB:AllocatedStorage,maxAllocatedGiB:MaxAllocatedStorage,status:DBInstanceStatus,backupRetentionDays:BackupRetentionPeriod,deletionProtection:DeletionProtection,publiclyAccessible:PubliclyAccessible}' --output json)"

buckets='[]'
for kind in assets documents; do
  bucket="dreiecksrennen-prod-${kind}-${expected_account}"
  summary="$(aws s3api list-object-versions --bucket "$bucket" --region "$region" --output json | \
    jq --arg kind "$kind" '{kind:$kind,versions:(.Versions // [] | length),versionBytes:(.Versions // [] | map(.Size // 0) | add // 0),deleteMarkers:(.DeleteMarkers // [] | length)}')"
  buckets="$(jq --argjson entry "$summary" '. + [$entry]' <<< "$buckets")"
done

costs='null'
start="$(date -u -d 'last month' +%Y-%m-01)"
end="$(date -u +%Y-%m-01)"
if aws ce get-cost-and-usage --time-period "Start=$start,End=$end" \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE --output json \
  > /tmp/msc-standby-costs.json 2>/tmp/msc-standby-cost-error.log; then
  costs="$(jq '[.ResultsByTime[].Groups[] | {service:.Keys[0],amount:(.Metrics.UnblendedCost.Amount | tonumber),unit:.Metrics.UnblendedCost.Unit} | select(.amount > 0.001)] | sort_by(-.amount)' /tmp/msc-standby-costs.json)"
fi

jq -n --arg generatedAt "$(date -u +%FT%TZ)" --arg costPeriod "$start/$end" \
  --argjson instance "$instance" --argjson buckets "$buckets" --argjson costs "$costs" \
  '{generatedAt:$generatedAt,db:$instance,s3:$buckets,costPeriod:$costPeriod,costs:$costs}' \
  > production-standby-inventory.json
cat production-standby-inventory.json
