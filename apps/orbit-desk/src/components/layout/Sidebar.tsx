import { useEffect } from 'react';
import { agents, currentAgentId, tickets } from '../../data/mock';
import { views, type ViewId } from '../../data/views';
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
}

const teams = ['Tier 1', 'Tier 2', 'Billing', 'Platform'];

export function Sidebar({ route, view, onSelectView, open, onClose }: SidebarProps) {
  const me = agents.find((a) => a.id === currentAgentId)!;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const link = (target: Route, icon: IconName, label: string) => (
    <a
      href={hrefFor(target)}
      className={cx(styles.item, route === target && styles.active)}
      aria-current={route === target ? 'page' : undefined}
      onClick={onClose}
    >
      <Icon name={icon} size={16} />
      <span className={styles.itemLabel}>{label}</span>
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
          <div className={styles.group}>{link('dashboard', 'grid', 'Overview')}</div>

          <div className={styles.group}>
            <p className={styles.groupLabel}>Views</p>
            {views.map((v) => {
              const count = tickets.filter(v.match).length;
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
                  <span className={cx(styles.count, 'tabular')}>{count}</span>
                </a>
              );
            })}
          </div>

          <div className={styles.group}>
            <p className={styles.groupLabel}>Teams</p>
            {teams.map((team) => (
              <span key={team} className={cx(styles.item, styles.static)}>
                <span className={styles.teamDot} aria-hidden="true" />
                <span className={styles.itemLabel}>{team}</span>
                <span className={cx(styles.count, 'tabular')}>
                  {agents.filter((a) => a.team === team).length}
                </span>
              </span>
            ))}
          </div>

          <div className={styles.group}>
            <p className={styles.groupLabel}>Design system</p>
            {link('elements', 'sparkle', 'Elements')}
          </div>
        </nav>

        <div className={styles.profile}>
          <Avatar initials={me.initials} name={me.name} size={32} highlight />
          <div className={styles.profileText}>
            <span className={styles.profileName}>{me.name}</span>
            <span className={styles.profileMeta}>
              <span className={styles.online} aria-hidden="true" /> Available · {me.team}
            </span>
          </div>
          <button type="button" className={styles.iconButton} aria-label="Settings">
            <Icon name="settings" size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}
