CREATE TABLE IF NOT EXISTS marshal_person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), helper_number integer NOT NULL,
  first_name text NOT NULL, last_name text NOT NULL, street text, zip text, city text,
  birthdate date, phone text, email text, shirt_size text,
  club_member boolean NOT NULL DEFAULT false, license_number text, vehicle_registration text,
  activity_areas jsonb NOT NULL DEFAULT '[]'::jsonb, note text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS marshal_person_helper_number_unique ON marshal_person(helper_number);
CREATE INDEX IF NOT EXISTS marshal_person_name_idx ON marshal_person(last_name, first_name);

CREATE TABLE IF NOT EXISTS marshal_event_participation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES marshal_person(id) ON DELETE CASCADE, contact_owner text, wish text, note text,
  shirt_size_snapshot text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_event_participation_event_person_unique UNIQUE(event_id, person_id)
);
CREATE INDEX IF NOT EXISTS marshal_event_participation_event_idx ON marshal_event_participation(event_id);

CREATE TABLE IF NOT EXISTS marshal_event_day (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  day_key text NOT NULL, label text NOT NULL, event_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_event_day_event_key_unique UNIQUE(event_id, day_key),
  CONSTRAINT marshal_event_day_key_check CHECK(day_key IN ('saturday', 'sunday'))
);

CREATE TABLE IF NOT EXISTS marshal_section (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL, leader_code text NOT NULL, sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_section_event_code_unique UNIQUE(event_id, code)
);
CREATE INDEX IF NOT EXISTS marshal_section_event_sort_idx ON marshal_section(event_id, sort_order);

CREATE TABLE IF NOT EXISTS marshal_post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES marshal_section(id) ON DELETE CASCADE, code text NOT NULL, description text,
  target_staff integer NOT NULL DEFAULT 2, is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_post_event_code_unique UNIQUE(event_id, code),
  CONSTRAINT marshal_post_target_staff_check CHECK(target_staff > 0)
);
CREATE INDEX IF NOT EXISTS marshal_post_section_sort_idx ON marshal_post(section_id, sort_order);

CREATE TABLE IF NOT EXISTS marshal_day_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participation_id uuid NOT NULL REFERENCES marshal_event_participation(id) ON DELETE CASCADE,
  day_id uuid NOT NULL REFERENCES marshal_event_day(id) ON DELETE CASCADE,
  commitment_status text NOT NULL DEFAULT 'not_asked', role text,
  section_id uuid REFERENCES marshal_section(id) ON DELETE SET NULL,
  post_id uuid REFERENCES marshal_post(id) ON DELETE SET NULL, function_code text, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_day_assignment_participation_day_unique UNIQUE(participation_id, day_id),
  CONSTRAINT marshal_day_assignment_commitment_check CHECK(commitment_status IN ('not_asked','pending','accepted','declined','tentative')),
  CONSTRAINT marshal_day_assignment_role_check CHECK(role IS NULL OR role IN ('marshal','section_leader','special'))
);
CREATE INDEX IF NOT EXISTS marshal_day_assignment_day_section_idx ON marshal_day_assignment(day_id, section_id);

CREATE TABLE IF NOT EXISTS marshal_qualification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL REFERENCES marshal_person(id) ON DELETE CASCADE,
  qualification_type text NOT NULL DEFAULT 'dmsb_license', number text, valid_from date, valid_until date, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_qualification_person_type_unique UNIQUE(person_id, qualification_type)
);

CREATE TABLE IF NOT EXISTS marshal_training_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  session_type text NOT NULL, title text NOT NULL, session_date date NOT NULL, location text, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_training_session_type_check CHECK(session_type IN ('training','briefing'))
);
CREATE INDEX IF NOT EXISTS marshal_training_session_event_date_idx ON marshal_training_session(event_id, session_date);

CREATE TABLE IF NOT EXISTS marshal_training_participant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES marshal_training_session(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES marshal_person(id) ON DELETE CASCADE,
  attendance_status text NOT NULL DEFAULT 'registered', note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_training_participant_session_person_unique UNIQUE(session_id, person_id),
  CONSTRAINT marshal_training_participant_attendance_check CHECK(attendance_status IN ('registered','attended','absent','excused'))
);

CREATE TABLE IF NOT EXISTS marshal_import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  workbook_sha256 text NOT NULL, filename text NOT NULL, status text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb, conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT marshal_import_run_status_check CHECK(status IN ('preview','completed','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS marshal_import_run_completed_workbook_unique
  ON marshal_import_run(event_id, workbook_sha256) WHERE status = 'completed';
