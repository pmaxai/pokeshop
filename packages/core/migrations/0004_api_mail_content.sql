-- 0004: API clients and idempotency, e-mail outbox, events page, legal texts,
-- contact form, admin sessions, audit log.

CREATE TABLE api_clients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  key_id text NOT NULL UNIQUE,
  secret_enc text NOT NULL,                 -- AES-256-GCM, see packages/core/src/secrets.ts
  scopes text[] NOT NULL DEFAULT '{products:read,products:write,stock:write}',
  ip_allowlist cidr[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 600,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Repeated Idempotency-Key within 24 h returns the stored response.
CREATE TABLE api_idempotency (
  client_id bigint NOT NULL REFERENCES api_clients (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, idempotency_key)
);
CREATE INDEX api_idempotency_created ON api_idempotency (created_at);

CREATE TABLE api_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id bigint REFERENCES api_clients (id) ON DELETE SET NULL,
  key_id text,
  method text NOT NULL,
  path text NOT NULL,
  status_code integer NOT NULL,
  error_code text,
  duration_ms integer,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_log_created ON api_request_log (created_at DESC);

-- Every e-mail is written here first (same transaction as its cause), then sent by the worker via Graph.
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template text NOT NULL,                   -- e.g. order_confirmation, shipped, withdrawal_ack
  dedupe_key text UNIQUE,                   -- e.g. order_confirmation:123, prevents double mails
  to_address text NOT NULL,
  reply_to text,
  locale text NOT NULL CHECK (locale IN ('de', 'en')),
  payload jsonb NOT NULL DEFAULT '{}',
  attachments jsonb NOT NULL DEFAULT '[]',  -- [{kind: "document", id: 12}] resolved at send time
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';

-- "Veranstaltungen": trading shows and other events.
CREATE TABLE shop_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  title_de text NOT NULL,
  title_en text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz CHECK (ends_at IS NULL OR ends_at >= starts_at),
  venue text,
  street text,
  postcode text,
  city text NOT NULL,
  country char(2) NOT NULL DEFAULT 'AT',
  description_de text,
  description_en text,
  entry_fee text,
  table_info text,
  website_url text CHECK (website_url IS NULL OR website_url ~ '^https?://'),
  image_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER shop_events_updated_at BEFORE UPDATE ON shop_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX shop_events_upcoming ON shop_events (starts_at) WHERE status = 'published';

-- Versioned legal texts; the AGB version accepted is stored on each order.
CREATE TABLE legal_texts (
  kind text NOT NULL CHECK (kind IN ('agb', 'privacy', 'withdrawal', 'shipping_payment', 'conditions', 'accessibility')),
  locale text NOT NULL CHECK (locale IN ('de', 'en')),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body_md text NOT NULL,
  published_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, locale, version)
);

CREATE TABLE contact_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  subject text,
  message text NOT NULL,
  locale text NOT NULL DEFAULT 'de',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Admin sign-in via Microsoft Entra ID; the cookie holds a random token, only its hash is stored.
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  subject text NOT NULL,                    -- Entra object id (oid)
  email text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('owner', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  user_agent text
);
CREATE INDEX admin_sessions_expires ON admin_sessions (expires_at);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,                     -- e.g. product.update, country.update, api_client.revoke
  entity text,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);
