CREATE TABLE simulator_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  best_time_ms INTEGER NOT NULL CHECK (best_time_ms > 0),
  day TEXT NOT NULL CHECK (day IN ('saturday', 'sunday')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name, day)
);
CREATE INDEX simulator_entry_event_day_time_idx ON simulator_entry (event_id, day, best_time_ms ASC);
