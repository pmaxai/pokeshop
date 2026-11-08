-- Categories such as "Cute": set in the admin or through the API, shown as a catalog filter.
CREATE TABLE categories (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       text NOT NULL UNIQUE
             CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  name_de    text NOT NULL CHECK (length(name_de) BETWEEN 1 AND 60),
  name_en    text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 60),
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_categories (
  product_id  bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  category_id bigint NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category ON product_categories (category_id);

-- A product's categories are part of the product: API clients syncing with updated_since see
-- the change.
CREATE FUNCTION product_categories_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE products SET updated_at = now()
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  RETURN NULL;
END $$;
CREATE TRIGGER product_categories_touch AFTER INSERT OR DELETE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION product_categories_touch();
