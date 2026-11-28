-- 0032: the iPhone app is in the App Store. The link without a country opens the visitor's own
-- App Store (Admin › App can change it).
INSERT INTO settings (key, value) VALUES ('app_app_store_url', 'null')
ON CONFLICT (key) DO NOTHING;
UPDATE settings
   SET value = '"https://apps.apple.com/app/overpriced-cardboard/id6835861090"'
 WHERE key = 'app_app_store_url' AND value = 'null'::jsonb;
