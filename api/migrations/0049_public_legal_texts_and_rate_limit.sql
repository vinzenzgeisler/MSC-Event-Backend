create table if not exists public_rate_limit (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key_hash text not null,
  window_start timestamptz not null,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists public_rate_limit_scope_key_window_unique
  on public_rate_limit (scope, key_hash, window_start);

create index if not exists public_rate_limit_updated_idx
  on public_rate_limit (updated_at);

insert into app_config (config_key, payload, updated_at, updated_by)
values (
  'public_legal_texts',
  jsonb_build_object(
    'currentVersion', 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0',
    'locales',
    jsonb_build_object(
      'de-DE',
      jsonb_build_object(
        'consentLocale', 'de-DE',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '5dc00be754ed72311584e7df88460471b8a5d8b979eae41f3e69c742f9a06ddd',
        'publishedAt', '2026-04-10T00:00:00.000Z'
      ),
      'en-GB',
      jsonb_build_object(
        'consentLocale', 'en-GB',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '2d0af1fc20976749575c690623905946ba6726528043bf20b712ce48a545ccdf',
        'publishedAt', '2026-04-10T00:00:00.000Z'
      ),
      'cs-CZ',
      jsonb_build_object(
        'consentLocale', 'cs-CZ',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '0ba11228eb03668a42fa1af962ed9431c2aa80c322c2918cc6447f27c00ffcb1',
        'publishedAt', '2026-04-10T00:00:00.000Z'
      ),
      'pl-PL',
      jsonb_build_object(
        'consentLocale', 'pl-PL',
        'consentVersion', 'privacy-v2.1+terms-v2.0+waiver-v2.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '558478d245fe15e1ba8dbbe9b7be5ab4fae5433d7cbef32a2d08b5397ceda3a6',
        'publishedAt', '2026-04-10T00:00:00.000Z'
      )
    )
  )::jsonb,
  now(),
  'system'
)
on conflict (config_key) do update
set payload = excluded.payload,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
