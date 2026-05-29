-- supabase/migrations/20260527163431_rate_limit.sql

-- =============================================================================
-- LinkdAPI rate limit state (token bucket)
-- =============================================================================
-- Single-row table that tracks the global LinkdAPI API budget.
-- All Edge Functions calling LinkdAPI must consume a token via consume_linkdapi_token()
-- before making the actual HTTP request. This guarantees we never exceed the
-- LinkdAPI rate limit (currently 30 req/min on Hobby tier), regardless of how
-- many users or jobs are running concurrently.

CREATE TABLE IF NOT EXISTS rate_limit_state (
  id INT PRIMARY KEY DEFAULT 1,
  tokens_available NUMERIC NOT NULL DEFAULT 25,
  bucket_size NUMERIC NOT NULL DEFAULT 25,
  refill_rate_per_second NUMERIC NOT NULL DEFAULT 0.4,
  last_refill_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_consumed BIGINT NOT NULL DEFAULT 0,
  total_waited_ms BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT singleton_check CHECK (id = 1)
);

-- Insert the single row (idempotent)
INSERT INTO rate_limit_state (id, tokens_available, bucket_size, refill_rate_per_second, last_refill_at)
VALUES (1, 25, 25, 0.4, NOW())
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- consume_linkdapi_token: try to take 1 token from the bucket
-- =============================================================================
-- Returns:
--   - TRUE  if a token was consumed (caller can proceed with the API call)
--   - FALSE if the bucket is empty (caller must wait and retry)
--
-- The function:
--   1. Computes how many tokens to refill based on elapsed time since last_refill_at
--   2. Caps the new total at bucket_size
--   3. If tokens >= 1, decrements by 1 and returns TRUE
--   4. Otherwise returns FALSE without modifying state
--
-- Atomicity is guaranteed because the UPDATE acquires a row-level lock for the
-- duration of the transaction. Concurrent calls are serialized by Postgres.

CREATE OR REPLACE FUNCTION consume_linkdapi_token()
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_state rate_limit_state%ROWTYPE;
  elapsed_seconds NUMERIC;
  tokens_to_add NUMERIC;
  new_tokens NUMERIC;
BEGIN
  -- Lock the row for update (serializes concurrent callers)
  SELECT * INTO current_state
  FROM rate_limit_state
  WHERE id = 1
  FOR UPDATE;

  -- Calculate elapsed time since last refill
  elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - current_state.last_refill_at));
  tokens_to_add := elapsed_seconds * current_state.refill_rate_per_second;

  -- New token count, capped at bucket_size
  new_tokens := LEAST(
    current_state.tokens_available + tokens_to_add,
    current_state.bucket_size
  );

  -- If we have at least 1 token, consume it and return TRUE
  IF new_tokens >= 1 THEN
    UPDATE rate_limit_state
    SET
      tokens_available = new_tokens - 1,
      last_refill_at = NOW(),
      total_consumed = total_consumed + 1
    WHERE id = 1;
    RETURN TRUE;
  ELSE
    -- Bucket empty: update last_refill_at + tokens but don't consume
    UPDATE rate_limit_state
    SET
      tokens_available = new_tokens,
      last_refill_at = NOW()
    WHERE id = 1;
    RETURN FALSE;
  END IF;
END;
$$;

-- =============================================================================
-- get_rate_limit_status: read-only status for monitoring/debugging
-- =============================================================================
-- Returns a snapshot of the current bucket state. Useful for logging and
-- diagnosing rate limit issues without modifying state.

CREATE OR REPLACE FUNCTION get_rate_limit_status()
RETURNS TABLE (
  tokens_available NUMERIC,
  bucket_size NUMERIC,
  refill_rate_per_second NUMERIC,
  seconds_until_full NUMERIC,
  total_consumed BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  state rate_limit_state%ROWTYPE;
  elapsed NUMERIC;
  current_tokens NUMERIC;
BEGIN
  SELECT * INTO state FROM rate_limit_state WHERE id = 1;
  
  elapsed := EXTRACT(EPOCH FROM (NOW() - state.last_refill_at));
  current_tokens := LEAST(
    state.tokens_available + (elapsed * state.refill_rate_per_second),
    state.bucket_size
  );

  RETURN QUERY SELECT
    current_tokens,
    state.bucket_size,
    state.refill_rate_per_second,
    CASE
      WHEN current_tokens >= state.bucket_size THEN 0::NUMERIC
      ELSE (state.bucket_size - current_tokens) / state.refill_rate_per_second
    END,
    state.total_consumed;
END;
$$;
