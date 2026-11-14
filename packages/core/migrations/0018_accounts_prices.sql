-- 0018: customer accounts (login by e-mail link, no password), the default shipping address,
-- past orders; the app's nightly data pack (cards and prices) for the web portal.

CREATE TABLE accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- acc_ + 10 random characters: shown in the admin, used by the video pipeline (usage API)
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^acc_[0-9a-z]{10}$'),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 200),
  name text CHECK (length(name) <= 100),
  phone text CHECK (length(phone) <= 40),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('de', 'en')),
  -- the Address of orders.ts; pre-fills the checkout
  shipping_address jsonb,
  -- Webshop as a Service: the customer's connected shop (unlocks Webshop mode in the app)
  webshop_host text CHECK (webshop_host ~ '^[a-z0-9.-]{3,253}$'),
  admin_note text CHECK (length(admin_note) <= 2000),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time login links. Only the token's hash is stored; the account is created on the first
-- successful login, so typing someone's address creates nothing.
CREATE TABLE account_login_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL CHECK (email = lower(email)),
  locale text NOT NULL CHECK (locale IN ('de', 'en')),
  next_path text CHECK (next_path ~ '^/[^/\\]' OR next_path = '/'),
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX account_login_links_email ON account_login_links (email, created_at DESC);

CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  user_agent text
);
CREATE INDEX account_sessions_account ON account_sessions (account_id);

-- Orders placed while logged in, and guest orders of the same (confirmed) address.
ALTER TABLE orders ADD COLUMN account_id bigint REFERENCES accounts (id) ON DELETE SET NULL;
CREATE INDEX orders_account ON orders (account_id, created_at DESC) WHERE account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The app's data pack (github.com/pmaxai/TCGdex, release "data-pack"), imported every night
-- so the portal shows the same cards and prices as the app. Copied as it is, replaced as a
-- whole; nothing else references these tables.
-- ---------------------------------------------------------------------------

CREATE TABLE pack_imports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL UNIQUE,          -- pack.json "version", e.g. 2026-11-14T00:23:29Z
  sha256 text NOT NULL,
  cards integer NOT NULL,
  prices integer NOT NULL,
  seconds numeric(8, 1) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pack_sets (
  id text NOT NULL,
  lang text NOT NULL,
  name text,
  serie_id text,
  serie_name text,
  official integer,
  total integer,
  release_date text,
  PRIMARY KEY (id, lang)
);

CREATE TABLE pack_cards (
  id text NOT NULL,                       -- TCGdex card id, e.g. sv03.5-199
  lang text NOT NULL,                     -- en, de, ja, zh-tw, zh-cn
  set_id text,
  local_id text,
  name text,
  image_url text,
  image_alt text,
  image_alt_large text,
  -- name, set name, number and id in lower case without accents (filled by the import)
  search text,
  PRIMARY KEY (id, lang)
);
CREATE INDEX pack_cards_search ON pack_cards USING gin (search gin_trgm_ops);
CREATE INDEX pack_cards_set ON pack_cards (set_id, lang);

CREATE TABLE pack_card_info (
  id text PRIMARY KEY,
  rarity text,
  variants jsonb,                         -- {"normal":true,"holo":true,"reverse":true,"firstEdition":true}
  category text,
  dex text
);

-- Cardmarket price guide, EUR ("holo" columns are Cardmarket's reverse-holo prices)
CREATE TABLE pack_prices (
  id text PRIMARY KEY,
  updated text,
  trend real, avg real, low real, avg1 real, avg7 real, avg30 real,
  trend_holo real, avg_holo real, low_holo real, avg30_holo real
);

-- TCGplayer market price per printing, USD: {"normal":1.2,"holofoil":3.4,"reverse-holofoil":…}
CREATE TABLE pack_tcgplayer (
  id text PRIMARY KEY,
  updated text,
  data jsonb NOT NULL
);

-- PSA 10 / 9 / 8 sold prices (USD) per printing ('' = printing unknown)
CREATE TABLE pack_graded (
  id text NOT NULL,
  printing text NOT NULL,
  currency text,
  updated text,
  psa10 real, psa10_n integer, psa9 real, psa9_n integer, psa8 real, psa8_n integer,
  source text,
  PRIMARY KEY (id, printing)
);

-- the pipeline's price check: dropped / uncertain / disagree
CREATE TABLE pack_price_check (
  id text PRIMARY KEY,
  status text NOT NULL,
  cm_trend real,
  tp_lo real,
  tp_hi real,
  others text
);

-- price history: one zlib-compressed float16 (or float32) series per card and field, on the
-- calendar in pack_meta.history_dates
CREATE TABLE pack_history (
  id text NOT NULL,
  field text NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (id, field)
);

CREATE TABLE pack_meta (
  key text PRIMARY KEY,
  value text
);
