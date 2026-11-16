-- 0028: affiliate links for the app subscription (Antalyse GmbH). Influencers get links
-- (/r/<code>) or a code to type in; an account that registers with one is recorded here, with its
-- first purchase. The link can carry a discount: a Stripe coupon on the website, a Google Play
-- offer (created in the Play Console under every base plan) in the app. Payouts are made by hand
-- from the export (Admin › Affiliates).

CREATE TABLE affiliates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email text CHECK (length(email) <= 254),
  country text CHECK (country ~ '^[A-Z]{2}$'),
  -- how and how much they are paid (by hand): e.g. "20 % of the first year, PayPal …"
  commission text CHECK (length(commission) <= 500),
  payout_details text CHECK (length(payout_details) <= 1000),
  note text CHECK (length(note) <= 2000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER affiliates_updated_at BEFORE UPDATE ON affiliates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE affiliate_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id bigint NOT NULL REFERENCES affiliates (id) ON DELETE RESTRICT,
  -- upper case; in the link and typed in by hand
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,29}$'),
  label text CHECK (length(label) <= 80),
  -- website: percent off the subscription for the first months (NULL = as long as it runs)
  discount_percent integer NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 90),
  discount_months integer CHECK (discount_months BETWEEN 1 AND 36),
  -- Google Play: the offer with this discount, created under each base plan with this id
  google_offer_id text CHECK (google_offer_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_links_affiliate ON affiliate_links (affiliate_id);
CREATE TRIGGER affiliate_links_updated_at BEFORE UPDATE ON affiliate_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- one per account; kept when the account is deleted (for the payouts), without it
CREATE TABLE affiliate_registrations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id bigint NOT NULL REFERENCES affiliate_links (id) ON DELETE RESTRICT,
  account_id bigint UNIQUE REFERENCES accounts (id) ON DELETE SET NULL,
  account_public_id text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  -- link: the website link (cookie); code: typed in; app: the app (install referrer or typed in)
  via text NOT NULL CHECK (via IN ('link', 'code', 'app', 'admin')),
  -- the first paid subscription after it
  first_purchase_at timestamptz,
  first_purchase_source text CHECK (first_purchase_source IN ('stripe', 'google_play', 'app_store')),
  first_plan text CHECK (first_plan IN ('collector', 'creator')),
  first_period text CHECK (first_period IN ('monthly', 'yearly')),
  first_country text CHECK (first_country ~ '^[A-Z]{2}$'),
  discount_used boolean
);
CREATE INDEX affiliate_registrations_period ON affiliate_registrations (registered_at);
CREATE INDEX affiliate_registrations_link ON affiliate_registrations (link_id, registered_at);
