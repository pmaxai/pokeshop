-- 0007: fulfilment – invoices and credit notes keep a frozen copy of their lines, refunds can
-- include the shipping charge, withdrawals get a note.

-- An issued document never changes, even if the order is refunded afterwards.
ALTER TABLE documents
  ADD COLUMN lines jsonb NOT NULL DEFAULT '[]',   -- [{de, en, quantity, unit_cents}]
  ADD COLUMN delivered_at timestamptz,            -- invoice: day the parcel left
  ADD COLUMN refers_to text,                      -- credit note: invoice number it corrects
  ADD COLUMN billing_address jsonb;

-- Shipping charge refunded with this refund (part of amount_cents).
ALTER TABLE refunds
  ADD COLUMN shipping_cents integer NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  ADD COLUMN error text;
CREATE INDEX refunds_order ON refunds (order_id);

ALTER TABLE withdrawals ADD COLUMN note text;
