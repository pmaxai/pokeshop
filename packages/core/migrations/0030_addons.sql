-- 0030: add-ons – price data sold beside a plan, monthly or yearly. The first is PSA prices
-- (feature psa_prices: what PSA 10, 9 and 8 copies sold for on eBay). The catalog is in
-- addon-catalog.ts; which plans may have an add-on and its store products are in the
-- store_products setting (Admin › App-Stores).
--   App Store: each add-on is its own subscription group; a purchase is a store_purchases row of
--     kind 'addon'. It never blocks or is blocked by a plan.
--   The shop can give an add-on away (account_addons), with or without an end, like a plan.
-- An add-on counts (features.<feature>) while the account's plan runs, the plan is one of the
-- add-on's plans, and the add-on runs.

ALTER TABLE store_purchases
  DROP CONSTRAINT store_purchases_kind_check,
  ADD CONSTRAINT store_purchases_kind_check CHECK (kind IN ('plan', 'devices', 'addon')),
  ADD COLUMN addon text CHECK (addon ~ '^[a-z][a-z0-9_]{1,39}$'),
  ADD CONSTRAINT store_purchases_addon CHECK ((kind = 'addon') = (addon IS NOT NULL));
COMMENT ON COLUMN store_purchases.devices_notice_for IS
  'kind devices or addon: the person was told it renews without counting, for the period ending then';

CREATE TABLE account_addons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  addon text NOT NULL CHECK (addon ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- null: no end
  ends_at timestamptz,
  -- ended early in the admin
  ended_at timestamptz,
  note text CHECK (length(note) <= 500),
  granted_by text NOT NULL CHECK (length(granted_by) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_addons_account ON account_addons (account_id);
