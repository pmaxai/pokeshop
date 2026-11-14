-- 0020: the customer's card collection (portal and app), binders, shares; cards bought in the
-- shop are added by the worker (order_item_id).

CREATE TABLE collection_binders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_binders_account ON collection_binders (account_id);

CREATE TABLE collection_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- the app's id for an add (idempotency); one per account
  client_ref text CHECK (length(client_ref) BETWEEN 8 AND 64),
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 80),
  language text NOT NULL CHECK (language IN ('DE', 'EN', 'FR', 'IT', 'ES', 'PT', 'NL', 'PL', 'RU',
                                             'JA', 'KO', 'ZH-HANT', 'ZH-HANS', 'ID', 'TH')),
  finish text NOT NULL CHECK (finish IN ('normal', 'holo', 'reverse_holo', 'first_edition',
                                         'shadowless', 'stamped', 'pokeball', 'masterball')),
  condition text NOT NULL CHECK (condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  grading_company text CHECK (length(grading_company) BETWEEN 1 AND 20),
  grading_grade text CHECK (length(grading_grade) BETWEEN 1 AND 10),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  -- per copy
  purchase_price_cents integer CHECK (purchase_price_cents BETWEEN 0 AND 100000000),
  note text CHECK (length(note) <= 500),
  binder_id bigint REFERENCES collection_binders (id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('app', 'portal', 'shop')),
  -- bought in the shop: added once per order line
  order_item_id bigint UNIQUE REFERENCES order_items (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- deleted items stay 90 days so the app's sync learns about them
  deleted_at timestamptz,
  CHECK ((grading_company IS NULL) = (grading_grade IS NULL)),
  UNIQUE (account_id, client_ref)
);
CREATE INDEX collection_items_sync ON collection_items (account_id, updated_at, id);
CREATE INDEX collection_items_card ON collection_items (account_id, card_id) WHERE deleted_at IS NULL;

-- Sharing the collection (or some binders): a public link, or a link for one person by e-mail
-- that works for 7 days.
CREATE TABLE collection_shares (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  kind text NOT NULL CHECK (kind IN ('public', 'personal')),
  -- empty = the whole collection
  binder_ids bigint[] NOT NULL DEFAULT '{}',
  show_prices boolean NOT NULL DEFAULT true,
  title text CHECK (length(title) <= 80),
  recipient_email text CHECK (recipient_email = lower(recipient_email) AND length(recipient_email) <= 200),
  message text CHECK (length(message) <= 500),
  expires_at timestamptz,
  revoked_at timestamptz,
  views integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'personal' OR (recipient_email IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX collection_shares_account ON collection_shares (account_id, created_at DESC);
