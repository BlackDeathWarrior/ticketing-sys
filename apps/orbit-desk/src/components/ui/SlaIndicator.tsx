import { cx, slaLabel, type SlaState, slaState } from '../../lib/format';
import { Icon } from './Icon';
import styles from './SlaIndicator.module.css';

const stateText = {
  breached: 'SLA breached',
  'at-risk': 'SLA at risk',
  'on-track': 'SLA on track',
  done: 'SLA met',
} as const;

/**
 * Time left on an SLA target. `state` comes from the server when known (it
 * counts business hours and the 80% at-risk line); otherwise it is guessed
 * from the minutes.
 */
export function SlaIndicator({
  minutes,
  state: given,
  label,
}: {
  minutes: number | null;
  state?: SlaState;
  label?: string;
}) {
  const state = given ?? slaState(minutes);
  const icon = state === 'breached' ? 'alert' : state === 'done' ? 'check' : 'clock';
  return (
    <span className={cx(styles.sla, styles[state], 'tabular')} title={stateText[state]}>
      <Icon name={icon} size={14} />
      {label ?? slaLabel(minutes)}
      <span className="visually-hidden">({stateText[state]})</span>
    </span>
  );
}
