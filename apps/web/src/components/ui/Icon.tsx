import { ICON_PATHS, type IconName } from '@widedrop/shared';

/**
 * The prototype's icon set: 24×24 stroke outlines, 1.7 stroke, round caps.
 *
 * Rendered from shared path data rather than an icon font or a sprite sheet, so
 * there is one definition and no extra request.
 */
export interface IconProps {
  name: IconName;
  size?: number;
  /** Defaults to the surrounding text colour. */
  color?: string;
  className?: string;
  /** A label makes the icon meaningful to assistive technology; without one it
   *  is decorative and hidden, which is correct beside a visible text label. */
  label?: string;
}

export function Icon({ name, size = 20, color = 'currentColor', className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
