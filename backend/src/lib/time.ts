/**
 * Day boundaries in the shop's timezone, not the server's.
 *
 * The API is meant to run on Railway, whose containers are UTC, while the shops
 * are UTC+2. Using the server clock would put every sale after 22:00 Lusaka on
 * the following day's report — so the reporting day is defined explicitly by
 * `REPORT_TIMEZONE` and computed with Intl rather than the process locale.
 */

/** How far the zone is ahead of UTC, in minutes, at a given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  // `hour: '2-digit'` with hour12:false yields 24 for midnight in some ICU
  // versions; normalise so Date.UTC doesn't roll the day forward.
  const hour = read('hour') % 24;

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second')
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/** `YYYY-MM-DD` for the calendar date an instant falls on in `timeZone`. */
export function dateKeyIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** Splits `YYYY-MM-DD` into its three numbers, rejecting anything else. */
function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`Invalid date key: ${dateKey}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The UTC instant at which `YYYY-MM-DD` begins in `timeZone`. */
export function startOfDayIn(dateKey: string, timeZone: string): Date {
  const { year, month, day } = parseDateKey(dateKey);

  // Start from the wall-clock time treated as UTC, then subtract the zone's
  // offset at that moment. Zambia has no DST; for zones that do, the offset is
  // read at the guessed instant, which is correct outside the switch hour.
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  return new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000);
}

/** Half-open `[start, end)` covering one calendar day in `timeZone`. */
export function dayRangeIn(dateKey: string, timeZone: string): { start: Date; end: Date } {
  return { start: startOfDayIn(dateKey, timeZone), end: startOfDayIn(nextDateKey(dateKey), timeZone) };
}

/** The date key for the day after `dateKey`. Midday avoids any rollover doubt. */
export function nextDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return dateKeyIn(new Date(Date.UTC(year, month - 1, day + 1, 12)), 'UTC');
}

/** The date key for the day before `dateKey`. */
export function previousDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return dateKeyIn(new Date(Date.UTC(year, month - 1, day - 1, 12)), 'UTC');
}

/** The date key `n` days after `dateKey`; negative `n` goes back. */
export function shiftDateKey(dateKey: string, n: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  return dateKeyIn(new Date(Date.UTC(year, month - 1, day + n, 12)), 'UTC');
}

export const REPORT_PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/**
 * The first date of the *calendar* period `instant` falls in.
 *
 * Calendar, not trailing: "this month" means the 1st onwards, not the last 30
 * days. A shopkeeper comparing the app against their own book is counting from
 * the 1st, and a trailing window silently moves its own start every morning,
 * so two people reading the same screen an hour apart can disagree.
 *
 * The week starts on Monday.
 */
export function periodStartKey(
  period: ReportPeriod,
  timeZone: string,
  instant: Date = new Date()
): string {
  const todayKey = dateKeyIn(instant, timeZone);
  const { year, month, day } = parseDateKey(todayKey);
  const pad = (n: number) => String(n).padStart(2, '0');

  switch (period) {
    case 'daily':
      return todayKey;
    case 'weekly': {
      // getUTCDay is 0 for Sunday, so Sunday sits at the end of its week.
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      return shiftDateKey(todayKey, -((weekday + 6) % 7));
    }
    case 'monthly':
      return `${year}-${pad(month)}-01`;
    case 'quarterly':
      return `${year}-${pad(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
    case 'yearly':
      return `${year}-01-01`;
  }
}

/** The instant a calendar period began, for use as a query lower bound. */
export function periodStartIn(
  period: ReportPeriod,
  timeZone: string,
  instant: Date = new Date()
): Date {
  return startOfDayIn(periodStartKey(period, timeZone, instant), timeZone);
}
