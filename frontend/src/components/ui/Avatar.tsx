import { cx } from '../../lib/format';
import styles from './Avatar.module.css';

interface AvatarProps {
  initials: string;
  name?: string;
  size?: 20 | 24 | 28 | 32 | 40;
  /** Accent ring — used for the signed-in agent and the AI assistant. */
  highlight?: boolean;
  className?: string;
}

/** Deterministic lightness step so avatars differ without introducing new hues. */
function tint(initials: string) {
  const n = [...initials].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return n % 4;
}

export function Avatar({ initials, name, size = 28, highlight, className }: AvatarProps) {
  return (
    <span
      className={cx(styles.avatar, styles[`tint${tint(initials)}`], highlight && styles.highlight, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      title={name}
    >
      {initials}
    </span>
  );
}

interface AvatarGroupProps {
  people: { initials: string; name: string }[];
  max?: number;
  size?: AvatarProps['size'];
}

export function AvatarGroup({ people, max = 4, size = 28 }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={styles.group}>
      {shown.map((p) => (
        <Avatar key={p.name} initials={p.initials} name={p.name} size={size} className={styles.stacked} />
      ))}
      {rest > 0 && (
        <span className={cx(styles.avatar, styles.more, styles.stacked)} style={{ width: size, height: size, fontSize: 11 }}>
          +{rest}
        </span>
      )}
    </span>
  );
}
