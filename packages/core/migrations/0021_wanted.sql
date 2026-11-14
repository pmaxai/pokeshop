-- 0021: missing cards ("wanted"): the customer's list of cards they are looking for, the shop's
-- offers for them, and the e-mail when a matching card is in the shop.

CREATE TABLE wanted_cards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- the app's id for an add (idempotency); one per account
  client_ref text CHECK (length(client_ref) BETWEEN 8 AND 64),
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 80),
  -- the customer's wishes; null = any
  language text CHECK (language IN ('DE', 'EN', 'FR', 'IT', 'ES', 'PT', 'NL', 'PL', 'RU',
                                    'JA', 'KO', 'ZH-HANT', 'ZH-HANS', 'ID', 'TH')),
  finish text CHECK (finish IN ('normal', 'holo', 'reverse_holo', 'first_edition',
                                'shadowless', 'stamped', 'pokeball', 'masterball')),
  -- this condition or better
  min_condition text CHECK (min_condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  max_price_cents integer CHECK (max_price_cents BETWEEN 1 AND 100000000),
  note text CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- off the list: removed by the customer, or bought in the shop
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IN ('removed', 'bought')),
  order_id bigint REFERENCES orders (id) ON DELETE SET NULL,
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  UNIQUE (account_id, client_ref)
);
CREATE INDEX wanted_cards_open ON wanted_cards (card_id) WHERE closed_at IS NULL;
CREATE INDEX wanted_cards_account ON wanted_cards (account_id, created_at DESC);

-- "Now in the shop" goes out once per missing card and product.
CREATE TABLE wanted_alerts (
  wanted_id bigint NOT NULL REFERENCES wanted_cards (id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  -- false: the card was already in the shop when it was put on the list (no e-mail)
  mailed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wanted_id, product_id)
);

-- The shop's offer to one customer: one copy of a product at a price of its own, until
-- expires_at. The product may be a draft: then nobody else sees it.
CREATE TABLE wanted_offers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wanted_id bigint NOT NULL REFERENCES wanted_cards (id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 1 AND 100000000),
  message text CHECK (length(message) <= 1000),
  expires_at timestamptz NOT NULL,
  -- open until bought (accepted), turned down (declined) or taken back (withdrawn); an open offer
  -- past expires_at has expired
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'withdrawn')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  order_id bigint REFERENCES orders (id) ON DELETE SET NULL
);
CREATE INDEX wanted_offers_account ON wanted_offers (account_id, created_at DESC);
CREATE INDEX wanted_offers_wanted ON wanted_offers (wanted_id);

-- A cart line taken from an offer: the offer's price, one copy, also for a draft product.
ALTER TABLE cart_items ADD COLUMN offer_id bigint REFERENCES wanted_offers (id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN offer_id bigint REFERENCES wanted_offers (id) ON DELETE SET NULL;

-- order_reserve as in 0003, except that a line from an offer may hold a draft product (the
-- card the shop put aside for that customer).
CREATE OR REPLACE FUNCTION order_reserve(p_order bigint) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  r_item record;
  r_box record;
  v_need integer;
  v_take integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
     WHERE i.order_id = p_order AND a.status IN ('reserved', 'committed')
  ) THEN
    RAISE EXCEPTION 'order already holds stock' USING ERRCODE = 'SH003';
  END IF;

  -- Lock every box of every product in this order, always in the same order.
  PERFORM 1 FROM stock_locations s
   WHERE s.product_id IN (SELECT product_id FROM order_items WHERE order_id = p_order)
   ORDER BY s.product_id, s.storage_location
     FOR UPDATE;

  FOR r_item IN
    SELECT i.id, i.product_id, i.quantity, p.status, i.offer_id
      FROM order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = p_order
     ORDER BY i.product_id, i.id
  LOOP
    IF r_item.status <> 'active' AND NOT (r_item.status = 'draft' AND r_item.offer_id IS NOT NULL) THEN
      RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = 'SH001',
        DETAIL = format('product %s is not active', r_item.product_id);
    END IF;
    v_need := r_item.quantity;
    FOR r_box IN
      SELECT storage_location, quantity - reserved AS free
        FROM stock_locations
       WHERE product_id = r_item.product_id AND quantity > reserved
       ORDER BY length(storage_location), storage_location
    LOOP
      EXIT WHEN v_need = 0;
      v_take := least(v_need, r_box.free);
      UPDATE stock_locations SET reserved = reserved + v_take, updated_at = now()
       WHERE product_id = r_item.product_id AND storage_location = r_box.storage_location;
      INSERT INTO order_item_allocations (order_item_id, storage_location, quantity)
        VALUES (r_item.id, r_box.storage_location, v_take);
      v_need := v_need - v_take;
    END LOOP;
    IF v_need > 0 THEN
      RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = 'SH001',
        DETAIL = format('product %s', r_item.product_id);
    END IF;
  END LOOP;
END $$;
