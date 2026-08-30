ALTER TABLE marshal_section
  ADD COLUMN leader_target_staff integer NOT NULL DEFAULT 2,
  ADD CONSTRAINT marshal_section_leader_target_staff_check
    CHECK (leader_target_staff > 0 AND leader_target_staff <= 20);
