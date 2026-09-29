import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/queryKeys.js';
import { Avatar } from '../components/ui/Avatar.js';
import { Icon } from '../components/ui/Icon.js';
import { useCurrentUser } from './AuthProvider.js';
import { useShellLayout } from './ShellLayoutContext.js';
import styles from './Toolbar.module.css';

/**
 * The top bar: search, notifications and the account avatar.
 *
 * The notification dot appears only when the server reports unread items. It
 * is never shown speculatively — a dot that means nothing teaches people to
 * ignore the one that does.
 */
export function Toolbar() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const { compact } = useShellLayout();

  const { data: unread } = useQuery({
    queryKey: queryKeys.notifications(true),
    queryFn: () => api.get<{ unread: number }>('/api/v1/notifications/unread-count'),
    retry: false,
    staleTime: 30_000,
  });

  const hasUnread = (unread?.unread ?? 0) > 0;

  return (
    <div className={styles.toolbar}>
      {/*
        The compact header has room for a title and two controls. A search field
        squeezed in beside them is too narrow to type into, so it is dropped —
        the prototype does the same.
      */}
      {!compact ? (
        <>
          <div className={styles.search}>
            <Icon name="search" size={16} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              type="search"
              placeholder="Search people, policies, payslips"
              aria-label="Search"
              role="combobox"
              aria-expanded={false}
              aria-autocomplete="list"
            />
          </div>
          <div className={styles.spacer} />
        </>
      ) : null}

      <button
        type="button"
        className={styles.iconButton}
        aria-label={
          hasUnread ? `Notifications, ${unread?.unread} unread` : 'Notifications, none unread'
        }
      >
        <Icon name="bell" size={18} />
        {hasUnread ? <span className={styles.unreadDot} aria-hidden="true" /> : null}
      </button>

      <button
        type="button"
        className={styles.avatarButton}
        onClick={() => navigate('/profile')}
        aria-label="My profile"
      >
        <Avatar
          initials={user.initials}
          department={user.department}
          name={user.displayName}
          size={40}
        />
      </button>
    </div>
  );
}
