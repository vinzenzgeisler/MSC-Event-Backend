with target_templates as (
  select id
  from email_template
  where template_key in (
    'registration_received',
    'accepted_open_payment',
    'payment_reminder',
    'rejected',
    'newsletter',
    'event_update',
    'free_form',
    'payment_reminder_followup',
    'email_confirmation'
  )
)
update email_template t
set
  description = replace(
    replace(
      replace(
        replace(
          replace(
            replace(coalesce(t.description, ''), 'Ae', 'Ä'),
            'Oe',
            'Ö'
          ),
          'Ue',
          'Ü'
        ),
        'ae',
        'ä'
      ),
      'oe',
      'ö'
    ),
    'ue',
    'ü'
  )
where t.id in (select id from target_templates);

with target_templates as (
  select id
  from email_template
  where template_key in (
    'registration_received',
    'accepted_open_payment',
    'payment_reminder',
    'rejected',
    'newsletter',
    'event_update',
    'free_form',
    'payment_reminder_followup',
    'email_confirmation'
  )
)
update email_template_version v
set
  subject_template = replace(
    replace(
      replace(
        replace(
          replace(
            replace(coalesce(v.subject_template, ''), 'Ae', 'Ä'),
            'Oe',
            'Ö'
          ),
          'Ue',
          'Ü'
        ),
        'ae',
        'ä'
      ),
      'oe',
      'ö'
    ),
    'ue',
    'ü'
  ),
  body_template = replace(
    replace(
      replace(
        replace(
          replace(
            replace(coalesce(v.body_template, ''), 'Ae', 'Ä'),
            'Oe',
            'Ö'
          ),
          'Ue',
          'Ü'
        ),
        'ae',
        'ä'
      ),
      'oe',
      'ö'
    ),
    'ue',
    'ü'
  ),
  body_text_template = replace(
    replace(
      replace(
        replace(
          replace(
            replace(coalesce(v.body_text_template, ''), 'Ae', 'Ä'),
            'Oe',
            'Ö'
          ),
          'Ue',
          'Ü'
        ),
        'ae',
        'ä'
      ),
      'oe',
      'ö'
    ),
    'ue',
    'ü'
  ),
  body_html_template = replace(
    replace(
      replace(
        replace(
          replace(
            replace(coalesce(v.body_html_template, ''), 'Ae', 'Ä'),
            'Oe',
            'Ö'
          ),
          'Ue',
          'Ü'
        ),
        'ae',
        'ä'
      ),
      'oe',
      'ö'
    ),
    'ue',
    'ü'
  )
where v.template_id in (select id from target_templates);
