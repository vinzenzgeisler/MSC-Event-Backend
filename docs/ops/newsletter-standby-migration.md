# Newsletter minimal operation and Event standby

## Decision and boundary

Keep the public newsletter working while the Event application is dormant. Use an
independent AWS stack with DynamoDB Standard/on-demand, Lambda, API Gateway, SES,
and the existing website. No always-on PostgreSQL is needed after cutover. This
is a target architecture, **not** a claim that the cutover has happened.

## Implemented release lanes (not yet executed in production)

The protected `newsletter-standby.yml` workflow provides separate manual actions.
Each action requires approval of the `prod` GitHub environment; the normal
`main` deploy is **not** the cutover control. Use the successful run artifact as
evidence at each gate, and do not mark Event standby complete from a green CI run.

1. `inventory`: inspect RDS, S3 version counts and last month's service costs
   (costs may be `null` if the deploy role lacks Cost Explorer access).
2. `archive-provision`, then `archive-snapshot`: create a retained AWS Backup
   vault and independently capture both versioned S3 buckets. Preserve the
   recovery-point ARNs outside the 30-day Actions artifact. An AWS Backup
   `COMPLETED` state is not a restore rehearsal.
3. `provision`: create the independent Cognito-authorized newsletter API,
   DynamoDB PITR table, SES sender/feedback and retention jobs with *writes
   disabled*. Record the `NewsletterApiUrl` stack output. The website and Event
   admin frontend have separate newsletter API configuration PRs; they continue
   using the old API while their new endpoint setting is unset.
4. `audit`, then `copy`: read and copy subscribers plus consent evidence, with
   strong-read per-key verification and count reconciliation. The new API
   remains read-only; no public route changes.
5. Verify the legacy newsletter outbox is drained. Set the production repository
   variable `PROD_NEWSLETTER_LEGACY_WRITES_ENABLED=false`, run `freeze-legacy`,
   and verify the legacy API, SES feedback and retention function environments
   are false. The freeze prevents those jobs from changing legacy newsletter
   subscriber rows, but old SES feedback arriving after the freeze still needs
   a deliberate suppression reconciliation; check the old feedback queue and
   repeat the final data reconciliation immediately before activation.
6. `final` rebuilds the target from a consistent PostgreSQL snapshot and writes
   a reconciliation marker. `activate` accepts that marker for at most 24 hours,
   confirms the legacy API is frozen, enables new writes, and seals migration.
   Then set both frontend/website newsletter API URL variables and deploy them;
   verify signup, double opt-in, unsubscribe, admin permissions, SES feedback,
   and delivery on the **live** endpoint. Until routing switches, the public
   website is still coupled to RDS despite an active standalone API.
7. Run the existing protected `prod-data-backup.yml` in `snapshot` mode again
   after cutover to obtain the final Event database snapshot. Do not retire RDS
   until S3 **and** RDS isolated restore rehearsals, newsletter-only operation,
   costs and reopen instructions are verified.

If activation succeeds but its migration-seal write fails, rerun `activate`.
The workflow tolerates the already-enabled API and writes the missing seal.
Do not run `copy` or `final` after new writes begin.

The live implementation is coupled to PostgreSQL in more places than the two
newsletter tables: `routes/newsletter.ts` writes `email_outbox`, reads the
published `free_form` template and writes `audit_log`; `emailWorker.ts` sends
newsletter mail; `sesFeedbackWorker.ts` suppresses bounced/complained contacts;
the retention worker deletes old subscriber records. The admin API uses Cognito
permissions. Preserve these behaviours before retiring RDS.

## Lowest-cost existing-service preflight

- Existing AWS services avoid a second vendor, an additional account and a
  new data-processing boundary. DynamoDB on-demand has no instance-hours and
  charges for storage/requests/backup; Lambda and API Gateway are also
  request-based. SES remains the sender. Measure the bill, including backups,
  CloudWatch and any domain/IPv4 charges, rather than promising zero cost.
- A hosted Postgres free tier or a self-hosted list manager retains another
  operational dependency. Listmonk is capable, but its required database/server
  would undercut the goal of an almost-idle newsletter. SES contact lists alone
  do not replace the existing consent-evidence and double-opt-in workflow.

## Data and API contract

- Subscriber record keyed by a stable normalized email key; preserve UUID,
  locale, status, consent version/text hash, token hashes and expiry, timestamps,
  verification window/count, and suppression state. Do not expose email or
  token hashes in logs. Conditional writes make concurrent signups, confirmation
  and unsubscribe idempotent. A token lookup index must not allow replay after
  its action has completed.
- Append-only consent events retain source, action, version, text hash, locale,
  and timestamp. Preserve the existing retention periods and export format.
  Audit/admin actions must be attributable to the Cognito subject.
- Write an idempotent outbox item in the same DynamoDB transaction as the
  subscriber change. DynamoDB Streams drives the SES sender; failed deliveries
  are retried and dead-lettered for operational repair. Avoid a state commit
  that silently loses a confirmation email.
  Preserve bounded resend behaviour, safe generic responses for unknown email
  addresses, sender identity and locale-specific content. SES feedback must
  suppress bounces and complaints in the new store.
- Keep the public `/public/newsletter/*` contract and website confirmation/
  unsubscribe links. Preserve the admin overview, list, resend and unsubscribe
  features, or change the admin UI as part of the same release. Keep public
  throttling/bot protection and CORS. Do not disable the Event API first.

## Cutover sequence and gates

1. Obtain a read-only production inventory via the protected pipeline: current
   subscriber/event/outbox counts, open newsletter messages, S3 bucket inventory,
   Cognito and stack dependencies, and AWS cost breakdown if the role permits.
   Store *counts/metadata only* in Actions artifacts, not addresses or tokens.
2. Implement the independent newsletter stack behind a non-production endpoint.
   Verify signup, double opt-in, unsubscribe, admin permissions, bounce/complaint
   suppression, retries, retention and recovery with test addresses.
3. Use a protected one-off migration to copy current subscribers and consent
   events. Reconcile counts and keyed checksums; exclude expired records under
   the existing policy. Do not put personal data in GitHub artifacts/logs.
4. Pause new newsletter writes briefly, drain the existing `email_outbox`, copy
   the final delta, and switch only newsletter website/API routing. Reconcile
   again; test public flows and admin actions. Keep the old DB read-only for a
   rollback window; do not dual-write without a tested conflict policy.
5. After a verified final RDS snapshot **and independent S3-object backup and
   isolated restore rehearsal**, disable Event-specific compute/routing. Retain
   Cognito, S3, DNS/SES identities and backup manifests. Delete RDS only once
   the snapshot's retention/cost and restart procedure are documented. `StopDB`
   is not durable standby: RDS resumes automatically after seven days.
6. Rehearse reopening: provision RDS from the final snapshot into a new instance,
   deploy backend through CI, verify Event records/files/login, then reconnect
   the *current* newsletter store. The old Event snapshot must never overwrite
   post-cutover newsletter subscriptions or consent changes.

## Rollback and acceptance

Before deleting RDS, rollback means switching the newsletter routes back to
the existing DB after reconciling any writes made to DynamoDB. After deletion,
rollback means restoring a new RDS instance from the final snapshot; it does
not recover newsletter writes made since cutover. Keep the newsletter store
authoritative for those writes.

Accept standby only after the newsletter works without RDS, exports and consent
evidence reconcile, a real backup restore succeeds, current monthly AWS costs
have been measured, and reopening instructions have been exercised. Until then
RDS remains online.
