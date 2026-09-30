import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transporter } from 'nodemailer';
import type { Env } from '../../config/env.js';

/**
 * Mail delivery.
 *
 * Three drivers, one interface:
 *
 *   - `smtp`       real delivery, used in production
 *   - `file`       writes an .eml per message, so a developer can read exactly
 *                  what would have been sent without a mail server
 *   - `noop`       accepts and discards, for tests
 *
 * A send either succeeds with a provider message id, or fails with whether the
 * failure is worth retrying. That distinction is the whole reason this
 * interface exists: a connection refused should be retried, and a rejected
 * recipient should not be retried forever.
 */

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string | null;
  /** Threads replies on a shared mailbox, and deduplicates at the provider. */
  messageId: string;
}

export type SendResult =
  { ok: true; providerMessageId: string | null } | { ok: false; retryable: boolean; error: string };

export interface MailTransport {
  readonly name: string;
  send(mail: OutgoingMail): Promise<SendResult>;
}

/* ------------------------------------------------------------------ */

class NoopTransport implements MailTransport {
  readonly name = 'noop';

  async send(): Promise<SendResult> {
    return { ok: true, providerMessageId: null };
  }
}

/**
 * Writes each message to disk as RFC 5322 text.
 *
 * Deliberately the development default: it makes the content reviewable and it
 * cannot accidentally email a real person from a developer's machine.
 */
class FileTransport implements MailTransport {
  readonly name = 'file';

  constructor(
    private readonly directory: string,
    private readonly from: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SendResult> {
    try {
      await mkdir(this.directory, { recursive: true });

      const headers = [
        `From: ${this.from}`,
        `To: ${mail.to.join(', ')}`,
        ...(mail.cc?.length ? [`Cc: ${mail.cc.join(', ')}`] : []),
        ...(mail.replyTo ? [`Reply-To: ${mail.replyTo}`] : []),
        `Subject: ${mail.subject}`,
        `Message-ID: <${mail.messageId}>`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
      ];

      // The message id, not a timestamp: two messages written in the same
      // millisecond would otherwise overwrite each other.
      const filename = `${mail.messageId.replace(/[^A-Za-z0-9._-]/g, '_')}.eml`;
      await writeFile(
        path.join(this.directory, filename),
        `${headers.join('\r\n')}\r\n\r\n${mail.text}\r\n`,
        'utf8',
      );

      return { ok: true, providerMessageId: mail.messageId };
    } catch (error) {
      // A full or unwritable disk is a local problem worth retrying.
      return {
        ok: false,
        retryable: true,
        error: error instanceof Error ? error.message : 'could not write the message',
      };
    }
  }
}

class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private transporter: Transporter | undefined;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      secure: boolean;
      user?: string | undefined;
      password?: string | undefined;
      from: string;
    },
  ) {}

  private async connection(): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    const nodemailer = await import('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      ...(this.config.user
        ? { auth: { user: this.config.user, pass: this.config.password ?? '' } }
        : {}),
      // A hung connection must not hold a worker slot indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // One connection, reused: the outbox drains serially and opening a TCP
      // session per message is the slowest part of sending.
      pool: true,
      maxConnections: 2,
    });

    return this.transporter;
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    try {
      const transporter = await this.connection();
      const info = await transporter.sendMail({
        from: this.config.from,
        to: mail.to,
        ...(mail.cc?.length ? { cc: mail.cc } : {}),
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        messageId: `<${mail.messageId}>`,
      });

      // A message the server accepted for some recipients and rejected for
      // others has not been fully delivered. Reported rather than counted as a
      // success, so the outbox row records what actually happened.
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        return {
          ok: false,
          retryable: false,
          error: `every recipient was rejected (${info.rejected.length})`,
        };
      }

      return { ok: true, providerMessageId: info.messageId ?? mail.messageId };
    } catch (error) {
      return { ok: false, retryable: isRetryable(error), error: describe(error) };
    }
  }
}

/**
 * Whether a failure is worth another attempt.
 *
 * SMTP 4xx is explicitly transient; 5xx is permanent. A network error has no
 * code at all and is treated as transient, because a refused connection during
 * a provider's restart is the commonest cause and it clears itself.
 */
function isRetryable(error: unknown): boolean {
  const code = (error as { responseCode?: number })?.responseCode;
  if (typeof code === 'number') return code >= 400 && code < 500;

  const errno = (error as { code?: string })?.code;
  if (typeof errno === 'string') {
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ESOCKET', 'EDNS'].includes(
      errno,
    );
  }

  return true;
}

/** A short description, with no credentials and no stack. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { responseCode?: number }).responseCode;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return 'the mail server could not be reached';
}

/* ------------------------------------------------------------------ */

let instance: MailTransport | undefined;

export function mailTransport(env: Env): MailTransport {
  instance ??= build(env);
  return instance;
}

function build(env: Env): MailTransport {
  switch (env.MAIL_DRIVER) {
    case 'noop':
      return new NoopTransport();

    case 'file':
      return new FileTransport(env.MAIL_FILE_PATH, env.MAIL_FROM);

    case 'smtp': {
      if (!env.SMTP_HOST || !env.SMTP_PORT) {
        // Refused rather than silently downgraded: a deployment that believes
        // it is sending mail and is not would lose help-desk tickets.
        throw new Error('MAIL_DRIVER=smtp requires SMTP_HOST and SMTP_PORT.');
      }
      return new SmtpTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.MAIL_FROM,
      });
    }
  }
}

export function resetMailTransport(): void {
  instance = undefined;
}
