CREATE TABLE IF NOT EXISTS newsletter_subscriber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_norm text NOT NULL,
  locale text NOT NULL DEFAULT 'de',
  status text NOT NULL DEFAULT 'pending',
  consent_version text NOT NULL,
  consent_text_hash text NOT NULL,
  verification_token_hash text,
  verification_expires_at timestamptz,
  verification_sent_at timestamptz,
  verification_window_started_at timestamptz,
  verification_send_count integer NOT NULL DEFAULT 0,
  unsubscribe_token_hash text,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscriber_email_norm_unique UNIQUE (email_norm),
  CONSTRAINT newsletter_subscriber_locale_check CHECK (locale IN ('de', 'en', 'cs', 'pl')),
  CONSTRAINT newsletter_subscriber_status_check CHECK (status IN ('pending', 'active', 'unsubscribed', 'bounced', 'complained'))
);

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscriber_verification_token_unique
  ON newsletter_subscriber (verification_token_hash) WHERE verification_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscriber_unsubscribe_token_unique
  ON newsletter_subscriber (unsubscribe_token_hash) WHERE unsubscribe_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS newsletter_subscriber_status_created_idx
  ON newsletter_subscriber (status, created_at DESC);

CREATE TABLE IF NOT EXISTS newsletter_consent_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid REFERENCES newsletter_subscriber(id) ON DELETE CASCADE,
  action text NOT NULL,
  consent_version text,
  consent_text_hash text,
  locale text NOT NULL,
  source text NOT NULL DEFAULT 'website',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_consent_event_action_check CHECK (action IN ('requested', 'confirmed', 'unsubscribed', 'admin_unsubscribed'))
);
CREATE INDEX IF NOT EXISTS newsletter_consent_event_subscriber_created_idx
  ON newsletter_consent_event (subscriber_id, created_at DESC);

-- Data minimisation: stale, unconfirmed requests and expired revocation evidence are removed automatically
-- when this migration runner is invoked regularly. The privacy-retention job performs the same statements.
