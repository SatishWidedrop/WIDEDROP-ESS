-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ess_ops";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "ess";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "ess";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "ess";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "ess";

-- CreateEnum
CREATE TYPE "ess_employment_status" AS ENUM ('PRE_JOINING', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'EXITED');

-- CreateEnum
CREATE TYPE "ess_employment_type" AS ENUM ('FULL_TIME_PERMANENT', 'FULL_TIME_PROBATION', 'FIXED_TERM', 'INTERN', 'CONTRACTOR', 'CONSULTANT');

-- CreateEnum
CREATE TYPE "ess_gender" AS ENUM ('FEMALE', 'MALE', 'NON_BINARY', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "ess_marital_status" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "ess_blood_group" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ess_user_status" AS ENUM ('INVITED', 'ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ess_mfa_method" AS ENUM ('TOTP');

-- CreateEnum
CREATE TYPE "ess_login_outcome" AS ENUM ('SUCCESS', 'BAD_CREDENTIALS', 'UNKNOWN_USER', 'MFA_REQUIRED', 'MFA_FAILED', 'LOCKED', 'DISABLED', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "ess_statutory_id_kind" AS ENUM ('PAN', 'AADHAAR', 'UAN', 'PF_ACCOUNT', 'ESI', 'PRAN', 'PASSPORT');

-- CreateEnum
CREATE TYPE "ess_leave_unit" AS ENUM ('DAY', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "ess_leave_accrual_frequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL', 'NONE');

-- CreateEnum
CREATE TYPE "ess_leave_request_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_leave_day_portion" AS ENUM ('FULL', 'FIRST_HALF', 'SECOND_HALF');

-- CreateEnum
CREATE TYPE "ess_leave_ledger_kind" AS ENUM ('OPENING', 'ACCRUAL', 'CARRY_FORWARD_IN', 'CARRY_FORWARD_OUT', 'CONSUMPTION', 'CONSUMPTION_REVERSAL', 'ENCASHMENT', 'LAPSE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ess_holiday_kind" AS ENUM ('PUBLIC', 'RESTRICTED', 'WEEKEND_COMPENSATORY');

-- CreateEnum
CREATE TYPE "ess_attendance_period_status" AS ENUM ('OPEN', 'HR_SUBMITTED', 'MANAGER_APPROVAL_PENDING', 'APPROVED', 'LOCKED', 'REOPENED');

-- CreateEnum
CREATE TYPE "ess_attendance_record_status" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ess_attendance_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_ESCALATED');

-- CreateEnum
CREATE TYPE "ess_attendance_source" AS ENUM ('HR_MANUAL', 'HR_BULK_UPLOAD', 'BIOMETRIC_IMPORT', 'SYSTEM_DERIVED');

-- CreateEnum
CREATE TYPE "ess_pay_component_kind" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFORMATIONAL');

-- CreateEnum
CREATE TYPE "ess_pay_component_calc" AS ENUM ('FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'SLAB', 'INPUT_DRIVEN', 'STATUTORY_ENGINE', 'PRORATED_FIXED');

-- CreateEnum
CREATE TYPE "ess_payroll_cycle_status" AS ENUM ('DRAFT', 'INPUTS_OPEN', 'INPUTS_LOCKED', 'ATTENDANCE_SUBMITTED', 'ATTENDANCE_APPROVED', 'VALIDATING', 'VALIDATION_FAILED', 'VALIDATED', 'CALCULATING', 'CALCULATED', 'APPROVED', 'PUBLISHED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_payroll_input_batch_status" AS ENUM ('UPLOADING', 'PARSED', 'PARSE_FAILED', 'VALIDATED', 'COMMITTED', 'SUPERSEDED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ess_payroll_input_kind" AS ENUM ('VARIABLE_PAY', 'INCENTIVE', 'BONUS', 'ARREAR', 'ONE_OFF_DEDUCTION', 'LOP_OVERRIDE', 'REIMBURSEMENT_PAYOUT', 'ADVANCE_RECOVERY', 'TDS_OVERRIDE');

-- CreateEnum
CREATE TYPE "ess_payroll_validation_severity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "ess_payroll_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ess_payslip_status" AS ENUM ('GENERATED', 'PUBLISHED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ess_payslip_line_kind" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFORMATIONAL');

-- CreateEnum
CREATE TYPE "ess_tax_regime_code" AS ENUM ('OLD', 'NEW');

-- CreateEnum
CREATE TYPE "ess_tax_declaration_status" AS ENUM ('DRAFT', 'SUBMITTED', 'PROOF_PENDING', 'PROOF_SUBMITTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ess_tds_quarter_status" AS ENUM ('UPCOMING', 'IN_PROGRESS', 'FILED', 'REVISED');

-- CreateEnum
CREATE TYPE "ess_form16_status" AS ENUM ('PENDING', 'ISSUED', 'REVISED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ess_benefit_category" AS ENUM ('HEALTH', 'LIFE', 'ACCIDENT', 'RETIREMENT', 'WELLNESS', 'ALLOWANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "ess_benefit_coverage_kind" AS ENUM ('FIXED_SUM_INSURED', 'MULTIPLE_OF_CTC', 'MONTHLY_AMOUNT', 'PERCENT_OF_BASIC', 'NON_MONETARY');

-- CreateEnum
CREATE TYPE "ess_benefit_enrolment_status" AS ENUM ('ELIGIBLE', 'ENROLLED', 'WAIVED', 'PENDING_DOCUMENTS', 'LAPSED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ess_benefit_action" AS ENUM ('NONE', 'DOWNLOAD_ECARD', 'VIEW_POLICY_DOCUMENT', 'CHANGE_CONTRIBUTION', 'ADD_DEPENDENT', 'RAISE_TICKET');

-- CreateEnum
CREATE TYPE "ess_dependent_relationship" AS ENUM ('SPOUSE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'FATHER_IN_LAW', 'MOTHER_IN_LAW', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "ess_expense_claim_status" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_MANAGER', 'MANAGER_APPROVED', 'MANAGER_REJECTED', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'QUEUED_FOR_PAYMENT', 'REIMBURSED', 'WITHDRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_expense_limit_basis" AS ENUM ('PER_CLAIM', 'PER_LINE', 'PER_DAY', 'PER_MONTH', 'PER_FY');

-- CreateEnum
CREATE TYPE "ess_reimbursement_batch_status" AS ENUM ('DRAFT', 'LOCKED', 'SENT_TO_PAYROLL', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_document_request_status" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'PROCESSING', 'ISSUED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_document_visibility" AS ENUM ('EMPLOYEE_AND_HR', 'HR_ONLY', 'EMPLOYEE_MANAGER_HR');

-- CreateEnum
CREATE TYPE "ess_policy_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ess_policy_version_status" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ess_policy_ack_status" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'WAIVED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "ess_policy_applicability_dimension" AS ENUM ('ALL', 'DEPARTMENT', 'LOCATION', 'EMPLOYMENT_TYPE', 'DESIGNATION', 'COST_CENTRE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "ess_announcement_status" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ess_announcement_audience_kind" AS ENUM ('ALL', 'DEPARTMENT', 'LOCATION', 'EMPLOYMENT_TYPE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "ess_ticket_status" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ess_ticket_comment_visibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ess_approval_task_kind" AS ENUM ('LEAVE_REQUEST', 'EXPENSE_CLAIM', 'ATTENDANCE_PERIOD', 'PROFILE_CHANGE', 'DOCUMENT_REQUEST');

-- CreateEnum
CREATE TYPE "ess_approval_task_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "ess_approval_decision_outcome" AS ENUM ('APPROVED', 'REJECTED', 'REASSIGNED', 'AUTO_APPROVED', 'AUTO_ESCALATED');

-- CreateEnum
CREATE TYPE "ess_notification_kind" AS ENUM ('PAYSLIP_PUBLISHED', 'LEAVE_SUBMITTED', 'LEAVE_DECIDED', 'EXPENSE_SUBMITTED', 'EXPENSE_DECIDED', 'EXPENSE_REIMBURSED', 'POLICY_ASSIGNED', 'POLICY_OVERDUE', 'ANNOUNCEMENT_PUBLISHED', 'TICKET_UPDATED', 'TICKET_RESOLVED', 'DOCUMENT_ISSUED', 'APPROVAL_PENDING', 'ATTENDANCE_APPROVAL_PENDING', 'PAYROLL_CYCLE_STATE', 'FORM16_ISSUED', 'SECURITY_ALERT');

-- CreateEnum
CREATE TYPE "ess_notification_tone" AS ENUM ('GREEN', 'AMBER', 'RED', 'BLUE', 'GRAY');

-- CreateEnum
CREATE TYPE "ess_file_scan_status" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ess_file_purpose" AS ENUM ('EXPENSE_BILL', 'TICKET_ATTACHMENT', 'EMPLOYEE_DOCUMENT', 'POLICY_PDF', 'PAYSLIP_PDF', 'FORM16_PDF', 'PAYROLL_INPUT_UPLOAD', 'ATTENDANCE_UPLOAD', 'BENEFIT_DOCUMENT', 'LETTER_PDF', 'PROFILE_PROOF', 'ORG_ASSET');

-- CreateEnum
CREATE TYPE "ess_ops"."ess_email_status" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ess_ops"."ess_email_kind" AS ENUM ('HELPDESK_TICKET_CREATED', 'HELPDESK_TICKET_UPDATED', 'PAYSLIP_PUBLISHED', 'PAYSLIP_COPY_REQUESTED', 'LEAVE_DECISION', 'EXPENSE_DECISION', 'POLICY_REMINDER', 'DOCUMENT_ISSUED', 'USER_INVITE', 'PASSWORD_RESET', 'MFA_ENROLLED', 'SECURITY_ALERT');

-- CreateEnum
CREATE TYPE "ess_audit_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'READ_SENSITIVE', 'LOGIN', 'LOGOUT', 'STATE_TRANSITION', 'EXPORT', 'DOWNLOAD', 'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'IMPERSONATE', 'CONFIG_CHANGE', 'CRYPTO_REWRAP');

-- CreateEnum
CREATE TYPE "ess_actor_kind" AS ENUM ('USER', 'SYSTEM', 'SCHEDULER', 'MIGRATION');

-- CreateEnum
CREATE TYPE "ess_persona" AS ENUM ('EMPLOYEE', 'MANAGER', 'HR', 'ACCOUNTS');

-- CreateEnum
CREATE TYPE "ess_payroll_run_type" AS ENUM ('REGULAR', 'SUPPLEMENTARY', 'OFF_CYCLE');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "domain" CITEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency_code" TEXT NOT NULL DEFAULT 'INR',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "employee_number_prefix" TEXT NOT NULL DEFAULT 'EMP',
    "helpdesk_email" CITEXT NOT NULL,
    "fiscal_year_start_month" SMALLINT NOT NULL DEFAULT 4,
    "logo_file_object_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_department_id" UUID,
    "head_employee_id" UUID,
    "accent_color" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "holiday_calendar_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centre" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_centre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "title" TEXT NOT NULL,
    "grade" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "designation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_year" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "start_year" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_quarter" (
    "id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "quarter" SMALLINT NOT NULL,
    "label" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_quarter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ui_copy" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" CITEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "value" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ui_copy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "key" CITEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "persona" "ess_persona" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "revoke_reason" TEXT,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT,
    "password_algo" TEXT NOT NULL DEFAULT 'argon2id',
    "password_updated_at" TIMESTAMPTZ(6),
    "password_must_change" BOOLEAN NOT NULL DEFAULT false,
    "status" "ess_user_status" NOT NULL DEFAULT 'INVITED',
    "failed_login_count" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip" INET,
    "mfa_enforced_at" TIMESTAMPTZ(6),
    "is_service_account" BOOLEAN NOT NULL DEFAULT false,
    "token_epoch" INTEGER NOT NULL DEFAULT 1,
    "terms_accepted_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "app_user_id" UUID,
    "employee_number" CITEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "preferred_name" TEXT,
    "initials" TEXT NOT NULL,
    "work_email" CITEXT NOT NULL,
    "work_phone" TEXT,
    "date_of_joining" DATE NOT NULL,
    "probation_end_date" DATE,
    "date_of_exit" DATE,
    "employment_status" "ess_employment_status" NOT NULL DEFAULT 'PRE_JOINING',
    "is_directory_listed" BOOLEAN NOT NULL DEFAULT true,
    "photo_file_object_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_employment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "designation_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "cost_centre_id" UUID,
    "employment_type" "ess_employment_type" NOT NULL,
    "notice_period_days" SMALLINT NOT NULL DEFAULT 0,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_employment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_manager" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "manager_employee_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_manager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_reporting_closure" (
    "organization_id" UUID NOT NULL,
    "ancestor_employee_id" UUID NOT NULL,
    "descendant_employee_id" UUID NOT NULL,
    "depth" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_reporting_closure_pkey" PRIMARY KEY ("ancestor_employee_id","descendant_employee_id")
);

-- CreateTable
CREATE TABLE "employee_personal_detail" (
    "employee_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "date_of_birth" DATE,
    "gender" "ess_gender" NOT NULL DEFAULT 'UNDISCLOSED',
    "marital_status" "ess_marital_status" NOT NULL DEFAULT 'UNDISCLOSED',
    "blood_group" "ess_blood_group" NOT NULL DEFAULT 'UNKNOWN',
    "nationality" TEXT,
    "personal_email_ct" BYTEA,
    "personal_email_iv" BYTEA,
    "personal_email_tag" BYTEA,
    "mobile_ct" BYTEA,
    "mobile_iv" BYTEA,
    "mobile_tag" BYTEA,
    "current_address_ct" BYTEA,
    "current_address_iv" BYTEA,
    "current_address_tag" BYTEA,
    "permanent_address_ct" BYTEA,
    "permanent_address_iv" BYTEA,
    "permanent_address_tag" BYTEA,
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_personal_detail_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "employee_statutory_id" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "ess_statutory_id_kind" NOT NULL,
    "value_ct" BYTEA NOT NULL,
    "value_iv" BYTEA NOT NULL,
    "value_tag" BYTEA NOT NULL,
    "masked_value" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_statutory_id_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_account" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number_ct" BYTEA NOT NULL,
    "account_number_iv" BYTEA NOT NULL,
    "account_number_tag" BYTEA NOT NULL,
    "account_number_masked" TEXT NOT NULL,
    "account_number_fingerprint" TEXT NOT NULL,
    "ifsc_ct" BYTEA NOT NULL,
    "ifsc_iv" BYTEA NOT NULL,
    "ifsc_tag" BYTEA NOT NULL,
    "ifsc_masked" TEXT NOT NULL,
    "account_holder_name" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "proof_file_object_id" UUID,
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_emergency_contact" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone_ct" BYTEA NOT NULL,
    "phone_iv" BYTEA NOT NULL,
    "phone_tag" BYTEA NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_emergency_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "parent_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "device_label" TEXT,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_credential" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "method" "ess_mfa_method" NOT NULL DEFAULT 'TOTP',
    "secret_ct" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "last_used_time_step" BIGINT,
    "confirmed_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_code" (
    "id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "app_user_id" UUID,
    "email_attempted" CITEXT NOT NULL,
    "outcome" "ess_login_outcome" NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendar" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week_off_days" INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "holiday_calendar_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ess_holiday_kind" NOT NULL DEFAULT 'PUBLIC',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_type" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "ess_leave_unit" NOT NULL DEFAULT 'DAY',
    "accrual_frequency" "ess_leave_accrual_frequency" NOT NULL DEFAULT 'MONTHLY',
    "accrual_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "max_carry_forward_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "min_notice_days" SMALLINT NOT NULL DEFAULT 0,
    "document_required_after_days" SMALLINT,
    "allows_half_day" BOOLEAN NOT NULL DEFAULT true,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_period" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance_ledger" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "leave_period_id" UUID NOT NULL,
    "kind" "ess_leave_ledger_kind" NOT NULL,
    "delta_days" DECIMAL(6,2) NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "note" TEXT,
    "effective_on" DATE NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "leave_period_id" UUID NOT NULL,
    "opening_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "accrued_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carried_forward_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "consumed_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "reserved_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "lapsed_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "adjusted_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "available_days" DECIMAL(6,2) NOT NULL,
    "entitlement_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "leave_period_id" UUID NOT NULL,
    "status" "ess_leave_request_status" NOT NULL DEFAULT 'DRAFT',
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_portion" "ess_leave_day_portion" NOT NULL DEFAULT 'FULL',
    "end_portion" "ess_leave_day_portion" NOT NULL DEFAULT 'FULL',
    "working_days" DECIMAL(5,2) NOT NULL,
    "reason" TEXT,
    "approver_employee_id" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "decision_note" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "document_file_object_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request_day" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "leave_request_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "portion" "ess_leave_day_portion" NOT NULL DEFAULT 'FULL',
    "day_fraction" DECIMAL(3,2) NOT NULL,

    CONSTRAINT "leave_request_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_period" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "month" SMALLINT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "total_days" SMALLINT NOT NULL,
    "status" "ess_attendance_period_status" NOT NULL DEFAULT 'OPEN',
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_record" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attendance_period_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "manager_employee_id" UUID,
    "status" "ess_attendance_record_status" NOT NULL DEFAULT 'DRAFT',
    "source" "ess_attendance_source" NOT NULL DEFAULT 'SYSTEM_DERIVED',
    "present_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "paid_leave_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "unpaid_leave_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "holiday_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "week_off_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "absent_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "payable_days" DECIMAL(5,2) NOT NULL,
    "lop_days" DECIMAL(5,2) NOT NULL,
    "employed_days" SMALLINT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_submission" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attendance_period_id" UUID NOT NULL,
    "submitted_by_user_id" UUID NOT NULL,
    "record_count" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_approval" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attendance_period_id" UUID NOT NULL,
    "manager_employee_id" UUID NOT NULL,
    "status" "ess_attendance_approval_status" NOT NULL DEFAULT 'PENDING',
    "record_count" INTEGER NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "return_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_cycle" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "month" SMALLINT NOT NULL,
    "label" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "pay_date" DATE NOT NULL,
    "status" "ess_payroll_cycle_status" NOT NULL DEFAULT 'DRAFT',
    "run_type" "ess_payroll_run_type" NOT NULL DEFAULT 'REGULAR',
    "attendance_period_id" UUID,
    "supersedes_cycle_id" UUID,
    "inputs_locked_at" TIMESTAMPTZ(6),
    "attendance_submitted_at" TIMESTAMPTZ(6),
    "attendance_approved_at" TIMESTAMPTZ(6),
    "validated_at" TIMESTAMPTZ(6),
    "calculated_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "employee_count" INTEGER,
    "excluded_count" INTEGER,
    "total_gross_minor" BIGINT,
    "total_deduction_minor" BIGINT,
    "total_net_minor" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payroll_cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_component" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ess_pay_component_kind" NOT NULL,
    "calc" "ess_pay_component_calc" NOT NULL,
    "rate" DECIMAL(12,6),
    "ceiling_minor" BIGINT,
    "is_prorated" BOOLEAN NOT NULL DEFAULT true,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "is_pf_applicable" BOOLEAN NOT NULL DEFAULT false,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "annual_ctc_minor" BIGINT NOT NULL,
    "revision_reason" TEXT,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure_component" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "salary_structure_id" UUID NOT NULL,
    "pay_component_id" UUID NOT NULL,
    "monthly_amount_minor" BIGINT,
    "rate_override" DECIMAL(12,6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structure_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_input_batch" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_cycle_id" UUID NOT NULL,
    "status" "ess_payroll_input_batch_status" NOT NULL DEFAULT 'UPLOADING',
    "file_object_id" UUID,
    "original_filename" TEXT,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "parse_errors" JSONB,
    "uploaded_by_user_id" UUID NOT NULL,
    "committed_at" TIMESTAMPTZ(6),
    "superseded_by_batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_input_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_input_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_input_batch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "ess_payroll_input_kind" NOT NULL,
    "pay_component_id" UUID,
    "amount_minor" BIGINT,
    "days" DECIMAL(5,2),
    "note" TEXT,
    "source_row_number" INTEGER,
    "is_applied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_input_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_validation_result" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_cycle_id" UUID NOT NULL,
    "employee_id" UUID,
    "check" TEXT NOT NULL,
    "severity" "ess_payroll_validation_severity" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "remedy" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_validation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_cycle_id" UUID NOT NULL,
    "status" "ess_payroll_run_status" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "engine_version" TEXT NOT NULL,
    "input_digest" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "employee_count" INTEGER,
    "error_message" TEXT,
    "triggered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_cycle_id" UUID NOT NULL,
    "payroll_run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "ess_payslip_status" NOT NULL DEFAULT 'GENERATED',
    "reference" CITEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_payslip_id" UUID,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "pay_date" DATE NOT NULL,
    "payable_days" DECIMAL(5,2) NOT NULL,
    "total_days" SMALLINT NOT NULL,
    "lop_days" DECIMAL(5,2) NOT NULL,
    "gross_earnings_minor" BIGINT NOT NULL,
    "total_deductions_minor" BIGINT NOT NULL,
    "net_pay_minor" BIGINT NOT NULL,
    "employer_contribution_minor" BIGINT NOT NULL DEFAULT 0,
    "pf_employee_minor" BIGINT NOT NULL DEFAULT 0,
    "pf_employer_minor" BIGINT NOT NULL DEFAULT 0,
    "tds_minor" BIGINT NOT NULL DEFAULT 0,
    "professional_tax_minor" BIGINT NOT NULL DEFAULT 0,
    "source_digest" TEXT NOT NULL,
    "pdf_file_object_id" UUID,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_line" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "pay_component_id" UUID,
    "kind" "ess_payslip_line_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "full_amount_minor" BIGINT,
    "display_order" SMALLINT NOT NULL,
    "payroll_input_item_id" UUID,
    "calculation_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_publication" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "published_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notification_sent" BOOLEAN NOT NULL DEFAULT false,
    "email_outbox_id" UUID,

    CONSTRAINT "payslip_publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_fy_rollup" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "payslip_count" INTEGER NOT NULL DEFAULT 0,
    "gross_minor" BIGINT NOT NULL DEFAULT 0,
    "net_minor" BIGINT NOT NULL DEFAULT 0,
    "tds_minor" BIGINT NOT NULL DEFAULT 0,
    "pf_employee_minor" BIGINT NOT NULL DEFAULT 0,
    "pf_employer_minor" BIGINT NOT NULL DEFAULT 0,
    "coverage_label" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_fy_rollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_regime" (
    "id" UUID NOT NULL,
    "code" "ess_tax_regime_code" NOT NULL,
    "fiscal_year_start_year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slabs" JSONB NOT NULL,
    "standard_deduction_minor" BIGINT NOT NULL DEFAULT 0,
    "rebate_threshold_minor" BIGINT,
    "rebate_max_minor" BIGINT,
    "cess_rate" DECIMAL(12,6) NOT NULL DEFAULT 0.04,
    "allows_deductions" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_regime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tax_regime_election" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "tax_regime_id" UUID NOT NULL,
    "elected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_default_applied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_tax_regime_election_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tax_declaration" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "status" "ess_tax_declaration_status" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "employee_tax_declaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tax_declaration_item" (
    "id" UUID NOT NULL,
    "declaration_id" UUID NOT NULL,
    "section_code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "declared_minor" BIGINT NOT NULL,
    "verified_minor" BIGINT,
    "proof_file_object_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_tax_declaration_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tax_projection" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "payroll_run_id" UUID,
    "projected_gross_minor" BIGINT NOT NULL,
    "exemptions_minor" BIGINT NOT NULL DEFAULT 0,
    "deductions_minor" BIGINT NOT NULL DEFAULT 0,
    "taxable_income_minor" BIGINT NOT NULL,
    "computed_tax_minor" BIGINT NOT NULL,
    "cess_minor" BIGINT NOT NULL DEFAULT 0,
    "total_liability_minor" BIGINT NOT NULL,
    "tds_deducted_to_date_minor" BIGINT NOT NULL DEFAULT 0,
    "remaining_liability_minor" BIGINT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_tax_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_quarter" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "fiscal_quarter_id" UUID NOT NULL,
    "status" "ess_tds_quarter_status" NOT NULL DEFAULT 'UPCOMING',
    "tds_minor" BIGINT,
    "filing_reference" TEXT,
    "filed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_quarter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form16_document" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "status" "ess_form16_status" NOT NULL DEFAULT 'PENDING',
    "file_object_id" UUID,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by_user_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form16_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_plan" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ess_benefit_category" NOT NULL,
    "coverage_kind" "ess_benefit_coverage_kind" NOT NULL,
    "coverage_value_minor" BIGINT,
    "coverage_multiplier" DECIMAL(12,6),
    "provider" TEXT,
    "policy_number" TEXT,
    "action" "ess_benefit_action" NOT NULL DEFAULT 'NONE',
    "document_file_object_id" UUID,
    "description" TEXT,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_plan_year" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "benefit_plan_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "enrolment_opens_on" DATE,
    "enrolment_closes_on" DATE,
    "employer_contribution_minor" BIGINT,
    "employee_contribution_minor" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_plan_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrolment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "benefit_plan_id" UUID NOT NULL,
    "benefit_plan_year_id" UUID NOT NULL,
    "status" "ess_benefit_enrolment_status" NOT NULL DEFAULT 'ELIGIBLE',
    "coverage_value_minor" BIGINT,
    "enrolled_at" TIMESTAMPTZ(6),
    "effective_from" DATE,
    "effective_to" DATE,
    "card_file_object_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrolment_dependent" (
    "id" UUID NOT NULL,
    "benefit_enrolment_id" UUID NOT NULL,
    "dependent_id" UUID NOT NULL,
    "covered_from" DATE,
    "covered_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_enrolment_dependent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependent" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "relationship" "ess_dependent_relationship" NOT NULL,
    "date_of_birth" DATE,
    "gender" "ess_gender" NOT NULL DEFAULT 'UNDISCLOSED',
    "initials" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominee" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "dependent_id" UUID,
    "full_name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "share_percent" DECIMAL(5,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nominee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requires_receipt" BOOLEAN NOT NULL DEFAULT true,
    "submission_window_days" SMALLINT NOT NULL DEFAULT 30,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_limit" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expense_category_id" UUID NOT NULL,
    "basis" "ess_expense_limit_basis" NOT NULL,
    "cap_minor" BIGINT NOT NULL,
    "designation_grade_min" SMALLINT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reference" CITEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ess_expense_claim_status" NOT NULL DEFAULT 'DRAFT',
    "total_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "approved_amount_minor" BIGINT,
    "spend_date" DATE NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "approver_employee_id" UUID,
    "manager_decided_at" TIMESTAMPTZ(6),
    "manager_decided_by_user_id" UUID,
    "manager_note" TEXT,
    "finance_decided_at" TIMESTAMPTZ(6),
    "finance_decided_by_user_id" UUID,
    "finance_note" TEXT,
    "reimbursement_batch_id" UUID,
    "reimbursed_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "expense_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim_line" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expense_claim_id" UUID NOT NULL,
    "expense_category_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "spend_date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "approved_amount_minor" BIGINT,
    "cap_applied_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_claim_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_attachment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expense_claim_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reimbursement_batch" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payroll_cycle_id" UUID,
    "reference" CITEXT NOT NULL,
    "status" "ess_reimbursement_batch_status" NOT NULL DEFAULT 'DRAFT',
    "cutoff_date" DATE NOT NULL,
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "total_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "reimbursement_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_fy_rollup" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "pending_minor" BIGINT NOT NULL DEFAULT 0,
    "approved_count" INTEGER NOT NULL DEFAULT 0,
    "approved_minor" BIGINT NOT NULL DEFAULT 0,
    "reimbursed_count" INTEGER NOT NULL DEFAULT 0,
    "reimbursed_minor" BIGINT NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_fy_rollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "visibility" "ess_document_visibility" NOT NULL DEFAULT 'EMPLOYEE_AND_HR',
    "is_requestable" BOOLEAN NOT NULL DEFAULT false,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_document" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "file_object_id" UUID NOT NULL,
    "document_date" DATE NOT NULL,
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_template" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "required_fields" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_request" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "letter_template_id" UUID,
    "status" "ess_document_request_status" NOT NULL DEFAULT 'SUBMITTED',
    "addressee" TEXT,
    "purpose" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),
    "issued_by_user_id" UUID,
    "file_object_id" UUID,
    "rejection_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_change_request" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "section" TEXT NOT NULL,
    "requested_changes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "proof_file_object_id" UUID,
    "ticket_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by_user_id" UUID,
    "decision_note" TEXT,
    "applied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "profile_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_team" TEXT NOT NULL,
    "contact_email" CITEXT,
    "status" "ess_policy_status" NOT NULL DEFAULT 'DRAFT',
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_version" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "version_label" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "ess_policy_version_status" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "review_due_on" DATE,
    "acknowledgement_due_days" SMALLINT,
    "requires_acknowledgement" BOOLEAN NOT NULL DEFAULT true,
    "pdf_file_object_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "superseded_by_version_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_version_point" (
    "id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "display_order" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_version_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_applicability_rule" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "dimension" "ess_policy_applicability_dimension" NOT NULL,
    "target_id" UUID,
    "target_value" TEXT,
    "is_exclusion" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_applicability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_assignment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_on" DATE,

    CONSTRAINT "policy_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_acknowledgement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "ess_policy_ack_status" NOT NULL DEFAULT 'PENDING',
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_ip" INET,
    "acknowledged_user_agent" TEXT,
    "due_on" DATE,
    "waived_at" TIMESTAMPTZ(6),
    "waived_by_user_id" UUID,
    "waive_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_acknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "department_label" TEXT NOT NULL,
    "author_employee_id" UUID,
    "byline" TEXT,
    "status" "ess_announcement_status" NOT NULL DEFAULT 'DRAFT',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "publish_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_paragraph" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "display_order" SMALLINT NOT NULL,

    CONSTRAINT "announcement_paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_audience" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "kind" "ess_announcement_audience_kind" NOT NULL,
    "target_id" UUID,
    "target_value" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_audience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_read" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_read_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "routing_email" CITEXT,
    "first_response_hours" SMALLINT NOT NULL DEFAULT 24,
    "resolution_hours" SMALLINT NOT NULL DEFAULT 72,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_ticket" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reference" CITEXT NOT NULL,
    "ticket_category_id" UUID NOT NULL,
    "requester_employee_id" UUID NOT NULL,
    "assignee_employee_id" UUID,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ess_ticket_status" NOT NULL DEFAULT 'OPEN',
    "priority" "ess_ticket_priority" NOT NULL DEFAULT 'NORMAL',
    "first_response_due_at" TIMESTAMPTZ(6),
    "resolution_due_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "paused_at" TIMESTAMPTZ(6),
    "assigned_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "reopened_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "source_type" TEXT,
    "source_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "helpdesk_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_employee_id" UUID,
    "author_user_id" UUID,
    "body" TEXT NOT NULL,
    "visibility" "ess_ticket_comment_visibility" NOT NULL DEFAULT 'PUBLIC',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_attachment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_article" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "ticket_category_id" UUID,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "app_user_id" UUID NOT NULL,
    "kind" "ess_notification_kind" NOT NULL,
    "tone" "ess_notification_tone" NOT NULL DEFAULT 'BLUE',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "target_module" TEXT,
    "target_id" UUID,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_task" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "ess_approval_task_kind" NOT NULL,
    "status" "ess_approval_task_status" NOT NULL DEFAULT 'PENDING',
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_employee_id" UUID NOT NULL,
    "assignee_employee_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "amount_minor" BIGINT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decision" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "approval_task_id" UUID NOT NULL,
    "outcome" "ess_approval_decision_outcome" NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "decided_by_employee_id" UUID,
    "note" TEXT,
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "actor_kind" "ess_actor_kind" NOT NULL DEFAULT 'USER',
    "actor_user_id" UUID,
    "actor_employee_id" UUID,
    "actor_persona" "ess_persona",
    "action" "ess_audit_action" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "from_state" TEXT,
    "to_state" TEXT,
    "before_data" JSONB,
    "after_data" JSONB,
    "summary" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previous_hash" TEXT NOT NULL,
    "row_hash" TEXT NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purpose" "ess_file_purpose" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "display_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_status" "ess_file_scan_status" NOT NULL DEFAULT 'PENDING',
    "scanned_at" TIMESTAMPTZ(6),
    "uploaded_by_user_id" UUID,
    "subject_employee_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delete_after" TIMESTAMPTZ(6),

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_encryption_key" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "wrap_iv" BYTEA NOT NULL,
    "wrap_tag" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_encryption_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ess_ops"."email_outbox" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "ess_ops"."ess_email_kind" NOT NULL,
    "status" "ess_ops"."ess_email_status" NOT NULL DEFAULT 'QUEUED',
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reply_to" TEXT,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ess_ops"."idempotency_record" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "app_user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ess_ops"."job_run" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "job_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_transition" (
    "id" UUID NOT NULL,
    "machine" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actor_persona" "ess_persona",
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_transition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_domain_key" ON "organization"("domain");

-- CreateIndex
CREATE INDEX "ix_department__org_active" ON "department"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "ux_department__org_code" ON "department"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_location__org_code" ON "location"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_cost_centre__org_code" ON "cost_centre"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_designation__org_code" ON "designation"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_fiscal_year__org_start" ON "fiscal_year"("organization_id", "start_year");

-- CreateIndex
CREATE UNIQUE INDEX "ux_fiscal_quarter__year_q" ON "fiscal_quarter"("fiscal_year_id", "quarter");

-- CreateIndex
CREATE INDEX "ix_ui_copy__org_locale" ON "ui_copy"("organization_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "ux_ui_copy__org_key_locale" ON "ui_copy"("organization_id", "key", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_persona_key" ON "role"("persona");

-- CreateIndex
CREATE INDEX "ix_user_role__user_active" ON "user_role"("app_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "ix_user_role__role" ON "user_role"("role_id");

-- CreateIndex
CREATE INDEX "ix_app_user__status" ON "app_user"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_app_user__locked" ON "app_user"("locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "ux_app_user__org_email" ON "app_user"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "employee_app_user_id_key" ON "employee"("app_user_id");

-- CreateIndex
CREATE INDEX "ix_employee__org_status" ON "employee"("organization_id", "employment_status");

-- CreateIndex
CREATE INDEX "ix_employee__org_directory" ON "employee"("organization_id", "is_directory_listed");

-- CreateIndex
CREATE UNIQUE INDEX "ux_employee__org_number" ON "employee"("organization_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "ux_employee__org_work_email" ON "employee"("organization_id", "work_email");

-- CreateIndex
CREATE INDEX "ix_employee_employment__org_emp_from" ON "employee_employment"("organization_id", "employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "ix_employee_employment__department" ON "employee_employment"("department_id");

-- CreateIndex
CREATE INDEX "ix_employee_manager__org_mgr" ON "employee_manager"("organization_id", "manager_employee_id", "effective_to");

-- CreateIndex
CREATE INDEX "ix_employee_manager__org_emp" ON "employee_manager"("organization_id", "employee_id", "effective_to");

-- CreateIndex
CREATE INDEX "ix_closure__org_ancestor_depth" ON "employee_reporting_closure"("organization_id", "ancestor_employee_id", "depth");

-- CreateIndex
CREATE INDEX "ix_closure__org_descendant" ON "employee_reporting_closure"("organization_id", "descendant_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_employee_statutory_id__emp_kind" ON "employee_statutory_id"("employee_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ux_employee_statutory_id__org_kind_fp" ON "employee_statutory_id"("organization_id", "kind", "fingerprint");

-- CreateIndex
CREATE INDEX "ix_employee_bank__org_emp_active" ON "employee_bank_account"("organization_id", "employee_id", "is_active");

-- CreateIndex
CREATE INDEX "ix_emergency_contact__org_emp" ON "employee_emergency_contact"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "ix_refresh_token__user_active" ON "refresh_token"("app_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "ix_refresh_token__family" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "ix_refresh_token__expiry" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_mfa_credential__user_method" ON "mfa_credential"("app_user_id", "method");

-- CreateIndex
CREATE INDEX "ix_mfa_recovery__user_unused" ON "mfa_recovery_code"("app_user_id", "used_at");

-- CreateIndex
CREATE INDEX "ix_login_attempt__email_time" ON "login_attempt"("email_attempted", "created_at");

-- CreateIndex
CREATE INDEX "ix_login_attempt__ip_time" ON "login_attempt"("ip", "created_at");

-- CreateIndex
CREATE INDEX "ix_login_attempt__user_time" ON "login_attempt"("app_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "ix_password_reset__user_unused" ON "password_reset_token"("app_user_id", "used_at");

-- CreateIndex
CREATE INDEX "ix_password_reset__expiry" ON "password_reset_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_holiday_calendar__org_name_year" ON "holiday_calendar"("organization_id", "name", "year");

-- CreateIndex
CREATE INDEX "ix_holiday__org_date" ON "holiday"("organization_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ux_holiday__calendar_date_name" ON "holiday"("holiday_calendar_id", "date", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ux_leave_type__org_code" ON "leave_type"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_leave_period__org_start" ON "leave_period"("organization_id", "start_date");

-- CreateIndex
CREATE INDEX "ix_leave_ledger__org_emp_type_period" ON "leave_balance_ledger"("organization_id", "employee_id", "leave_type_id", "leave_period_id");

-- CreateIndex
CREATE INDEX "ix_leave_ledger__source" ON "leave_balance_ledger"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "ix_leave_balance__org_period" ON "leave_balance"("organization_id", "leave_period_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_leave_balance__emp_type_period" ON "leave_balance"("employee_id", "leave_type_id", "leave_period_id");

-- CreateIndex
CREATE INDEX "ix_leave_request__org_emp_status" ON "leave_request"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_leave_request__org_approver_status" ON "leave_request"("organization_id", "approver_employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_leave_request__org_dates" ON "leave_request"("organization_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "ix_leave_request_day__org_date" ON "leave_request_day"("organization_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ux_leave_request_day__request_date" ON "leave_request_day"("leave_request_id", "date");

-- CreateIndex
CREATE INDEX "ix_attendance_period__org_status" ON "attendance_period"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_attendance_period__org_year_month" ON "attendance_period"("organization_id", "year", "month");

-- CreateIndex
CREATE INDEX "ix_attendance_record__org_mgr_status" ON "attendance_record"("organization_id", "manager_employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_attendance_record__org_emp" ON "attendance_record"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_attendance_record__period_emp" ON "attendance_record"("attendance_period_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_attendance_submission__org_period" ON "attendance_submission"("organization_id", "attendance_period_id");

-- CreateIndex
CREATE INDEX "ix_attendance_approval__org_mgr_status" ON "attendance_approval"("organization_id", "manager_employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_attendance_approval__period_mgr" ON "attendance_approval"("attendance_period_id", "manager_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_cycle_attendance_period_id_key" ON "payroll_cycle"("attendance_period_id");

-- CreateIndex
CREATE INDEX "ix_payroll_cycle__org_status" ON "payroll_cycle"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_payroll_cycle__org_year_month" ON "payroll_cycle"("organization_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ux_payroll_cycle__org_period_run" ON "payroll_cycle"("organization_id", "year", "month", "run_type", "supersedes_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_pay_component__org_code" ON "pay_component"("organization_id", "code");

-- CreateIndex
CREATE INDEX "ix_salary_structure__org_emp_from" ON "salary_structure"("organization_id", "employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "ux_structure_component__structure_component" ON "salary_structure_component"("salary_structure_id", "pay_component_id");

-- CreateIndex
CREATE INDEX "ix_payroll_input_batch__org_cycle_status" ON "payroll_input_batch"("organization_id", "payroll_cycle_id", "status");

-- CreateIndex
CREATE INDEX "ix_payroll_input_item__org_batch" ON "payroll_input_item"("organization_id", "payroll_input_batch_id");

-- CreateIndex
CREATE INDEX "ix_payroll_input_item__org_emp" ON "payroll_input_item"("organization_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_payroll_validation__org_cycle_passed" ON "payroll_validation_result"("organization_id", "payroll_cycle_id", "passed");

-- CreateIndex
CREATE INDEX "ix_payroll_validation__org_cycle_emp" ON "payroll_validation_result"("organization_id", "payroll_cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_payroll_run__org_cycle_status" ON "payroll_run"("organization_id", "payroll_cycle_id", "status");

-- CreateIndex
CREATE INDEX "ix_payslip__org_emp_status" ON "payslip"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_payslip__org_cycle" ON "payslip"("organization_id", "payroll_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_payslip__org_reference" ON "payslip"("organization_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "ux_payslip__cycle_emp_version" ON "payslip"("payroll_cycle_id", "employee_id", "version");

-- CreateIndex
CREATE INDEX "ix_payslip_line__payslip_order" ON "payslip_line"("payslip_id", "display_order");

-- CreateIndex
CREATE INDEX "ix_payslip_publication__org_payslip" ON "payslip_publication"("organization_id", "payslip_id");

-- CreateIndex
CREATE INDEX "ix_payslip_rollup__org_fy" ON "payslip_fy_rollup"("organization_id", "fiscal_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_payslip_rollup__emp_fy" ON "payslip_fy_rollup"("employee_id", "fiscal_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tax_regime__code_fy" ON "tax_regime"("code", "fiscal_year_start_year");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tax_election__emp_fy" ON "employee_tax_regime_election"("employee_id", "fiscal_year_id");

-- CreateIndex
CREATE INDEX "ix_tax_declaration__org_status" ON "employee_tax_declaration"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tax_declaration__emp_fy" ON "employee_tax_declaration"("employee_id", "fiscal_year_id");

-- CreateIndex
CREATE INDEX "ix_tax_declaration_item__decl_section" ON "employee_tax_declaration_item"("declaration_id", "section_code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tax_projection__emp_fy" ON "employee_tax_projection"("employee_id", "fiscal_year_id");

-- CreateIndex
CREATE INDEX "ix_tds_quarter__org_fy" ON "tds_quarter"("organization_id", "fiscal_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tds_quarter__emp_quarter" ON "tds_quarter"("employee_id", "fiscal_quarter_id");

-- CreateIndex
CREATE INDEX "ix_form16__org_status" ON "form16_document"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_form16__emp_fy_revision" ON "form16_document"("employee_id", "fiscal_year_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ux_benefit_plan__org_code" ON "benefit_plan"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_benefit_plan_year__plan_start" ON "benefit_plan_year"("benefit_plan_id", "start_date");

-- CreateIndex
CREATE INDEX "ix_benefit_enrolment__org_status" ON "benefit_enrolment"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_benefit_enrolment__emp_year" ON "benefit_enrolment"("employee_id", "benefit_plan_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_benefit_dependent__enrolment_dependent" ON "benefit_enrolment_dependent"("benefit_enrolment_id", "dependent_id");

-- CreateIndex
CREATE INDEX "ix_dependent__org_emp" ON "dependent"("organization_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_nominee__org_emp_purpose" ON "nominee"("organization_id", "employee_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "ux_expense_category__org_code" ON "expense_category"("organization_id", "code");

-- CreateIndex
CREATE INDEX "ix_expense_limit__org_cat_from" ON "expense_limit"("organization_id", "expense_category_id", "effective_from");

-- CreateIndex
CREATE INDEX "ix_expense_claim__org_emp_status" ON "expense_claim"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_expense_claim__org_approver_status" ON "expense_claim"("organization_id", "approver_employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_expense_claim__org_status_date" ON "expense_claim"("organization_id", "status", "spend_date");

-- CreateIndex
CREATE UNIQUE INDEX "ux_expense_claim__org_reference" ON "expense_claim"("organization_id", "reference");

-- CreateIndex
CREATE INDEX "ix_expense_line__org_claim" ON "expense_claim_line"("organization_id", "expense_claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_expense_attachment__claim_file" ON "expense_attachment"("expense_claim_id", "file_object_id");

-- CreateIndex
CREATE INDEX "ix_reimbursement_batch__org_status" ON "reimbursement_batch"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_reimbursement_batch__org_reference" ON "reimbursement_batch"("organization_id", "reference");

-- CreateIndex
CREATE INDEX "ix_expense_rollup__org_fy" ON "expense_fy_rollup"("organization_id", "fiscal_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_expense_rollup__emp_fy" ON "expense_fy_rollup"("employee_id", "fiscal_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_document_type__org_code" ON "document_type"("organization_id", "code");

-- CreateIndex
CREATE INDEX "ix_employee_document__org_emp_date" ON "employee_document"("organization_id", "employee_id", "document_date");

-- CreateIndex
CREATE UNIQUE INDEX "ux_letter_template__org_type_version" ON "letter_template"("organization_id", "document_type_id", "version");

-- CreateIndex
CREATE INDEX "ix_document_request__org_emp_status" ON "document_request"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_document_request__org_status" ON "document_request"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_change_request__org_emp_status" ON "profile_change_request"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_change_request__org_status" ON "profile_change_request"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ix_policy__org_status" ON "policy"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_policy__org_code" ON "policy"("organization_id", "code");

-- CreateIndex
CREATE INDEX "ix_policy_version__org_status_from" ON "policy_version"("organization_id", "status", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "ux_policy_version__policy_number" ON "policy_version"("policy_id", "version_number");

-- CreateIndex
CREATE INDEX "ix_policy_point__version_order" ON "policy_version_point"("policy_version_id", "display_order");

-- CreateIndex
CREATE INDEX "ix_policy_rule__org_version" ON "policy_applicability_rule"("organization_id", "policy_version_id");

-- CreateIndex
CREATE INDEX "ix_policy_assignment__org_emp" ON "policy_assignment"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_policy_assignment__version_emp" ON "policy_assignment"("policy_version_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_policy_ack__org_emp_status" ON "policy_acknowledgement"("organization_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_policy_ack__org_status_due" ON "policy_acknowledgement"("organization_id", "status", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "ux_policy_ack__version_emp" ON "policy_acknowledgement"("policy_version_id", "employee_id");

-- CreateIndex
CREATE INDEX "ix_announcement__org_status_published" ON "announcement"("organization_id", "status", "published_at");

-- CreateIndex
CREATE INDEX "ix_announcement__org_pinned" ON "announcement"("organization_id", "is_pinned", "published_at");

-- CreateIndex
CREATE INDEX "ix_announcement_para__ann_order" ON "announcement_paragraph"("announcement_id", "display_order");

-- CreateIndex
CREATE INDEX "ix_announcement_audience__org_ann" ON "announcement_audience"("organization_id", "announcement_id");

-- CreateIndex
CREATE INDEX "ix_announcement_read__org_emp" ON "announcement_read"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_announcement_read__ann_emp" ON "announcement_read"("announcement_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_ticket_category__org_code" ON "ticket_category"("organization_id", "code");

-- CreateIndex
CREATE INDEX "ix_ticket__org_requester_status" ON "helpdesk_ticket"("organization_id", "requester_employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_ticket__org_assignee_status" ON "helpdesk_ticket"("organization_id", "assignee_employee_id", "status");

-- CreateIndex
CREATE INDEX "ix_ticket__org_status_created" ON "helpdesk_ticket"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_ticket__org_reference" ON "helpdesk_ticket"("organization_id", "reference");

-- CreateIndex
CREATE INDEX "ix_ticket_comment__org_ticket_time" ON "ticket_comment"("organization_id", "ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_ticket_attachment__ticket_file" ON "ticket_attachment"("ticket_id", "file_object_id");

-- CreateIndex
CREATE INDEX "ix_faq__org_active_order" ON "faq_article"("organization_id", "is_active", "display_order");

-- CreateIndex
CREATE INDEX "ix_notification__org_user_unread" ON "notification"("organization_id", "app_user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_notification__user_source_kind" ON "notification"("app_user_id", "source_type", "source_id", "kind");

-- CreateIndex
CREATE INDEX "ix_approval_task__org_assignee_status" ON "approval_task"("organization_id", "assignee_employee_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "ix_approval_task__org_subject" ON "approval_task"("organization_id", "subject_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_task__subject_assignee" ON "approval_task"("subject_type", "subject_id", "assignee_employee_id");

-- CreateIndex
CREATE INDEX "ix_approval_decision__org_task" ON "approval_decision"("organization_id", "approval_task_id");

-- CreateIndex
CREATE INDEX "ix_audit_event__org_entity" ON "audit_event"("organization_id", "entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_audit_event__org_actor" ON "audit_event"("organization_id", "actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_audit_event__org_action" ON "audit_event"("organization_id", "action", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_audit_event__request" ON "audit_event"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_audit_event__org_sequence" ON "audit_event"("organization_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_storage_key_key" ON "file_object"("storage_key");

-- CreateIndex
CREATE INDEX "ix_file_object__org_purpose" ON "file_object"("organization_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "ix_file_object__org_subject" ON "file_object"("organization_id", "subject_employee_id");

-- CreateIndex
CREATE INDEX "ix_file_object__scan_status" ON "file_object"("scan_status");

-- CreateIndex
CREATE INDEX "ix_file_object__delete_after" ON "file_object"("delete_after");

-- CreateIndex
CREATE UNIQUE INDEX "data_encryption_key_version_key" ON "data_encryption_key"("version");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotency_key_key" ON "ess_ops"."email_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "ix_email_outbox__status_next" ON "ess_ops"."email_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ix_email_outbox__org_source" ON "ess_ops"."email_outbox"("organization_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "ix_idempotency__expiry" ON "ess_ops"."idempotency_record"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_idempotency__user_key" ON "ess_ops"."idempotency_record"("app_user_id", "key");

-- CreateIndex
CREATE INDEX "ix_job_run__status_scheduled" ON "ess_ops"."job_run"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "ix_job_run__name_status" ON "ess_ops"."job_run"("job_name", "status");

-- CreateIndex
CREATE INDEX "ix_state_transition__machine" ON "state_transition"("machine");

-- CreateIndex
CREATE UNIQUE INDEX "ux_state_transition__machine_from_event" ON "state_transition"("machine", "from_state", "event");

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_parent_department_id_fkey" FOREIGN KEY ("parent_department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_head_employee_id_fkey" FOREIGN KEY ("head_employee_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_holiday_calendar_id_fkey" FOREIGN KEY ("holiday_calendar_id") REFERENCES "holiday_calendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designation" ADD CONSTRAINT "designation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_year" ADD CONSTRAINT "fiscal_year_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_quarter" ADD CONSTRAINT "fiscal_quarter_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ui_copy" ADD CONSTRAINT "ui_copy_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_photo_file_object_id_fkey" FOREIGN KEY ("photo_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_employment" ADD CONSTRAINT "employee_employment_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_employment" ADD CONSTRAINT "employee_employment_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_employment" ADD CONSTRAINT "employee_employment_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_employment" ADD CONSTRAINT "employee_employment_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_employment" ADD CONSTRAINT "employee_employment_cost_centre_id_fkey" FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_manager" ADD CONSTRAINT "employee_manager_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_manager" ADD CONSTRAINT "employee_manager_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reporting_closure" ADD CONSTRAINT "employee_reporting_closure_ancestor_employee_id_fkey" FOREIGN KEY ("ancestor_employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reporting_closure" ADD CONSTRAINT "employee_reporting_closure_descendant_employee_id_fkey" FOREIGN KEY ("descendant_employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_personal_detail" ADD CONSTRAINT "employee_personal_detail_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_statutory_id" ADD CONSTRAINT "employee_statutory_id_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_account" ADD CONSTRAINT "employee_bank_account_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_account" ADD CONSTRAINT "employee_bank_account_proof_file_object_id_fkey" FOREIGN KEY ("proof_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_emergency_contact" ADD CONSTRAINT "employee_emergency_contact_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_credential" ADD CONSTRAINT "mfa_credential_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_attempt" ADD CONSTRAINT "login_attempt_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_calendar" ADD CONSTRAINT "holiday_calendar_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_holiday_calendar_id_fkey" FOREIGN KEY ("holiday_calendar_id") REFERENCES "holiday_calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_period" ADD CONSTRAINT "leave_period_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_ledger" ADD CONSTRAINT "leave_balance_ledger_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_ledger" ADD CONSTRAINT "leave_balance_ledger_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_ledger" ADD CONSTRAINT "leave_balance_ledger_leave_period_id_fkey" FOREIGN KEY ("leave_period_id") REFERENCES "leave_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_leave_period_id_fkey" FOREIGN KEY ("leave_period_id") REFERENCES "leave_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_leave_period_id_fkey" FOREIGN KEY ("leave_period_id") REFERENCES "leave_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_document_file_object_id_fkey" FOREIGN KEY ("document_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_leave_request_id_fkey" FOREIGN KEY ("leave_request_id") REFERENCES "leave_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_period" ADD CONSTRAINT "attendance_period_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_attendance_period_id_fkey" FOREIGN KEY ("attendance_period_id") REFERENCES "attendance_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_submission" ADD CONSTRAINT "attendance_submission_attendance_period_id_fkey" FOREIGN KEY ("attendance_period_id") REFERENCES "attendance_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_approval" ADD CONSTRAINT "attendance_approval_attendance_period_id_fkey" FOREIGN KEY ("attendance_period_id") REFERENCES "attendance_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_approval" ADD CONSTRAINT "attendance_approval_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_cycle" ADD CONSTRAINT "payroll_cycle_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_cycle" ADD CONSTRAINT "payroll_cycle_attendance_period_id_fkey" FOREIGN KEY ("attendance_period_id") REFERENCES "attendance_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_cycle" ADD CONSTRAINT "payroll_cycle_supersedes_cycle_id_fkey" FOREIGN KEY ("supersedes_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure" ADD CONSTRAINT "salary_structure_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_component" ADD CONSTRAINT "salary_structure_component_salary_structure_id_fkey" FOREIGN KEY ("salary_structure_id") REFERENCES "salary_structure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_component" ADD CONSTRAINT "salary_structure_component_pay_component_id_fkey" FOREIGN KEY ("pay_component_id") REFERENCES "pay_component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_batch" ADD CONSTRAINT "payroll_input_batch_payroll_cycle_id_fkey" FOREIGN KEY ("payroll_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_batch" ADD CONSTRAINT "payroll_input_batch_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_batch" ADD CONSTRAINT "payroll_input_batch_superseded_by_batch_id_fkey" FOREIGN KEY ("superseded_by_batch_id") REFERENCES "payroll_input_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_item" ADD CONSTRAINT "payroll_input_item_payroll_input_batch_id_fkey" FOREIGN KEY ("payroll_input_batch_id") REFERENCES "payroll_input_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_item" ADD CONSTRAINT "payroll_input_item_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_input_item" ADD CONSTRAINT "payroll_input_item_pay_component_id_fkey" FOREIGN KEY ("pay_component_id") REFERENCES "pay_component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_validation_result" ADD CONSTRAINT "payroll_validation_result_payroll_cycle_id_fkey" FOREIGN KEY ("payroll_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_validation_result" ADD CONSTRAINT "payroll_validation_result_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_payroll_cycle_id_fkey" FOREIGN KEY ("payroll_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_payroll_cycle_id_fkey" FOREIGN KEY ("payroll_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_pdf_file_object_id_fkey" FOREIGN KEY ("pdf_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_supersedes_payslip_id_fkey" FOREIGN KEY ("supersedes_payslip_id") REFERENCES "payslip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_line" ADD CONSTRAINT "payslip_line_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_line" ADD CONSTRAINT "payslip_line_pay_component_id_fkey" FOREIGN KEY ("pay_component_id") REFERENCES "pay_component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_publication" ADD CONSTRAINT "payslip_publication_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_fy_rollup" ADD CONSTRAINT "payslip_fy_rollup_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_fy_rollup" ADD CONSTRAINT "payslip_fy_rollup_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_regime_election" ADD CONSTRAINT "employee_tax_regime_election_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_regime_election" ADD CONSTRAINT "employee_tax_regime_election_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_regime_election" ADD CONSTRAINT "employee_tax_regime_election_tax_regime_id_fkey" FOREIGN KEY ("tax_regime_id") REFERENCES "tax_regime"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declaration" ADD CONSTRAINT "employee_tax_declaration_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declaration" ADD CONSTRAINT "employee_tax_declaration_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declaration_item" ADD CONSTRAINT "employee_tax_declaration_item_declaration_id_fkey" FOREIGN KEY ("declaration_id") REFERENCES "employee_tax_declaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declaration_item" ADD CONSTRAINT "employee_tax_declaration_item_proof_file_object_id_fkey" FOREIGN KEY ("proof_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_projection" ADD CONSTRAINT "employee_tax_projection_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_projection" ADD CONSTRAINT "employee_tax_projection_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_quarter" ADD CONSTRAINT "tds_quarter_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_quarter" ADD CONSTRAINT "tds_quarter_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_quarter" ADD CONSTRAINT "tds_quarter_fiscal_quarter_id_fkey" FOREIGN KEY ("fiscal_quarter_id") REFERENCES "fiscal_quarter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form16_document" ADD CONSTRAINT "form16_document_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form16_document" ADD CONSTRAINT "form16_document_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form16_document" ADD CONSTRAINT "form16_document_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plan" ADD CONSTRAINT "benefit_plan_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plan" ADD CONSTRAINT "benefit_plan_document_file_object_id_fkey" FOREIGN KEY ("document_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plan_year" ADD CONSTRAINT "benefit_plan_year_benefit_plan_id_fkey" FOREIGN KEY ("benefit_plan_id") REFERENCES "benefit_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment" ADD CONSTRAINT "benefit_enrolment_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment" ADD CONSTRAINT "benefit_enrolment_benefit_plan_id_fkey" FOREIGN KEY ("benefit_plan_id") REFERENCES "benefit_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment" ADD CONSTRAINT "benefit_enrolment_benefit_plan_year_id_fkey" FOREIGN KEY ("benefit_plan_year_id") REFERENCES "benefit_plan_year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment" ADD CONSTRAINT "benefit_enrolment_card_file_object_id_fkey" FOREIGN KEY ("card_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment_dependent" ADD CONSTRAINT "benefit_enrolment_dependent_benefit_enrolment_id_fkey" FOREIGN KEY ("benefit_enrolment_id") REFERENCES "benefit_enrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrolment_dependent" ADD CONSTRAINT "benefit_enrolment_dependent_dependent_id_fkey" FOREIGN KEY ("dependent_id") REFERENCES "dependent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependent" ADD CONSTRAINT "dependent_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_dependent_id_fkey" FOREIGN KEY ("dependent_id") REFERENCES "dependent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_limit" ADD CONSTRAINT "expense_limit_expense_category_id_fkey" FOREIGN KEY ("expense_category_id") REFERENCES "expense_category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_reimbursement_batch_id_fkey" FOREIGN KEY ("reimbursement_batch_id") REFERENCES "reimbursement_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_line" ADD CONSTRAINT "expense_claim_line_expense_claim_id_fkey" FOREIGN KEY ("expense_claim_id") REFERENCES "expense_claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_line" ADD CONSTRAINT "expense_claim_line_expense_category_id_fkey" FOREIGN KEY ("expense_category_id") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_expense_claim_id_fkey" FOREIGN KEY ("expense_claim_id") REFERENCES "expense_claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_attachment" ADD CONSTRAINT "expense_attachment_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement_batch" ADD CONSTRAINT "reimbursement_batch_payroll_cycle_id_fkey" FOREIGN KEY ("payroll_cycle_id") REFERENCES "payroll_cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_fy_rollup" ADD CONSTRAINT "expense_fy_rollup_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_fy_rollup" ADD CONSTRAINT "expense_fy_rollup_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_template" ADD CONSTRAINT "letter_template_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_request" ADD CONSTRAINT "document_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_request" ADD CONSTRAINT "document_request_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_request" ADD CONSTRAINT "document_request_letter_template_id_fkey" FOREIGN KEY ("letter_template_id") REFERENCES "letter_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_request" ADD CONSTRAINT "document_request_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_proof_file_object_id_fkey" FOREIGN KEY ("proof_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy" ADD CONSTRAINT "policy_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_pdf_file_object_id_fkey" FOREIGN KEY ("pdf_file_object_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_superseded_by_version_id_fkey" FOREIGN KEY ("superseded_by_version_id") REFERENCES "policy_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_version_point" ADD CONSTRAINT "policy_version_point_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_applicability_rule" ADD CONSTRAINT "policy_applicability_rule_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_assignment" ADD CONSTRAINT "policy_assignment_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_assignment" ADD CONSTRAINT "policy_assignment_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_acknowledgement" ADD CONSTRAINT "policy_acknowledgement_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_acknowledgement" ADD CONSTRAINT "policy_acknowledgement_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_paragraph" ADD CONSTRAINT "announcement_paragraph_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_audience" ADD CONSTRAINT "announcement_audience_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_read" ADD CONSTRAINT "announcement_read_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_read" ADD CONSTRAINT "announcement_read_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_category" ADD CONSTRAINT "ticket_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket" ADD CONSTRAINT "helpdesk_ticket_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket" ADD CONSTRAINT "helpdesk_ticket_ticket_category_id_fkey" FOREIGN KEY ("ticket_category_id") REFERENCES "ticket_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket" ADD CONSTRAINT "helpdesk_ticket_requester_employee_id_fkey" FOREIGN KEY ("requester_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket" ADD CONSTRAINT "helpdesk_ticket_assignee_employee_id_fkey" FOREIGN KEY ("assignee_employee_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comment" ADD CONSTRAINT "ticket_comment_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "helpdesk_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comment" ADD CONSTRAINT "ticket_comment_author_employee_id_fkey" FOREIGN KEY ("author_employee_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachment" ADD CONSTRAINT "ticket_attachment_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "helpdesk_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachment" ADD CONSTRAINT "ticket_attachment_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_assignee_employee_id_fkey" FOREIGN KEY ("assignee_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_subject_employee_id_fkey" FOREIGN KEY ("subject_employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_approval_task_id_fkey" FOREIGN KEY ("approval_task_id") REFERENCES "approval_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ess_ops"."email_outbox" ADD CONSTRAINT "email_outbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
