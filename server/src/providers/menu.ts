import { Provider } from "../core/provider.ts";
import { localDateKey, shiftDateKey } from "../core/time.ts";

export interface MenuMeal { type: string; name: string }
export interface MenuDay { date: string; meals: MenuMeal[] }
export interface MenuData {
  locationId: string;
  locationName: string;
  sourceUrl: string;
  days: MenuDay[];
}
export const MENU_LOCATION_ID = "karstula_koulut";
const SOURCE = `https://kouluruoka.fi/menu/${MENU_LOCATION_ID}/`;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ruokalistan rakenne muuttui");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Ruokalistan tiedot ovat puutteelliset");
  return value.trim();
}

/** Dates have no year in day labels. Match to the seven actual dates of Start,
 * so missing weekdays and weeks crossing New Year never shift the meals. */
export function parseMenuPage(body: unknown): MenuData {
  const menu = record(record(record(body).result).pageContext).menu;
  const m = record(menu);
  if (m.RestaurantId !== MENU_LOCATION_ID) throw new Error("Ruokalista kuuluu eri koululle");
  const start = text(m.Start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start) {
    throw new Error("Ruokalistan viikko puuttuu");
  }
  if (!Array.isArray(m.Days) || m.Days.length > 7) throw new Error("Ruokalistan päivät puuttuvat");
  const dates = Array.from({ length: 7 }, (_, i) => shiftDateKey(start, i));
  const seen = new Set<string>();
  const days = m.Days.map((raw): MenuDay => {
    const day = record(raw);
    const match = /(?:^|\s)(\d{1,2})\.(\d{1,2})\.$/.exec(text(day.Date));
    const date = dates.find(d => Number(d.slice(5, 7)) === Number(match?.[2]) && Number(d.slice(8)) === Number(match?.[1]));
    if (!date || seen.has(date)) throw new Error("Ruokalistan päivämäärä on virheellinen");
    seen.add(date);
    if (!Array.isArray(day.Meals)) throw new Error("Ruokalistan ateriat puuttuvat");
    return { date, meals: day.Meals.map(rawMeal => {
      const meal = record(rawMeal);
      return { type: text(meal.MealType), name: text(meal.Name) };
    }) };
  });
  return { locationId: MENU_LOCATION_ID, locationName: text(m.RestaurantName), sourceUrl: SOURCE, days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function fetchMenu(fetcher: typeof fetch = fetch, now: Date = new Date()): Promise<MenuData> {
  const weeks = await Promise.all(["", "2/"].map(async suffix => {
    const response = await fetcher(`https://kouluruoka.fi/page-data/menu/${MENU_LOCATION_ID}/${suffix}page-data.json`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    // Next week is legitimately absent during school holidays.
    if (suffix && response.status === 404) return null;
    if (!response.ok) throw new Error(`Ruokalistan haku epäonnistui (HTTP ${response.status})`);
    return parseMenuPage(await response.json());
  }));
  const first = weeks[0]!;
  if (!first) throw new Error("Ruokalista puuttuu");
  const today = localDateKey(now);
  const days = [...new Map(weeks.flatMap(w => w?.days ?? []).map(d => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date));
  // An old HTTP 200 must not overwrite the last usable cache with a healthy badge.
  if (days.length && days.every(d => d.date < shiftDateKey(today, -2))) throw new Error("Lähteen ruokalista on vanhentunut");
  return { ...first, days };
}
export function createMenuProvider(): Provider<MenuData> {
  return new Provider<MenuData>({ id: "menu", intervalMs: 4 * 60 * 60 * 1000, initialDelayMs: 7_000, fetch: () => fetchMenu() });
}
