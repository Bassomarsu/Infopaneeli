import { config } from "./config.ts";

const TZ = config.timezone;

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Everything date-related is computed in Europe/Helsinki rather than UTC.
 * Getting this wrong would shift the schedule rollover by an hour twice a year,
 * which is exactly the kind of bug nobody notices until a March morning.
 */
export function localDateKey(date: Date = new Date()): string {
  return dateKeyFormatter.format(date);
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(date: Date = new Date()): LocalParts {
  const parts = partsFormatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
  };
}

/** Minutes since local midnight — used for the schedule rollover comparison. */
export function localMinutesOfDay(date: Date = new Date()): number {
  const { hour, minute } = localParts(date);
  return hour * 60 + minute;
}

/** Shifts a YYYY-MM-DD key by whole days without touching time zones. */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD key. */
export function dayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

export function isWeekend(dateKey: string): boolean {
  const day = dayOfWeek(dateKey);
  return day === 0 || day === 6;
}

/** Wilma wants dates as d.M.yyyy. */
export function toFinnishDate(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

/** Parses "HH:MM" into minutes since midnight; null when malformed. */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
