import type { ReactNode } from 'react';
import styles from './ListDetail.module.css';

export function ListDetailSplit({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className={styles.split}>
      <div className={styles.list}>{list}</div>
      <div className={styles.detail}>{detail}</div>
    </div>
  );
}

export interface ListRowProps {
  title: string;
  meta?: string;
  value?: string;
  selected?: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}

export function ListRow({ title, meta, value, selected, onSelect, trailing }: ListRowProps) {
  return (
    <button
      type="button"
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onSelect}
      // Announces which record the detail pane is showing, so a screen reader
      // user is not left guessing what changed after a click.
      aria-current={selected ? 'true' : undefined}
    >
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{title}</span>
        {meta ? <span className={styles.rowMeta}>{meta}</span> : null}
      </span>
      {value ? <span className={styles.rowValue}>{value}</span> : null}
      {trailing}
    </button>
  );
}
