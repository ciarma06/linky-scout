-- Contatori LinkdAPI per job (debug routing Motore A/B/C)
ALTER TABLE search_jobs
ADD COLUMN IF NOT EXISTS linkdapi_call_stats jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION increment_linkdapi_call_stats(
  p_job_id uuid,
  p_key text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE search_jobs
  SET linkdapi_call_stats = jsonb_set(
    COALESCE(linkdapi_call_stats, '{}'::jsonb),
    ARRAY[p_key],
    to_jsonb(COALESCE((linkdapi_call_stats ->> p_key)::int, 0) + 1),
    true
  )
  WHERE id = p_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION merge_linkdapi_call_stats(
  p_job_id uuid,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE search_jobs
  SET linkdapi_call_stats = COALESCE(linkdapi_call_stats, '{}'::jsonb) || p_patch
  WHERE id = p_job_id;
END;
$$;
