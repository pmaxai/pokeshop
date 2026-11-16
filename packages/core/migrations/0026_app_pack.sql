-- 0026: the app's data pack, mirrored for the store editions (GET /api/app/v1/pack). The files
-- lie under MEDIA_DIR/app-pack, named by their SHA-256; one row per version, the last 3 kept.
CREATE TABLE app_packs (
  version text PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 40),
  -- [{name, size, sha256}] in the order the app gets them
  files jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
