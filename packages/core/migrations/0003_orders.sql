-- 0003: orders, box allocations (pick sheet), reservation functions, Stripe events,
-- invoices and credit notes, refunds, withdrawals.

CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number text NOT NULL UNIQUE,              -- e.g. PK-2611-7KQ4M
  lookup_token text NOT NULL UNIQUE,        -- random, used in e-mail links to the order-status page
  status text NOT NULL DEFAULT 'checkout' CHECK (status IN (
    'checkout',          -- cards reserved, buyer on the Stripe page (max. reservation time)
    'awaiting_payment',  -- async payment started, waiting for Stripe's result
    'paid', 'packing', 'shipped', 'completed',
    'expired', 'payment_failed', 'cancelled', 'refunded')),
  locale text NOT NULL CHECK (locale IN ('de', 'en')),
  country char(2) NOT NULL REFERENCES countries (code),
  email text,
  customer_name text,
  phone text,
  billing_address jsonb,
  shipping_address jsonb,
  goods_cents integer NOT NULL CHECK (goods_cents >= 0),
  shipping_cents integer NOT NULL CHECK (shipping_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents = goods_cents + shipping_cents),
  shipping_method text NOT NULL CHECK (shipping_method IN ('standard', 'insured', 'tracked')),
  vat_regime text NOT NULL CHECK (vat_regime IN ('domestic', 'oss', 'export')),
  tax_country char(2),
  vat_rate_bp integer NOT NULL CHECK (vat_rate_bp >= 0),
  vat_cents integer NOT NULL CHECK (vat_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  reserved_until timestamptz,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text,
  payment_method_type text,
  agb_version integer,
  paid_at timestamptz,
  shipped_at timestamptz,
  cancelled_at timestamptz,
  carrier text,
  tracking_number text,
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  internal_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX orders_status ON orders (status, created_at DESC);
CREATE INDEX orders_open_holds ON orders (reserved_until) WHERE status = 'checkout';
CREATE INDEX orders_email ON orders (lower(email));

-- Line items keep a snapshot of the card as sold.
CREATE TABLE order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (id),
  sku text NOT NULL,
  name_de text NOT NULL,
  name_en text NOT NULL,
  set_code text NOT NULL,
  set_name_de text,
  set_name_en text,
  card_number text NOT NULL,
  card_language text NOT NULL,
  condition text NOT NULL,
  finish text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  high_value boolean NOT NULL DEFAULT false,
  refunded_quantity integer NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  restocked_quantity integer NOT NULL DEFAULT 0 CHECK (restocked_quantity >= 0),
  CHECK (refunded_quantity <= quantity AND restocked_quantity <= refunded_quantity)
);
CREATE INDEX order_items_order ON order_items (order_id);
CREATE INDEX order_items_product ON order_items (product_id);

-- Which box each copy comes from. Committed rows drive the pick sheet.
CREATE TABLE order_item_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id bigint NOT NULL REFERENCES order_items (id) ON DELETE CASCADE,
  storage_location text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER order_item_allocations_updated_at BEFORE UPDATE ON order_item_allocations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX order_item_allocations_item ON order_item_allocations (order_item_id);
CREATE INDEX order_item_allocations_box ON order_item_allocations (storage_location) WHERE status = 'committed';

-- Reserves every line of an order, taking copies from the lowest box number first.
-- All-or-nothing: raises SH001 (DETAIL names the product) if any line cannot be covered.
CREATE FUNCTION order_reserve(p_order bigint) RETURNS void
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
    SELECT i.id, i.product_id, i.quantity, p.status
      FROM order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = p_order
     ORDER BY i.product_id, i.id
  LOOP
    IF r_item.status <> 'active' THEN
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

-- Gives back all copies an order still holds (reservation expired, payment failed, cancelled).
-- Returns the number of copies released.
CREATE FUNCTION order_release_stock(p_order bigint) RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT a.id, i.product_id, a.storage_location, a.quantity
      FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
     WHERE i.order_id = p_order AND a.status = 'reserved'
     ORDER BY i.product_id, a.storage_location
       FOR UPDATE OF a
  LOOP
    UPDATE stock_locations SET reserved = greatest(reserved - r.quantity, 0), updated_at = now()
     WHERE product_id = r.product_id AND storage_location = r.storage_location;
    UPDATE order_item_allocations SET status = 'released' WHERE id = r.id;
    v_count := v_count + r.quantity;
  END LOOP;
  RETURN v_count;
END $$;

-- Turns the reservation into a sale once Stripe reports the payment.
-- Returns 'committed', 'already_committed' or 'unavailable'.
-- If the hold had already been released, it tries to take the copies again;
-- 'unavailable' means the cards are gone and the caller must refund.
CREATE FUNCTION order_commit_stock(p_order bigint, p_reference text) RETURNS text
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  PERFORM 1 FROM orders WHERE id = p_order FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
     WHERE i.order_id = p_order AND a.status = 'reserved'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
       WHERE i.order_id = p_order AND a.status = 'committed'
    ) THEN
      RETURN 'already_committed';
    END IF;
    BEGIN
      PERFORM order_reserve(p_order);
    EXCEPTION WHEN SQLSTATE 'SH001' THEN
      RETURN 'unavailable';
    END;
  END IF;

  PERFORM 1 FROM stock_locations s
   WHERE s.product_id IN (SELECT product_id FROM order_items WHERE order_id = p_order)
   ORDER BY s.product_id, s.storage_location
     FOR UPDATE;

  -- A box may have been counted down below what was reserved (card found damaged).
  IF EXISTS (
    SELECT 1
      FROM (SELECT i.product_id, a.storage_location, sum(a.quantity) AS q
              FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
             WHERE i.order_id = p_order AND a.status = 'reserved'
             GROUP BY 1, 2) need
      JOIN stock_locations s
        ON s.product_id = need.product_id AND s.storage_location = need.storage_location
     WHERE s.quantity < need.q
  ) THEN
    PERFORM order_release_stock(p_order);
    RETURN 'unavailable';
  END IF;

  FOR r IN
    SELECT a.id, i.product_id, a.storage_location, a.quantity
      FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
     WHERE i.order_id = p_order AND a.status = 'reserved'
     ORDER BY i.product_id, a.storage_location
  LOOP
    UPDATE stock_locations SET reserved = greatest(reserved - r.quantity, 0)
     WHERE product_id = r.product_id AND storage_location = r.storage_location;
    PERFORM stock_change(r.product_id, r.storage_location, -r.quantity, 'order', 'system', p_reference, 'sold');
    UPDATE order_item_allocations SET status = 'committed' WHERE id = r.id;
  END LOOP;
  RETURN 'committed';
END $$;

-- Puts refunded copies back into the box they were picked from.
CREATE FUNCTION order_item_restock(p_item bigint, p_quantity integer, p_actor text, p_reference text)
  RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  v_item order_items%ROWTYPE;
  r record;
  v_left integer := p_quantity;
  v_take integer;
BEGIN
  SELECT * INTO v_item FROM order_items WHERE id = p_item FOR UPDATE;
  IF NOT FOUND OR p_quantity < 1
     OR v_item.restocked_quantity + p_quantity > v_item.refunded_quantity THEN
    RAISE EXCEPTION 'invalid restock' USING ERRCODE = 'SH002';
  END IF;
  FOR r IN
    SELECT storage_location, sum(quantity) AS q FROM order_item_allocations
     WHERE order_item_id = p_item AND status = 'committed'
     GROUP BY storage_location ORDER BY length(storage_location), storage_location
  LOOP
    EXIT WHEN v_left = 0;
    v_take := least(v_left, r.q);
    PERFORM stock_change(v_item.product_id, r.storage_location, v_take, 'refund', p_actor, p_reference, 'restock');
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'nothing to restock' USING ERRCODE = 'SH002';
  END IF;
  UPDATE order_items SET restocked_quantity = restocked_quantity + p_quantity WHERE id = p_item;
END $$;

-- Each Stripe webhook event is stored once and processed once.
CREATE TABLE stripe_events (
  id text PRIMARY KEY,                      -- evt_…
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);
CREATE INDEX stripe_events_unprocessed ON stripe_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE refunds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  stripe_refund_id text UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text,
  items jsonb NOT NULL DEFAULT '[]',       -- [{order_item_id, quantity, restock}]
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Gap-free numbering per kind and year; call inside the transaction that writes the document.
CREATE TABLE document_sequences (
  kind text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  year integer NOT NULL,
  last_seq integer NOT NULL,
  PRIMARY KEY (kind, year)
);

CREATE FUNCTION next_document_seq(p_kind text, p_year integer) RETURNS integer
  LANGUAGE sql AS $$
  INSERT INTO document_sequences (kind, year, last_seq) VALUES (p_kind, p_year, 1)
  ON CONFLICT (kind, year) DO UPDATE SET last_seq = document_sequences.last_seq + 1
  RETURNING last_seq
$$;

CREATE TABLE documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  refund_id bigint REFERENCES refunds (id),
  kind text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  year integer NOT NULL,
  seq integer NOT NULL,
  number text NOT NULL UNIQUE,              -- RE-2026-000123 / GS-2026-000017
  issued_at timestamptz NOT NULL DEFAULT now(),
  net_cents integer NOT NULL,
  vat_cents integer NOT NULL,
  gross_cents integer NOT NULL,
  vat_rate_bp integer NOT NULL,
  locale text NOT NULL CHECK (locale IN ('de', 'en')),
  pdf_key text,
  UNIQUE (kind, year, seq),
  CHECK (net_cents + vat_cents = gross_cents)
);
CREATE INDEX documents_order ON documents (order_id);

-- Online withdrawal ("Vertrag widerrufen", § 13a FAGG).
CREATE TABLE withdrawals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint REFERENCES orders (id),
  order_number text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  items text,                               -- chosen items or free text for a partial withdrawal
  received_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,              -- confirmation e-mail sent
  handled_at timestamptz,
  handled_by text
);
CREATE INDEX withdrawals_received ON withdrawals (received_at DESC);
