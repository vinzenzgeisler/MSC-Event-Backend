-- Kein Einsatz mehr Flag
ALTER TABLE marshal_person
  ADD COLUMN IF NOT EXISTS no_deployment boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN marshal_person.no_deployment IS
  'Kein Einsatz mehr — Person bleibt im System, wird rot markiert';

-- Composite key used by event-scoped assignment foreign keys below.
ALTER TABLE marshal_event_participation
  ADD CONSTRAINT marshal_event_participation_id_event_unique UNIQUE(id, event_id);

-- Flexible Event-Bereiche (Aufbau FL1, FL2, Allg. Helfer Sa/So)
CREATE TABLE IF NOT EXISTS marshal_helper_area (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  area_type         text NOT NULL,
  day_scope         text,
  sort_order        integer NOT NULL DEFAULT 0,
  responsible_label text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_helper_area_event_code_unique UNIQUE(event_id, code),
  CONSTRAINT marshal_helper_area_id_event_unique UNIQUE(id, event_id),
  CONSTRAINT marshal_helper_area_type_check CHECK(area_type IN ('setup', 'general')),
  CONSTRAINT marshal_helper_area_day_scope_check CHECK(day_scope IS NULL OR day_scope IN ('saturday', 'sunday'))
);
CREATE INDEX IF NOT EXISTS marshal_helper_area_event_sort_idx ON marshal_helper_area(event_id, sort_order);

-- Konfigurierbare Tagesschichten pro Aufbau-Bereich
CREATE TABLE IF NOT EXISTS marshal_area_shift (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  area_id     uuid NOT NULL,
  label       text NOT NULL,
  shift_date  date NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_area_shift_area_date_unique UNIQUE(area_id, shift_date),
  CONSTRAINT marshal_area_shift_id_event_unique UNIQUE(id, event_id),
  CONSTRAINT marshal_area_shift_area_event_fk FOREIGN KEY(area_id, event_id)
    REFERENCES marshal_helper_area(id, event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS marshal_area_shift_area_sort_idx ON marshal_area_shift(area_id, sort_order);

-- Zuweisung Person <-> Schicht (für Aufbau)
CREATE TABLE IF NOT EXISTS marshal_shift_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participation_id  uuid NOT NULL,
  shift_id          uuid NOT NULL,
  commitment_status text NOT NULL DEFAULT 'not_asked',
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_shift_assignment_unique UNIQUE(participation_id, shift_id),
  CONSTRAINT marshal_shift_assignment_participation_event_fk FOREIGN KEY(participation_id, event_id)
    REFERENCES marshal_event_participation(id, event_id) ON DELETE CASCADE,
  CONSTRAINT marshal_shift_assignment_shift_event_fk FOREIGN KEY(shift_id, event_id)
    REFERENCES marshal_area_shift(id, event_id) ON DELETE CASCADE,
  CONSTRAINT marshal_shift_assignment_status_check CHECK(commitment_status IN ('not_asked','pending','accepted','declined','tentative'))
);
CREATE INDEX IF NOT EXISTS marshal_shift_assignment_shift_idx ON marshal_shift_assignment(shift_id);

-- Zuweisung Person <-> Bereich (für Allg. Helfer ohne Schichten)
CREATE TABLE IF NOT EXISTS marshal_area_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participation_id  uuid NOT NULL,
  area_id           uuid NOT NULL,
  commitment_status text NOT NULL DEFAULT 'not_asked',
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marshal_area_assignment_unique UNIQUE(participation_id, area_id),
  CONSTRAINT marshal_area_assignment_participation_event_fk FOREIGN KEY(participation_id, event_id)
    REFERENCES marshal_event_participation(id, event_id) ON DELETE CASCADE,
  CONSTRAINT marshal_area_assignment_area_event_fk FOREIGN KEY(area_id, event_id)
    REFERENCES marshal_helper_area(id, event_id) ON DELETE CASCADE,
  CONSTRAINT marshal_area_assignment_status_check CHECK(commitment_status IN ('not_asked','pending','accepted','declined','tentative'))
);
CREATE INDEX IF NOT EXISTS marshal_area_assignment_area_idx ON marshal_area_assignment(area_id);
