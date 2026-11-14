-- 0019: app subscriptions (Collector / Creator, extra devices) sold by Antalyse GmbH through its
-- Stripe account, complimentary subscriptions given by the shop, and the devices paired to an
-- account by QR code. Replaces the one-off licences for new customers.

-- The customer's billing details at the GmbH's Stripe account.
ALTER TABLE accounts
  ADD COLUMN stripe_customer_id text UNIQUE,
  -- {buyer, name, company, vat_id, street, postcode, city, country, regime, vies_name}
  ADD COLUMN billing jsonb;

-- One row per account: the current (or last) subscription.
CREATE TABLE subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('stripe', 'complimentary')),
  plan text NOT NULL CHECK (plan IN ('collector', 'creator')),
  extra_devices integer NOT NULL DEFAULT 0 CHECK (extra_devices BETWEEN 0 AND 20),
  -- Stripe's status (active, past_due, canceled, …); 'complimentary' for given ones
  status text NOT NULL,
  stripe_subscription_id text UNIQUE,
  -- 'incl' (price with VAT) or 'excl' (net, reverse charge)
  tax_behavior text CHECK (tax_behavior IN ('incl', 'excl')),
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- complimentary: until when (NULL = no end); Stripe: when a cancellation takes effect
  ends_at timestamptz,
  ended_at timestamptz,
  -- Stripe subscription item ids {base, devices}
  items jsonb NOT NULL DEFAULT '{}',
  note text CHECK (length(note) <= 500),
  granted_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'stripe' OR stripe_subscription_id IS NOT NULL)
);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Monthly prices in cents including VAT; usage prices are set before the services are offered.
INSERT INTO settings (key, value) VALUES
  ('subscription_prices', '{"collector": 700, "creator": 1200, "collector_device": 400,
                            "creator_device": 700, "s3_gb": null, "pipeline_minute": null}')
ON CONFLICT (key) DO NOTHING;

-- Phones and tablets paired to an account. A device belongs to one account at a time; a
-- disconnected one keeps its row (ended_at, end_reason), so the app can be told why.
CREATE TABLE devices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^dev_[0-9a-z]{10}$'),
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- the random id the app made once (its "device_id")
  device_uuid text NOT NULL CHECK (length(device_uuid) BETWEEN 8 AND 64),
  name text CHECK (length(name) <= 80),
  platform text NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
  app_version text CHECK (length(app_version) <= 40),
  token_hash text NOT NULL UNIQUE,
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('removed', 'transferred', 'replaced', 'disconnected')),
  -- transferred: the name of the device that took over
  successor_name text,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX devices_active_uuid ON devices (device_uuid) WHERE ended_at IS NULL;
CREATE INDEX devices_account ON devices (account_id, paired_at) WHERE ended_at IS NULL;

-- QR codes that pair a device: shown in the portal, or by a device moving to a new phone.
CREATE TABLE pairing_codes (
  code_hash text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- a transfer code: the device that hands over its slot
  from_device_id bigint REFERENCES devices (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by bigint REFERENCES devices (id) ON DELETE SET NULL
);
CREATE INDEX pairing_codes_account ON pairing_codes (account_id, created_at DESC);

-- Services on request (Creator): S3 storage for recordings and the video pipeline, switched on
-- by the shop per customer and billed by usage. config_enc: the S3 settings for the app,
-- encrypted with the API master key.
CREATE TABLE account_services (
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('s3', 'pipeline')),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  enabled_by text,
  disabled_at timestamptz,
  config_enc text,
  config_updated_at timestamptz,
  -- the metered Stripe subscription item the usage is reported to
  stripe_item_id text,
  PRIMARY KEY (account_id, service)
);
