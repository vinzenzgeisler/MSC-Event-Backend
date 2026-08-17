ALTER TABLE marshal_post
  ADD COLUMN emergency_target_staff integer DEFAULT 1,
  ADD COLUMN map_x integer,
  ADD COLUMN map_y integer;

UPDATE marshal_post
SET emergency_target_staff = target_staff;

ALTER TABLE marshal_post
  ALTER COLUMN emergency_target_staff SET NOT NULL,
  ADD CONSTRAINT marshal_post_emergency_target_staff_check
    CHECK (emergency_target_staff > 0 AND emergency_target_staff <= target_staff),
  ADD CONSTRAINT marshal_post_map_coordinates_check
    CHECK (
      (map_x IS NULL AND map_y IS NULL)
      OR (
        map_x IS NOT NULL AND map_y IS NOT NULL
        AND map_x BETWEEN 0 AND 1000
        AND map_y BETWEEN 0 AND 1000
      )
    );
