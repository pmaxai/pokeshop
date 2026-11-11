-- The shop moves from pokemonkarten.at to overpricedcardboard.com, shown as "Overpriced
-- Cardboard", with the shared mailbox order@overpricedcardboard.com. Settings that still hold
-- the old values get the new ones; anything changed in the admin since stays as it is.

UPDATE settings SET value = '"order@overpricedcardboard.com"'
 WHERE key = 'shop_mailbox' AND value = '"bestellung@pokemonkarten.at"';

UPDATE settings
   SET value = (SELECT coalesce(jsonb_agg(CASE WHEN e = '"bestellung@pokemonkarten.at"'
                                               THEN '"order@overpricedcardboard.com"'::jsonb
                                               ELSE e END), '[]'::jsonb)
                  FROM jsonb_array_elements(value) AS e)
 WHERE key = 'admin_alert_recipients'
   AND jsonb_typeof(value) = 'array'
   AND value ? 'bestellung@pokemonkarten.at';

UPDATE settings
   SET value = value
     || CASE WHEN value->>'public_name' = 'pokemonkarten.at'
             THEN '{"public_name": "Overpriced Cardboard"}'::jsonb ELSE '{}'::jsonb END
     || CASE WHEN value->>'email' = 'bestellung@pokemonkarten.at'
             THEN '{"email": "order@overpricedcardboard.com"}'::jsonb ELSE '{}'::jsonb END
 WHERE key = 'company';
