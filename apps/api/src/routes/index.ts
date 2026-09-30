import type { App } from '../app.js';
import { generateDevelopmentKeyPair, loadTokenKeys } from '../services/auth/tokens.js';
import { authenticatePlugin } from '../plugins/authenticate.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './v1/auth.routes.js';
import { meRoutes } from './v1/me.js';
import { payslipRoutes } from './v1/payslips.js';
import { leaveRoutes } from './v1/leave.js';
import { expenseRoutes } from './v1/expenses.js';
import { policyRoutes } from './v1/policies.js';
import { helpdeskRoutes } from './v1/helpdesk.js';
import { directoryRoutes } from './v1/directory.js';
import { announcementRoutes } from './v1/announcements.js';
import { documentRoutes } from './v1/documents.js';
import { profileRoutes } from './v1/profile.js';
import { taxRoutes } from './v1/tax.js';
import { benefitRoutes } from './v1/benefits.js';
import { approvalRoutes } from './v1/approvals.js';
import { attendanceRoutes } from './v1/attendance.js';
import { hrRoutes } from './v1/hr.js';
import { payrollRoutes } from './v1/payroll.js';
import { reimbursementRoutes } from './v1/reimbursements.js';
import { auditRoutes } from './v1/audit.js';
import { cspReportRoutes } from './v1/csp-report.js';
import { fileRoutes } from './v1/files.js';
import { jobRoutes } from './v1/jobs.js';

/**
 * Route registration.
 *
 * Health and version sit outside the versioned prefix, so a monitor never has
 * to know the API version. Everything under `/api/v1` requires a session unless
 * its config says otherwise.
 */
export async function registerRoutes(app: App): Promise<void> {
  const env = app.env;

  // Outside production, a missing key pair is generated so a developer can run
  // the API without ceremony. Production refuses to start without real keys.
  let privateKeyBase64 = env.JWT_PRIVATE_KEY;
  let publicKeyBase64 = env.JWT_PUBLIC_KEY;

  if (env.NODE_ENV !== 'production') {
    const looksLikePem = (value: string) =>
      Buffer.from(value, 'base64').toString('utf8').includes('KEY');
    if (!looksLikePem(privateKeyBase64) || !looksLikePem(publicKeyBase64)) {
      const generated = generateDevelopmentKeyPair();
      privateKeyBase64 = generated.privateKeyBase64;
      publicKeyBase64 = generated.publicKeyBase64;
      app.log.warn(
        'generated an ephemeral JWT key pair: sessions will not survive a restart. Set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY for a stable one.',
      );
    }
  }

  const keys = await loadTokenKeys({
    privateKeyBase64,
    publicKeyBase64,
    keyId: env.JWT_KEY_ID,
  });

  await app.register(authenticatePlugin, { keys, db: app.db });
  await app.register(healthRoutes);
  await app.register(authRoutes, { keys });
  await app.register(meRoutes);
  await app.register(payslipRoutes);
  await app.register(profileRoutes);
  await app.register(leaveRoutes);
  await app.register(taxRoutes);
  await app.register(benefitRoutes);
  await app.register(expenseRoutes);
  await app.register(documentRoutes);
  await app.register(policyRoutes);
  await app.register(directoryRoutes);
  await app.register(announcementRoutes);
  await app.register(helpdeskRoutes);
  await app.register(approvalRoutes);
  await app.register(attendanceRoutes);
  await app.register(hrRoutes);
  await app.register(payrollRoutes);
  await app.register(reimbursementRoutes);
  await app.register(auditRoutes);
  await app.register(cspReportRoutes);
  await app.register(fileRoutes);
  await app.register(jobRoutes);
}
