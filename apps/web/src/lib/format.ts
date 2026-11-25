type DateInput = Date | string | number;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const STEPS: [limit: number, size: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [HOUR, MINUTE, "minute"],
  [DAY, HOUR, "hour"],
  [7 * DAY, DAY, "day"],
  [30 * DAY, 7 * DAY, "week"],
  [365 * DAY, 30 * DAY, "month"],
  [Infinity, 365 * DAY, "year"],
];

// "just now", "4 minutes ago", "yesterday", "in 5 days". A past time rounds down. A future time rounds to the nearest
// unit, so a 7-day invite reads "in 7 days" a moment after it is sent.
export function formatRelative(value: DateInput, now = Date.now()): string {
  const delta = new Date(value).getTime() - now;
  // Rounding a future delta can reach the next unit, such as 59.9 minutes, so it is rounded to the minute first.
  const distance = delta > 0 ? Math.round(delta / MINUTE) * MINUTE : -delta;
  if (distance < MINUTE) return "just now";
  // Expiries count days up to a month, so "in 13 days" rather than "in 2 weeks".
  const [, size, unit] =
    delta > 0 && distance >= DAY && distance < 30 * DAY
      ? ([0, DAY, "day"] as const)
      : STEPS.find(([limit]) => distance < limit)!;
  return delta > 0
    ? relative.format(Math.round(distance / size), unit)
    : relative.format(-Math.floor(distance / size), unit);
}

export function formatDate(value: DateInput): string {
  return date.format(new Date(value));
}

export function formatDateTime(value: DateInput): string {
  return dateTime.format(new Date(value));
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// Decimal units, like Docker's: 4.8 MB, 412 MB, 1.2 GB.
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  // 999.5 would round to "1000".
  while (value >= 999.5 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit > 0 && value < 99.95 ? 1 : 0;
  return `${Number(value.toFixed(digits))} ${SIZE_UNITS[unit]}`;
}

// sha256:1a2b3c4d…
export function shortDigest(digest: string): string {
  const [algorithm, hex = ""] = digest.split(":");
  return `${algorithm}:${hex.slice(0, 8)}…`;
}
