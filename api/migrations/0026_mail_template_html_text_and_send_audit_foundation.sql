alter table if exists "email_template_version"
  add column if not exists "body_html_template" text,
  add column if not exists "body_text_template" text;

update "email_template_version"
set
  "body_html_template" = coalesce("body_html_template", "body_template"),
  "body_text_template" = coalesce("body_text_template", "body_template")
where "body_html_template" is null
   or "body_text_template" is null;
