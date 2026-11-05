-- 0006: high value by price, 10 % insurance, Austrian Post, carts, checkout fields on orders,
-- order history, online withdrawal details.

-- ---------------------------------------------------------------------------
-- High value: a card is high value when its price is MORE than the threshold
-- (setting high_value_threshold_cents, € 20). Kept in products.high_value by a
-- trigger so every reader (shop, checkout, admin) sees the same answer.
-- ---------------------------------------------------------------------------
UPDATE settings SET value = '2000', updated_at = now() WHERE key = 'high_value_threshold_cents';

CREATE FUNCTION high_value_threshold() RETURNS integer
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::integer END
    FROM settings WHERE key = 'high_value_threshold_cents'
$$;

CREATE FUNCTION products_set_high_value() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_threshold integer := high_value_threshold();
BEGIN
  NEW.high_value := NEW.price_cents IS NOT NULL AND v_threshold IS NOT NULL
                    AND NEW.price_cents > v_threshold;
  RETURN NEW;
END $$;

CREATE TRIGGER products_high_value BEFORE INSERT OR UPDATE OF price_cents, high_value ON products
  FOR EACH ROW EXECUTE FUNCTION products_set_high_value();

-- Changing the threshold re-evaluates every product.
CREATE FUNCTION settings_high_value_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'high_value_threshold_cents' AND NEW.value IS DISTINCT FROM OLD.value THEN
    UPDATE products SET high_value = high_value;  -- fires products_high_value
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settings_high_value AFTER UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION settings_high_value_changed();

UPDATE products SET high_value = high_value;

-- ---------------------------------------------------------------------------
-- Insured shipping: 10 % of the goods value, at least € 5, for orders up to
-- € 500. Above € 500 there is no insured option (tracked, free).
-- ---------------------------------------------------------------------------
ALTER TABLE countries ALTER COLUMN insured_rate_bp SET DEFAULT 1000;
UPDATE countries SET insured_rate_bp = 1000, updated_at = now() WHERE insured_rate_bp = 2000;

-- Carrier: Österreichische Post. {number} is replaced by the tracking number.
INSERT INTO settings (key, value) VALUES
  ('carrier', '{"code": "post_at", "name": "Österreichische Post",
                "tracking_url": "https://www.post.at/s/sendungsdetails?snr={number}"}')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Carts: no reservation, just a list. The cookie holds the random cart id.
-- ---------------------------------------------------------------------------
CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country char(2) REFERENCES countries (code),
  locale text NOT NULL DEFAULT 'de' CHECK (locale IN ('de', 'en')),
  -- Details last entered at checkout, so a cancelled payment need not be retyped.
  checkout jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER carts_updated_at BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX carts_updated ON carts (updated_at);

CREATE TABLE cart_items (
  cart_id uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Orders: link to the cart, payment page, accepted terms, history.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN cart_id uuid,
  ADD COLUMN payment_url text,
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN privacy_version integer,
  ADD COLUMN withdrawal_version integer;
CREATE INDEX orders_cart ON orders (cart_id) WHERE status = 'checkout';
CREATE INDEX orders_stripe_pi ON orders (stripe_payment_intent_id);

CREATE TABLE order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind text NOT NULL,          -- created, reserved, payment_started, paid, expired, refunded, …
  detail jsonb NOT NULL DEFAULT '{}',
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, created_at);

-- Refunds the shop starts itself (cards sold out by the time a late payment arrives).
ALTER TABLE refunds ADD COLUMN status text NOT NULL DEFAULT 'succeeded'
  CHECK (status IN ('pending', 'succeeded', 'failed'));

-- ---------------------------------------------------------------------------
-- Online withdrawal (§ 13a FAGG): what the form collects.
-- ---------------------------------------------------------------------------
ALTER TABLE withdrawals
  ADD COLUMN order_date text,
  ADD COLUMN message text,
  ADD COLUMN locale text NOT NULL DEFAULT 'de' CHECK (locale IN ('de', 'en'));
ALTER TABLE withdrawals ALTER COLUMN order_number DROP NOT NULL;

-- Legal texts are kept in the repository and loaded on migrate; one row per version.
ALTER TABLE legal_texts ADD COLUMN content_hash text;
