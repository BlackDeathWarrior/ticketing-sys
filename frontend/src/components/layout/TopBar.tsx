import { forwardRef } from 'react';
import { Button, Icon, SearchField } from '../ui';
import styles from './TopBar.module.css';

interface TopBarProps {
  title: string;
  search: string;
  onSearch: (value: string) => void;
  onOpenMenu: () => void;
  onNewTicket: () => void;
  showSearch?: boolean;
}

/** Floating nav pill (DESIGN.md › Navigation Pill), sticky at the top of the content column. */
export const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(
  { title, search, onSearch, onOpenMenu, onNewTicket, showSearch = true },
  searchRef,
) {
  return (
    <div className={styles.wrap}>
      <div className={styles.pill}>
        <button type="button" className={styles.menu} onClick={onOpenMenu} aria-label="Open navigation">
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
              placeholder="Search tickets, customers, tags…"
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
          <button type="button" className={styles.iconButton} aria-label="Notifications, 3 unread">
            <Icon name="bell" size={18} />
            <span className={styles.dot} aria-hidden="true" />
          </button>
          <Button variant="primary" icon="plus" onClick={onNewTicket} className={styles.cta}>
            New ticket
          </Button>
        </div>
      </div>
    </div>
  );
});
