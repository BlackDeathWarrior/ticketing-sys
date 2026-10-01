import { useState } from 'react';
import { Button } from '../../components/ui';
import settings from '../settings/Settings.module.css';
import styles from './Integrations.module.css';

/** The one time a generated secret (an API key, a webhook signing secret) is on screen. */
export function SecretOnce({
  title,
  label,
  value,
  testId,
  onDone,
}: {
  title: string;
  /** For screen readers, e.g. "New API key". */
  label: string;
  value: string;
  testId: string;
  onDone: () => void;
}) {
  const [note, setNote] = useState('Copy it now. It will not be shown again.');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setNote('Copied. Store it where the app keeps its secrets.');
    } catch {
      setNote('Select it and copy it by hand.');
    }
  };
  return (
    <div className={settings.banner} role="status" aria-label={label}>
      <div>
        <div>{title}</div>
        <div className={settings.keyState}>{note}</div>
      </div>
      <div className={styles.keyBox}>
        <code className={styles.keyValue} data-testid={testId}>
          {value}
        </code>
        <div className={settings.actions}>
          <Button size="sm" onClick={() => void copy()}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
