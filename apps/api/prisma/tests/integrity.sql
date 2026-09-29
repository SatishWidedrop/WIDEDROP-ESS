-- Database-level integrity tests.
--
-- These prove the rules hold even when the application is bypassed entirely:
-- a direct SQL insert, a migration, or an admin with a psql prompt cannot leave
-- the database in a state the business forbids.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/tests/integrity.sql
--
-- The whole file runs inside a transaction that is rolled back, so it leaves
-- nothing behind.

BEGIN;
SET search_path = ess, ess_ops, public;
SET client_min_messages = NOTICE;

CREATE TEMP TABLE result (name text, passed boolean);

CREATE OR REPLACE FUNCTION pg_temp.expect_violation(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  INSERT INTO result VALUES (label, false);
EXCEPTION
  WHEN check_violation OR exclusion_violation OR unique_violation OR foreign_key_violation
       OR not_null_violation OR raise_exception THEN
    INSERT INTO result VALUES (label, true);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  INSERT INTO result VALUES (label, true);
EXCEPTION WHEN others THEN
  INSERT INTO result VALUES (label || ' [' || SQLERRM || ']', false);
END;
$$;

-- ── Fixtures ──────────────────────────────────────────────────────────────

INSERT INTO organization (id, legal_name, display_name, domain, helpdesk_email)
VALUES ('11111111-1111-1111-1111-111111111111', 'Widedrop Technologies Pvt Ltd',
        'Widedrop', 'widedrop.test', 'helpdesk@widedroptech.com');

INSERT INTO employee (id, organization_id, employee_number, first_name, middle_name, last_name,
                      work_email, date_of_joining, employment_status)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'WDT-00001', 'Priya', NULL, 'Raghavan', 'priya.raghavan@widedrop.test', '2022-07-11', 'ACTIVE'),
       ('22222222-2222-2222-2222-222222222223', '11111111-1111-1111-1111-111111111111',
        'WDT-00002', 'Arjun', NULL, 'Malhotra', 'arjun.malhotra@widedrop.test', '2020-01-06', 'ACTIVE');

INSERT INTO attendance_period (id, organization_id, year, month, start_date, end_date, total_days,
                               status, submitted_at, approved_at)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
        2026, 8, '2026-08-01', '2026-08-31', 31, 'APPROVED', now(), now());

INSERT INTO payroll_cycle (id, organization_id, year, month, label, period_start, period_end, pay_date, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        2026, 8, 'August 2026', '2026-08-01', '2026-08-31', '2026-08-31', 'INPUTS_OPEN');

INSERT INTO payroll_run (id, organization_id, payroll_cycle_id, status, engine_version, triggered_by_user_id)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'SUCCEEDED', '1.0.0',
        '55555555-5555-5555-5555-555555555555');

-- ── Attendance period bookkeeping ────────────────────────────────

SELECT pg_temp.expect_violation(
  'a period past OPEN must record when it was submitted',
  $q$INSERT INTO attendance_period (organization_id, year, month, start_date, end_date, total_days, status)
     VALUES ('11111111-1111-1111-1111-111111111111', 2026, 9, '2026-09-01','2026-09-30', 30, 'APPROVED')$q$);

SELECT pg_temp.expect_violation(
  'a truncate cannot empty the audit log',
  $q$TRUNCATE ess.audit_event$q$);

-- ── Generated columns ─────────────────────────────────────────────────────

INSERT INTO result
SELECT 'employee.full_name is generated', full_name = 'Priya Raghavan' FROM employee
 WHERE employee_number = 'WDT-00001';

INSERT INTO result
SELECT 'employee.initials are generated', initials = 'PR' FROM employee
 WHERE employee_number = 'WDT-00001';

INSERT INTO attendance_record (organization_id, attendance_period_id, employee_id,
                               present_days, paid_leave_days, unpaid_leave_days,
                               holiday_days, week_off_days, absent_days, employed_days)
VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
        '22222222-2222-2222-2222-222222222222', 20, 1, 2, 1, 8, 1, 31);

INSERT INTO result
SELECT 'attendance payable_days is derived, not supplied', payable_days = 30.00
  FROM attendance_record WHERE employee_id = '22222222-2222-2222-2222-222222222222';

INSERT INTO result
SELECT 'attendance lop_days is derived, not supplied', lop_days = 3.00
  FROM attendance_record WHERE employee_id = '22222222-2222-2222-2222-222222222222';

-- ── The payroll pipeline cannot be short-circuited ────────────────────────

SELECT pg_temp.expect_violation(
  'no payslip before payroll is calculated',
  $q$INSERT INTO payslip (organization_id, payroll_cycle_id, payroll_run_id, employee_id, reference,
        period_start, period_end, pay_date, payable_days, total_days, lop_days,
        gross_earnings_minor, total_deductions_minor, net_pay_minor, source_digest)
     VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
             '44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222',
             'WDT-PS-2608-0001','2026-08-01','2026-08-31','2026-08-31',31,31,0,
             18320000, 2354000, 15966000, repeat('a',64))$q$);

SELECT pg_temp.expect_violation(
  'a cycle cannot be validated without an attendance period',
  $q$UPDATE payroll_cycle SET validated_at = now(), attendance_approved_at = now()
      WHERE id = '33333333-3333-3333-3333-333333333333'$q$);

SELECT pg_temp.expect_violation(
  'a cycle cannot be calculated before it is validated',
  $q$UPDATE payroll_cycle
        SET attendance_period_id = '77777777-7777-7777-7777-777777777777',
            attendance_approved_at = now(), calculated_at = now()
      WHERE id = '33333333-3333-3333-3333-333333333333'$q$);

SELECT pg_temp.expect_violation(
  'a cycle cannot be published before it is calculated',
  $q$UPDATE payroll_cycle
        SET attendance_period_id = '77777777-7777-7777-7777-777777777777',
            attendance_approved_at = now(), validated_at = now(),
            published_at = now(), published_by_user_id = '55555555-5555-5555-5555-555555555555'
      WHERE id = '33333333-3333-3333-3333-333333333333'$q$);

-- Walk the pipeline properly.
UPDATE payroll_cycle
   SET attendance_period_id = '77777777-7777-7777-7777-777777777777',
       attendance_submitted_at = now(), attendance_approved_at = now(),
       validated_at = now(), calculated_at = now(), status = 'CALCULATED'
 WHERE id = '33333333-3333-3333-3333-333333333333';

SELECT pg_temp.expect_ok(
  'a payslip may be created once the cycle is calculated',
  $q$INSERT INTO payslip (id, organization_id, payroll_cycle_id, payroll_run_id, employee_id, reference,
        period_start, period_end, pay_date, payable_days, total_days, lop_days,
        gross_earnings_minor, total_deductions_minor, net_pay_minor, source_digest)
     VALUES ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111',
             '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444',
             '22222222-2222-2222-2222-222222222222','WDT-PS-2608-0001','2026-08-01','2026-08-31',
             '2026-08-31',31,31,0, 18320000, 2354000, 15966000, repeat('a',64))$q$);

SELECT pg_temp.expect_violation(
  'a payslip cannot be published before its cycle is',
  $q$UPDATE payslip SET status = 'PUBLISHED', published_at = now()
      WHERE id = '66666666-6666-6666-6666-666666666666'$q$);

SELECT pg_temp.expect_violation(
  'a payslip is immutable once generated',
  $q$UPDATE payslip SET net_pay_minor = 99999999
      WHERE id = '66666666-6666-6666-6666-666666666666'$q$);

SELECT pg_temp.expect_violation(
  'a payslip that does not add up cannot be stored',
  $q$INSERT INTO payslip (organization_id, payroll_cycle_id, payroll_run_id, employee_id, reference,
        period_start, period_end, pay_date, payable_days, total_days, lop_days,
        gross_earnings_minor, total_deductions_minor, net_pay_minor, source_digest)
     VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
             '44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222',
             'WDT-PS-2608-0002','2026-08-01','2026-08-31','2026-08-31',31,31,0,
             100, 10, 55, repeat('b',64))$q$);

INSERT INTO payslip_line (organization_id, payslip_id, kind, label, amount_minor, display_order)
VALUES ('11111111-1111-1111-1111-111111111111','66666666-6666-6666-6666-666666666666',
        'EARNING','Basic salary', 8600000, 1);

SELECT pg_temp.expect_violation(
  'a payslip line cannot be edited after the fact',
  $q$UPDATE payslip_line SET amount_minor = 1
      WHERE payslip_id = '66666666-6666-6666-6666-666666666666'$q$);

SELECT pg_temp.expect_violation(
  'a payslip line cannot be deleted',
  $q$DELETE FROM payslip_line WHERE payslip_id = '66666666-6666-6666-6666-666666666666'$q$);

SELECT pg_temp.expect_violation(
  'an earning cannot be negative',
  $q$INSERT INTO payslip_line (organization_id, payslip_id, kind, label, amount_minor, display_order)
     VALUES ('11111111-1111-1111-1111-111111111111','66666666-6666-6666-6666-666666666666',
             'EARNING','Negative earning', -100, 2)$q$);

-- ── Append-only ledgers ───────────────────────────────────────────────────

INSERT INTO audit_event (organization_id, sequence, action, entity_type, previous_hash, row_hash)
VALUES ('11111111-1111-1111-1111-111111111111', nextval('ess.audit_event_sequence'),
        'LOGIN', 'app_user', repeat('0',64), repeat('c',64));

SELECT pg_temp.expect_violation(
  'an audit row cannot be deleted',
  $q$DELETE FROM audit_event WHERE entity_type = 'app_user'$q$);

SELECT pg_temp.expect_violation(
  'an audit row cannot be edited',
  $q$UPDATE audit_event SET row_hash = repeat('d',64) WHERE entity_type = 'app_user'$q$);

-- ── Effective-dated rows may not overlap ──────────────────────────────────

INSERT INTO salary_structure (organization_id, employee_id, effective_from, effective_to, annual_ctc_minor)
VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        '2026-04-01', NULL, 220000000);

SELECT pg_temp.expect_violation(
  'two salary structures cannot overlap',
  $q$INSERT INTO salary_structure (organization_id, employee_id, effective_from, effective_to, annual_ctc_minor)
     VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
             '2026-06-01', NULL, 240000000)$q$);

SELECT pg_temp.expect_violation(
  'nobody reports to themselves',
  $q$INSERT INTO employee_manager (organization_id, employee_id, manager_employee_id, effective_from)
     VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
             '22222222-2222-2222-2222-222222222222','2022-07-11')$q$);

-- ── Leave ─────────────────────────────────────────────────────────────────

INSERT INTO leave_period (id, organization_id, name, start_date, end_date)
VALUES ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111',
        '2026', '2026-01-01', '2026-12-31');

INSERT INTO leave_type (id, organization_id, code, name)
VALUES ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','EL','Earned leave');

SELECT pg_temp.expect_violation(
  'a leave balance cannot be overdrawn',
  $q$INSERT INTO leave_balance (organization_id, employee_id, leave_type_id, leave_period_id,
        opening_days, accrued_days, consumed_days)
     VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
             '99999999-9999-9999-9999-999999999999','88888888-8888-8888-8888-888888888888',
             0, 5, 9)$q$);

INSERT INTO leave_request (id, organization_id, employee_id, leave_type_id, leave_period_id,
                           status, start_date, end_date, working_days)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','99999999-9999-9999-9999-999999999999',
        '88888888-8888-8888-8888-888888888888','PENDING_APPROVAL','2026-10-20','2026-10-24', 5);

SELECT pg_temp.expect_violation(
  'two live leave requests cannot cover the same day',
  $q$INSERT INTO leave_request (organization_id, employee_id, leave_type_id, leave_period_id,
        status, start_date, end_date, working_days)
     VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
             '99999999-9999-9999-9999-999999999999','88888888-8888-8888-8888-888888888888',
             'PENDING_APPROVAL','2026-10-22','2026-10-26', 3)$q$);

SELECT pg_temp.expect_violation(
  'a leave request cannot be approved without recording who decided it',
  $q$UPDATE leave_request SET status = 'APPROVED' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$q$);

-- ── Expenses ──────────────────────────────────────────────────────────────

SELECT pg_temp.expect_violation(
  'a claim cannot be marked reimbursed without a batch',
  $q$INSERT INTO expense_claim (organization_id, employee_id, reference, title, status,
        total_amount_minor, spend_date)
     VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
             'EXP-0001','Client visit','REIMBURSED', 186000, '2026-09-24')$q$);

-- ── Report ────────────────────────────────────────────────────────────────

SELECT CASE WHEN passed THEN '  ok  ' ELSE ' FAIL ' END || ' ' || name AS "integrity"
  FROM result ORDER BY passed, name;

DO $$
DECLARE failures int;
BEGIN
  SELECT count(*) INTO failures FROM result WHERE NOT passed;
  RAISE NOTICE '% of % integrity checks passed',
    (SELECT count(*) FROM result WHERE passed), (SELECT count(*) FROM result);
  IF failures > 0 THEN
    RAISE EXCEPTION '% integrity check(s) failed', failures;
  END IF;
END $$;

ROLLBACK;
