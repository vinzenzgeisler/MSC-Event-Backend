-- Nutzerwunsch (2026-09-22): RacePic akzeptierte im MVP bewusst nur JPEG (siehe
-- racepic-architecture.md), jetzt zusaetzlich PNG zulassen. Die CHECK-Constraint auf
-- racepic_upload.content_type liess bisher ausschliesslich 'image/jpeg' zu.

alter table "racepic_upload" drop constraint "racepic_upload_content_type_check";
alter table "racepic_upload" add constraint "racepic_upload_content_type_check"
  check ("content_type" in ('image/jpeg', 'image/png'));
