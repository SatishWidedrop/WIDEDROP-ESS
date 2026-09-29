import { departmentColor } from '@widedrop/shared';
import styles from './Avatar.module.css';

export interface AvatarProps {
  /** Server-derived. The client never splits a name to guess them. */
  initials: string;
  /** Tints the avatar by department, deterministically. */
  department?: string | null;
  /** A stored photo. Absent, the initials show — never a stock silhouette. */
  photoUrl?: string | null;
  name?: string;
  size?: number;
}

export function Avatar({ initials, department, photoUrl, name, size = 36 }: AvatarProps) {
  const background = departmentColor(department);
  const fontSize = Math.max(10, Math.round(size * 0.34));

  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background, fontSize }}
      title={name}
      aria-hidden={name ? undefined : true}
      role={name ? 'img' : undefined}
      aria-label={name}
    >
      {photoUrl ? (
        <img className={styles.image} src={photoUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        initials
      )}
    </span>
  );
}
