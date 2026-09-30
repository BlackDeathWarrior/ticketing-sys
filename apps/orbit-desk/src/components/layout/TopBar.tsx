import { forwardRef } from 'react';
import { Button, Icon, SearchField } from '../ui';
import { NotificationBell, PresenceSwitch } from './Notifications';
import styles from './TopBar.module.css';

interface TopBarProps {
  title: string;
  search: string;
  onSearch: (value: string) => void;
  onOpenMenu: () => void;
  onNewTicket: () => void;
  /** Opens a ticket from a notification. */
  onOpenTicket: (ticketId: string) => void;
  showSearch?: boolean;
}

/** Floating nav pill (DESIGN.md › Navigation Pill), sticky at the top of the content column. */
export const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(
  { title, search, onSearch, onOpenMenu, onNewTicket, onOpenTicket, showSearch = true },
  searchRef,
) {
  return (
    <div className={styles.wrap}>
      <div className={styles.pill}>
        <button
          type="button"
          className={styles.menu}
          onClick={onOpenMenu}
          aria-label="Open navigation"
        >
          <Icon name="menu" size={18} />
        </button>
        <span className={styles.title}>{title}</span>
        {showSearch && (
          <div className={styles.search} role="search">
            <label htmlFor="global-search" className="visually-hidden">
              Search tickets
            </label>
            <SearchField
              id="global-search"
              ref={searchRef}
              placeholder="Search subject or TMS number…"
              shortcut="/"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onSearch('');
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
        <div className={styles.actions}>
          <PresenceSwitch />
          <NotificationBell onOpenTicket={onOpenTicket} />
          <Button variant="primary" icon="plus" onClick={onNewTicket} className={styles.cta}>
            New ticket
          </Button>
        </div>
      </div>
    </div>
  );
});
