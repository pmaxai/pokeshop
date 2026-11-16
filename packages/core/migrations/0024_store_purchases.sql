-- 0024: subscriptions bought in the app stores (Google Play now, the App Store later). The store
-- is the source of truth: every report from the app and every store notification reads the
-- subscription from the store again and stores what it says here. The account's subscription
-- (subscriptions.ts › subscriptionOf) is a running store purchase if there is one.

CREATE TABLE store_purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store text NOT NULL CHECK (store IN ('google_play', 'app_store')),
  -- kept without the account when it is deleted (the store's records stay)
  account_id bigint REFERENCES accounts (id) ON DELETE SET NULL,
  -- the account the store says it was bought for (obfuscatedExternalAccountId, appAccountToken)
  store_ref uuid,
  -- Google: the purchase token; Apple: the original transaction id
  purchase_token text NOT NULL CHECK (length(purchase_token) BETWEEN 1 AND 4096),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 150),
  base_plan_id text CHECK (length(base_plan_id) <= 63),
  plan text CHECK (plan IN ('collector', 'creator')),
  period text CHECK (period IN ('monthly', 'yearly')),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'canceled', 'grace', 'on_hold',
                                       'paused', 'expired', 'revoked')),
  expires_at timestamptz,
  auto_renew boolean NOT NULL DEFAULT false,
  acknowledged boolean NOT NULL DEFAULT false,
  -- licence testers (Google) and sandbox (Apple)
  test boolean NOT NULL DEFAULT false,
  latest_order_id text CHECK (length(latest_order_id) <= 100),
  -- a plan change or resubscription replaces the earlier purchase (Google: linkedPurchaseToken)
  replaced_by bigint REFERENCES store_purchases (id) ON DELETE SET NULL,
  -- not accepted: the account already had a paid subscription; never acknowledged, so Google
  -- refunds it after 3 days
  refused text CHECK (refused IN ('already_subscribed')),
  -- the account was deleted: the renewal is to be stopped at the store
  cancel_requested_at timestamptz,
  cancelled_at_store timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store, purchase_token)
);
CREATE INDEX store_purchases_account ON store_purchases (account_id, expires_at DESC);
CREATE INDEX store_purchases_due ON store_purchases (expires_at)
  WHERE state NOT IN ('expired', 'revoked') AND replaced_by IS NULL;
CREATE TRIGGER store_purchases_updated_at BEFORE UPDATE ON store_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What is on sale in the stores; the product ids are entered in Admin › App-Stores.
INSERT INTO settings (key, value) VALUES
  ('store_products', '{
     "google": {
       "collector": {"product_id": null, "base_plans": {"monthly": null, "yearly": null}},
       "creator":   {"product_id": null, "base_plans": {"monthly": null, "yearly": null}}
     },
     "apple": {
       "collector": {"monthly": null, "yearly": null},
       "creator":   {"monthly": null, "yearly": null}
     }
   }')
ON CONFLICT (key) DO NOTHING;
