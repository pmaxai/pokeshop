-- 0009: the shop is run by Maximilian Pinter Sammelkartenverkauf (sole trader, not in the company
-- register) under the Austrian small business scheme (Kleinunternehmerregelung,
-- § 6 Abs. 1 Z 27 UStG): no VAT is charged or shown. High value now above € 50, insured shipping
-- 5 % of the goods value (still at least € 5).

ALTER TABLE orders DROP CONSTRAINT orders_vat_regime_check;
ALTER TABLE orders ADD CONSTRAINT orders_vat_regime_check
  CHECK (vat_regime IN ('domestic', 'oss', 'export', 'small_business'));

-- Read by checkout, cart and product pages; false = regular VAT (domestic / OSS / export).
INSERT INTO settings (key, value) VALUES ('small_business', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- The operator's name appears only in the legal notice, on invoices and in e-mail footers;
-- shop pages and legal texts use public_name and refer to the legal notice.
UPDATE settings SET value = '{
     "name": "Maximilian Pinter Sammelkartenverkauf",
     "public_name": "pokemonkarten.at",
     "street": "Wienerstraße 1",
     "postcode": "2440",
     "city": "Moosbrunn",
     "country": "AT",
     "email": "bestellung@pokemonkarten.at",
     "trade": "Handel mit Waren aller Art",
     "register_number": "",
     "register_court": "",
     "vat_id": "",
     "managing_director": "",
     "chamber": "Wirtschaftskammer Niederösterreich",
     "supervisory_authority": "Bezirkshauptmannschaft Bruck an der Leitha",
     "trade_licence": null
   }', updated_at = now()
 WHERE key = 'company' AND value ->> 'name' = 'Antalyse GmbH';

-- The settings trigger re-evaluates every product's high_value flag.
UPDATE settings SET value = '5000', updated_at = now()
 WHERE key = 'high_value_threshold_cents' AND value = '2000'::jsonb;

ALTER TABLE countries ALTER COLUMN insured_rate_bp SET DEFAULT 500;
UPDATE countries SET insured_rate_bp = 500, updated_at = now() WHERE insured_rate_bp = 1000;
