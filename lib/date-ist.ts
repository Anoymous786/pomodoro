/**
 * v5 — ALL user-facing date logic runs on India Standard Time
 * (Asia/Kolkata), independent of the device timezone. Keys are the same
 * "YYYY-MM-DD" shape the persisted history map already uses, so existing
 * data keeps working while every calculation becomes IST-stable around
 * midnight.
 */
const TZ = "Asia/Kolkata";

/** "YYYY-MM-DD" for RIGHT NOW in IST. */
export function istTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current hour (0-23) in IST. */
export function istHour(): number {
  const v = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return Number(v) % 24;
}

/** Shifts an IST "YYYY-MM-DD" key by N days (handles month/year rollover). */
export function shiftIST(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Short human label ("26 Aug") for an IST key. */
export function labelIST(dateKey: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
  }).format(new Date(`${dateKey}T00:00:00+05:30`));
}

/** "Wed, 26 Aug" for an IST key. */
export function labelLongIST(dateKey: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${dateKey}T00:00:00+05:30`));
}
