import { Provider } from "../core/provider.ts";
import { localDateKey, localParts, shiftDateKey } from "../core/time.ts";
import { getMonthlyAverages, type MonthAverage } from "./price-history.ts";

const API_URL = "https://api.porssisahko.net/v1/latest-prices.json";

interface RawPrice {
  price: number;
  startDate: string;
  endDate: string;
}

export interface PriceHour {
  /** Local hour of day, 0-23. */
  hour: number;
  /** Price in snt/kWh, VAT included; null when that hour is not in the feed. */
  price: number | null;
  startsAt: string | null;
}

export interface PriceDay {
  date: string;
  /** Always 24 entries indexed by local hour, so a chart cannot shift. */
  hours: PriceHour[];
  min: number;
  max: number;
  average: number;
  knownHours: number;
}

export interface ElectricityData {
  unit: "snt/kWh";
  today: PriceDay | null;
  tomorrow: PriceDay | null;
  /**
   * Tomorrow's prices are published around 14:00 Finnish time. Before that they
   * genuinely do not exist, which is a normal state and not an error.
   */
  tomorrowAvailable: boolean;
  currentPrice: number | null;
  currentHour: number;
  /** Null when the history fetch has never succeeded — the rest of the card still works. */
  currentMonth: MonthAverage | null;
  previousMonth: MonthAverage | null;
}

function toDay(date: string, raw: RawPrice[]): PriceDay | null {
  // The feed is a rolling window, so a day can legitimately be missing its
  // first hour. Indexing by hour keeps the chart aligned to the clock instead
  // of silently shifting every bar left.
  const slots: PriceHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    price: null,
    startsAt: null,
  }));

  for (const entry of raw) {
    const start = new Date(entry.startDate);
    if (localDateKey(start) !== date) continue;
    const hour = localParts(start).hour;
    const slot = slots[hour];
    if (slot) {
      slot.price = entry.price;
      slot.startsAt = entry.startDate;
    }
  }

  const prices = slots.map((s) => s.price).filter((p): p is number => p !== null);
  if (prices.length === 0) return null;

  return {
    date,
    hours: slots,
    min: Math.min(...prices),
    max: Math.max(...prices),
    average: prices.reduce((sum, p) => sum + p, 0) / prices.length,
    knownHours: prices.length,
  };
}

async function fetchElectricity(): Promise<ElectricityData> {
  const response = await fetch(API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`porssisahko.net returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as { prices?: RawPrice[] };
  const prices = Array.isArray(body.prices) ? body.prices : [];
  if (prices.length === 0) {
    throw new Error("porssisahko.net returned no prices");
  }

  const todayKey = localDateKey();
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const tomorrow = toDay(tomorrowKey, prices);

  // A separate source (Elering) and its own once-a-day cache — see
  // price-history.ts. Never throws, so a history outage cannot take the rest
  // of this card down with it.
  const history = await getMonthlyAverages();

  return {
    unit: "snt/kWh",
    today: toDay(todayKey, prices),
    tomorrow,
    // A nearly complete day means the publication has happened; a couple of
    // hours short is the rolling window, not a missing day.
    tomorrowAvailable: tomorrow !== null && tomorrow.knownHours >= 23,
    currentPrice: currentPriceFrom(prices),
    currentHour: localParts().hour,
    currentMonth: history?.currentMonth ?? null,
    previousMonth: history?.previousMonth ?? null,
  };
}

function currentPriceFrom(prices: RawPrice[]): number | null {
  const now = Date.now();
  const match = prices.find((entry) => {
    const start = new Date(entry.startDate).getTime();
    const end = new Date(entry.endDate).getTime();
    return now >= start && now < end;
  });
  return match ? match.price : null;
}

export function createElectricityProvider(): Provider<ElectricityData> {
  return new Provider<ElectricityData>({
    id: "electricity",
    // Prices are hourly, but polling every 20 minutes means tomorrow's prices
    // appear on the screen shortly after they are published around 14:00.
    intervalMs: 20 * 60 * 1000,
    initialDelayMs: 0,
    fetch: fetchElectricity,
  });
}
