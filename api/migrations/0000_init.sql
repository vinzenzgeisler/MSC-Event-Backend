create extension if not exists "pgcrypto";

create table if not exists "event" (
  "id" uuid primary key default gen_random_uuid(),
  "name" text not null,
  "starts_at" date not null,
  "ends_at" date not null,
  "status" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "event_status_check" check ("status" in ('active', 'archived'))
);

create table if not exists "class" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "name" text not null,
  "vehicle_type" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "class_vehicle_type_check" check ("vehicle_type" in ('moto', 'auto')),
  constraint "class_event_name_unique" unique ("event_id", "name")
);

create table if not exists "person" (
  "id" uuid primary key default gen_random_uuid(),
  "email" text,
  "first_name" text not null,
  "last_name" text not null,
  "birthdate" date,
  "nationality" text,
  "street" text,
  "zip" text,
  "city" text,
  "phone" text,
  "emergency_contact_name" text,
  "emergency_contact_phone" text,
  "motorsport_history" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "person_email_unique"
  on "person" (lower("email"))
  where "email" is not null;

create table if not exists "vehicle" (
  "id" uuid primary key default gen_random_uuid(),
  "owner_person_id" uuid references "person"("id"),
  "vehicle_type" text not null,
  "make" text,
  "model" text,
  "year" integer,
  "brand" text,
  "displacement_ccm" integer,
  "engine_type" text,
  "power_ps" integer,
  "cylinders" integer,
  "gears" integer,
  "brakes" text,
  "description" text,
  "start_number_raw" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "vehicle_vehicle_type_check" check ("vehicle_type" in ('moto', 'auto'))
);

create table if not exists "entry" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "class_id" uuid not null references "class"("id"),
  "driver_person_id" uuid not null references "person"("id"),
  "codriver_person_id" uuid references "person"("id"),
  "vehicle_id" uuid not null references "vehicle"("id"),
  "is_backup_vehicle" boolean not null default false,
  "start_number_norm" text,
  "registration_status" text not null,
  "acceptance_status" text not null,
  "id_verified" boolean not null default false,
  "id_verified_at" timestamptz,
  "id_verified_by" text,
  "entry_fee_cents" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "entry_start_number_check" check ("start_number_norm" is null or "start_number_norm" ~ '^[A-Z0-9]{1,6}$'),
  constraint "entry_registration_status_check" check ("registration_status" in ('submitted_unverified', 'submitted_verified')),
  constraint "entry_acceptance_status_check" check ("acceptance_status" in ('pending', 'shortlist', 'accepted', 'rejected'))
);

create unique index if not exists "entry_start_number_unique"
  on "entry" ("event_id", "class_id", "start_number_norm")
  where "start_number_norm" is not null;

create table if not exists "invoice" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "driver_person_id" uuid not null references "person"("id"),
  "total_cents" integer not null default 0,
  "payment_status" text not null,
  "paid_at" timestamptz,
  "paid_amount_cents" integer,
  "recorded_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "invoice_payment_status_check" check ("payment_status" in ('due', 'paid')),
  constraint "invoice_event_driver_unique" unique ("event_id", "driver_person_id")
);

create table if not exists "audit_log" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event"("id") on delete set null,
  "actor_user_id" text,
  "action" text not null,
  "entity_type" text not null,
  "entity_id" uuid,
  "payload" jsonb,
  "created_at" timestamptz not null default now()
);

create index if not exists "audit_log_event_idx" on "audit_log" ("event_id");
