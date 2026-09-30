-- The shared rate-limit window.
--
-- An in-process counter gives each API instance its own budget: a sign-in
-- lockout then holds only on whichever instance the next attempt reaches,
-- which is not a lockout. Redis is the usual store and stays supported; this
-- table exists because the target deployment has no Redis, and a control this
-- load-bearing must not quietly become per-instance for want of one.

CREATE TABLE ess_ops.rate_limit_counter (
  key        text        PRIMARY KEY,
  count      integer     NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Swept by the worker. Without this the sweep is a sequential scan over every
-- window the system has ever opened.
CREATE INDEX ix_rate_limit_counter__expires
  ON ess_ops.rate_limit_counter (expires_at);

-- A count is only ever set by the upsert below, which starts at 1.
ALTER TABLE ess_ops.rate_limit_counter
  ADD CONSTRAINT ck_rate_limit_counter__count_positive CHECK (count >= 1);

COMMENT ON TABLE ess_ops.rate_limit_counter IS
  'Rate-limit windows, shared across API instances. Disposable: losing the '
  'table loses only the windows currently open.';

COMMENT ON COLUMN ess_ops.rate_limit_counter.key IS
  'Opaque and already route-scoped. Carries a hashed identifier, never an '
  'email address.';
