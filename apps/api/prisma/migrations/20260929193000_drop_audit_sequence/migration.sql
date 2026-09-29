-- The audit chain no longer uses a database sequence.
--
-- Its position is now per organisation and contiguous, computed from the
-- previous row under a transaction-scoped advisory lock. A shared sequence left
-- a legitimate gap whenever a transaction rolled back or another organisation
-- wrote a row, which made gap detection useless — and a gap has to mean
-- something, because it is how the deletion of the tail of a chain is detected.

DROP SEQUENCE IF EXISTS ess.audit_event_sequence;
