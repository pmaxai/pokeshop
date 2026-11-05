-- Seeds, constraints, search text and document numbering.
BEGIN;

DO $$
DECLARE
  v_id bigint;
  failed boolean;
BEGIN
  -- Launch countries and minimums.
  ASSERT (SELECT string_agg(code || ':' || min_order_cents, ',' ORDER BY code)
            FROM countries WHERE delivery_enabled) = 'AT:1000,DE:2000', 'AT € 10, DE € 20';
  ASSERT (SELECT count(*) FROM countries WHERE is_eu) = 27;
  ASSERT (SELECT insured_rate_bp = 2000 AND insured_minimum_cents = 500 AND insured_max_order_cents = 50000
            FROM countries WHERE code = 'AT');
  ASSERT (SELECT value::int FROM settings WHERE key = 'reservation_minutes') = 10;
  ASSERT (SELECT value->>'vat_id' FROM settings WHERE key = 'company') = 'ATU79907228';

  -- Search text is lower-case and accent-free, so "flabebe" finds "Flabébé".
  INSERT INTO products (sku, slug, set_code, card_number, name_de, name_en, card_language, finish, condition)
  VALUES ('sv04-1-FR-EX-R', 'flabebe', 'sv04', '001/182', 'Flabébé', 'Flabébé', 'FR', 'reverse_holo', 'EX')
  RETURNING id INTO v_id;
  ASSERT (SELECT search_text LIKE '%flabebe%' FROM products WHERE id = v_id);
  -- Search matches a word inside the long search text (word similarity), typos included.
  ASSERT (SELECT id FROM products WHERE 'flabebe' <% search_text) = v_id, 'exact word';
  ASSERT (SELECT id FROM products WHERE 'flabbebe' <% search_text) = v_id, 'typo tolerated';

  -- An active product needs a price.
  failed := false;
  BEGIN
    UPDATE products SET status = 'active' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  ASSERT failed, 'active without price refused';

  -- Storage boxes: digits only, at least three.
  failed := false;
  BEGIN
    INSERT INTO stock_locations (product_id, storage_location, quantity) VALUES (v_id, '14', 1);
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  ASSERT failed, 'box "14" refused';
  failed := false;
  BEGIN
    INSERT INTO stock_locations (product_id, storage_location, quantity) VALUES (v_id, 'A01', 1);
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  ASSERT failed, 'box "A01" refused';

  -- Gap-free document numbers per kind and year.
  ASSERT next_document_seq('invoice', 2026) = 1;
  ASSERT next_document_seq('invoice', 2026) = 2;
  ASSERT next_document_seq('credit_note', 2026) = 1;
  ASSERT next_document_seq('invoice', 2027) = 1;

  -- Event end must not be before its start.
  failed := false;
  BEGIN
    INSERT INTO shop_events (slug, title_de, starts_at, ends_at, city)
    VALUES ('x', 'Börse', '2026-12-12 10:00+01', '2026-12-12 09:00+01', 'Wien');
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  ASSERT failed, 'event ending before start refused';
END $$;

ROLLBACK;
