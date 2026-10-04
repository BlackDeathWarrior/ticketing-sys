/** Calls the desk places are held to these hours when the switch in Settings is on. */
const OPENS = 9;
const CLOSES = 21;

/** True from 09:00 up to, not including, 21:00 India time. */
export function withinCallingHours(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  );
  return hour >= OPENS && hour < CLOSES;
}
