-- Gift vouchers and discount codes.
--
-- Vouchers (Wertgutscheine) are redeemable for cards only, i.e. with the shop (sole trader):
--   sold  – bought by a customer: a means of payment. The money came in at the sale; the open
--           balance is a liability, the sale itself is no revenue (multi-purpose voucher).
--   promo – given away by the shop, nobody paid for it: redeeming it is a price reduction.
-- Discount codes reduce the price of cards, licences or both (campaigns, codes for friends).
--
-- On an order: total = goods + shipping − discount (what the invoice says); voucher_cents of
-- the total is paid with sold vouchers, the rest through Stripe.

ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('cards', 'license', 'voucher'));

ALTER TABLE orders DROP CONSTRAINT orders_vat_regime_check;
ALTER TABLE orders ADD CONSTRAINT orders_vat_regime_check
  CHECK (vat_regime IN ('domestic', 'oss', 'export', 'small_business', 'reverse_charge',
                        'voucher'));

ALTER TABLE orders
  ADD COLUMN discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  -- Part of discount_cents that lowers the shipping charge (promotional vouchers only).
  ADD COLUMN shipping_discount_cents integer NOT NULL DEFAULT 0
    CHECK (shipping_discount_cents >= 0 AND shipping_discount_cents <= shipping_cents),
  ADD COLUMN voucher_cents integer NOT NULL DEFAULT 0 CHECK (voucher_cents >= 0),
  -- Part of refunded_cents that went back onto vouchers instead of the card.
  ADD COLUMN voucher_refunded_cents integer NOT NULL DEFAULT 0
    CHECK (voucher_refunded_cents >= 0 AND voucher_refunded_cents <= voucher_cents);
-- (the multi-column check of 0003 got the name orders_check)
ALTER TABLE orders DROP CONSTRAINT orders_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_cents_check
  CHECK (total_cents = goods_cents + shipping_cents - discount_cents
         AND total_cents >= 0 AND voucher_cents <= total_cents
         AND shipping_discount_cents <= discount_cents);

-- Share of the order's discount on each line (all its copies), so a refund pays back what the
-- buyer really paid for a card.
ALTER TABLE order_items ADD COLUMN discount_cents integer NOT NULL DEFAULT 0
  CHECK (discount_cents >= 0 AND discount_cents <= unit_price_cents * quantity);

-- ---------------------------------------------------------------------------
-- Vouchers
-- ---------------------------------------------------------------------------

CREATE TABLE vouchers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  origin text NOT NULL CHECK (origin IN ('sold', 'promo')),
  value_cents integer NOT NULL CHECK (value_cents > 0),
  balance_cents integer NOT NULL CHECK (balance_cents >= 0 AND balance_cents <= value_cents),
  -- sold: the order that paid for it
  order_id bigint UNIQUE REFERENCES orders (id),
  -- printed on the voucher
  recipient_name text CHECK (length(recipient_name) <= 80),
  message text CHECK (length(message) <= 300),
  -- promo: for whom or what (internal)
  note text CHECK (length(note) <= 300),
  -- Only promotional vouchers may expire; bought ones are valid for the statutory 30 years.
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'cancelled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin = 'promo' OR (order_id IS NOT NULL AND expires_at IS NULL))
);
CREATE INDEX vouchers_origin ON vouchers (origin, created_at DESC);

-- A voucher used on an order. Held while the order waits for payment; used once paid;
-- released (balance back) when the order is not paid. Refunds give restored_cents back.
CREATE TABLE voucher_redemptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_id bigint NOT NULL REFERENCES vouchers (id),
  order_id bigint NOT NULL REFERENCES orders (id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  restored_cents integer NOT NULL DEFAULT 0
    CHECK (restored_cents >= 0 AND restored_cents <= amount_cents),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'used', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (voucher_id, order_id)
);
CREATE INDEX voucher_redemptions_order ON voucher_redemptions (order_id);

-- Every change of a balance, for the books: sale, redemption, release, refund, cancellation.
CREATE TABLE voucher_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_id bigint NOT NULL REFERENCES vouchers (id),
  order_id bigint REFERENCES orders (id),
  kind text NOT NULL CHECK (kind IN ('issued', 'redeemed', 'released', 'restored', 'cancelled')),
  -- change of the balance (issued +, redeemed −, released/restored +, cancelled −)
  amount_cents integer NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voucher_movements_voucher ON voucher_movements (voucher_id, id);
CREATE INDEX voucher_movements_time ON voucher_movements (created_at);

-- A bought voucher before it exists: the purchase order (kind 'voucher').
CREATE TABLE order_gift_vouchers (
  order_id bigint PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
  value_cents integer NOT NULL CHECK (value_cents BETWEEN 1000 AND 30000),
  recipient_name text CHECK (length(recipient_name) <= 80),
  message text CHECK (length(message) <= 300),
  voucher_id bigint REFERENCES vouchers (id)
);

-- ---------------------------------------------------------------------------
-- Discount codes
-- ---------------------------------------------------------------------------

CREATE TABLE discount_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- what the customer types; compared without case
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$'),
  -- groups codes of one campaign (e.g. a batch of single-use codes for flyers)
  campaign text CHECK (length(campaign) <= 80),
  kind text NOT NULL CHECK (kind IN ('percent', 'amount')),
  percent_bp integer CHECK (percent_bp BETWEEN 1 AND 10000),   -- 2000 = 20 %
  amount_cents integer CHECK (amount_cents > 0),
  applies_to text NOT NULL CHECK (applies_to IN ('cards', 'licenses', 'both')),
  -- cards: minimum value of the cards (before the discount)
  min_goods_cents integer NOT NULL DEFAULT 0 CHECK (min_goods_cents >= 0),
  -- licences: the discount covers at most this many licences of an order
  max_licenses integer CHECK (max_licenses BETWEEN 1 AND 50),
  -- orders that may use it in total (null: no limit)
  max_uses integer CHECK (max_uses >= 1),
  once_per_customer boolean NOT NULL DEFAULT true,
  valid_from timestamptz,
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  note text CHECK (length(note) <= 300),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'percent') = (percent_bp IS NOT NULL)),
  CHECK ((kind = 'amount') = (amount_cents IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX discount_codes_code ON discount_codes (upper(code));
CREATE INDEX discount_codes_campaign ON discount_codes (campaign) WHERE campaign IS NOT NULL;

CREATE TABLE discount_code_uses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_id bigint NOT NULL REFERENCES discount_codes (id),
  order_id bigint NOT NULL UNIQUE REFERENCES orders (id),
  email text,
  discount_cents integer NOT NULL CHECK (discount_cents >= 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'used', 'released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discount_code_uses_code ON discount_code_uses (code_id, status);

-- Codes a visitor entered in the cart (checked again at checkout).
CREATE TABLE cart_codes (
  cart_id uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  code text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, code)
);

-- ---------------------------------------------------------------------------
-- Holds follow the order: an order that is not paid gives vouchers and codes back, a paid one
-- uses them. Every path that closes an open order (expiry, failed payment, a new checkout from
-- the same cart, sold out after payment) goes through the status, so none can forget it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION order_redemptions_follow_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Held amounts exist only on open orders – or on a given-up order whose late payment took
  -- them again – so any change to a closed status gives them back.
  IF NEW.status IN ('expired', 'payment_failed', 'cancelled') THEN
    UPDATE vouchers v SET balance_cents = v.balance_cents + r.amount_cents
      FROM voucher_redemptions r
     WHERE r.order_id = NEW.id AND r.status = 'held' AND v.id = r.voucher_id;
    INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents)
    SELECT voucher_id, order_id, 'released', amount_cents
      FROM voucher_redemptions WHERE order_id = NEW.id AND status = 'held';
    UPDATE voucher_redemptions SET status = 'released' WHERE order_id = NEW.id AND status = 'held';
    UPDATE discount_code_uses SET status = 'released' WHERE order_id = NEW.id AND status = 'held';
  ELSIF NEW.status = 'paid' AND OLD.status <> 'paid' THEN
    UPDATE voucher_redemptions SET status = 'used' WHERE order_id = NEW.id AND status = 'held';
    UPDATE discount_code_uses SET status = 'used' WHERE order_id = NEW.id AND status = 'held';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_redemptions_follow_status
  AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION order_redemptions_follow_status();

-- Refunds: part paid back onto vouchers (the rest went to the card through Stripe).
ALTER TABLE refunds ADD COLUMN voucher_cents integer NOT NULL DEFAULT 0 CHECK (voucher_cents >= 0);

-- Invoices: what was paid with which voucher (a means of payment, not a discount).
ALTER TABLE documents ADD COLUMN payments jsonb NOT NULL DEFAULT '[]';
