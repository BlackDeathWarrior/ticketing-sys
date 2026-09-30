import { cx, slaLabel, slaState } from '../../lib/format';
import { Icon } from './Icon';
import styles from './SlaIndicator.module.css';

const stateText = {
  breached: 'SLA breached',
  'at-risk': 'SLA at risk',
  'on-track': 'SLA on track',
  done: 'SLA met',
} as const;

export function SlaIndicator({ minutes }: { minutes: number | null }) {
  const state = slaState(minutes);
  const icon = state === 'breached' ? 'alert' : state === 'done' ? 'check' : 'clock';
  return (
    <span className={cx(styles.sla, styles[state], 'tabular')} title={stateText[state]}>
      <Icon name={icon} size={14} />
      {slaLabel(minutes)}
      <span className="visually-hidden">({stateText[state]})</span>
    </span>
  );
}
