-- 0022: usage of the services S3 storage and video pipeline, reported by the pipeline
-- (POST /api/v1/usage) and passed on to Stripe's meters for the customer's next invoice.

CREATE TABLE usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('s3', 'pipeline')),
  -- s3: megabytes uploaded; pipeline: seconds of finished video
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000000),
  unit text NOT NULL CHECK (unit IN ('mb', 'second')),
  occurred_at timestamptz NOT NULL,
  reference text CHECK (length(reference) <= 200),
  api_client_id bigint REFERENCES api_clients (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- queued → sent (to Stripe's meter); not_billed: no paid Stripe subscription at the time
  -- (free subscription); failed: Stripe refused it for good (see billing_error)
  billing text NOT NULL DEFAULT 'queued' CHECK (billing IN ('queued', 'sent', 'not_billed', 'failed')),
  billing_error text,
  billed_at timestamptz,
  CHECK ((service = 's3') = (unit = 'mb'))
);
CREATE INDEX usage_events_account ON usage_events (account_id, occurred_at DESC);
CREATE INDEX usage_events_queued ON usage_events (id) WHERE billing = 'queued';
