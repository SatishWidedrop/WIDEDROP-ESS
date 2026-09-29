-- Integrity that Prisma's schema language cannot express.
--
-- Everything here enforces in the database a rule the application also enforces.
-- That redundancy is the point: a bug in a service, a bad migration or a manual
-- query cannot leave the database in a state the business rules forbid.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. updated_at maintenance and optimistic locking
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ess.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Bumps row_version on every update, so a stale writer's If-Match fails.
CREATE OR REPLACE FUNCTION ess.touch_updated_at_and_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_schema, c.table_name,
           bool_or(c.column_name = 'row_version') AS has_version
      FROM information_schema.columns c
     WHERE c.table_schema IN ('ess', 'ess_ops')
       AND c.column_name IN ('updated_at', 'row_version')
     GROUP BY c.table_schema, c.table_name
    HAVING bool_or(c.column_name = 'updated_at')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %I.%I
         FOR EACH ROW EXECUTE FUNCTION ess.%I()',
      t.table_schema, t.table_name,
      CASE WHEN t.has_version THEN 'touch_updated_at_and_version' ELSE 'touch_updated_at' END
    );
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Generated columns
--
-- Derived values are computed by the database, not by application code, so two
-- call sites cannot disagree and the UI never derives them client-side.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE ess.employee DROP COLUMN full_name;
ALTER TABLE ess.employee ADD COLUMN full_name text NOT NULL
  GENERATED ALWAYS AS (
    btrim(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)
  ) STORED;

ALTER TABLE ess.employee DROP COLUMN initials;
ALTER TABLE ess.employee ADD COLUMN initials text NOT NULL
  GENERATED ALWAYS AS (upper(left(first_name, 1) || left(last_name, 1))) STORED;

ALTER TABLE ess.dependent DROP COLUMN initials;
ALTER TABLE ess.dependent ADD COLUMN initials text NOT NULL
  GENERATED ALWAYS AS (
    upper(left(split_part(btrim(full_name), ' ', 1), 1) ||
          coalesce(nullif(left(split_part(btrim(full_name), ' ', 2), 1), ''), ''))
  ) STORED;

-- Payable days drive proration; loss-of-pay days reduce it. Deriving both means
-- a payslip can never be prorated by a number that does not match its own
-- attendance record.
ALTER TABLE ess.attendance_record DROP COLUMN payable_days;
ALTER TABLE ess.attendance_record ADD COLUMN payable_days numeric(5,2) NOT NULL
  GENERATED ALWAYS AS (present_days + paid_leave_days + holiday_days + week_off_days) STORED;

ALTER TABLE ess.attendance_record DROP COLUMN lop_days;
ALTER TABLE ess.attendance_record ADD COLUMN lop_days numeric(5,2) NOT NULL
  GENERATED ALWAYS AS (unpaid_leave_days + absent_days) STORED;

-- The Leave screen's "14.5 of 18 days" reads this; it is arithmetic over the
-- ledger projection, never a separately maintained number.
ALTER TABLE ess.leave_balance DROP COLUMN available_days;
ALTER TABLE ess.leave_balance ADD COLUMN available_days numeric(6,2) NOT NULL
  GENERATED ALWAYS AS (
    opening_days + accrued_days + carried_forward_days + adjusted_days
    - consumed_days - reserved_days - lapsed_days
  ) STORED;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Check constraints
-- ─────────────────────────────────────────────────────────────────────────

-- Identity ------------------------------------------------------------------

ALTER TABLE ess.app_user
  ADD CONSTRAINT ck_app_user__password_present
    CHECK (status = 'INVITED' OR password_hash IS NOT NULL),
  ADD CONSTRAINT ck_app_user__failed_count CHECK (failed_login_count >= 0),
  -- A disabled account records both when and why, or neither.
  ADD CONSTRAINT ck_app_user__disabled
    CHECK (num_nulls(disabled_at, disabled_reason) IN (0, 2)),
  ADD CONSTRAINT ck_app_user__token_epoch CHECK (token_epoch >= 1);

ALTER TABLE ess.employee
  ADD CONSTRAINT ck_employee__exit_after_join
    CHECK (date_of_exit IS NULL OR date_of_exit >= date_of_joining),
  ADD CONSTRAINT ck_employee__exited_has_date
    CHECK (employment_status <> 'EXITED' OR date_of_exit IS NOT NULL),
  ADD CONSTRAINT ck_employee__probation
    CHECK (probation_end_date IS NULL OR probation_end_date >= date_of_joining);

-- Effective-dated rows ------------------------------------------------------

ALTER TABLE ess.employee_employment
  ADD CONSTRAINT ck_employee_employment__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from);

ALTER TABLE ess.employee_manager
  ADD CONSTRAINT ck_employee_manager__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Nobody reports to themselves.
  ADD CONSTRAINT ck_employee_manager__not_self
    CHECK (employee_id <> manager_employee_id);

ALTER TABLE ess.salary_structure
  ADD CONSTRAINT ck_salary_structure__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  ADD CONSTRAINT ck_salary_structure__ctc CHECK (annual_ctc_minor >= 0);

-- A closure row's depth is 0 only for the employee themselves.
ALTER TABLE ess.employee_reporting_closure
  ADD CONSTRAINT ck_closure__self_depth
    CHECK ((ancestor_employee_id = descendant_employee_id) = (depth = 0));

-- Leave ---------------------------------------------------------------------

ALTER TABLE ess.leave_request
  ADD CONSTRAINT ck_leave_request__range CHECK (end_date >= start_date),
  ADD CONSTRAINT ck_leave_request__working_days CHECK (working_days > 0),
  -- Only whole and half days exist.
  ADD CONSTRAINT ck_leave_request__half_days CHECK ((working_days * 2) = floor(working_days * 2)),
  -- A decided request records when and by whom.
  ADD CONSTRAINT ck_leave_request__decided
    CHECK (status NOT IN ('APPROVED', 'REJECTED') OR (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL));

ALTER TABLE ess.leave_request_day
  ADD CONSTRAINT ck_leave_request_day__fraction CHECK (day_fraction IN (0.5, 1.0));

ALTER TABLE ess.leave_balance
  ADD CONSTRAINT ck_leave_balance__non_negative
    CHECK (opening_days >= 0 AND accrued_days >= 0 AND carried_forward_days >= 0
           AND consumed_days >= 0 AND reserved_days >= 0 AND lapsed_days >= 0),
  -- A balance can never go negative: leave cannot be spent that was never earned.
  ADD CONSTRAINT ck_leave_balance__not_overdrawn CHECK (available_days >= 0);

-- Attendance ----------------------------------------------------------------

ALTER TABLE ess.attendance_period
  ADD CONSTRAINT ck_attendance_period__month CHECK (month BETWEEN 1 AND 12),
  ADD CONSTRAINT ck_attendance_period__range CHECK (end_date >= start_date),
  ADD CONSTRAINT ck_attendance_period__total_days CHECK (total_days BETWEEN 28 AND 31),
  ADD CONSTRAINT ck_attendance_period__submitted
    CHECK (status = 'OPEN' OR submitted_at IS NOT NULL);

ALTER TABLE ess.attendance_record
  ADD CONSTRAINT ck_attendance_record__non_negative
    CHECK (present_days >= 0 AND paid_leave_days >= 0 AND unpaid_leave_days >= 0
           AND holiday_days >= 0 AND week_off_days >= 0 AND absent_days >= 0),
  ADD CONSTRAINT ck_attendance_record__employed_days CHECK (employed_days BETWEEN 0 AND 31);

ALTER TABLE ess.attendance_approval
  -- A returned slice must say why, so HR knows what to correct.
  ADD CONSTRAINT ck_attendance_approval__return_reason
    CHECK (status <> 'REJECTED' OR return_reason IS NOT NULL),
  ADD CONSTRAINT ck_attendance_approval__decided
    CHECK (status = 'PENDING' OR decided_at IS NOT NULL);

-- Payroll -------------------------------------------------------------------

ALTER TABLE ess.payroll_cycle
  ADD CONSTRAINT ck_payroll_cycle__month CHECK (month BETWEEN 1 AND 12),
  ADD CONSTRAINT ck_payroll_cycle__range CHECK (period_end >= period_start),
  ADD CONSTRAINT ck_payroll_cycle__pay_date CHECK (pay_date >= period_start),
  -- The pipeline's order, expressed as data: a cycle cannot claim to have
  -- reached a stage without the timestamp of the stage before it.
  ADD CONSTRAINT ck_payroll_cycle__attendance_before_validation
    CHECK (validated_at IS NULL OR attendance_approved_at IS NOT NULL),
  ADD CONSTRAINT ck_payroll_cycle__validated_before_calculated
    CHECK (calculated_at IS NULL OR validated_at IS NOT NULL),
  ADD CONSTRAINT ck_payroll_cycle__calculated_before_published
    CHECK (published_at IS NULL OR calculated_at IS NOT NULL),
  ADD CONSTRAINT ck_payroll_cycle__published_has_actor
    CHECK (published_at IS NULL OR published_by_user_id IS NOT NULL),
  -- A cycle past validation must name the attendance period it consumed.
  ADD CONSTRAINT ck_payroll_cycle__attendance_period_required
    CHECK (validated_at IS NULL OR attendance_period_id IS NOT NULL),
  ADD CONSTRAINT ck_payroll_cycle__cancel_reason
    CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL),
  ADD CONSTRAINT ck_payroll_cycle__totals
    CHECK (total_gross_minor IS NULL OR total_gross_minor >= 0);

ALTER TABLE ess.payslip
  ADD CONSTRAINT ck_payslip__amounts
    CHECK (gross_earnings_minor >= 0 AND total_deductions_minor >= 0),
  -- Net is exactly gross minus deductions. A payslip whose lines do not add up
  -- cannot be stored, let alone shown to anyone.
  ADD CONSTRAINT ck_payslip__net_is_gross_minus_deductions
    CHECK (net_pay_minor = gross_earnings_minor - total_deductions_minor),
  ADD CONSTRAINT ck_payslip__days
    CHECK (payable_days >= 0 AND payable_days <= total_days AND lop_days >= 0),
  ADD CONSTRAINT ck_payslip__published_has_timestamp
    CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  ADD CONSTRAINT ck_payslip__version CHECK (version >= 1),
  -- Traceability: a payslip always carries the digest of the inputs that made it.
  ADD CONSTRAINT ck_payslip__source_digest CHECK (length(source_digest) = 64);

ALTER TABLE ess.payslip_line
  ADD CONSTRAINT ck_payslip_line__earning_non_negative
    CHECK (kind <> 'EARNING' OR amount_minor >= 0);

ALTER TABLE ess.payroll_validation_result
  ADD CONSTRAINT ck_payroll_validation__failure_has_message
    CHECK (passed OR length(btrim(message)) > 0);

-- Expenses ------------------------------------------------------------------

ALTER TABLE ess.expense_claim
  ADD CONSTRAINT ck_expense_claim__total CHECK (total_amount_minor >= 0),
  ADD CONSTRAINT ck_expense_claim__approved_within_claimed
    CHECK (approved_amount_minor IS NULL
           OR (approved_amount_minor >= 0 AND approved_amount_minor <= total_amount_minor)),
  -- Reimbursement is only ever through a named batch, so "paid with September
  -- salary" is a fact that can be followed to a payroll cycle.
  ADD CONSTRAINT ck_expense_claim__reimbursed_has_batch
    CHECK (status <> 'REIMBURSED' OR reimbursement_batch_id IS NOT NULL);

ALTER TABLE ess.expense_claim_line
  ADD CONSTRAINT ck_expense_line__amount CHECK (amount_minor > 0);

-- Policies ------------------------------------------------------------------

ALTER TABLE ess.policy_version
  ADD CONSTRAINT ck_policy_version__number CHECK (version_number >= 1),
  ADD CONSTRAINT ck_policy_version__published_has_actor
    CHECK (status <> 'PUBLISHED' OR (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)),
  ADD CONSTRAINT ck_policy_version__superseded_has_successor
    CHECK (status <> 'SUPERSEDED' OR superseded_by_version_id IS NOT NULL);

-- The requirement in full: employee, policy version, status, timestamp.
ALTER TABLE ess.policy_acknowledgement
  ADD CONSTRAINT ck_policy_ack__acknowledged_has_timestamp
    CHECK (status <> 'ACKNOWLEDGED' OR acknowledged_at IS NOT NULL),
  ADD CONSTRAINT ck_policy_ack__waived_has_reason
    CHECK (status <> 'WAIVED' OR (waived_at IS NOT NULL AND waive_reason IS NOT NULL));

-- Communications ------------------------------------------------------------

ALTER TABLE ess.announcement
  ADD CONSTRAINT ck_announcement__published_has_timestamp
    CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL);

ALTER TABLE ess.helpdesk_ticket
  ADD CONSTRAINT ck_ticket__resolved_has_timestamp
    CHECK (status NOT IN ('RESOLVED', 'CLOSED') OR resolved_at IS NOT NULL),
  ADD CONSTRAINT ck_ticket__paused_seconds CHECK (paused_seconds >= 0);

ALTER TABLE ess.nominee
  ADD CONSTRAINT ck_nominee__share CHECK (share_percent > 0 AND share_percent <= 100);

-- Files and email -----------------------------------------------------------

ALTER TABLE ess.file_object
  ADD CONSTRAINT ck_file_object__size CHECK (size_bytes > 0),
  ADD CONSTRAINT ck_file_object__sha256 CHECK (length(sha256) = 64);

ALTER TABLE ess_ops.email_outbox
  ADD CONSTRAINT ck_email_outbox__recipients CHECK (cardinality(to_addresses) > 0),
  ADD CONSTRAINT ck_email_outbox__attempts CHECK (attempts >= 0),
  ADD CONSTRAINT ck_email_outbox__sent_has_timestamp
    CHECK (status <> 'SENT' OR sent_at IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Exclusion constraints — effective-dated rows may not overlap
--
-- Enforced by the database rather than hoped for in application code: two
-- overlapping salary structures would make a payslip ambiguous.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE ess.employee_employment
  ADD CONSTRAINT ex_employee_employment__no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

ALTER TABLE ess.salary_structure
  ADD CONSTRAINT ex_salary_structure__no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

-- Only the primary reporting line is exclusive; a dotted line may overlap.
ALTER TABLE ess.employee_manager
  ADD CONSTRAINT ex_employee_manager__no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (is_primary);

-- One leave year at a time.
ALTER TABLE ess.leave_period
  ADD CONSTRAINT ex_leave_period__no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- An employee cannot have two live requests covering the same day.
ALTER TABLE ess.leave_request
  ADD CONSTRAINT ex_leave_request__no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('PENDING_APPROVAL', 'APPROVED'));

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The payroll pipeline, enforced in the database
--
-- A payslip row may exist only once its cycle has actually been calculated, and
-- may be PUBLISHED only once its cycle has been published. The service layer
-- checks this too; this is the backstop that makes it impossible rather than
-- merely unlikely.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ess.enforce_payslip_cycle_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cycle_status ess.ess_payroll_cycle_status;
BEGIN
  SELECT status INTO cycle_status
    FROM ess.payroll_cycle WHERE id = NEW.payroll_cycle_id FOR SHARE;

  IF cycle_status IS NULL THEN
    RAISE EXCEPTION 'payslip references a payroll cycle that does not exist';
  END IF;

  IF cycle_status NOT IN ('CALCULATING', 'CALCULATED', 'APPROVED', 'PUBLISHED', 'CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'a payslip cannot exist while its payroll cycle is %; payroll must be validated and calculated first',
      cycle_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'PUBLISHED' AND cycle_status NOT IN ('PUBLISHED', 'CLOSED') THEN
    RAISE EXCEPTION
      'a payslip cannot be published while its payroll cycle is %',
      cycle_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payslip_cycle_state
  BEFORE INSERT OR UPDATE ON ess.payslip
  FOR EACH ROW EXECUTE FUNCTION ess.enforce_payslip_cycle_state();

-- A payslip is a business record: once written it is never edited. A correction
-- issues a new version and marks this one SUPERSEDED.
CREATE OR REPLACE FUNCTION ess.enforce_payslip_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.gross_earnings_minor <> NEW.gross_earnings_minor
     OR OLD.total_deductions_minor <> NEW.total_deductions_minor
     OR OLD.net_pay_minor <> NEW.net_pay_minor
     OR OLD.source_digest <> NEW.source_digest
     OR OLD.employee_id <> NEW.employee_id
     OR OLD.payroll_cycle_id <> NEW.payroll_cycle_id
     OR OLD.payable_days <> NEW.payable_days THEN
    RAISE EXCEPTION
      'a payslip is immutable once generated; issue a superseding version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payslip_immutable
  BEFORE UPDATE ON ess.payslip
  FOR EACH ROW EXECUTE FUNCTION ess.enforce_payslip_immutability();

-- Payslip lines are written once with their payslip.
CREATE OR REPLACE FUNCTION ess.forbid_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: this table is append-only',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_payslip_line_append_only
  BEFORE UPDATE OR DELETE ON ess.payslip_line
  FOR EACH ROW EXECUTE FUNCTION ess.forbid_write();

-- An acknowledgement, once given, is evidence. It is never edited away.
CREATE OR REPLACE FUNCTION ess.enforce_ack_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ACKNOWLEDGED' AND
     (NEW.status <> 'ACKNOWLEDGED'
      OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
      OR NEW.policy_version_id <> OLD.policy_version_id
      OR NEW.employee_id <> OLD.employee_id) THEN
    RAISE EXCEPTION
      'a policy acknowledgement cannot be changed once given'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_ack_immutable
  BEFORE UPDATE ON ess.policy_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION ess.enforce_ack_immutability();

-- A published policy version's text never changes; a change publishes a new one.
CREATE OR REPLACE FUNCTION ess.enforce_policy_version_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'SUPERSEDED')
     AND (NEW.body <> OLD.body
          OR NEW.summary <> OLD.summary
          OR NEW.version_label <> OLD.version_label
          OR NEW.effective_from <> OLD.effective_from) THEN
    RAISE EXCEPTION
      'a published policy version is immutable; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_version_immutable
  BEFORE UPDATE ON ess.policy_version
  FOR EACH ROW EXECUTE FUNCTION ess.enforce_policy_version_immutability();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Append-only ledgers
-- ─────────────────────────────────────────────────────────────────────────

CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON ess.audit_event
  FOR EACH ROW EXECUTE FUNCTION ess.forbid_write();

CREATE TRIGGER trg_leave_ledger_append_only
  BEFORE UPDATE OR DELETE ON ess.leave_balance_ledger
  FOR EACH ROW EXECUTE FUNCTION ess.forbid_write();

CREATE TRIGGER trg_approval_decision_append_only
  BEFORE UPDATE OR DELETE ON ess.approval_decision
  FOR EACH ROW EXECUTE FUNCTION ess.forbid_write();

CREATE TRIGGER trg_login_attempt_append_only
  BEFORE UPDATE OR DELETE ON ess.login_attempt
  FOR EACH ROW EXECUTE FUNCTION ess.forbid_write();

-- The audit chain's position is per organisation and contiguous, computed from
-- the previous row under an advisory lock rather than from a database sequence:
-- a sequence would leave a gap whenever a transaction rolled back or another
-- organisation wrote a row, and a gap has to mean something. It is how the
-- deletion of the tail of a chain is detected, which the hash links cannot
-- catch on their own.
--
-- The unique constraint on (organization_id, sequence) is what makes the
-- computation safe: if two writers ever raced past the lock, the second fails
-- rather than forking the chain.

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Search and partial indexes
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX ix_employee__search_trgm
  ON ess.employee USING gin (
    (full_name || ' ' || coalesce(preferred_name, '') || ' ' || employee_number::text) gin_trgm_ops
  );

CREATE INDEX ix_policy_version__published
  ON ess.policy_version (organization_id, effective_from DESC)
  WHERE status = 'PUBLISHED';

CREATE INDEX ix_announcement__live
  ON ess.announcement (organization_id, is_pinned DESC, published_at DESC)
  WHERE status = 'PUBLISHED';

CREATE INDEX ix_payslip__employee_published
  ON ess.payslip (organization_id, employee_id, period_start DESC)
  WHERE status = 'PUBLISHED';

CREATE INDEX ix_approval_task__pending
  ON ess.approval_task (organization_id, assignee_employee_id, requested_at DESC)
  WHERE status = 'PENDING';

CREATE INDEX ix_policy_ack__outstanding
  ON ess.policy_acknowledgement (organization_id, employee_id, due_on)
  WHERE status IN ('PENDING', 'OVERDUE');

CREATE INDEX ix_notification__unread
  ON ess.notification (organization_id, app_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX ix_email_outbox__pending
  ON ess_ops.email_outbox (next_attempt_at)
  WHERE status IN ('QUEUED', 'FAILED');

CREATE INDEX ix_refresh_token__live
  ON ess.refresh_token (app_user_id, expires_at)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;
