/** Midnight in Vienna of a YYYY-MM-DD day, as a Date. */
function viennaMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  // the offset of Vienna on that day (CET +1, CEST +2)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vienna',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utc + 12 * 3600_000));
  const hour = Number(parts.find((x) => x.type === 'hour')?.value ?? 13);
  return new Date(utc - (hour - 12) * 3600_000);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(d);

/**
 * The period of the affiliate page and export: both days included; default the last month.
 * `to` of the result is exclusive (midnight after the last day).
 */
export function periodOf(fromQ: string | null | undefined, toQ: string | null | undefined) {
  const today = isoDay(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  const lastMonth = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
  const lastDay = new Date(Date.UTC(y, m - 1, 0));
  let fromDay = fromQ && DAY.test(fromQ) ? fromQ : lastMonth.toISOString().slice(0, 10);
  let toDay = toQ && DAY.test(toQ) ? toQ : lastDay.toISOString().slice(0, 10);
  if (toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  const [ty, tm, td] = toDay.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  return { fromDay, toDay, from: viennaMidnight(fromDay), to: viennaMidnight(next) };
}
