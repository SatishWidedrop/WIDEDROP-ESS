-- Widedrop ESS — the background-work schedule.
--
-- A serverless deployment has no process to loop in, so the database is the
-- scheduler: pg_cron decides when, pg_net makes the call, and the API's
-- /api/v1/jobs/:name endpoint does the work. Run this once, in the Supabase
-- SQL editor, against the project the API points at.
--
-- The alternative is a container running `node dist/worker.js`, which needs
-- none of this. Run one or the other, never both — not because they would
-- conflict (every job claims its work and is safe to overlap) but because two
-- schedules is two places to look when something stops.
--
-- ── Before running ───────────────────────────────────────────────────
-- Set the two values in `job_runner_config` below. The token is the same
-- JOB_RUNNER_TOKEN the API is configured with; without it the endpoint is not
-- registered at all and every call here would 404.

-- pg_cron schedules; pg_net makes an HTTP call without blocking the
-- transaction that asked for it.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Configuration ────────────────────────────────────────────────────
-- A table rather than a literal in each job, so rotating the token is one
-- UPDATE rather than three rescheduled jobs — and so the token is not sitting
-- in `cron.job`, which is readable by anybody who can read the schedule.
CREATE SCHEMA IF NOT EXISTS ess_ops;

CREATE TABLE IF NOT EXISTS ess_ops.job_runner_config (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  api_origin text NOT NULL,
  token      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Readable only by the roles that need it. `authenticated` and `anon` are the
-- roles a browser reaches Supabase with; neither has any business here.
REVOKE ALL ON ess_ops.job_runner_config FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE ess_ops.job_runner_config IS
  'Where the scheduler posts and the secret it presents. One row.';

-- Replace both values, then run this file.
INSERT INTO ess_ops.job_runner_config (id, api_origin, token)
VALUES (true, 'https://ess.widedrop.com', 'REPLACE-WITH-JOB_RUNNER_TOKEN')
ON CONFLICT (id) DO UPDATE
  SET api_origin = excluded.api_origin,
      token      = excluded.token,
      updated_at = now();

-- ── The call ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ess_ops.run_job(job_name text)
RETURNS bigint
LANGUAGE plpgsql
-- SECURITY DEFINER so the cron role can read the token without being granted
-- the table. `search_path` is pinned because a definer function that resolves
-- names through the caller's path is a way to get it to run somebody else's
-- code.
SECURITY DEFINER
SET search_path = ess_ops, pg_catalog
AS $$
DECLARE
  config ess_ops.job_runner_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM ess_ops.job_runner_config WHERE id;

  IF config.token IS NULL OR config.token = 'REPLACE-WITH-JOB_RUNNER_TOKEN' THEN
    RAISE EXCEPTION 'ess_ops.job_runner_config has no token; the schedule would 401 every minute';
  END IF;

  -- Fire and forget. pg_net queues the request and returns an id immediately,
  -- so a slow API cannot hold a cron worker open — and the job's own result is
  -- recorded in ess_ops.job_run by the API, which is the better place to read
  -- it from anyway.
  RETURN net.http_post(
    url     := config.api_origin || '/api/v1/jobs/' || job_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || config.token,
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    -- Longer than the endpoint's own 7-second budget, so a run that uses all
    -- of it is not recorded as a timeout.
    timeout_milliseconds := 15000
  );
END;
$$;

REVOKE ALL ON FUNCTION ess_ops.run_job(text) FROM PUBLIC, anon, authenticated;

-- ── The schedule ─────────────────────────────────────────────────────
-- Unscheduled first, so re-running this file replaces rather than duplicates.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('ess-email-outbox', 'ess-payslip-documents', 'ess-maintenance');

-- Mail is what somebody is waiting for: a help-desk ticket is acknowledged by
-- its confirmation arriving.
SELECT cron.schedule(
  'ess-email-outbox', '* * * * *',
  $job$ SELECT ess_ops.run_job('email-outbox'); $job$
);

-- Normally finds nothing — calculating a cycle renders its documents. This is
-- for the run where object storage was briefly unavailable, because the
-- publish guard refuses a cycle whose payslips have no document.
SELECT cron.schedule(
  'ess-payslip-documents', '* * * * *',
  $job$ SELECT ess_ops.run_job('payslip-documents'); $job$
);

-- Overdue acknowledgements and closed rate-limit windows. Measured in days, so
-- hourly is frequent enough; every minute would be a full scan per
-- organisation for nothing.
SELECT cron.schedule(
  'ess-maintenance', '17 * * * *',
  $job$ SELECT ess_ops.run_job('maintenance'); $job$
);

-- ── Checking it afterwards ───────────────────────────────────────────
--
--   -- The schedule
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'ess-%';
--
--   -- Did pg_cron fire?
--   SELECT jobname, status, start_time, return_message
--     FROM cron.job_run_details
--    WHERE start_time > now() - interval '1 hour'
--    ORDER BY start_time DESC LIMIT 20;
--
--   -- Did the API answer? 401 means the token does not match; 404 means the
--   -- endpoint is not registered, so JOB_RUNNER_TOKEN is unset on the API.
--   SELECT id, status_code, created
--     FROM net._http_response
--    WHERE created > now() - interval '1 hour'
--    ORDER BY created DESC LIMIT 20;
--
--   -- What the jobs actually did. This is the one to read: pg_cron only knows
--   -- that it called, and pg_net only knows the status code.
--   SELECT job_name, status, started_at, finished_at, payload, last_error
--     FROM ess_ops.job_run
--    ORDER BY started_at DESC LIMIT 20;
