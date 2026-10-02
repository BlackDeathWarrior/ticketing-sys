import { Button, Icon } from '../ui';
import { NotificationBell, PresenceSwitch } from './Notifications';
import styles from './TopBar.module.css';

interface TopBarProps {
  title: string;
  onOpenMenu: () => void;
  onNewTicket: () => void;
  /** Opens a ticket from a notification. */
  onOpenTicket: (ticketId: string) => void;
}

/**
 * Floating nav pill (DESIGN.md › Navigation Pill), sticky at the top of the
 * content column. Ticket search lives in the tickets card it filters.
 */
export function TopBar({ title, onOpenMenu, onNewTicket, onOpenTicket }: TopBarProps) {
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
}
