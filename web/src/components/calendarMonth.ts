/**
 * Kuukausinäkymän puhdas logiikka: ruudukon rakentaminen, kuukausien selaus ja
 * päiväsolun tilan päättely. Omana tiedostonaan jotta nämä ovat testattavissa
 * ilman DOM:ia (ks. web/test/calendar-month.ts) — kaikki kolme ovat asioita
 * joista kalenterit tyypillisesti erehtyvät hiljaa.
 */
import type { CalendarEvent, CalendarMonth } from "../types";

/** Maanantaista sunnuntaihin — viikko alkaa Suomessa maanantaista. */
export const WEEKDAY_SHORT = ["ma", "ti", "ke", "to", "pe", "la", "su"] as const;

export const WEEKDAY_LONG = [
  "maanantai",
  "tiistai",
  "keskiviikko",
  "torstai",
  "perjantai",
  "lauantai",
  "sunnuntai",
] as const;

const MONTH_NAMES = [
  "tammikuu",
  "helmikuu",
  "maaliskuu",
  "huhtikuu",
  "toukokuu",
  "kesäkuu",
  "heinäkuu",
  "elokuu",
  "syyskuu",
  "lokakuu",
  "marraskuu",
  "joulukuu",
] as const;

/**
 * Ruudukko on AINA kuusi viikkoa, vaikka kuukausi mahtuisi viiteen.
 *
 * Vaihtuva rivimäärä muuttaisi solun korkeutta kuukautta vaihdettaessa, ja
 * koska mahtuvien tapahtumarivien määrä lasketaan solun korkeudesta
 * (`chipCapacity`), ruudukko hyppäisi JA tapahtumarivien määrä vaihtuisi
 * pelkästä nuolen painalluksesta. Kiinteä korkeus maksaa toisinaan yhden
 * tyhjän rivin ja on sen arvoinen.
 */
export const GRID_WEEKS = 6;

/** Paikallinen YYYY-MM-DD — sama muoto kuin palvelimen `dateKey`, jotta vertailu on merkkijonovertailu. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Paikallinen YYYY-MM. */
export function localMonthKey(date: Date): string {
  return localDateKey(date).slice(0, 7);
}

function parseMonthKey(monthKey: string): { year: number; month: number } {
  const [y, m] = monthKey.split("-").map(Number);
  return { year: y ?? 1970, month: m ?? 1 };
}

/**
 * Siirtää kuukausiavainta `delta` kuukautta. Laskenta tehdään kokonaislukuina
 * eikä `Date`-olioilla: `setMonth` 31. päivänä vyöryttäisi kuukauden yli
 * (31.1. + 1 kk = 3.3.), ja se olisi juuri se vika jota ei huomaa ennen kuin
 * joku selaa tammikuuta.
 */
export function shiftMonth(monthKey: string, delta: number): string {
  const { year, month } = parseMonthKey(monthKey);
  const zeroBased = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}`;
}

/** "2026-09" → "syyskuu 2026". */
export function monthLabel(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey);
  return `${MONTH_NAMES[month - 1] ?? monthKey} ${year}`;
}

/** 0 = maanantai … 6 = sunnuntai. */
export function weekdayIndex(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  // Rakennetaan UTC:nä vain viikonpäivän lukemiseksi: paikallinen `new Date(y, m, d)`
  // toimisi tässä myös, mutta UTC pitää funktion riippumattomana aikavyöhykkeestä.
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return (utc.getUTCDay() + 6) % 7;
}

/** "2026-09-11" → "Perjantai 11. syyskuuta". */
export function dayHeading(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  const weekday = WEEKDAY_LONG[weekdayIndex(dateKey)] ?? "";
  const name = MONTH_NAMES[(m ?? 1) - 1] ?? "";
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${d}. ${name}ta`;
}

export interface GridDay {
  dateKey: string;
  /** Kuukauden päivä, 1–31. */
  dayOfMonth: number;
  /** false = viereisen kuukauden täytesolu. */
  inMonth: boolean;
  /** 0 = maanantai … 6 = sunnuntai. */
  weekday: number;
}

/**
 * Kuukauden ruudukko maanantaista alkaen, aina `GRID_WEEKS` × 7 solua.
 *
 * Ruudukko syntyy pelkästä kuukausiavaimesta — se ei tarvitse palvelimen
 * vastausta. Juuri siksi näkymä voi piirtää oikean ruudukon heti ja täyttää
 * tapahtumat vasta kun ne saapuvat: mikään ei välky eikä asettelu liiku.
 */
export function buildMonthGrid(monthKey: string): GridDay[] {
  const { year, month } = parseMonthKey(monthKey);
  const firstKey = `${monthKey}-01`;
  const leading = weekdayIndex(firstKey);

  const cells: GridDay[] = [];
  for (let i = 0; i < GRID_WEEKS * 7; i += 1) {
    // Paikallinen Date kuukauden 1. päivästä laskien: ylivuoto (0 tai > kuukauden
    // pituus) rullaa oikein edelliseen tai seuraavaan kuukauteen.
    const date = new Date(year, month - 1, 1 + (i - leading));
    const dateKey = localDateKey(date);
    cells.push({
      dateKey,
      dayOfMonth: date.getDate(),
      inMonth: dateKey.slice(0, 7) === monthKey,
      weekday: i % 7,
    });
  }
  return cells;
}

/**
 * Päiväsolun tila.
 *
 * `empty` ja `unknown` ovat eri asioita eivätkä saa näyttää samalta: `empty`
 * tarkoittaa "kysyttiin, ei tapahtumia", `unknown` tarkoittaa "ei kysytty".
 * Kun `covered` on false, lähde EI kata koko kuukautta, jolloin päivä josta
 * `days` vaikenee on `unknown`. Päivät joilla on tapahtumia ovat silti
 * tiedossa myös kattamattomassa kuukaudessa.
 *
 * `month` on sen kuukauden vastaus johon PÄIVÄ kuuluu, ei välttämättä se jota
 * ruudukko näyttää. Viereisen kuukauden täytesolulle annetaan naapurin vastaus,
 * jolloin sekin saa oikean tilan sen sijaan että olisi aina tyhjä. Se onko
 * solu näytettävän kuukauden sisällä on erillinen asia (`GridDay.inMonth`) ja
 * vaikuttaa vain ulkoasuun.
 */
export type DayKind = "events" | "empty" | "unknown";

export function dayKind(
  dateKey: string,
  month: CalendarMonth | null,
  /** true = haku on kesken tai epäonnistui, jolloin mitään ei tiedetä. */
  indeterminate: boolean,
): DayKind {
  if (indeterminate || month === null) return "unknown";
  const events = month.days[dateKey];
  if (events !== undefined && events.length > 0) return "events";
  return month.covered ? "empty" : "unknown";
}

/**
 * Montako tapahtumariviä päiväsoluun mahtuu. Mitattu eikä arvattu: solun
 * korkeus riippuu dialogin koosta, joka riippuu ruudusta.
 *
 * Kun tapahtumia on enemmän kuin mahtuu, viimeinen rivi menee "+N lisää"
 * -merkinnälle, joten näytettäviä tapahtumia on yksi vähemmän kuin rivejä.
 */
export function chipCapacity(availablePx: number, chipPx: number): number {
  if (!Number.isFinite(availablePx) || !Number.isFinite(chipPx) || chipPx <= 0) return 1;
  return Math.max(1, Math.floor(availablePx / chipPx));
}

export interface ChipPlan {
  shown: CalendarEvent[];
  /** Montako jää näyttämättä. 0 = kaikki mahtuivat. */
  hidden: number;
}

export function planChips(events: CalendarEvent[], capacity: number): ChipPlan {
  if (events.length <= capacity) return { shown: events, hidden: 0 };
  // Ylivuotorivi vie yhden paikan, joten mahtuvia tapahtumia on capacity - 1.
  const room = Math.max(0, capacity - 1);
  return { shown: events.slice(0, room), hidden: events.length - room };
}

function clockTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Alkaako tapahtuma tiettynä kellonaikana juuri tänä päivänä.
 *
 * Ruudukko ei näytä kellonaikoja — solussa on tilaa noin viidelletoista
 * merkille, ja kellonaika söi siitä kolmanneksen niin että "Kerttu
 * hammaslääkäri" katkesi muotoon "Kerttu hamma…". Kellonaika on päivänäkymän
 * asia; se avataan juuri sitä varten. Tätä tietoa tarvitaan silti: kestollinen
 * rivi (koko päivä tai monipäiväisen välipäivä) piirtyy umpinaisena palkkina
 * ja hetkellinen reunaviivana, ja ero lasketaan tästä.
 *
 * Monipäiväisen tapahtuman jokaisella rivillä on sama start/end (koko
 * instanssin hetket), joten vain ensimmäisellä päivällä on oma alkuhetkensä.
 */
export function chipTime(event: CalendarEvent): string | null {
  if (event.allDay) return null;
  if (event.span && event.span.day !== 1) return null;
  return clockTime(event.start);
}

/** Päivänäkymän aikaleima: koko rivi, ei pelkkä alkuhetki. */
export function dayViewTime(event: CalendarEvent): string {
  if (event.allDay) return "koko päivä";
  const start = clockTime(event.start);
  const end = clockTime(event.end);
  if (start === null || end === null) return "";
  if (!event.span) return `${start}–${end}`;
  if (event.span.day === 1) return `alkaa ${start}`;
  if (event.span.day === event.span.totalDays) return `päättyy ${end}`;
  return "jatkuu koko päivän";
}

/** Päivän tapahtumat kahtena ryhmänä: kestot ensin, sitten kellonaikaan sidotut. */
export function splitDayEvents(events: CalendarEvent[]): {
  allDay: CalendarEvent[];
  timed: CalendarEvent[];
} {
  const allDay: CalendarEvent[] = [];
  const timed: CalendarEvent[] = [];
  for (const event of events) {
    // Monipäiväisen tapahtuman välipäivä kestää koko sen päivän, vaikka
    // tapahtuma itse on kellonaikaan sidottu — se kuuluu ylempään ryhmään,
    // koska sillä ei ole tämän päivän kellonaikaa.
    const spansWholeDay =
      event.allDay ||
      (event.span !== undefined && event.span.day !== 1 && event.span.day !== event.span.totalDays);
    if (spansWholeDay) allDay.push(event);
    else timed.push(event);
  }
  return { allDay, timed };
}
