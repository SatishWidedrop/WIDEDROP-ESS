-- Close the TRUNCATE hole in the append-only tables.
--
-- A row-level BEFORE UPDATE OR DELETE trigger does not fire for TRUNCATE, so
-- `TRUNCATE audit_event` would silently empty the audit log without tripping
-- any of the protections added alongside it. A statement-level TRUNCATE trigger
-- closes that path.

CREATE OR REPLACE FUNCTION ess.forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on %.% is not permitted: this table is append-only',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_audit_event_no_truncate
  BEFORE TRUNCATE ON ess.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION ess.forbid_truncate();

CREATE TRIGGER trg_leave_ledger_no_truncate
  BEFORE TRUNCATE ON ess.leave_balance_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ess.forbid_truncate();

CREATE TRIGGER trg_approval_decision_no_truncate
  BEFORE TRUNCATE ON ess.approval_decision
  FOR EACH STATEMENT EXECUTE FUNCTION ess.forbid_truncate();

CREATE TRIGGER trg_payslip_line_no_truncate
  BEFORE TRUNCATE ON ess.payslip_line
  FOR EACH STATEMENT EXECUTE FUNCTION ess.forbid_truncate();

CREATE TRIGGER trg_payslip_no_truncate
  BEFORE TRUNCATE ON ess.payslip
  FOR EACH STATEMENT EXECUTE FUNCTION ess.forbid_truncate();
