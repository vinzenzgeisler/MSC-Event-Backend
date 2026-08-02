-- Fix orphaned registration_groups where deleted_at IS NULL but all linked entries
-- are soft-deleted (or no entries exist at all). This can happen when an entry was
-- created without a registrationGroupId and later deleted, leaving the group behind.
UPDATE registration_group
SET deleted_at = now(),
    updated_at = now()
WHERE deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM entry
    WHERE entry.registration_group_id = registration_group.id
      AND entry.deleted_at IS NULL
  );
