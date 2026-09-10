-- Publish the immutable OLD 2026 waiver contract and the consent hashes that
-- include its localized reading aids. The German contract remains authoritative.
update "app_config"
set
  "payload" = jsonb_build_object(
    'currentVersion', 'privacy-v2.1+terms-v2.0+waiver-OLD2026-HAFTVERZICHT-1.0.0+media-v2.0+club-info-v1.0',
    'locales',
    jsonb_build_object(
      'de-DE', jsonb_build_object(
        'consentLocale', 'de-DE',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-OLD2026-HAFTVERZICHT-1.0.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '5ab49c3026e00db080c8d7adec440f2e1c99971cf3b111b1bf17036284666324',
        'publishedAt', '2026-09-10T00:00:00.000Z'
      ),
      'en-GB', jsonb_build_object(
        'consentLocale', 'en-GB',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-OLD2026-HAFTVERZICHT-1.0.0+media-v2.0+club-info-v1.0',
        'consentTextHash', 'f1ba308a20f32504458d4efbbb218ad97056c760ca94c734fb1c6f83e6983a4d',
        'publishedAt', '2026-09-10T00:00:00.000Z'
      ),
      'cs-CZ', jsonb_build_object(
        'consentLocale', 'cs-CZ',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-OLD2026-HAFTVERZICHT-1.0.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '00db7d9c3bedcf1476b1dc728f845c288fd4aa7758bc0e39046b1668a75229de',
        'publishedAt', '2026-09-10T00:00:00.000Z'
      ),
      'pl-PL', jsonb_build_object(
        'consentLocale', 'pl-PL',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-OLD2026-HAFTVERZICHT-1.0.0+media-v2.0+club-info-v1.0',
        'consentTextHash', 'a23baec637d7a9ca7ac0aba0c4a6496ee4a19871af792df6ec7093411082687a',
        'publishedAt', '2026-09-10T00:00:00.000Z'
      )
    )
  )::jsonb,
  "updated_at" = now(),
  "updated_by" = 'system'
where "config_key" = 'public_legal_texts';

-- A driver/event group may have only one live terminal workflow at a time.
-- This is the database-level backstop for concurrent operators and tablets.
update "signing_session"
set "status" = 'cancelled', "workflow_stage" = 'cancelled', "updated_at" = now(), "error_last" = 'SIGNING_SESSION_EXPIRED'
where "status" in ('pending', 'displayed') and "expires_at" <= now();

with "duplicate_active_sessions" as (
  select
    "id",
    row_number() over (partition by "event_id", "driver_person_id" order by "created_at" desc, "id" desc) as "position"
  from "signing_session"
  where "status" in ('pending', 'displayed')
)
update "signing_session"
set "status" = 'cancelled', "workflow_stage" = 'cancelled', "updated_at" = now(), "error_last" = 'SIGNING_SESSION_SUPERSEDED'
where "id" in (select "id" from "duplicate_active_sessions" where "position" > 1);

with "duplicate_device_sessions" as (
  select
    "id",
    row_number() over (partition by "device_session_id" order by "created_at" desc, "id" desc) as "position"
  from "signing_session"
  where "status" in ('pending', 'displayed')
)
update "signing_session"
set "status" = 'cancelled', "workflow_stage" = 'cancelled', "updated_at" = now(), "error_last" = 'SIGNING_DEVICE_SESSION_SUPERSEDED'
where "id" in (select "id" from "duplicate_device_sessions" where "position" > 1);

create unique index if not exists "signing_session_event_driver_active_unique"
  on "signing_session" ("event_id", "driver_person_id")
  where "status" in ('pending', 'displayed');

create unique index if not exists "signing_session_device_active_unique"
  on "signing_session" ("device_session_id")
  where "status" in ('pending', 'displayed');
