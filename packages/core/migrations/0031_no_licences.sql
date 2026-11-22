-- 0031: app licences are switched off (docs/decisions.md, 2026-11-22). The app comes from Google
-- Play and soon the App Store, with a free version and the subscriptions; no licence was ever
-- sold. Old licence orders stay for the records (the shop leaves them out of every list); what
-- was still open ends here.

-- Licence checkouts still open: expired (their Stripe sessions ran out long ago), and the codes
-- they held are free again.
WITH still_open AS (
  UPDATE orders SET status = 'expired', reserved_until = NULL
   WHERE kind = 'license' AND status IN ('checkout', 'awaiting_payment')
  RETURNING id
), events AS (
  INSERT INTO order_events (order_id, kind, detail)
  SELECT id, 'expired', '{"reason": "app licences switched off"}' FROM still_open
)
UPDATE discount_code_uses SET status = 'released'
 WHERE status = 'held' AND order_id IN (SELECT id FROM still_open);

-- Licence jobs and mails still waiting: nothing runs or sends them any more.
UPDATE jobs SET status = 'failed', last_error = 'app licences switched off (0031)'
 WHERE kind LIKE 'license.%' AND status IN ('pending', 'running');
UPDATE outbox SET status = 'failed', last_error = 'app licences switched off (0031)'
 WHERE template IN ('license_delivery', 'license_resend') AND status IN ('pending', 'sending');

-- Codes for licences take nothing off cards: switched off. Codes for both now are card codes.
UPDATE discount_codes SET active = false WHERE applies_to = 'licenses';
UPDATE discount_codes SET applies_to = 'cards' WHERE applies_to = 'both';

-- The APK the shop handed out: the stores do that now. (Its files under MEDIA_DIR/app can go.)
DROP TABLE app_releases;

-- No licence price any more. The store links: the app's page in Google Play, and the App Store's
-- once the iPhone app is out (Admin › App).
DELETE FROM settings WHERE key = 'app_license_price_cents';
INSERT INTO settings (key, value) VALUES
  ('app_play_store_url', '"https://play.google.com/store/apps/details?id=com.overpricedcardboard.app"'),
  ('app_app_store_url', 'null')
ON CONFLICT (key) DO NOTHING;
UPDATE settings
   SET value = '"https://play.google.com/store/apps/details?id=com.overpricedcardboard.app"'
 WHERE key = 'app_play_store_url' AND value = 'null'::jsonb;
