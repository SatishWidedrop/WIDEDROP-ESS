import {
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import styles from './Field.module.css';

/**
 * Form fields.
 *
 * Every control is labelled by a real `<label>` and, when it has one, is
 * described by its error and hint through `aria-describedby`. An invalid field
 * carries `aria-invalid`, so it is announced as invalid rather than merely
 * outlined in red.
 */

interface FieldShellProps {
  label: string;
  /** Rendered beside the label, in the prototype's muted weight. */
  optional?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

function FieldShell({ label, optional, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {error ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'className'
> {
  label: string;
  optional?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextField({ label, optional, hint, error, ...rest }: TextFieldProps) {
  return (
    <FieldShell label={label} optional={optional} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          {...rest}
          id={id}
          className={`${styles.control} ${invalid ? styles.controlInvalid : ''}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  );
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'className'
> {
  label: string;
  optional?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

export function SelectField({ label, optional, hint, error, children, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} optional={optional} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select
          {...rest}
          id={id}
          className={`${styles.control} ${styles.select} ${invalid ? styles.controlInvalid : ''}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id' | 'className'
> {
  label: string;
  optional?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextAreaField({ label, optional, hint, error, ...rest }: TextAreaFieldProps) {
  return (
    <FieldShell label={label} optional={optional} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <textarea
          {...rest}
          id={id}
          className={`${styles.control} ${styles.textarea} ${invalid ? styles.controlInvalid : ''}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  );
}

/** A row of fields that wraps rather than overflowing on a narrow screen. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}

/** The whole-form error, distinct from a field's own. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className={styles.formError} role="alert">
      {message}
    </p>
  );
}
