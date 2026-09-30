import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../../lib/format';
import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import styles from './Input.module.css';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: IconName;
  shortcut?: string;
  label?: string;
  hint?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, shortcut, label, hint, className, wrapperClassName, id, ...rest },
  ref,
) {
  const field = (
    <span className={cx(styles.field, wrapperClassName)}>
      {icon && <Icon name={icon} size={16} className={styles.icon} />}
      <input
        ref={ref}
        id={id}
        className={cx(styles.input, icon && styles.withIcon, className)}
        {...rest}
      />
      {shortcut && <Kbd className={styles.kbd}>{shortcut}</Kbd>}
    </span>
  );

  if (!label) return field;
  return (
    <label className={styles.group} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      {field}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
});

export const SearchField = forwardRef<HTMLInputElement, Omit<InputProps, 'icon' | 'type'>>(
  function SearchField(props, ref) {
    return (
      <Input
        ref={ref}
        icon="search"
        type="search"
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
    );
  },
);

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className, id, ...rest },
  ref,
) {
  const field = (
    <textarea
      ref={ref}
      id={id}
      className={cx(styles.input, styles.textarea, className)}
      {...rest}
    />
  );
  if (!label) return field;
  return (
    <label className={styles.group} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      {field}
    </label>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
  hideLabel?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, hideLabel, className, id, ...rest },
  ref,
) {
  return (
    <label className={styles.group} htmlFor={id}>
      {label && <span className={hideLabel ? 'visually-hidden' : styles.label}>{label}</span>}
      <span className={styles.field}>
        <select ref={ref} id={id} className={cx(styles.input, styles.select, className)} {...rest}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} className={styles.chevron} />
      </span>
    </label>
  );
});
