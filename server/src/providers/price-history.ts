import { logger } from "../core/logging.ts";
import { readCache, writeCache } from "../core/store.ts";
import { localDateKey, localParts } from "../core/time.ts";

/**
 * Elering (the Estonian TSO) republishes Nord Pool day-ahead prices for all
 * four Baltic/Finnish bidding zones, with no API key and no registration, and
 * — unlike api.porssisahko.net — accepts an arbitrary date range, so a whole
 * month comes back in a single request. That is what makes a monthly average
 * practical here; porssisahko.net only ever exposes a rolling ~48h window.
 */
const ELERING_URL = "https://dashboard.elering.ee/api/nps/price";

const CACHE_ID = "electricity-history";

/**
 * Finland's standard VAT rate went from 24 % to 25.5 % on 1 September 2024,
 * and Elering's prices are EUR/MWh excluding VAT. Verified empirically by
 * comparing api.porssisahko.net (snt/kWh, VAT included) against Elering's `fi`
 * series for the same hours: the ratio was 1.255 across dozens of samples
 * (see the PR/task notes). If VAT changes again this constant must move with
 * it — a silently wrong ratio here would look plausible and be wrong, which is
 * worse than an outage.
 */
const VAT_MULTIPLIER = 1.255;

/** 1 EUR/MWh = 100 snt / 1000 kWh = 0.1 snt/kWh. */
const EUR_PER_MWH_TO_SNT_PER_KWH = 0.1;

interface EleringQuote {
  /** Unix seconds. */
  timestamp: number;
  /** EUR/MWh, VAT excluded. */
  price: number;
}

interface EleringResponse {
  success: boolean;
  data: Record<string, EleringQuote[]>;
}

export interface MonthAverage {
  /** "2026-08" */
  month: string;
  /** Ready-made Finnish label, e.g. "Elokuu 2026". */
  label: string;
  average: number | null;
  /** How many hours actually went into the average — a partial month is normal, not an error. */
  knownHours: number;
  expectedHours: number;
}

interface HistoryCache {
  currentMonth: MonthAverage;
  previousMonth: MonthAverage;
}

const MONTH_NAMES = [
  "Tammikuu",
  "Helmikuu",
  "Maaliskuu",
  "Huhtikuu",
  "Toukokuu",
  "Kesäkuu",
  "Heinäkuu",
  "Elokuu",
  "Syyskuu",
  "Lokakuu",
  "Marraskuu",
  "Joulukuu",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthKeyOf(year: number, month1: number): string {
  return `${year}-${pad2(month1)}`;
}

function parseMonthKey(key: string): { year: number; month: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y ?? 1970, month: m ?? 1 };
}

/** Shifts a "YYYY-MM" key by whole months, across year boundaries. */
export function shiftMonthKey(key: string, delta: number): string {
  const { year, month } = parseMonthKey(key);
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return monthKeyOf(y, m);
}

function labelFor(key: string): string {
  const { year, month } = parseMonthKey(key);
  return `${MONTH_NAMES[month - 1] ?? "?"} ${year}`;
}

/**
 * How many real hours a month is expected to have data for by now, found by
 * walking actual UTC hours rather than assuming 24 hours/day. Calendar
 * arithmetic gets this wrong on a DST-transition month: Europe/Helsinki loses
 * an hour at the end of March (the local 03:00-03:59 slot does not exist) and
 * gains one at the end of October (local 03:00-03:59 happens twice), so a
 * "days * 24" formula is off by one for both. Walking real hours and
 * classifying each by its local calendar month self-corrects for that without
 * any special-casing. A past month counts every real hour in it; the current
 * month stops at the hour that just started, since that is the last one the
 * day-ahead market has already published a price for.
 */
export function expectedHoursFor(monthKey: string, isCurrentMonth: boolean, now: Date = new Date()): number {
  const { year, month } = parseMonthKey(monthKey);
  // Scan a day of padding on each side, same margin as the Elering query uses.
  const scanStart = Date.UTC(year, month - 1, 1) - 24 * 3_600_000;
  const scanEnd = Date.UTC(year, month, 1) + 24 * 3_600_000;
  const nowMs = now.getTime();

  let count = 0;
  for (let hourStart = scanStart; hourStart < scanEnd; hourStart += 3_600_000) {
    const local = localParts(new Date(hourStart));
    if (monthKeyOf(local.year, local.month) !== monthKey) continue;
    if (isCurrentMonth && hourStart > nowMs) continue;
    count += 1;
  }
  return count;
}

function isComplete(m: MonthAverage): boolean {
  return m.average !== null && m.expectedHours > 0 && m.knownHours >= m.expectedHours;
}

/**
 * Pure aggregation, kept separate from the network call so it can be tested
 * without hitting Elering. Groups raw quotes into local Europe/Helsinki hours
 * — needed because the source can be hourly or 15-minute resolution depending
 * on the period (Nord Pool moved FI to 15-minute settlement in late 2025) —
 * then averages the per-hour prices rather than the raw ticks, so a
 * higher-resolution period does not get a different weight than an
 * hourly-resolution one.
 */
export function aggregateMonth(
  quotes: EleringQuote[],
  monthKey: string,
  isCurrentMonth: boolean,
  now: Date = new Date(),
): MonthAverage {
  // Keyed by real UTC hour (hours since epoch), not the local wall-clock hour.
  // A wall-clock key collides on the October DST fall-back, where local 03:00
  // happens twice in one night — two different real hours, each with its own
  // price, would silently average into a single bucket and one hour of data
  // would vanish without the hour counts ever looking wrong.
  const hourBuckets = new Map<number, { sum: number; count: number }>();

  // The day-ahead market publishes tomorrow's prices during the afternoon, so
  // the response for the current month carries hours that have not happened
  // yet. They do not belong in "the average so far": counting them produced
  // more known hours than the month has elapsed, and the coverage read as an
  // impossible 169/153.
  const nowHourBucket = isCurrentMonth ? Math.floor(now.getTime() / 3_600_000) : null;

  for (const q of quotes) {
    const local = localParts(new Date(q.timestamp * 1000));
    if (monthKeyOf(local.year, local.month) !== monthKey) continue; // margin from the padded query range
    const hourBucket = Math.floor(q.timestamp / 3600);
    if (nowHourBucket !== null && hourBucket > nowHourBucket) continue;
    const bucket = hourBuckets.get(hourBucket) ?? { sum: 0, count: 0 };
    bucket.sum += q.price;
    bucket.count += 1;
    hourBuckets.set(hourBucket, bucket);
  }

  const hourlyPrices = Array.from(hourBuckets.values()).map(
    (b) => (b.sum / b.count) * EUR_PER_MWH_TO_SNT_PER_KWH * VAT_MULTIPLIER,
  );

  const knownHours = hourlyPrices.length;
  const average = knownHours === 0 ? null : hourlyPrices.reduce((sum, p) => sum + p, 0) / knownHours;

  return {
    month: monthKey,
    label: labelFor(monthKey),
    average,
    knownHours,
    expectedHours: expectedHoursFor(monthKey, isCurrentMonth, now),
  };
}

async function fetchMonthAverage(monthKey: string, isCurrentMonth: boolean): Promise<MonthAverage> {
  const { year, month } = parseMonthKey(monthKey);
  // Padded by a day on each side: the query is expressed in UTC, and this
  // keeps the whole local Europe/Helsinki month inside the window regardless
  // of the UTC offset. aggregateMonth() filters the padding back out.
  const start = new Date(Date.UTC(year, month - 1, 1));
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(Date.UTC(year, month, 1));
  end.setUTCDate(end.getUTCDate() + 1);

  const url = `${ELERING_URL}?start=${start.toISOString()}&end=${end.toISOString()}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Elering returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as EleringResponse;
  const quotes = body.data?.fi;
  if (!Array.isArray(quotes)) {
    throw new Error("Elering response is missing the fi price series");
  }

  return aggregateMonth(quotes, monthKey, isCurrentMonth);
}

/** Only the OK <-> FAILED edge is logged, matching the Provider class's policy elsewhere. */
let historyHealthy = true;

/**
 * Returns the current/previous month averages, fetching from Elering at most
 * once per local calendar day and otherwise reading the cache written by a
 * previous call. Never throws: on failure it falls back to the last cached
 * result, and only returns null if nothing has ever been fetched
 * successfully — the electricity card must keep working without it.
 */
export async function getMonthlyAverages(): Promise<{ currentMonth: MonthAverage; previousMonth: MonthAverage } | null> {
  const cached = readCache<HistoryCache>(CACHE_ID);
  const today = localDateKey();
  const dueForRefresh = !cached || localDateKey(new Date(cached.fetchedAt)) !== today;

  if (!dueForRefresh) return cached ? cached.data : null;

  const nowParts = localParts();
  const currentKey = monthKeyOf(nowParts.year, nowParts.month);
  const previousKey = shiftMonthKey(currentKey, -1);

  try {
    let previousMonth: MonthAverage;
    if (cached?.data.previousMonth.month === previousKey && isComplete(cached.data.previousMonth)) {
      // A completed month cannot change any more — re-fetching it daily would
      // just be load on Elering for no reason.
      previousMonth = cached.data.previousMonth;
    } else if (cached?.data.currentMonth.month === previousKey && isComplete(cached.data.currentMonth)) {
      // The calendar just rolled over and yesterday's "current month" was
      // already complete — reuse it instead of asking Elering again.
      previousMonth = cached.data.currentMonth;
    } else {
      previousMonth = await fetchMonthAverage(previousKey, false);
    }

    // The current month is always still growing, so it is refetched every
    // time a refresh is due.
    const currentMonth = await fetchMonthAverage(currentKey, true);

    const result: HistoryCache = { currentMonth, previousMonth };
    writeCache(CACHE_ID, result, new Date().toISOString());

    if (!historyHealthy) {
      logger.warn({ event: "electricity_history_recovered" }, "electricity month history recovered");
    }
    historyHealthy = true;
    return result;
  } catch (err) {
    if (historyHealthy) {
      logger.error({ event: "electricity_history_failed", err }, "electricity month history fetch failed");
    }
    historyHealthy = false;
    // Stale beats missing: keep serving the last good averages if there are any.
    return cached ? cached.data : null;
  }
}
