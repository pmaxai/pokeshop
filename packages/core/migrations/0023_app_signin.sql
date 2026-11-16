-- 0023: signing in from the app, for buying the subscription in the app stores: "Continue with
-- Google" (later "Sign in with Apple") or a 6-digit code by e-mail. Such an account exists before
-- anything is bought; its store_ref goes with every store purchase, so a purchase always finds
-- its account.

ALTER TABLE accounts
  ADD COLUMN store_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  -- confirmed by a login link or an e-mail code; accounts from Google/Apple until the link is used
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN signup_via text NOT NULL DEFAULT 'portal'
    CHECK (signup_via IN ('portal', 'google', 'apple', 'email', 'review'));
-- portal accounts were created by a login link, which confirmed the address
UPDATE accounts SET email_verified_at = coalesce(last_login_at, created_at);
CREATE UNIQUE INDEX accounts_store_ref ON accounts (store_ref);

-- Who signed in with Google or Apple: their account id there (Apple sends the e-mail only once).
CREATE TABLE account_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email text CHECK (length(email) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX account_identities_account ON account_identities (account_id);

-- "Use another e-mail" in the app: a 6-digit code, 10 minutes, 5 tries.
CREATE TABLE app_login_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 200),
  code_hash text NOT NULL,
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX app_login_codes_email ON app_login_codes (email, created_at DESC);
