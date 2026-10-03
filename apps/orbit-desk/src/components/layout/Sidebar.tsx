import { useEffect } from 'react';
import { initials } from '../../data/adapters';
import { canOpenSettings } from '../../features/settings/logic';
import { views, type ViewId } from '../../data/views';
import { useSession } from '../../lib/session';
import { cx } from '../../lib/format';
import { hrefFor, type Route } from '../../lib/useHashRoute';
import { Avatar, Icon, type IconName } from '../ui';
import { Logo } from './Logo';
import styles from './Sidebar.module.css';

interface SidebarProps {
  route: Route;
  view: ViewId;
  onSelectView: (view: ViewId) => void;
  open: boolean;
  onClose: () => void;
  /** Ticket totals per view; undefined while loading. */
  counts: Partial<Record<ViewId, number>>;
  teams: Array<{ id: string; name: string; members: Array<{ id: string }> }>;
  /** Approvals waiting for a decision; undefined when the user can't approve. */
  pendingApprovals?: number;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Super admin',
  supervisor: 'Supervisor',
  team_lead: 'Team lead',
  agent: 'Agent',
};

export function Sidebar({
  route,
  view,
  onSelectView,
  open,
  onClose,
  counts,
  teams,
  pendingApprovals,
}: SidebarProps) {
  const { user, signOut, can } = useSession();
  const role = ROLE_LABELS[user.roles[0] ?? ''] ?? user.roles[0] ?? 'Agent';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const link = (target: Route, icon: IconName, label: string, count?: number) => (
    <a
      href={hrefFor(target)}
      className={cx(styles.item, route === target && styles.active)}
      aria-current={route === target ? 'page' : undefined}
      onClick={onClose}
    >
      <Icon name={icon} size={16} />
      <span className={styles.itemLabel}>{label}</span>
      {count !== undefined && <span className={cx(styles.count, 'tabular')}>{count}</span>}
    </a>
  );

  return (
    <>
      <div
        className={cx(styles.scrim, open && styles.scrimOpen)}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={cx(styles.sidebar, open && styles.open)} aria-label="Primary">
        <div className={styles.brand}>
          <Logo />
          <span className={styles.brandName}>Orbit Desk</span>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close navigation"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <nav className={styles.nav}>
          <div className={styles.group}>
            {link('dashboard', 'grid', 'Overview')}
            {can('kb:read') && link('kb', 'book', 'Knowledge base')}
            {pendingApprovals !== undefined &&
              link('approvals', 'check', 'Approvals', pendingApprovals)}
            {can('report:read') && link('reports', 'chart', 'Reports')}
            {can('learning:manage') && link('learning', 'target', 'Learning')}
          </div>

          <div className={styles.group}>
            <p className={styles.groupLabel}>Views</p>
            {views.map((v) => {
              const count = counts[v.id];
              const active = route === 'dashboard' && view === v.id;
              return (
                <a
                  key={v.id}
                  href="#/"
                  className={cx(styles.item, active && styles.activeView)}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    onSelectView(v.id);
                    onClose();
                  }}
                >
                  <Icon name={v.icon} size={16} />
                  <span className={styles.itemLabel}>{v.label}</span>
                  <span className={cx(styles.count, 'tabular')}>{count ?? '·'}</span>
                </a>
              );
            })}
          </div>

          <div className={styles.group}>
            <p className={styles.groupLabel}>Teams</p>
            {teams.map((team) => (
              <span
                key={team.id}
                className={cx(styles.item, styles.static)}
                title={`${team.members.length} members`}
              >
                <span className={styles.teamDot} aria-hidden="true" />
                <span className={styles.itemLabel}>{team.name}</span>
                <span className={cx(styles.count, 'tabular')}>{team.members.length}</span>
              </span>
            ))}
          </div>

          {canOpenSettings(can) && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Admin</p>
              {link('settings', 'settings', 'Settings')}
            </div>
          )}

          <div className={styles.group}>
            <p className={styles.groupLabel}>Design system</p>
            {link('elements', 'sparkle', 'Elements')}
          </div>
        </nav>

        <div className={styles.profile}>
          <Avatar initials={initials(user.name)} name={user.name} size={32} highlight />
          <div className={styles.profileText}>
            <span className={styles.profileName}>{user.name}</span>
            <span className={styles.profileMeta}>
              <span className={styles.online} aria-hidden="true" /> {role}
            </span>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Sign out"
            onClick={signOut}
          >
            <Icon name="logout" size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}
