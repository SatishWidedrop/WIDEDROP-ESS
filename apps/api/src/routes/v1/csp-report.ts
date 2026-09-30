import type { App } from '../../app.js';

/**
 * Where the browser sends a Content-Security-Policy violation.
 *
 * The policy's `report-uri` points here, so a violation shows up in the logs
 * rather than only in somebody's console. That matters most in the one release
 * a policy change ships report-only: without an endpoint, "report-only" means
 * "unenforced and unobserved".
 *
 * Deliberately minimal, because this endpoint is unauthenticated and anyone
 * can post to it:
 *
 *  - it is rate limited by IP and capped well below the body limit
 *  - it writes no database row at all, so it cannot be used to fill a table
 *  - it is sampled into the log, so a page in a redirect loop cannot drown
 *    every other line
 *  - it never writes an audit event: the audit chain records what people did
 *    to business records, not what a browser refused to load
 *
 * A report is still subject to the CSRF plugin's origin check, which is the
 * useful half of that plugin here: only our own pages can report.
 */
export async function cspReportRoutes(app: App): Promise<void> {
  // One in ten, which is plenty to notice a directive that is wrong and not
  // enough to matter when a browser extension trips the policy on every load.
  const SAMPLE_RATE = 0.1;
  const MAX_BYTES = 8 * 1024;

  // Browsers send `application/csp-report` (the report-uri directive) or
  // `application/reports+json` (Reporting API). Neither is `application/json`,
  // so without these parsers Fastify answers 415 and the reports are lost.
  for (const contentType of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'string', bodyLimit: MAX_BYTES },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          // A malformed report is discarded rather than erroring: there is
          // nobody to tell, and a parse error here is not the application's
          // problem to solve.
          done(null, {});
        }
      },
    );
  }

  app.post(
    '/api/v1/csp-report',
    {
      config: { public: true, rateLimitName: 'default' },
      bodyLimit: MAX_BYTES,
    },
    async (request, reply) => {
      // 204 before anything else: the browser is not waiting for a verdict,
      // and a slow report endpoint slows the page that is reporting.
      void reply.status(204).send();

      if (Math.random() > SAMPLE_RATE) return reply;

      const body = request.body as Record<string, unknown> | undefined;
      const report = extract(body);
      if (!report) return reply;

      app.log.warn(
        {
          cspViolation: {
            directive: report.effectiveDirective ?? report.violatedDirective,
            blockedUri: truncate(report.blockedURI),
            documentUri: truncate(report.documentURI),
            sourceFile: truncate(report.sourceFile),
            line: report.lineNumber,
            disposition: report.disposition,
          },
          userAgent: truncate(request.headers['user-agent']),
        },
        'content security policy violation',
      );

      return reply;
    },
  );
}

interface Violation {
  effectiveDirective?: string;
  violatedDirective?: string;
  blockedURI?: string;
  documentURI?: string;
  sourceFile?: string;
  lineNumber?: number;
  disposition?: string;
}

/**
 * Pull the violation out of either shape.
 *
 * `report-uri` posts `{ "csp-report": { ... } }` with hyphenated keys; the
 * Reporting API posts an array of `{ type, body }` with camelCase ones.
 */
function extract(body: Record<string, unknown> | undefined): Violation | null {
  if (!body) return null;

  const legacy = body['csp-report'] as Record<string, unknown> | undefined;
  if (legacy) {
    return {
      effectiveDirective: string(legacy['effective-directive']),
      violatedDirective: string(legacy['violated-directive']),
      blockedURI: string(legacy['blocked-uri']),
      documentURI: string(legacy['document-uri']),
      sourceFile: string(legacy['source-file']),
      lineNumber: number(legacy['line-number']),
      disposition: string(legacy.disposition),
    };
  }

  const reports = Array.isArray(body) ? body : null;
  const first = reports?.[0] as { body?: Record<string, unknown> } | undefined;
  if (first?.body) {
    return {
      effectiveDirective: string(first.body.effectiveDirective),
      blockedURI: string(first.body.blockedURL),
      documentURI: string(first.body.documentURL),
      sourceFile: string(first.body.sourceFile),
      lineNumber: number(first.body.lineNumber),
      disposition: string(first.body.disposition),
    };
  }

  return null;
}

const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

/** Bounded, because every field here came from outside and lands in a log. */
const truncate = (value: string | undefined): string | undefined =>
  typeof value === 'string' ? value.slice(0, 300) : undefined;
