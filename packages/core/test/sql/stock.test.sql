-- Stock per box, reservation, sale, release and restock.
-- Runs in one transaction that is rolled back at the end.
BEGIN;

CREATE FUNCTION pg_temp.product(p_sku text, p_name text DEFAULT 'Glurak-ex') RETURNS bigint
  LANGUAGE sql AS $$
  INSERT INTO products (sku, slug, set_code, card_number, name_de, name_en, card_language,
                        finish, condition, price_cents, status)
  VALUES (p_sku, lower(p_sku), 'sv03.5', '199/165', p_name, p_name, 'DE', 'holo', 'NM', 12900, 'active')
  RETURNING id
$$;

CREATE FUNCTION pg_temp.order_for(p_product bigint, p_qty integer) RETURNS bigint
  LANGUAGE plpgsql AS $$
DECLARE v_order bigint;
BEGIN
  INSERT INTO orders (number, lookup_token, locale, country, goods_cents, shipping_cents, total_cents,
                      shipping_method, vat_regime, tax_country, vat_rate_bp, vat_cents)
  VALUES ('T-' || gen_random_uuid(), gen_random_uuid()::text, 'de', 'AT', 12900 * p_qty, 0, 12900 * p_qty,
          'standard', 'domestic', 'AT', 2000, 2150 * p_qty)
  RETURNING id INTO v_order;
  INSERT INTO order_items (order_id, product_id, sku, name_de, name_en, set_code, card_number,
                           card_language, condition, finish, unit_price_cents, quantity)
  SELECT v_order, id, sku, name_de, name_en, set_code, card_number, card_language, condition, finish,
         price_cents, p_qty FROM products WHERE id = p_product;
  RETURN v_order;
END $$;

CREATE FUNCTION pg_temp.available(p_product bigint) RETURNS integer
  LANGUAGE sql AS $$ SELECT available FROM product_stock WHERE product_id = p_product $$;

CREATE FUNCTION pg_temp.boxes(p_order bigint, p_status text) RETURNS text
  LANGUAGE sql AS $$
  SELECT coalesce(string_agg(a.storage_location || ':' || a.quantity, ',' ORDER BY a.storage_location), '')
    FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
   WHERE i.order_id = p_order AND a.status = p_status
$$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-GLURAK');
  o_a bigint; o_b bigint; o_c bigint;
  v text;
  failed boolean;
BEGIN
  -- Intake: one copy into box 014, one into box 003 (a second box entry, not an overwrite).
  ASSERT stock_change(p, '014', 1, 'api', 'kid_test', 'req-1') = 1;
  ASSERT stock_change(p, '003', 1, 'api', 'kid_test', 'req-2') = 1;
  ASSERT pg_temp.available(p) = 2, 'two copies in two boxes';
  ASSERT (SELECT count(*) FROM stock_ledger WHERE product_id = p) = 2, 'two ledger rows';

  -- Cannot remove more than a box holds.
  failed := false;
  BEGIN
    PERFORM stock_change(p, '014', -2, 'api', 'kid_test');
  EXCEPTION WHEN SQLSTATE 'SH001' THEN failed := true;
  END;
  ASSERT failed, 'negative stock is refused';

  -- Order A takes the copy from the lowest box number first.
  o_a := pg_temp.order_for(p, 1);
  PERFORM order_reserve(o_a);
  ASSERT pg_temp.boxes(o_a, 'reserved') = '003:1', 'lowest box first: ' || pg_temp.boxes(o_a, 'reserved');
  ASSERT pg_temp.available(p) = 1;

  -- Order B wants two copies but only one is free: nothing is reserved at all.
  o_b := pg_temp.order_for(p, 2);
  failed := false;
  BEGIN
    PERFORM order_reserve(o_b);
  EXCEPTION WHEN SQLSTATE 'SH001' THEN failed := true;
  END;
  ASSERT failed, 'over-reservation refused';
  ASSERT pg_temp.boxes(o_b, 'reserved') = '', 'no partial reservation';
  ASSERT pg_temp.available(p) = 1, 'still one free';

  -- Order C takes the last copy (box 014); a single copy can never be held twice.
  o_c := pg_temp.order_for(p, 1);
  PERFORM order_reserve(o_c);
  ASSERT pg_temp.boxes(o_c, 'reserved') = '014:1';
  ASSERT pg_temp.available(p) = 0;

  -- Reserving the same order twice is an error.
  failed := false;
  BEGIN
    PERFORM order_reserve(o_c);
  EXCEPTION WHEN SQLSTATE 'SH003' THEN failed := true;
  END;
  ASSERT failed, 'double reservation refused';

  -- A's 10 minutes run out: the copy goes back.
  ASSERT order_release_stock(o_a) = 1;
  ASSERT pg_temp.available(p) = 1;
  ASSERT pg_temp.boxes(o_a, 'released') = '003:1';

  -- C pays: the copy leaves box 014; paying twice changes nothing.
  ASSERT order_commit_stock(o_c, 'PK-C') = 'committed';
  ASSERT order_commit_stock(o_c, 'PK-C') = 'already_committed';
  ASSERT (SELECT quantity FROM stock_locations WHERE product_id = p AND storage_location = '014') = 0;
  ASSERT (SELECT reserved FROM stock_locations WHERE product_id = p AND storage_location = '014') = 0;
  ASSERT pg_temp.boxes(o_c, 'committed') = '014:1', 'pick sheet box for C';

  -- A's payment still lands after its hold was released: the copy is free again, so it is sold.
  ASSERT order_commit_stock(o_a, 'PK-A') = 'committed', 'late payment re-takes a free copy';
  ASSERT pg_temp.boxes(o_a, 'committed') = '003:1';
  ASSERT pg_temp.available(p) = 0;

  -- Refund with restock puts C's copy back into box 014.
  UPDATE order_items SET refunded_quantity = 1 WHERE order_id = o_c;
  PERFORM order_item_restock((SELECT id FROM order_items WHERE order_id = o_c), 1, 'admin@test', 'GS-1');
  ASSERT (SELECT quantity FROM stock_locations WHERE product_id = p AND storage_location = '014') = 1;
  ASSERT (SELECT source FROM stock_ledger WHERE product_id = p ORDER BY id DESC LIMIT 1) = 'refund';
END $$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-LATE');
  o_1 bigint; o_2 bigint;
BEGIN
  -- Late payment when the copy has meanwhile been sold to someone else: caller must refund.
  PERFORM stock_change(p, '010', 1, 'api', 'kid_test');
  o_1 := pg_temp.order_for(p, 1);
  PERFORM order_reserve(o_1);
  PERFORM order_release_stock(o_1);
  o_2 := pg_temp.order_for(p, 1);
  PERFORM order_reserve(o_2);
  ASSERT order_commit_stock(o_2, 'PK-2') = 'committed';
  ASSERT order_commit_stock(o_1, 'PK-1') = 'unavailable', 'sold out → unavailable';
END $$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-DAMAGED');
  o bigint;
BEGIN
  -- Card found damaged during an open checkout: count set to 0, payment cannot be fulfilled.
  PERFORM stock_change(p, '005', 1, 'api', 'kid_test');
  o := pg_temp.order_for(p, 1);
  PERFORM order_reserve(o);
  ASSERT stock_set(p, '005', 0, 'admin', 'admin@test', NULL, 'damaged') = 0;
  ASSERT pg_temp.available(p) = 0;
  ASSERT order_commit_stock(o, 'PK-D') = 'unavailable';
  ASSERT (SELECT reserved FROM stock_locations WHERE product_id = p) = 0, 'hold released';
END $$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-MULTI');
  o bigint;
BEGIN
  -- One order line spread over two boxes appears as two pick-sheet lines.
  PERFORM stock_change(p, '002', 2, 'api', 'kid_test');
  PERFORM stock_change(p, '001', 1, 'api', 'kid_test');
  PERFORM stock_change(p, '100', 5, 'api', 'kid_test');
  o := pg_temp.order_for(p, 3);
  PERFORM order_reserve(o);
  ASSERT pg_temp.boxes(o, 'reserved') = '001:1,002:2', pg_temp.boxes(o, 'reserved');
  ASSERT order_commit_stock(o, 'PK-M') = 'committed';
  ASSERT pg_temp.available(p) = 5;
END $$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-MOVE');
  failed boolean := false;
BEGIN
  -- Moving copies between boxes keeps the total and writes two ledger rows.
  PERFORM stock_change(p, '001', 2, 'api', 'kid_test');
  PERFORM stock_move(p, '001', '002', 1, 'api', 'kid_test');
  ASSERT (SELECT string_agg(storage_location || ':' || quantity, ',' ORDER BY storage_location)
            FROM stock_locations WHERE product_id = p) = '001:1,002:1';
  ASSERT (SELECT count(*) FROM stock_ledger WHERE product_id = p AND reason LIKE 'move%') = 2;
  BEGIN
    PERFORM stock_move(p, '001', '002', 5, 'api', 'kid_test');
  EXCEPTION WHEN SQLSTATE 'SH001' THEN failed := true;
  END;
  ASSERT failed, 'cannot move more than the box holds';
END $$;

DO $$
DECLARE
  p bigint := pg_temp.product('T-DRAFT');
  o bigint;
  failed boolean := false;
BEGIN
  -- Draft or archived products cannot be reserved.
  PERFORM stock_change(p, '001', 1, 'api', 'kid_test');
  UPDATE products SET status = 'archived' WHERE id = p;
  o := pg_temp.order_for(p, 1);
  BEGIN
    PERFORM order_reserve(o);
  EXCEPTION WHEN SQLSTATE 'SH001' THEN failed := true;
  END;
  ASSERT failed, 'archived product refused';
END $$;

ROLLBACK;
