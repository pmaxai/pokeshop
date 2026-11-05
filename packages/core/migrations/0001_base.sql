-- 0001: extensions, helpers, settings, countries.
-- Needs the extensions pg_trgm and unaccent (ask the DB admin to allow them).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE; this wrapper fixes the dictionary so it can be
-- used in generated columns and indexes.
CREATE FUNCTION shop_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path FROM CURRENT
  AS $$ SELECT unaccent('unaccent'::regdictionary, $1) $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Key/value settings edited in the admin (reservation time, OSS switch, company data …).
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO settings (key, value) VALUES
  ('reservation_minutes', '10'),
  ('oss_enabled', 'false'),
  ('high_value_threshold_cents', 'null'),
  ('shop_mailbox', '"bestellung@pokemonkarten.at"'),
  ('admin_alert_recipients', '["bestellung@pokemonkarten.at"]'),
  ('company', '{
     "name": "Antalyse GmbH",
     "street": "Wienerstraße 1",
     "postcode": "2440",
     "city": "Moosbrunn",
     "country": "AT",
     "email": "bestellung@pokemonkarten.at",
     "register_number": "FN 614039z",
     "register_court": "Landesgericht Korneuburg",
     "vat_id": "ATU79907228",
     "managing_director": "Maximilian Pinter",
     "chamber": "Wirtschaftskammer Niederösterreich",
     "supervisory_authority": "Bezirkshauptmannschaft Bruck an der Leitha",
     "trade_licence": null
   }');

-- One row per country: delivery on/off, minimum order, shipping and insurance rules, VAT rate.
CREATE TABLE countries (
  code char(2) PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  delivery_enabled boolean NOT NULL DEFAULT false,
  is_eu boolean NOT NULL DEFAULT false,
  -- Standard VAT rate in basis points, used only when OSS is on (seed values: verify before use).
  vat_rate_bp integer NOT NULL DEFAULT 0 CHECK (vat_rate_bp BETWEEN 0 AND 5000),
  min_order_cents integer NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  standard_shipping_cents integer NOT NULL DEFAULT 0 CHECK (standard_shipping_cents >= 0),
  insured_rate_bp integer NOT NULL DEFAULT 2000 CHECK (insured_rate_bp BETWEEN 0 AND 10000),
  insured_minimum_cents integer NOT NULL DEFAULT 500 CHECK (insured_minimum_cents >= 0),
  -- Above this goods subtotal: tracked, uninsured, no charge. NULL = always insured.
  insured_max_order_cents integer DEFAULT 50000 CHECK (insured_max_order_cents >= 0),
  insured_max_charge_cents integer CHECK (insured_max_charge_cents >= 0),
  delivery_time_de text,
  delivery_time_en text,
  customs_required boolean NOT NULL DEFAULT false,
  note_de text,
  note_en text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER countries_updated_at BEFORE UPDATE ON countries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- EU member states with their standard VAT rates (as known mid-2026), delivery off.
INSERT INTO countries (code, is_eu, vat_rate_bp) VALUES
  ('AT', true, 2000), ('BE', true, 2100), ('BG', true, 2000), ('CY', true, 1900),
  ('CZ', true, 2100), ('DE', true, 1900), ('DK', true, 2500), ('EE', true, 2400),
  ('ES', true, 2100), ('FI', true, 2550), ('FR', true, 2000), ('GR', true, 2400),
  ('HR', true, 2500), ('HU', true, 2700), ('IE', true, 2300), ('IT', true, 2200),
  ('LT', true, 2100), ('LU', true, 1700), ('LV', true, 2100), ('MT', true, 1800),
  ('NL', true, 2100), ('PL', true, 2300), ('PT', true, 2300), ('RO', true, 2100),
  ('SE', true, 2500), ('SI', true, 2200), ('SK', true, 2300);

-- Other countries that may be switched on later, on request (exports, customs data needed).
INSERT INTO countries (code, is_eu, customs_required) VALUES
  ('CH', false, true), ('LI', false, true), ('NO', false, true), ('IS', false, true),
  ('GB', false, true), ('US', false, true), ('CA', false, true);

-- Launch countries.
UPDATE countries SET delivery_enabled = true, min_order_cents = 1000,
  delivery_time_de = '1–3 Werktage', delivery_time_en = '1–3 working days'
  WHERE code = 'AT';
UPDATE countries SET delivery_enabled = true, min_order_cents = 2000,
  delivery_time_de = '3–5 Werktage', delivery_time_en = '3–5 working days'
  WHERE code = 'DE';
