-- Delivery to every EU member state on Germany's terms (shipping charge, minimum order and
-- insurance rules), 4–10 working days. Countries already switched on keep their settings;
-- everything stays editable in Admin › Einstellungen › Lieferländer.
UPDATE countries c
   SET delivery_enabled = true,
       min_order_cents = de.min_order_cents,
       standard_shipping_cents = de.standard_shipping_cents,
       insured_rate_bp = de.insured_rate_bp,
       insured_minimum_cents = de.insured_minimum_cents,
       insured_max_order_cents = de.insured_max_order_cents,
       insured_max_charge_cents = de.insured_max_charge_cents,
       delivery_time_de = coalesce(c.delivery_time_de, '4–10 Werktage'),
       delivery_time_en = coalesce(c.delivery_time_en, '4–10 working days')
  FROM countries de
 WHERE de.code = 'DE' AND c.is_eu AND NOT c.delivery_enabled;

-- English is the storefront's default language now: rows written without one get English.
ALTER TABLE carts ALTER COLUMN locale SET DEFAULT 'en';
ALTER TABLE withdrawals ALTER COLUMN locale SET DEFAULT 'en';
ALTER TABLE contact_messages ALTER COLUMN locale SET DEFAULT 'en';
