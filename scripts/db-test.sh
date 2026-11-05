#!/usr/bin/env bash
# Applies all migrations to a fresh, temporary database and runs the SQL tests.
# Uses the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD); the
# user needs CREATEDB and must be allowed to create the extensions pg_trgm and unaccent.
set -euo pipefail

cd "$(dirname "$0")/.."
DB="pokeshop_test_$$"
export PGDATABASE="${PGDATABASE:-postgres}"

cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$DB"
for f in packages/core/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done
echo "migrations applied: $(ls packages/core/migrations/*.sql | wc -l)"

status=0
for t in packages/core/test/sql/*.sql; do
  if psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$t" >/dev/null 2>"/tmp/db-test-$$.err"; then
    echo "ok   $(basename "$t")"
  else
    echo "FAIL $(basename "$t")"
    cat "/tmp/db-test-$$.err"
    status=1
  fi
  rm -f "/tmp/db-test-$$.err"
done

# Race: two buyers start paying for the last copy at the same moment.
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL'
INSERT INTO products (sku, slug, set_code, card_number, name_de, name_en, card_language, finish, condition, price_cents, status)
VALUES ('RACE-1', 'race-1', 'sv1', '1/1', 'X', 'X', 'DE', 'holo', 'NM', 1000, 'active');
SELECT stock_change((SELECT id FROM products WHERE sku = 'RACE-1'), '001', 1, 'api', 'race');
INSERT INTO orders (number, lookup_token, locale, country, goods_cents, shipping_cents, total_cents,
                    shipping_method, vat_regime, vat_rate_bp, vat_cents)
SELECT 'RACE-' || g, 'race-' || g, 'de', 'AT', 1000, 0, 1000, 'standard', 'domestic', 2000, 167
  FROM generate_series(1, 2) g;
INSERT INTO order_items (order_id, product_id, sku, name_de, name_en, set_code, card_number,
                         card_language, condition, finish, unit_price_cents, quantity)
SELECT o.id, p.id, p.sku, 'X', 'X', 'sv1', '1/1', 'DE', 'NM', 'holo', 1000, 1
  FROM orders o, products p WHERE o.number LIKE 'RACE-%' AND p.sku = 'RACE-1';
SQL
psql -X -q -d "$DB" -c "BEGIN; SELECT order_reserve(id) FROM orders WHERE number = 'RACE-1'; SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 &
sleep 0.4
if psql -X -q -d "$DB" -c "SELECT order_reserve(id) FROM orders WHERE number = 'RACE-2';" >/dev/null 2>&1; then
  wait
  echo "FAIL race: the last copy was reserved twice"
  status=1
else
  wait
  held=$(psql -X -tA -d "$DB" -c "SELECT reserved FROM stock_locations s JOIN products p ON p.id = s.product_id WHERE p.sku = 'RACE-1'")
  if [ "$held" = "1" ]; then echo "ok   race: last copy held once"; else echo "FAIL race: reserved=$held"; status=1; fi
fi
exit $status
