-- 0025: deleting an account (portal or app). The account's data goes at once; the scrubbed row
-- stays 30 days so its devices learn why they were signed out (unpaired / account_deleted) and
-- a store subscription's renewal can still be stopped; then the worker removes it.
ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;

ALTER TABLE devices DROP CONSTRAINT devices_end_reason_check;
ALTER TABLE devices ADD CONSTRAINT devices_end_reason_check
  CHECK (end_reason IN ('removed', 'transferred', 'replaced', 'disconnected', 'account_deleted'));

-- The app's privacy policy (Antalyse GmbH) is a legal text of its own.
ALTER TABLE legal_texts DROP CONSTRAINT legal_texts_kind_check;
ALTER TABLE legal_texts ADD CONSTRAINT legal_texts_kind_check
  CHECK (kind IN ('agb', 'privacy', 'withdrawal', 'shipping_payment', 'conditions',
                  'accessibility', 'license_terms', 'app_privacy'));
