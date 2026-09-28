-- RacePic Commerce (AP05): Passkeys und serverseitige Step-up-Grants fuer die Stufe `strong`.
-- Cognito-Tokens verraten nicht, welcher Faktor benutzt wurde (docs/memory-bank/racepic-architecture.md,
-- Abschnitt "Step-up-Authentication"). Deshalb registriert das Backend Passkeys selbst (oeffentlicher Schluessel
-- wird hier gespeichert; Cognito liefert ihn nicht heraus) und stellt nach erfolgreicher WebAuthn-Assertion
-- einen kurzlebigen, einmal verwendbaren, an Fotograf, Aktion und Sitzung gebundenen Grant aus.

create table if not exists "racepic_passkey_credential" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete restrict,
  "credential_id" text not null,
  "public_key" text not null,
  "counter" bigint not null default 0,
  "transports" text[] not null default '{}',
  "device_type" text,
  "backed_up" boolean not null default false,
  "label" text,
  "created_at" timestamptz not null default now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  constraint "racepic_passkey_credential_id_unique" unique ("credential_id")
);
create index if not exists "racepic_passkey_credential_photographer_idx"
  on "racepic_passkey_credential" ("photographer_id") where "revoked_at" is null;

-- Einmal verwendbare WebAuthn-Challenges (Registrierung und Step-up).
create table if not exists "racepic_webauthn_challenge" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete restrict,
  "purpose" text not null,
  "action" text,
  "session_ref" text not null,
  "challenge" text not null,
  "expires_at" timestamptz not null,
  "consumed_at" timestamptz,
  "created_at" timestamptz not null default now(),
  constraint "racepic_webauthn_challenge_purpose_check" check ("purpose" in ('REGISTER', 'STEP_UP')),
  constraint "racepic_webauthn_challenge_action_check" check (
    ("purpose" = 'STEP_UP' and "action" is not null) or ("purpose" = 'REGISTER' and "action" is null)
  )
);
create index if not exists "racepic_webauthn_challenge_open_idx"
  on "racepic_webauthn_challenge" ("photographer_id", "purpose", "created_at" desc) where "consumed_at" is null;

create table if not exists "racepic_step_up_grant" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete restrict,
  "action" text not null,
  "session_ref" text not null,
  "credential_id" uuid not null references "racepic_passkey_credential"("id") on delete restrict,
  "created_at" timestamptz not null default now(),
  "expires_at" timestamptz not null,
  "consumed_at" timestamptz,
  constraint "racepic_step_up_grant_action_check" check ("action" in ('PAYMENT_ACCOUNT', 'IDENTITY_CHANGE'))
);
create index if not exists "racepic_step_up_grant_lookup_idx"
  on "racepic_step_up_grant" ("photographer_id", "action", "session_ref") where "consumed_at" is null;
