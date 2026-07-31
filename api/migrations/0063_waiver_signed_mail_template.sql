-- Add waiver_signed system mail template
-- Sent automatically after completeDeviceSigningSession with the signed PDF attached.

insert into email_template (id, template_key, description, is_active)
values (gen_random_uuid(), 'waiver_signed', 'Persönliche Haftverzichtserklärung (nach Unterzeichnung)', true)
on conflict (template_key) do update
set description = excluded.description, is_active = true;

with tt as (
  select t.id as template_id, coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key = 'waiver_signed'
  group by t.id
)
insert into email_template_version (
  id, template_id, version,
  subject_template, body_template, body_text_template, body_html_template,
  status, created_by, updated_by, updated_at
)
select
  gen_random_uuid(),
  tt.template_id,
  tt.current_version + 1,
  'Ihre persönliche Haftverzichtserklärung – {{eventName}}',
  'Hallo {{signerName}},' || E'\n\n' ||
  'anbei finden Sie Ihre persönliche Haftverzichtserklärung für die Veranstaltung {{eventName}} ' ||
  '({{eventDates}}).' || E'\n\n' ||
  'Die Erklärung wurde am {{signedAt}} von Ihnen persönlich unterzeichnet. ' ||
  'Das signierte Dokument ist dieser E-Mail als PDF-Anhang beigefügt.' || E'\n\n' ||
  'Bei Fragen wenden Sie sich bitte an: nennung@msc-oberlausitzer-dreilaendereck.eu' || E'\n\n' ||
  'Mit freundlichen Grüßen' || E'\n' ||
  'MSC Oberlausitzer Dreiländereck e.V.',
  'Hallo {{signerName}},' || E'\n\n' ||
  'anbei finden Sie Ihre persönliche Haftverzichtserklärung für die Veranstaltung {{eventName}} ' ||
  '({{eventDates}}).' || E'\n\n' ||
  'Die Erklärung wurde am {{signedAt}} von Ihnen persönlich unterzeichnet. ' ||
  'Das signierte Dokument ist dieser E-Mail als PDF-Anhang beigefügt.' || E'\n\n' ||
  'Bei Fragen wenden Sie sich bitte an: nennung@msc-oberlausitzer-dreilaendereck.eu' || E'\n\n' ||
  'Mit freundlichen Grüßen' || E'\n' ||
  'MSC Oberlausitzer Dreiländereck e.V.',
  '<p>Hallo {{signerName}},</p>' ||
  '<p>anbei finden Sie Ihre persönliche Haftverzichtserklärung für die Veranstaltung ' ||
  '<strong>{{eventName}}</strong> ({{eventDates}}).</p>' ||
  '<p>Die Erklärung wurde am {{signedAt}} von Ihnen persönlich unterzeichnet. ' ||
  'Das signierte Dokument ist dieser E-Mail als PDF-Anhang beigefügt.</p>' ||
  '<p>Bei Fragen wenden Sie sich bitte an: ' ||
  '<a href="mailto:nennung@msc-oberlausitzer-dreilaendereck.eu">nennung@msc-oberlausitzer-dreilaendereck.eu</a></p>' ||
  '<p>Mit freundlichen Grüßen<br>MSC Oberlausitzer Dreiländereck e.V.</p>',
  'published',
  'system',
  'system',
  now()
from tt;
