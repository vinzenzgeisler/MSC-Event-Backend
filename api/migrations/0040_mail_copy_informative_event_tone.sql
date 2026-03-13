with template_updates(template_key, subject_template, body_text_template, body_html_template) as (
  values
    (
      'registration_received',
      'Anmeldung eingegangen - {{eventName}}',
      $$Hallo {{driverName}},

deine Nennung für {{eventName}} ist bei uns eingegangen.
Bitte bestätige jetzt deine E-Mail-Adresse über den Bestätigungslink:
{{verificationUrl}}

Danach prüfen wir deine Unterlagen und melden uns mit den nächsten Schritten zur Veranstaltung.$$,
      null::text
    ),
    (
      'email_confirmation_reminder',
      'Erinnerung: E-Mail bestätigen - {{eventName}}',
      $$Hallo {{driverName}},

deine Nennung für {{eventName}} ist noch nicht bestätigt.
Bitte bestätige jetzt deine E-Mail-Adresse über den Bestätigungslink:
{{verificationUrl}}

Ohne Bestätigung können wir deine Nennung nicht abschließend bearbeiten.$$,
      null::text
    ),
    (
      'accepted_open_payment',
      'Zulassung bestätigt - {{eventName}}',
      $$Hallo {{driverName}},

deine Nennung für {{eventName}} wurde zugelassen.
Aktuell ist noch ein Betrag offen: {{amountOpen}}.

Die Nennbestätigung findest du im Anhang als PDF.$$,
      null::text
    ),
    (
      'accepted_paid_completed',
      'Nennung vollständig - {{eventName}}',
      $$Hallo {{driverName}},

vielen Dank, deine Zahlung ist eingegangen und deine Nennung für {{eventName}} ist vollständig abgeschlossen.
Wir freuen uns auf deine Teilnahme an der Veranstaltung.$$,
      null::text
    ),
    (
      'rejected',
      'Status deiner Nennung - {{eventName}}',
      $$Hallo {{driverName}},

leider können wir deine Nennung für {{eventName}} aktuell nicht berücksichtigen.
Wenn du Rückfragen hast, antworte einfach auf diese E-Mail.$$,
      null::text
    ),
    (
      'payment_reminder',
      'Zahlungserinnerung - {{eventName}}',
      $$Hallo {{driverName}},

für deine Nennung zu {{eventName}} ist aktuell noch ein Betrag offen: {{amountOpen}}.
Bitte nutze die bekannten Zahlungsinformationen, damit wir deine Nennung vollständig abschließen können.$$,
      null::text
    ),
    (
      'newsletter',
      'Aktuelles zur Veranstaltung - {{eventName}}',
      $$Hallo {{driverName}},

{{introText}}

{{detailsText}}

{{closingText}}$$,
      null::text
    ),
    (
      'event_update',
      'Update zur Veranstaltung - {{eventName}}',
      $$Hallo {{driverName}},

{{introText}}

{{detailsText}}

{{closingText}}$$,
      null::text
    ),
    (
      'free_form',
      'Mitteilung zur Veranstaltung - {{eventName}}',
      $$Hallo {{driverName}},

{{introText}}

{{detailsText}}

{{closingText}}$$,
      null::text
    ),
    (
      'payment_reminder_followup',
      'Freundliche Zahlungserinnerung - {{eventName}}',
      $$Hallo {{driverName}},

das ist eine freundliche Erinnerung zu deiner Nennung für {{eventName}}.
{{detailsText}}

{{closingText}}$$,
      null::text
    ),
    (
      'email_confirmation',
      'Bitte E-Mail-Adresse bestätigen - {{eventName}}',
      $$Hallo {{driverName}},

bitte bestätige deine E-Mail-Adresse über den folgenden Link:
{{verificationUrl}}

Erst danach können wir deine Nennung abschließend bearbeiten.$$,
      null::text
    ),
    (
      'codriver_info',
      'Info: Du wurdest als Beifahrer eingetragen - {{eventName}}',
      $$Hallo {{codriverName}},

{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.
{{className}}
Startnummer: {{startNumber}}

Dies ist nur eine Information. Du musst nichts weiter tun.$$,
      '<p>Hallo {{codriverName}},</p><p>{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.</p><p>{{className}}<br />Startnummer: {{startNumber}}</p><p>Dies ist nur eine Information. Du musst nichts weiter tun.</p>'
    )
),
target_templates as (
  select
    t.id as template_id,
    t.template_key,
    coalesce(max(v.version), 0) as current_version,
    u.subject_template,
    u.body_text_template,
    u.body_html_template
  from email_template t
  join template_updates u on u.template_key = t.template_key
  left join email_template_version v on v.template_id = t.id
  group by t.id, t.template_key, u.subject_template, u.body_text_template, u.body_html_template
)
insert into email_template_version (
  id,
  template_id,
  version,
  subject_template,
  body_template,
  body_text_template,
  body_html_template,
  status,
  created_by,
  updated_by,
  updated_at
)
select
  gen_random_uuid(),
  tt.template_id,
  tt.current_version + 1,
  tt.subject_template,
  tt.body_text_template,
  tt.body_text_template,
  tt.body_html_template,
  'published',
  'system',
  'system',
  now()
from target_templates tt;
