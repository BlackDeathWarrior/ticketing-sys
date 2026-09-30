import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/format';
import { Icon, type IconName } from './Icon';
import styles from './Badge.module.css';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** `ai` = the violet-rimmed highlight pill; `neutral` = quiet tag. */
  tone?: 'ai' | 'neutral';
  icon?: IconName;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], className)} {...rest}>
      {icon && <Icon name={icon} size={14} className={styles.icon} />}
      {children}
    </span>
  );
}
