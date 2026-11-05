-- 0005: richer card master data, rarity labels, background jobs.

-- TCGdex gives rarity and types per language; the English value is the canonical
-- key used for filters, the German one is its label.
ALTER TABLE card_master
  ADD COLUMN rarity_de text,
  ADD COLUMN category text,                  -- Pokemon, Trainer, Energy (English)
  ADD COLUMN image_url_de text,
  ADD COLUMN details_fetched_at timestamptz;
CREATE INDEX card_master_name_de ON card_master USING gin (shop_unaccent(lower(coalesce(name_de, ''))) gin_trgm_ops);
CREATE INDEX card_master_name_en ON card_master USING gin (shop_unaccent(lower(coalesce(name_en, ''))) gin_trgm_ops);

CREATE TABLE rarity_labels (
  rarity text PRIMARY KEY,                   -- English, e.g. "Special illustration rare"
  label_de text,
  sort_order integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Work for the worker container: card-data sync, card details, image processing …
CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due ON jobs (run_after) WHERE status = 'pending';
-- At most one open job per dedupe key (e.g. one pending sync at a time).
CREATE UNIQUE INDEX jobs_open_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

-- Products list in the shop: only sellable copies, newest first.
CREATE INDEX products_active_created ON products (created_at DESC) WHERE status = 'active';

-- English product URLs get their own slug (English card name).
ALTER TABLE products ADD COLUMN slug_en text UNIQUE;

-- Image processing retries (downloads can fail for a while).
ALTER TABLE product_images
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX product_images_pending ON product_images (next_attempt_at) WHERE status = 'pending';
