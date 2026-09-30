-- Who approves attendance for people with no reporting manager.
--
-- Every organisation has somebody at the top. Their attendance record has no
-- manager to route to, and `submit_attendance` refused the whole period
-- because of it — which meant no period could ever be approved, and so no
-- payroll cycle could ever consume one. Nominating an approver is the way
-- through, and it is a nomination rather than a fallback to whoever submitted
-- the period because nobody should approve attendance they themselves filed.

ALTER TABLE ess.organization
  ADD COLUMN attendance_approver_employee_id uuid;

ALTER TABLE ess.organization
  ADD CONSTRAINT fk_organization__attendance_approver
  FOREIGN KEY (attendance_approver_employee_id)
  REFERENCES ess.employee (id)
  ON DELETE RESTRICT;

-- The nomination is read on every attendance submission and shown on the HR
-- attendance screen; one row per organisation, so the index is for the foreign
-- key's own sake rather than for the lookup.
CREATE INDEX ix_organization__attendance_approver
  ON ess.organization (attendance_approver_employee_id)
  WHERE attendance_approver_employee_id IS NOT NULL;
