import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, ERROR_CODES, isAppError, type ErrorDetail } from '../lib/errors.js';
import { redactValue } from '../lib/logger.js';

/**
 * The single exit point for every failure.
 *
 * Clients receive one envelope shape and never receive internals: no stack
 * traces, no SQL, no file paths, no upstream provider text. Everything an
 * operator needs goes to the log under the same request id.
 */
export const errorHandlerPlugin = fp(
  async (app: FastifyInstance, options: { exposeStackTraces: boolean }) => {
    app.setNotFoundHandler((request, reply) => {
      void reply.status(404).send({
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: 'No such endpoint.',
          requestId: request.context?.requestId ?? 'unknown',
        },
      });
    });

    app.setErrorHandler((error, request, reply) => {
      const requestId = request.context?.requestId ?? 'unknown';
      const appError = toAppError(error);

      const logPayload = {
        err: appError.expected ? { name: appError.name, message: appError.message } : error,
        code: appError.code,
        statusCode: appError.statusCode,
        meta: appError.meta ? redactValue(appError.meta) : undefined,
        route: request.context?.route,
        userId: request.context?.userId,
      };

      // Expected outcomes are routine; unexpected ones are incidents. Logging
      // them at the same level would bury the incidents.
      if (appError.expected) {
        request.log.info(logPayload, appError.code);
      } else {
        request.log.error(logPayload, appError.code);
      }

      if (appError.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(appError.retryAfterSeconds));
      }

      const body = appError.toEnvelope(requestId);

      // Stack traces are available in development only, and never in a response
      // that leaves a production process.
      if (options.exposeStackTraces && !appError.expected && error instanceof Error) {
        (body.error as Record<string, unknown>).stack = error.stack;
      }

      void reply.status(appError.statusCode).send(body);
    });
  },
  { name: 'error-handler' },
);

function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'The request could not be validated.', {
      details: zodDetails(error),
    });
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      message?: string;
    };

    // Fastify's own body-parse and schema failures.
    if (candidate.statusCode === 400 || candidate.validation) {
      return new AppError(400, ERROR_CODES.MALFORMED_REQUEST, 'The request could not be read.');
    }
    if (candidate.statusCode === 413 || candidate.code === 'FST_REQ_FILE_TOO_LARGE') {
      return new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'That upload is too large.');
    }
    if (candidate.statusCode === 415) {
      return new AppError(
        415,
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        'That content type is not accepted here.',
      );
    }
    if (candidate.statusCode === 429) {
      return new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests. Slow down and try again.');
    }

    // Prisma's known request errors. The client learns that something conflicts
    // or is missing, never which constraint or column.
    if (typeof candidate.code === 'string' && /^P\d{4}$/.test(candidate.code)) {
      return fromPrisma(candidate.code, error);
    }
  }

  return new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.', {
    cause: error,
    expected: false,
  });
}

function fromPrisma(code: string, cause: unknown): AppError {
  switch (code) {
    case 'P2002':
      return new AppError(409, ERROR_CODES.ALREADY_EXISTS, 'That already exists.', { cause });
    case 'P2003':
      return new AppError(409, ERROR_CODES.CONFLICT, 'That refers to something which no longer exists.', {
        cause,
      });
    case 'P2025':
      return new AppError(404, ERROR_CODES.NOT_FOUND, 'The requested record could not be found.', {
        cause,
      });
    case 'P2034':
      return new AppError(
        409,
        ERROR_CODES.CONCURRENT_MODIFICATION,
        'Someone else changed this while you were working. Reload and try again.',
        { cause },
      );
    default:
      return new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.', {
        cause,
        meta: { prismaCode: code },
        expected: false,
      });
  }
}

/**
 * Turn Zod issues into details a person can act on, without echoing the value
 * that failed — a rejected password must not come back in the error body.
 */
function zodDetails(error: ZodError): ErrorDetail[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.') || undefined,
    message: issue.message,
    rule: issue.code,
  }));
}
