-- App licences are sold by Antalyse GmbH, everything else by the shop's owner (sole trader).
-- Each seller has its own Stripe account; the GmbH's invoices, credit notes and VAT (Stripe
-- Tax) come from its Stripe account, so its numbers never mix with the shop's RE-/GS- series.

ALTER TABLE orders ADD COLUMN seller text NOT NULL DEFAULT 'shop'
  CHECK (seller IN ('shop', 'gmbh'));

-- VAT on GmbH orders: Austrian VAT, the buyer's country's VAT (OSS), reverse charge for EU
-- businesses, none for businesses outside the EU (export of a service).
ALTER TABLE orders DROP CONSTRAINT orders_vat_regime_check;
ALTER TABLE orders ADD CONSTRAINT orders_vat_regime_check
  CHECK (vat_regime IN ('domestic', 'oss', 'export', 'small_business', 'reverse_charge'));

-- The buyer: business or consumer, and the business's tax id (EU VAT ids checked with VIES).
ALTER TABLE orders
  ADD COLUMN buyer_business boolean NOT NULL DEFAULT false,
  ADD COLUMN buyer_tax_id text,
  ADD COLUMN buyer_tax_id_type text,
  ADD COLUMN stripe_customer_id text;

-- Stripe's invoice for a GmbH licence order (number, page and PDF for the e-mail and admin).
ALTER TABLE order_licenses
  ADD COLUMN stripe_invoice_id text,
  ADD COLUMN invoice_number text,
  ADD COLUMN invoice_url text,
  ADD COLUMN invoice_pdf_url text,
  ADD COLUMN terms_version integer;

-- Credit notes for GmbH refunds come from Stripe as well.
ALTER TABLE refunds
  ADD COLUMN stripe_credit_note_id text,
  ADD COLUMN credit_note_number text,
  ADD COLUMN credit_note_pdf_url text;

-- Business buyers from these countries may buy licences too (no consumers outside the EU).
INSERT INTO countries (code, is_eu, customs_required) VALUES ('AU', false, true)
ON CONFLICT (code) DO NOTHING;

-- The GmbH as seller: invoices come from its Stripe account; these details are for the licence
-- terms, the legal notice and the licence e-mails (sent from `email`).
INSERT INTO settings (key, value) VALUES ('license_seller', '{
  "name": "Antalyse GmbH",
  "street": "Wienerstraße 1",
  "postcode": "2440",
  "city": "Moosbrunn",
  "country": "AT",
  "email": "info@abc-it.at",
  "register_number": "FN 614039z",
  "register_court": "Landesgericht Korneuburg",
  "vat_id": "ATU79907228",
  "managing_director": "Maximilian Pinter",
  "chamber": "Wirtschaftskammer Niederösterreich",
  "supervisory_authority": "Bezirkshauptmannschaft Bruck an der Leitha"
}')
ON CONFLICT (key) DO NOTHING;

-- The GmbH's licence terms are a legal text of their own.
ALTER TABLE legal_texts DROP CONSTRAINT legal_texts_kind_check;
ALTER TABLE legal_texts ADD CONSTRAINT legal_texts_kind_check
  CHECK (kind IN ('agb', 'privacy', 'withdrawal', 'shipping_payment', 'conditions',
                  'accessibility', 'license_terms'));
