-- The name printed on the card. German and English cards use name_de / name_en; every other
-- card language (French, Japanese, …) keeps its own name in name_local.
ALTER TABLE products ADD COLUMN name_local text
  CHECK (name_local IS NULL OR length(name_local) BETWEEN 1 AND 200);
ALTER TABLE order_items ADD COLUMN name_local text;

CREATE FUNCTION products_name_local() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.name_local := nullif(btrim(NEW.name_local), '');
  IF NEW.card_language IN ('DE', 'EN') THEN
    NEW.name_local := NULL;  -- the printed name is name_de / name_en
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_name_local BEFORE INSERT OR UPDATE OF name_local, card_language ON products
  FOR EACH ROW EXECUTE FUNCTION products_name_local();

-- Names TCGdex keeps on the international card in further languages, by TCGdex language code:
-- {"fr": "Dracaufeu-ex", "nl": null}. A key with null means: asked, TCGdex has none.
ALTER TABLE card_master ADD COLUMN names_local jsonb NOT NULL DEFAULT '{}';

-- Search covers the card's own name as well.
DROP INDEX products_search_trgm;
ALTER TABLE products DROP COLUMN search_text;
ALTER TABLE products ADD COLUMN search_text text GENERATED ALWAYS AS (
  shop_unaccent(lower(
    coalesce(name_local, '') || ' ' || coalesce(name_de, '') || ' ' || coalesce(name_en, '') || ' ' ||
    coalesce(set_name_de, '') || ' ' || coalesce(set_name_en, '') || ' ' ||
    set_code || ' ' || card_number || ' ' || sku
  ))
) STORED;
CREATE INDEX products_search_trgm ON products USING gin (search_text gin_trgm_ops);
