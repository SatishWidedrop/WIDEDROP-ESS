import { z } from 'zod';
import { email, freeText, safeString } from './common.js';

/**
 * Authentication request and response shapes, shared by the API and the web app
 * so a form cannot validate against different rules than the server applies.
 */

export const loginRequest = z
  .object({
    email,
    // Not length-bounded at the low end: telling someone their password is too
    // short to be right is telling them something about the password.
    password: z.string().min(1).max(256),
    /** A name for this device, shown in the user's session list. */
    deviceLabel: safeString(1, 60).optional(),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequest>;

export const mfaVerifyRequest = z
  .object({
    challengeId: z.string().min(16).max(128),
    /** A six-digit authenticator code, or a recovery code. */
    code: z.string().trim().min(6).max(32),
  })
  .strict();

export const mfaEnrolConfirmRequest = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the six-digit code from your app'),
  })
  .strict();

export const passwordChangeRequest = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(128),
  })
  .strict();

export const passwordResetRequest = z.object({ email }).strict();

export const passwordResetConfirmRequest = z
  .object({
    token: z.string().min(32).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();

export const invitationAcceptRequest = z
  .object({
    token: z.string().min(32).max(128),
    password: z.string().min(12).max(128),
  })
  .strict();

export const revokeSessionRequest = z.object({ familyId: z.string().uuid() }).strict();

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a sign-in returns.
 *
 * The refresh token is not here: it goes into an httpOnly cookie the page
 * cannot read. The access token is returned in the body and held in memory, so
 * it is never attached automatically to a cross-site request.
 */
export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  csrfToken: string;
  user: {
    id: string;
    email: string;
    employeeId: string | null;
    displayName: string;
    initials: string;
    employeeNumber: string | null;
    personas: string[];
    mustChangePassword: boolean;
    mfaEnrolled: boolean;
  };
}

/** Returned when a second factor is needed before a session is issued. */
export interface MfaChallengeResponse {
  status: 'mfa-required';
  challengeId: string;
  expiresIn: number;
  /** True when the user must enrol first, rather than enter a code. */
  enrolmentRequired: boolean;
}

export interface MfaEnrolmentResponse {
  /** Shown as a QR code. Contains the secret, so it is returned once. */
  otpauthUri: string;
  /** For manual entry where a camera is not available. */
  secret: string;
}

export interface RecoveryCodesResponse {
  /** Shown once. Only hashes are stored; the server cannot show them again. */
  codes: string[];
}

export const helpdeskTicketRequest = z
  .object({
    categoryCode: safeString(2, 40),
    subject: safeString(3, 150),
    description: freeText(5_000),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    fileObjectIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .strict();

export type HelpdeskTicketRequest = z.infer<typeof helpdeskTicketRequest>;
