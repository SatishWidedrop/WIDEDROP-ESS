import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}

export function Skeleton({ width = '100%', height = '1em', radius, className }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${className ?? ''}`}
      style={{ display: 'block', width, height, ...(radius ? { borderRadius: radius } : {}) }}
      aria-hidden="true"
    />
  );
}

/** Several lines, for a paragraph or a list that is still loading. */
export function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <div className={styles.stack} role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          className={styles.text}
          // The last line is short, the way a real paragraph ends.
          width={index === count - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  );
}
