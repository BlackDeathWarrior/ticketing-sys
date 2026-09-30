import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../lib/format';
import { Icon, type IconName } from './Icon';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Trailing icon; `link` buttons default to a chevron. */
  trailingIcon?: IconName;
  iconOnly?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, iconOnly, className, children, type = 'button', ...rest },
  ref,
) {
  const trailing = trailingIcon ?? (variant === 'link' ? 'chevronRight' : undefined);
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], iconOnly && styles.iconOnly, className)}
      {...rest}
    >
      {icon && <Icon name={icon} size={iconSize} />}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
      {trailing && !iconOnly && <Icon name={trailing} size={iconSize} className={styles.trailing} />}
    </button>
  );
});
