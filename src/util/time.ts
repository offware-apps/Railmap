/** Time helpers. All "times" are minutes from local midnight unless noted. */

/** Parse "HH:MM" or "HH:MM:SS" into minutes from midnight. NaN if unparseable. */
export function parseTimeToMinutes(t: string | undefined | null): number {
  if (!t) return NaN;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t).trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN; // reject malformed times (24:00, 12:60, …)
  return h * 60 + min;
}

/** Minutes from midnight -> "HH:MM" (wraps a day so 1490 -> "00:50"). */
export function minutesToHHMM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Days since the Unix epoch for a "YYYY-MM-DD" date (UTC, stable). */
export function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/** "YYYY-MM-DD" shifted by `n` days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Absolute minute on a continuous timeline across dates. */
export function absoluteMinute(date: string, minutesFromMidnight: number): number {
  return dayIndex(date) * 1440 + minutesFromMidnight;
}
