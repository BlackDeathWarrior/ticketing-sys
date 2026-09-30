import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/format';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'article' | 'div' | 'aside';
  /** `raised` swaps to the brighter rim glow for focal panels. */
  tone?: 'default' | 'raised' | 'flat';
  padding?: 'none' | 'md' | 'lg';
  children: ReactNode;
}

export function Card({
  as: Tag = 'section',
  tone = 'default',
  padding = 'md',
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag className={cx(styles.card, styles[tone], styles[`pad-${padding}`], className)} {...rest}>
      {children}
    </Tag>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  id?: string;
}

export function CardHeader({ title, subtitle, actions, id }: CardHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.headings}>
        <h2 className={styles.title} id={id}>
          {title}
        </h2>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
