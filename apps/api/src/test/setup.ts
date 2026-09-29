/**
 * Vitest setup for the API suite.
 *
 * Unit tests run with no external dependencies. Integration tests opt in by
 * importing `src/test/db.ts`, which requires DATABASE_URL to point at a
 * throwaway test database.
 */
process.env.NODE_ENV ??= 'test';
process.env.TZ = 'UTC';
