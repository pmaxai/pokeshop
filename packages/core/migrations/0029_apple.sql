-- 0029: the App Store, with the iPhone app.
--   Sign in with Apple: the refresh token from the app's authorization code is kept (encrypted)
--     so that deleting the account can revoke it at Apple, as Apple requires. Deleting queues it
--     in apple_token_revocations; the worker retries until Apple confirms.
--   Extra devices: an App Store subscription group holds one subscription at a time, so extra
--     devices are their own subscriptions, in one more group per plan ("Extra devices
--     (Collector)", "… (Creator)"), one product per number of devices and period. Such a purchase
--     is a store_purchases row of kind 'devices'; it counts for a running App Store subscription
--     of the same plan.
--   Creator codes: one App Store offer code per affiliate link.
--   Devices: the iPhone app registers with platform 'ios'.

ALTER TABLE devices DROP CONSTRAINT devices_platform_check,
  ADD CONSTRAINT devices_platform_check CHECK (platform IN ('android', 'ios'));

ALTER TABLE store_purchases
  ADD COLUMN kind text NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'devices')),
  -- kind 'devices': how many extra devices the product stands for
  ADD COLUMN devices integer CHECK (devices BETWEEN 1 AND 4),
  -- kind 'devices': the person was told it renews without counting, for the period ending then
  ADD COLUMN devices_notice_for timestamptz,
  ADD CONSTRAINT store_purchases_devices CHECK ((kind = 'devices') = (devices IS NOT NULL));
CREATE INDEX store_purchases_devices ON store_purchases (account_id)
  WHERE kind = 'devices';

-- Sign in with Apple: the refresh token, encrypted with API_KEY_MASTER_KEY (secrets.ts)
ALTER TABLE account_identities ADD COLUMN refresh_token_enc text;

CREATE TABLE apple_token_revocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_enc text NOT NULL,
  -- made with the staging test hooks: nothing to revoke at Apple
  test boolean NOT NULL DEFAULT false,
  tries integer NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apple_token_revocations_due ON apple_token_revocations (next_try_at);

-- the custom offer code in App Store Connect that carries the link's discount (usually the code)
ALTER TABLE affiliate_links
  ADD COLUMN apple_offer_code text CHECK (apple_offer_code ~ '^[A-Za-z0-9]{1,64}$');
