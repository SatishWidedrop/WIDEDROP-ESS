-- An acknowledgement is its own kind of act, not a generic update.
--
-- The requirement names policy acknowledgement among the things that must be
-- auditable, and a compliance question is usually "show me every
-- acknowledgement in the period" rather than "show me every update and let me
-- work out which were acknowledgements". Giving it its own action makes that
-- one indexed predicate.
ALTER TYPE ess.ess_audit_action ADD VALUE IF NOT EXISTS 'ACKNOWLEDGE';
