-- 0027: extra devices for subscriptions bought in Google Play, in two ways:
--   in the app: Play subscription add-ons, one product per extra device (up to 4 per plan),
--     billed with the subscription; they are line items of its purchase;
--   in the portal: a Stripe subscription that holds only the device item ("device subscription").
--     It ends together with the store subscription (rest refunded).

-- The purchase's add-on lines that are devices: [{product_id, expires_at, auto_renew}]
ALTER TABLE store_purchases ADD COLUMN device_add_ons jsonb NOT NULL DEFAULT '[]';

CREATE TABLE device_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  -- the device price follows the store subscription's plan
  plan text NOT NULL CHECK (plan IN ('collector', 'creator')),
  devices integer NOT NULL CHECK (devices BETWEEN 0 AND 20),
  status text NOT NULL,
  tax_behavior text CHECK (tax_behavior IN ('incl', 'excl')),
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  ended_at timestamptz,
  item_id text,
  -- set when it was ended because the store subscription ended (with the refund in cents)
  ended_reason text CHECK (ended_reason IN ('store_ended', 'account_deleted', 'admin')),
  refunded_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_subscriptions_account ON device_subscriptions (account_id, created_at DESC);
CREATE TRIGGER device_subscriptions_updated_at BEFORE UPDATE ON device_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
