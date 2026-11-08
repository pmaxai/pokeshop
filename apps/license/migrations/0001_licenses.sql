-- License service: one-off licences for the scanner app, one active device per licence.
-- Own database (LICENSE_DATABASE_URL), separate from the shop's.

CREATE TABLE licenses (
  id text PRIMARY KEY,                          -- lic_…, safe to show and log
  key_hash bytea NOT NULL UNIQUE,               -- sha256 of the normalized key: lookups
  key_enc text NOT NULL,                        -- the key, AES-256-GCM (LICENSE_MASTER_KEY): sent again on request
  key_hint text NOT NULL,                       -- last group of the key, for support
  email text,                                   -- buyer, for "send my licence again"
  name text,
  order_ref text,                               -- the shop's order (with order_seq: one row per licence of an order)
  order_seq integer NOT NULL DEFAULT 1 CHECK (order_seq >= 1),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  UNIQUE (order_ref, order_seq)
);

CREATE INDEX licenses_email ON licenses (lower(email));

-- Every device a licence was ever activated on. The current one has ended_at NULL;
-- activating another device ends it (replaced_by), and the old device learns that on its next check.
CREATE TABLE activations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_id text NOT NULL REFERENCES licenses (id),
  token_hash bytea NOT NULL UNIQUE,             -- sha256 of the token the device holds
  device_id text NOT NULL,                      -- random id the app made on first start
  device_name text,                             -- e.g. "Pixel 8", shown to the replaced device
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  replaced_by bigint REFERENCES activations (id)
);

-- the rule itself: never two active devices for one licence
CREATE UNIQUE INDEX activations_one_active ON activations (license_id) WHERE ended_at IS NULL;
CREATE INDEX activations_license ON activations (license_id, created_at);
