import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../../lib/format';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** `drawer` slides in from the right; `modal` is centered. */
  variant?: 'drawer' | 'modal';
  labelledBy: string;
  children: ReactNode;
  className?: string;
}

/**
 * Native <dialog> wrapper: showModal() gives us focus trapping, Esc-to-close and an
 * inert background for free. Clicking the backdrop closes it.
 */
export function Dialog({
  open,
  onClose,
  variant = 'modal',
  labelledBy,
  children,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, styles[variant], className)}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && <div className={styles.body}>{children}</div>}
    </dialog>
  );
}
