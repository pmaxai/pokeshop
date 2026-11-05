-- 0002: card master data, products, images, stock per storage box, stock ledger.

-- Master data imported from TCGdex (sets and cards, names in DE and EN).
CREATE TABLE card_sets (
  set_code text PRIMARY KEY,
  name_de text,
  name_en text,
  series_de text,
  series_en text,
  release_date date,
  card_count integer,
  logo_url text,
  symbol_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_master (
  card_ref text PRIMARY KEY,              -- TCGdex card id, e.g. "sv03.5-199"
  set_code text NOT NULL REFERENCES card_sets (set_code) ON UPDATE CASCADE,
  local_id text NOT NULL,                 -- number within the set, e.g. "199"
  name_de text,
  name_en text,
  rarity text,
  supertype text,
  energy_types text[] NOT NULL DEFAULT '{}',
  image_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_code, local_id)
);

-- One product = one card print × card language × condition × finish (× grading).
CREATE TABLE products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  external_id text UNIQUE,
  card_ref text REFERENCES card_master (card_ref) ON DELETE SET NULL,
  set_code text NOT NULL,
  set_name_de text,
  set_name_en text,
  series_de text,
  series_en text,
  card_number text NOT NULL,              -- as printed, e.g. "199/165"
  name_de text NOT NULL,
  name_en text NOT NULL,
  card_language text NOT NULL,
  release_year smallint CHECK (release_year BETWEEN 1996 AND 2100),
  rarity text,
  supertype text CHECK (supertype IN ('pokemon', 'trainer', 'energy')),
  energy_types text[] NOT NULL DEFAULT '{}',
  finish text NOT NULL,
  condition text NOT NULL CHECK (condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  grading_company text,
  grading_grade text,
  grading_cert text,
  price_cents integer CHECK (price_cents >= 0),
  purchase_price_cents integer CHECK (purchase_price_cents >= 0), -- internal, profit reports only
  high_value boolean NOT NULL DEFAULT false,
  description_de text,
  description_en text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  customs_code text NOT NULL DEFAULT '9504.40',
  search_text text GENERATED ALWAYS AS (
    shop_unaccent(lower(
      coalesce(name_de, '') || ' ' || coalesce(name_en, '') || ' ' ||
      coalesce(set_name_de, '') || ' ' || coalesce(set_name_en, '') || ' ' ||
      set_code || ' ' || card_number || ' ' || sku
    ))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stock_change_at timestamptz,
  CONSTRAINT active_needs_price CHECK (status <> 'active' OR price_cents IS NOT NULL),
  CONSTRAINT grading_complete CHECK ((grading_company IS NULL) = (grading_grade IS NULL))
);
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX products_search_trgm ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX products_status ON products (status);
CREATE INDEX products_set_number ON products (set_code, card_number);
CREATE INDEX products_language ON products (card_language);
CREATE INDEX products_rarity ON products (rarity);
CREATE INDEX products_price ON products (price_cents);
CREATE INDEX products_created ON products (created_at DESC);

CREATE TABLE product_images (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'front' CHECK (role IN ('front', 'back', 'extra')),
  position smallint NOT NULL DEFAULT 0,
  source_url text,
  storage_key text,                       -- file name under the media volume once processed
  width integer,
  height integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_images_product ON product_images (product_id, position);

-- Copies per storage box. available = quantity − reserved (never below 0).
CREATE TABLE stock_locations (
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  storage_location text NOT NULL CHECK (storage_location ~ '^[0-9]{3,10}$'),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, storage_location)
);
CREATE INDEX stock_locations_box ON stock_locations (storage_location);

CREATE VIEW product_stock AS
  SELECT p.id AS product_id,
         coalesce(sum(s.quantity), 0)::integer AS quantity,
         coalesce(sum(s.reserved), 0)::integer AS reserved,
         coalesce(sum(greatest(s.quantity - s.reserved, 0)), 0)::integer AS available
    FROM products p
    LEFT JOIN stock_locations s ON s.product_id = p.id
   GROUP BY p.id;

-- Every stock movement, one row each: the audit trail for the scanning app.
CREATE TABLE stock_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  storage_location text NOT NULL,
  delta integer NOT NULL CHECK (delta <> 0),
  quantity_after integer NOT NULL,
  source text NOT NULL CHECK (source IN ('api', 'admin', 'order', 'refund', 'sweeper', 'import')),
  actor text,                             -- API key id, admin e-mail or "system"
  reference text,                         -- order number, request id …
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_ledger_product ON stock_ledger (product_id, created_at DESC);
CREATE INDEX stock_ledger_created ON stock_ledger (created_at DESC);

-- Adds (or removes) copies in one box and writes the ledger. Returns the box quantity after.
-- Raises SH001 when the box would go below zero.
CREATE FUNCTION stock_change(
  p_product bigint, p_location text, p_delta integer,
  p_source text, p_actor text, p_reference text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  v_qty integer;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'delta must not be 0' USING ERRCODE = 'SH002';
  END IF;
  INSERT INTO stock_locations (product_id, storage_location) VALUES (p_product, p_location)
    ON CONFLICT DO NOTHING;
  SELECT quantity INTO v_qty FROM stock_locations
   WHERE product_id = p_product AND storage_location = p_location FOR UPDATE;
  IF v_qty + p_delta < 0 THEN
    RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = 'SH001',
      DETAIL = format('product %s box %s has %s, change %s', p_product, p_location, v_qty, p_delta);
  END IF;
  UPDATE stock_locations SET quantity = quantity + p_delta, updated_at = now()
   WHERE product_id = p_product AND storage_location = p_location
   RETURNING quantity INTO v_qty;
  INSERT INTO stock_ledger (product_id, storage_location, delta, quantity_after, source, actor, reference, reason)
    VALUES (p_product, p_location, p_delta, v_qty, p_source, p_actor, p_reference, p_reason);
  UPDATE products SET last_stock_change_at = now() WHERE id = p_product;
  RETURN v_qty;
END $$;

-- Sets the quantity of one box (e.g. after a recount). Returns the box quantity after.
CREATE FUNCTION stock_set(
  p_product bigint, p_location text, p_quantity integer,
  p_source text, p_actor text, p_reference text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  v_qty integer;
BEGIN
  IF p_quantity < 0 THEN
    RAISE EXCEPTION 'quantity must not be negative' USING ERRCODE = 'SH002';
  END IF;
  INSERT INTO stock_locations (product_id, storage_location) VALUES (p_product, p_location)
    ON CONFLICT DO NOTHING;
  SELECT quantity INTO v_qty FROM stock_locations
   WHERE product_id = p_product AND storage_location = p_location FOR UPDATE;
  IF p_quantity = v_qty THEN
    RETURN v_qty;
  END IF;
  RETURN stock_change(p_product, p_location, p_quantity - v_qty, p_source, p_actor, p_reference, p_reason);
END $$;

-- Moves copies from one box to another (two ledger rows, reason "move").
CREATE FUNCTION stock_move(
  p_product bigint, p_from text, p_to text, p_quantity integer,
  p_source text, p_actor text, p_reference text DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  v_free integer;
BEGIN
  IF p_quantity < 1 OR p_from = p_to THEN
    RAISE EXCEPTION 'invalid move' USING ERRCODE = 'SH002';
  END IF;
  -- lock both boxes in a fixed order to avoid deadlocks
  PERFORM 1 FROM stock_locations
   WHERE product_id = p_product AND storage_location IN (p_from, p_to)
   ORDER BY storage_location FOR UPDATE;
  SELECT quantity - reserved INTO v_free FROM stock_locations
   WHERE product_id = p_product AND storage_location = p_from;
  IF coalesce(v_free, 0) < p_quantity THEN
    RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = 'SH001',
      DETAIL = format('box %s has %s unreserved copies', p_from, coalesce(v_free, 0));
  END IF;
  PERFORM stock_change(p_product, p_from, -p_quantity, p_source, p_actor, p_reference, 'move to ' || p_to);
  PERFORM stock_change(p_product, p_to, p_quantity, p_source, p_actor, p_reference, 'move from ' || p_from);
END $$;
