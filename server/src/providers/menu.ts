import { getSettings } from "../core/settings.ts";
import { readCache } from "../core/store.ts";
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
const sourceUrl = (id: string) => `https://kouluruoka.fi/menu/${id}/`;
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
export function parseMenuPage(body: unknown, locationId = MENU_LOCATION_ID): MenuData {
  const menu = record(record(record(body).result).pageContext).menu;
  const m = record(menu);
  if (m.RestaurantId !== locationId) throw new Error("Ruokalista kuuluu eri koululle");
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
  return { locationId, locationName: text(m.RestaurantName), sourceUrl: sourceUrl(locationId), days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function fetchMenu(fetcher: typeof fetch = fetch, now: Date = new Date(), locationId = MENU_LOCATION_ID): Promise<MenuData> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(locationId)) throw new Error("Virheellinen koulutunniste");
  const weeks = await Promise.all(["", "2/"].map(async suffix => {
    const response = await fetcher(`https://kouluruoka.fi/page-data/menu/${locationId}/${suffix}page-data.json`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    // Next week is legitimately absent during school holidays.
    if (suffix && response.status === 404) return null;
    if (!response.ok) throw new Error(`Ruokalistan haku epäonnistui (HTTP ${response.status})`);
    return parseMenuPage(await response.json(), locationId);
  }));
  const first = weeks[0]!;
  if (!first) throw new Error("Ruokalista puuttuu");
  const today = localDateKey(now);
  const days = [...new Map(weeks.flatMap(w => w?.days ?? []).map(d => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date));
  // An old HTTP 200 must not overwrite the last usable cache with a healthy badge.
  if (days.length && days.every(d => d.date < shiftDateKey(today, -2))) throw new Error("Lähteen ruokalista on vanhentunut");
  return { ...first, days };
}

export interface MenuSchool extends MenuData { status: 'ok'|'stale'|'failed'|'loading'; error: string|null; fetchedAt: string|null }
export interface MenuCollection { schools: MenuSchool[] }
export function selectedMenuData(data: unknown, ids: string[], fetchedAt: string|null = null): MenuCollection {
  const raw = data as Partial<MenuCollection & MenuData> | null;
  const schools = Array.isArray(raw?.schools) ? raw.schools : raw?.locationId && Array.isArray(raw.days) ? [{...raw, status:'stale',error:null,fetchedAt} as MenuSchool] : [];
  return {schools:ids.map(id=>schools.find(s=>s.locationId===id) ?? {locationId:id,locationName:id,sourceUrl:sourceUrl(id),days:[],status:'loading',error:null,fetchedAt:null})};
}
export async function fetchSelectedMenus(fetcher: typeof fetch = fetch, selection = () => getSettings().menuSchoolIds, previous: unknown = null, now = new Date()): Promise<MenuCollection> {
  // A setting can change during either network request. Finish with the current
  // selection, so Provider's busy guard cannot strand the new school for 4h.
  for(let attempt=0;attempt<4;attempt++) {
    const ids=[...selection()]; const old=selectedMenuData(previous,ids).schools;
    const schools=await Promise.all(ids.map(async (id): Promise<MenuSchool> => {
      try {return {...await fetchMenu(fetcher,now,id),status:'ok',error:null,fetchedAt:new Date().toISOString()};}
      catch(error) {const cached=old.find(s=>s.locationId===id)!;return {...cached,status:cached.fetchedAt?'stale':'failed',error:error instanceof Error?error.message:'Ruokalistan haku epäonnistui'};}
    }));
    if(JSON.stringify(ids)===JSON.stringify(selection()))return {schools};
    previous={schools};
  }
  throw new Error('Kouluvalinta muuttui haun aikana. Yritetään uudelleen.');
}
export function createMenuProvider(): Provider<MenuCollection> {
  return new Provider<MenuCollection>({ id: 'menu', intervalMs: 4*60*60*1000, initialDelayMs:7000,
    fetch:()=>{ const cached=readCache<unknown>('menu'); return fetchSelectedMenus(fetch,()=>getSettings().menuSchoolIds,selectedMenuData(cached?.data,getSettings().menuSchoolIds,cached?.fetchedAt)); } });
}
