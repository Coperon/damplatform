-- Access-check CTE walks collections.parent_id on every tenant-scoped request.
CREATE INDEX IF NOT EXISTS collections_parent_id_idx ON collections (parent_id);

-- IP + bucket counters for login, password reset, invite redeem, and share tokens.
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,
  ip          text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_events_bucket_ip_created_idx
  ON rate_limit_events (bucket, ip, created_at);
