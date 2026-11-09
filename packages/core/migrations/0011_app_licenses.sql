-- App licences (ScanPM) sold in the shop. A licence purchase is an order of its own kind:
-- no cards, no shipping; the keys come from the licence service (apps/license) after payment.

ALTER TABLE orders ADD COLUMN kind text NOT NULL DEFAULT 'cards'
  CHECK (kind IN ('cards', 'license'));
CREATE INDEX orders_kind ON orders (kind, created_at DESC) WHERE kind <> 'cards';

ALTER TABLE orders DROP CONSTRAINT orders_shipping_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_shipping_method_check
  CHECK (shipping_method IN ('standard', 'insured', 'tracked', 'none'));

-- What a licence order bought. Keys are not stored here: the licence service keeps them
-- (encrypted) and the shop asks for them when it sends the e-mail.
CREATE TABLE order_licenses (
  order_id bigint PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  -- The buyer asked for delivery before the withdrawal period ends and acknowledged that the
  -- right of withdrawal ends with it (§ 18 Abs. 1 Z 11 FAGG): ticked at checkout.
  immediate_delivery_consent_at timestamptz NOT NULL,
  license_ids text[] NOT NULL DEFAULT '{}',
  issued_at timestamptz,
  revoked_at timestamptz,
  downloads integer NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  last_download_at timestamptz
);

-- The APK the shop hands out; the newest row is the current one.
CREATE TABLE app_releases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  storage_key text NOT NULL,            -- path under MEDIA_DIR
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  notes text,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('app_license_price_cents', '8000'),
  -- Once the app is in the Play Store, its link replaces the APK download everywhere.
  ('app_play_store_url', 'null')
ON CONFLICT (key) DO NOTHING;
