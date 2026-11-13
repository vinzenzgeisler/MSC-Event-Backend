# Production data during Event app standby

The newsletter and Event app share the same production PostgreSQL database. **Do not stop or delete that database while the newsletter must work.** The API Lambda, scheduled email worker, SES, Cognito admin pool, and required S3 assets must remain available. The Event frontend may be hidden separately after its newsletter links have been checked. The path to a cheaper independent newsletter is specified in [newsletter-standby-migration.md](newsletter-standby-migration.md).

## Backup pipeline

Run **Production data backup** from GitHub Actions on `main`, choosing:

- `audit`: verify the AWS account, live RDS availability, deletion protection, backup retention, a restorable point no more than 24 hours old, and versioning on the assets/documents buckets.
- `snapshot`: perform the same checks, create a manual RDS snapshot, wait until it is available, and save its ARN in the workflow artifact.

Both modes use the existing production OIDC deploy role and the protected `prod` environment. An approver must release **this job**; it does not run the normal deployment. The manifest artifact contains metadata only, never database contents or credentials. Artifacts expire after 30 days, but manual RDS snapshots remain in AWS until explicitly deleted. Keep the snapshot identifier in an operational record independent of the artifact.

The configured RDS automated-backup retention is 30 days. Verify the **live** setting with `audit`; code configuration alone is not proof. Automated backups provide recent point-in-time recovery while the database keeps receiving newsletter writes. A manual snapshot is an additional historical recovery point, **not** a continuously updated copy. Neither database-backup type includes S3 objects or Cognito identities.

The two primary S3 buckets are retained and versioned in the production CDK configuration, but versioning alone is not an independently tested backup. Check the live bucket inventory and a representative object restore before claiming full recovery readiness. Check whether the optional RacePic stack exists; its media bucket is not versioned in the current CDK code. Keep the Cognito user pool and its stack intact; recreating the pool is not equivalent to restoring user sign-in state.

## Reopening the Event app

1. Check the newsletter, RDS status, latest restorable time, S3 buckets, Cognito pool, and existing API health. The retained live database contains the then-current newsletter and Event records; do **not** replace it with the older manual snapshot as a routine reopen step.
2. Re-enable the Event frontend through its own repository pipeline if it was hidden. The backend's existing `main` pipeline deploys auth/data/storage, runs migrations, and deploys API; it is **not** a backup job and requires a separate production approval. Review its exact changes before releasing that gate.
3. Smoke-test Event login, entries, document access, and the newsletter (including confirmation, unsubscribe and the mail worker) with dedicated test data. Do not send a bulk newsletter as a smoke test.

## Disaster recovery

For loss or corruption of the live database, choose the latest valid point-in-time recovery within retention, or a manual snapshot if older. RDS restore creates a **new** instance; inspect the recovered data before changing the application connection. Preserve the old instance for investigation. Check for newsletter writes after the chosen restore point before cutover; a snapshot cannot contain future writes. Recover S3/Cognito separately as required. A real isolated restore rehearsal and documented recovery time are still required before calling this backup strategy proven.

## Remaining work before cost-saving standby

- The `snapshot` mode succeeded on 2026-11-13 in [run 43418505604](https://github.com/vinzenzgeisler/MSC-Event-Backend/actions/runs/43418505604). Its manifest recorded the manual snapshot `dreiecksrennen-prod-postgres-public-manual-43418505604-1`, 30-day automated-backup retention, and `Enabled` versioning on the two primary S3 buckets. This proves snapshot availability at that time, not a restore or independent S3 backup.
- Migrate the newsletter to a separate low-idle-cost store and runtime; verify its flows and current consent data before disconnecting PostgreSQL.
- Inventory all live S3 buckets and Cognito; design independent backup for mutable files if needed, with costs reviewed first.
- Rehearse a restore without replacing production or sending real emails.
- Measure current costs and disable only Event-specific components that are proven independent of the newsletter.
