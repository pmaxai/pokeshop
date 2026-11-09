-- App licences: € 139 each, up to 50 per order (the licence service's limit).
UPDATE settings SET value = '13900' WHERE key = 'app_license_price_cents';

ALTER TABLE order_licenses DROP CONSTRAINT order_licenses_quantity_check;
ALTER TABLE order_licenses ADD CONSTRAINT order_licenses_quantity_check
  CHECK (quantity BETWEEN 1 AND 50);

-- The legal notice, invoices and e-mail footers name the owner only.
UPDATE settings SET value = jsonb_set(value, '{name}', '"Maximilian Pinter"')
 WHERE key = 'company' AND value->>'name' = 'Maximilian Pinter Sammelkartenverkauf';
