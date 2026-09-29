import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import type { IconName } from '@widedrop/shared';
import styles from './Button.module.css';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  icon?: IconName;
  /** Shows a spinner and blocks further clicks while a mutation is in flight. */
  busy?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'medium',
    icon,
    busy = false,
    fullWidth = false,
    type = 'button',
    disabled,
    children,
    className,
    ...rest
  },
  ref,
) {
  const classes = [
    styles.button,
    styles[variant],
    size !== 'medium' ? styles[size] : '',
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || busy}
      // Announces the busy state rather than only showing it, so a screen
      // reader user knows the click registered.
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={size === 'small' ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
});
