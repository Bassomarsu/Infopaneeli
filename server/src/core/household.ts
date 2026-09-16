import { randomUUID } from "node:crypto";
import { getSetting, setSetting } from "./store.ts";

export interface Waste { id: string; label: string; date: string; intervalWeeks: number }
export interface Shopping { id: string; text: string; done: boolean }
export interface Seasonal { id: string; label: string; date: string; annual: boolean; completedDate: string | null }
export type HouseholdKind = "waste" | "shopping" | "seasonal" | "anniversaries";
type Item = Waste | Shopping | Seasonal;
const DAY = 86_400_000;
export function helsinkiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9998-12-31") return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function nextWasteDate(item: Waste, today: string): string {
  if (item.date >= today || item.intervalWeeks === 0) return item.date;
  const start = Date.parse(`${item.date}T00:00:00Z`);
  const elapsed = Date.parse(`${today}T00:00:00Z`) - start;
  return new Date(start + Math.ceil(elapsed / (item.intervalWeeks * 7 * DAY)) * item.intervalWeeks * 7 * DAY).toISOString().slice(0, 10);
}
/**
 * Saman kuukauden ja päivän esiintymä annettuna vuonna, 29.2. leikattuna
 * 28.2:een ei-karkausvuosina. `Date.UTC(year, month, 0)` on kuukauden
 * viimeinen päivä — määritelty operaatio, ei olematon aika joka
 * normalisoituisi eteenpäin (29.2.2025 -> 1.3.2025). Aikaisemmin eikä
 * myöhemmin: muistutus kuuluu helmikuulle, ja 1.3. siirtäisi sen väärään
 * kuukauteen.
 */
function anniversary(date: string, year: number): string {
  const month = Number(date.slice(5, 7));
  const day = Math.min(Number(date.slice(8)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${year}-${date.slice(5, 7)}-${String(day).padStart(2, "0")}`;
}
/**
 * Meneillään oleva esiintymä, laskettuna NYKYHETKESTÄ.
 *
 * Kaksi vaatimusta yhdessä:
 *  - kuittaamaton esiintymä pysyy myöhässä kunnes se kuitataan (joulukuun
 *    renkaat näkyvät myöhässä vielä tammikuussa),
 *  - väliin jääneet vuodet EIVÄT kasaannu. Aiemmin lähtökohta oli merkinnän
 *    oma vuosi ja kuittaus siirsi sitä yhden vuoden kerrallaan: 2020
 *    kuitattuna näytti vuonna 2026 päivämäärää 1.5.2021, ja kiinni pääsi vain
 *    klikkaamalla kerran jokaista väliin jäänyttä vuotta kohti.
 *
 * Siksi lähtökohta on viimeisin JO KOITTANUT esiintymä (tuleva merkintä alkaa
 * omasta vuodestaan), ja vain se katsotaan kuitatuksi tai kuittaamattomaksi.
 * Yksi kuittaus riittää aina, oli väliin jäänyt vuosi tai viisi. Vanhojen
 * väliin jääneiden vuosien "myöhässä" -tieto menetetään tarkoituksella:
 * vuosittaisesta muistutuksesta ei kerry velkalistaa, ja merkinnän oma
 * aloituspäivä säilyy silti `date`-kentässä.
 *
 * Kaikki laskenta on merkkijono- ja UTC-aritmetiikkaa (ks. `anniversary`), ei
 * paikallista `new Date(y, m, d, h, min)` -rakentamista — juuri se normalisoi
 * olemattoman ajan hiljaa, mikä oli hälytysten kesäaikavika.
 */
export function seasonalOccurrence(item: Seasonal, today: string): string {
  if (!item.annual) return item.date;
  const startYear = Number(item.date.slice(0, 4));
  let year = Math.max(startYear, Number(today.slice(0, 4)));
  if (anniversary(item.date, year) > today) year = Math.max(startYear, year - 1);
  const occurrence = anniversary(item.date, year);
  return item.completedDate !== null && item.completedDate >= occurrence ? anniversary(item.date, year + 1) : occurrence;
}
function items<T extends Item>(kind: HouseholdKind): T[] { return getSetting<T[]>(`household.${kind}`) ?? []; }
export function readHousehold(now = new Date()) {
  const today = helsinkiToday(now);
  return {
    waste: items<Waste>("waste").map(item => ({ ...item, nextDate: nextWasteDate(item, today) })).sort((a, b) => a.nextDate.localeCompare(b.nextDate)),
    shopping: items<Shopping>("shopping"),
    anniversaries: items<Seasonal>("anniversaries").map(item => { let occurrenceDate = anniversary(item.date, Math.max(Number(item.date.slice(0, 4)), Number(today.slice(0, 4)))); if (occurrenceDate < today) occurrenceDate = anniversary(item.date, Number(today.slice(0, 4)) + 1); return { ...item, occurrenceDate, done: false }; }).sort((a,b) => a.occurrenceDate.localeCompare(b.occurrenceDate)),
    seasonal: items<Seasonal>("seasonal").map(item => { const occurrenceDate = seasonalOccurrence(item, today); return { ...item, occurrenceDate, done: item.completedDate === occurrenceDate }; }).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate)),
  };
}
/**
 * Avoimien merkintöjen katto, ja erikseen kova katto tallennetulle listalle.
 *
 * Kauppalistalla tehdyt ostokset jäävät riville kunnes ne tyhjennetään, ja
 * yksi yhteinen 200:n katto laski ne mukaan: kymmenen ostosta viikossa täytti
 * listan puolessa vuodessa ja uuden lisääminen lakkasi toimimasta, vaikka
 * tekemättömiä oli kourallinen. Katto lasketaan siksi tekemättömistä.
 *
 * Tallennettu lista tarvitsee silti oman ylärajansa — tehtyjä voi kertyä
 * ilman tyhjennystä, ja koko lista menee yhtenä JSONina asetusriville. 500 on
 * reilusti yli sen mitä kotitalous kerää tyhjennysten välissä, mutta pitää
 * rivin rajallisena. Muilla listoilla tehtyjä ei ole, joten niillä kumpikin
 * raja osuu samaan 200:aan.
 */
const MAX_OPEN = 200;
const MAX_STORED = 500;
function enforceLimit(kind: HouseholdKind, list: Item[]): void {
  const open = kind === "shopping" ? list.filter(item => !(item as Shopping).done).length : list.length;
  if (open >= MAX_OPEN) throw new Error(`Listalla voi olla enintään ${MAX_OPEN} ${kind === "shopping" ? "tekemätöntä " : ""}merkintää.`);
  if (list.length >= MAX_STORED) throw new Error("Lista on täynnä. Tyhjennä tehdyt ostokset.");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new Error("Anna 1–200 merkin teksti.");
  return value.trim();
}
/** The read/modify/write is synchronous: concurrent HTTP requests cannot overwrite each other's changes. */
export function saveHousehold(kind: HouseholdKind, body: unknown, id?: string, now = new Date()): Item | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Virheellinen sisältö.");
  const input = body as Record<string, unknown>;
  const list = items<Item>(kind);
  const index = id === undefined ? -1 : list.findIndex(item => item.id === id);
  if (id !== undefined && index < 0) return null;
  if (id === undefined) enforceLimit(kind, list);
  const old = index < 0 ? undefined : list[index];
  const allowed = kind === "shopping" ? ["text", "done"] : kind === "waste" ? ["label", "date", "intervalWeeks"] : kind === "anniversaries" ? ["label", "date"] : ["label", "date", "annual", "done", "occurrenceDate"];
  if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Tuntematon tai puuttuva kenttä.");
  const merged = { ...old, ...input, ...(kind === "anniversaries" ? { annual: true } : {}) } as Record<string, unknown>;
  let item: Item;
  if (kind === "shopping") {
    if (merged.done !== undefined && typeof merged.done !== "boolean") throw new Error("Virheellinen valintatila.");
    item = { id: id ?? randomUUID(), text: text(merged.text), done: merged.done === true };
  } else {
    const label = text(merged.label);
    if (!validDate(merged.date)) throw new Error("Anna kelvollinen päivämäärä.");
    if (kind === "waste") {
      if (typeof merged.intervalWeeks !== "number" || !Number.isInteger(merged.intervalWeeks) || merged.intervalWeeks < 0 || merged.intervalWeeks > 52) throw new Error("Toistoväli on 0–52 viikkoa (0 = kertaluonteinen).");
      item = { id: id ?? randomUUID(), label, date: merged.date, intervalWeeks: merged.intervalWeeks };
    } else {
      if (typeof merged.annual !== "boolean" || (input.done !== undefined && typeof input.done !== "boolean")) throw new Error("Virheellinen valintatila.");
      const previous = old as Seasonal | undefined;
      item = { id: id ?? randomUUID(), label, date: merged.date, annual: merged.annual, completedDate: previous?.completedDate ?? null };
      if (previous && (previous.date !== item.date || previous.annual !== item.annual)) item.completedDate = null;
      if (input.done !== undefined) {
        if (!validDate(input.occurrenceDate)) throw new Error("Kuittauksen päivämäärä puuttuu.");
        if (input.done === true) {
          if (item.completedDate !== input.occurrenceDate) {
            if (seasonalOccurrence(item, helsinkiToday(now)) !== input.occurrenceDate) throw new Error("Muistutus on muuttunut. Päivitä näkymä.");
            item.completedDate = input.occurrenceDate;
          }
        } else if (item.completedDate === input.occurrenceDate) {
          const previousYear = Number(input.occurrenceDate.slice(0, 4)) - 1;
          item.completedDate = item.annual && previousYear >= Number(item.date.slice(0, 4)) ? anniversary(item.date, previousYear) : null;
        } else if (seasonalOccurrence(item, helsinkiToday(now)) !== input.occurrenceDate) {
          throw new Error("Muistutus on muuttunut. Päivitä näkymä.");
        }
      }
    }
  }
  if (index < 0) list.push(item); else list[index] = item;
  setSetting(`household.${kind}`, list);
  return item;
}
export function deleteHousehold(kind: HouseholdKind, id: string): boolean {
  const list = items<Item>(kind);
  const remaining = list.filter(item => item.id !== id);
  if (list.length === remaining.length) return false;
  setSetting(`household.${kind}`, remaining);
  return true;
}
/** Poistaa kauppalistalta kaikki tehdyiksi merkityt kerralla ja palauttaa poistettujen määrän. */
export function clearDoneShopping(): number {
  const list = items<Shopping>("shopping");
  const remaining = list.filter(item => !item.done);
  if (remaining.length === list.length) return 0;
  setSetting("household.shopping", remaining);
  return list.length - remaining.length;
}
