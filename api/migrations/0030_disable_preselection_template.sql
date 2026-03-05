update "email_template"
set
  "is_active" = false,
  "updated_at" = now()
where "template_key" = 'preselection';
