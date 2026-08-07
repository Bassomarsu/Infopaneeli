import ical from "node-ical";
import type { CalendarResponse, FetchOptions, VEvent } from "node-ical";
import { FatalProviderError, Provider } from "../core/provider.ts";
import { config } from "../core/config.ts";
import { localDateKey, localParts, shiftDateKey } from "../core/time.ts";

const WINDOW_DAYS = 14;

// Turvaraja "monesko päivä" -badgen luotettavuudelle — EI rajaa mitä päiviä
// ikkunaan tuotetaan (se on aina rajattu ikkunan omaan pituuteen, ks.
// daysForInstance). Ilman tätä virheellinen syöte (esim. DTEND vuosisatojen
// päässä DTSTARTista) näyttäisi mielivaltaisen suuria lukuja kuten "45/58000".
// Reilusti yli vuoden pituinen, jotta oikeatkin pitkät tapahtumat (esim.
// vanhempainvapaa tai remontti) saavat silti tarkan numeroinnin.
export const MAX_EVENT_SPAN_DAYS = 400;

// `fromURL`'s overloads resolve to the callback form (returning void) as soon
// as a second argument is passed, even though it also accepts just options.
// A narrow cast to the promise-returning shape keeps the call site honest.
const fromURL = ical.async.fromURL as (url: string, options: FetchOptions) => Promise<CalendarResponse>;

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  allDay: boolean;
  location: string | null;
  /** Local day this particular row falls on — a multi-day event contributes one row per day. */
  dateKey: string;
  /**
   * Läsnä vain monipäiväisessä tapahtumassa: monesko päivä menossa ja jakson
   * kokonaispituus. Puuttuu myös silloin kun tapahtuman todellinen kesto
   * ylittää MAX_EVENT_SPAN_DAYS:n (selvästi virheellinen syöte) — silloin
   * numerointi jätetään pois sen sijaan että näytettäisiin epäluotettava luku.
   */
  span?: { day: number; totalDays: number };
}

export interface CalendarData {
  /**
   * Chronological, spanning the next 14 days, recurrences already expanded.
   * A multi-day event contributes one row per day it touches within the
   * window — see `dateKey` and `span` on CalendarEvent.
   */
  events: CalendarEvent[];
}

/** iCal text fields are either a plain string or `{ val, params }` when they carry parameters. */
function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) {
    const val = (value as { val: unknown }).val;
    return typeof val === "string" ? val : "";
  }
  return "";
}

// Full-day instances come back as a `Date` built from local getters
// (see node-ical's expandRecurringEvent), i.e. it already *is* the intended
// calendar day — reading it back through the Helsinki Intl formatter would
// misfire if this process ever ran in a different system timezone. Timed
// instances are real instants, so those go through the normal formatter.
function dateKeyFor(date: Date, allDay: boolean): string {
  if (allDay) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return localDateKey(date);
}

/**
 * Päivien lukumäärä a:sta b:hen (b - a) YYYY-MM-DD-avaimista. Puhdasta
 * kalenteriaritmetiikkaa (ei silmukkaa), joten turvallista kutsua vaikka
 * väli olisi vuosien mittainen.
 */
function diffDayKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const aUtc = Date.UTC(ay ?? 1970, (am ?? 1) - 1, ad ?? 1);
  const bUtc = Date.UTC(by ?? 1970, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((bUtc - aUtc) / (24 * 60 * 60 * 1000));
}

/**
 * Kellonaikaan sidotun instanssin `end` on viimeinen inklusiivinen hetki. Jos
 * se osuu tarkalleen seuraavan päivän keskiyöhön, tapahtuma ei todellisuudessa
 * ulotu sille päivälle — käsitellään silloin kuten eksklusiivinen raja, samaan
 * tapaan kuin koko päivän tapahtuman DTEND.
 */
function timedEndKeyExclusive(end: Date, startKey: string): string {
  const endKey = localDateKey(end);
  if (endKey === startKey) return shiftDateKey(endKey, 1);
  const { hour, minute } = localParts(end);
  if (hour === 0 && minute === 0) return endKey;
  return shiftDateKey(endKey, 1);
}

interface InstanceDay {
  dateKey: string;
  day: number;
  totalDays: number;
  /**
   * Tosi kun tapahtuman todellinen kesto ylittää MAX_EVENT_SPAN_DAYS:n —
   * "monesko päivä" -badge jätetään tällöin kokonaan pois sen sijaan että se
   * väittäisi tarkkaa kokonaiskestoa jota ei todellisuudessa tiedetä.
   */
  truncated: boolean;
}

/**
 * Tuottaa ikkunaan [windowFromKey, windowToKey] osuvat päivät instanssista
 * [startKey, endKeyExclusive). Päivät lasketaan suoraan leikkauksena, EI
 * laajentamalla tapahtumaa alusta lähtien turvarajaan asti ja vasta sitten
 * suodattamalla ikkunaan — se aiempi järjestys oli bugi: yli
 * MAX_EVENT_SPAN_DAYS päivää sitten alkanut mutta yhä käynnissä oleva
 * tapahtuma (esim. kolmen kuukauden vanhempainvapaa) putosi kokonaan pois,
 * koska turvarajattu laajennus loppui ennen kuin ikkuna edes alkoi.
 *
 * Tämän ansiosta silmukka on aina rajattu ikkunan omaan pituuteen (enintään
 * WINDOW_DAYS+1 päivää) riippumatta tapahtuman todellisesta kestosta, joten
 * MAX_EVENT_SPAN_DAYS ei enää tarvitse rajata silmukkaa — se rajaa vain
 * `totalDays`-luvun luotettavuutta (ks. `truncated`).
 */
function daysForInstance(
  startKey: string,
  endKeyExclusive: string,
  windowFromKey: string,
  windowToKey: string,
): InstanceDay[] {
  // Virheellinen syöte (end <= start) ei saa pudottaa tapahtumaa kokonaan pois —
  // käsitellään yhden päivän tapahtumana, kuten ennen tätä korjausta.
  const realEndExclusive = endKeyExclusive > startKey ? endKeyExclusive : shiftDateKey(startKey, 1);

  const totalDaysReal = diffDayKeys(startKey, realEndExclusive);
  const truncated = totalDaysReal > MAX_EVENT_SPAN_DAYS;
  const totalDays = truncated ? MAX_EVENT_SPAN_DAYS : totalDaysReal;

  const windowToExclusive = shiftDateKey(windowToKey, 1);
  const rangeStart = startKey > windowFromKey ? startKey : windowFromKey;
  const rangeEndExclusive = realEndExclusive < windowToExclusive ? realEndExclusive : windowToExclusive;

  const days: InstanceDay[] = [];
  let key = rangeStart;
  while (key < rangeEndExclusive) {
    days.push({ dateKey: key, day: diffDayKeys(startKey, key) + 1, totalDays, truncated });
    key = shiftDateKey(key, 1);
  }
  return days;
}

/**
 * Laajentaa yhden VEVENTin (toistuva tai ei) CalendarEvent-riveiksi ikkunassa
 * [from, to] — yksi rivi jokaista päivää kohti jota tapahtuma koskee, jotta
 * monipäiväinen tapahtuma näkyy kortissa joka päivänään eikä vain
 * alkupäivänään. Puhdas funktio (ei verkkokutsuja), joten testattavissa
 * käsin rakennetuilla VEVENT-olioilla.
 */
export function expandEvent(event: VEvent, from: Date, to: Date): CalendarEvent[] {
  const windowFromKey = localDateKey(from);
  const windowToKey = localDateKey(to);

  // expandOngoing: true tuo mukaan myös tapahtuman, joka on alkanut ennen
  // ikkunaa mutta jatkuu sen sisälle — muuten se putoaisi kokonaan pois.
  const instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });

  const events: CalendarEvent[] = [];
  for (const instance of instances) {
    const title = textValue(instance.summary) || textValue(event.summary) || "(nimetön)";
    const location = textValue(instance.event.location ?? event.location) || null;

    const startKey = dateKeyFor(instance.start, instance.isFullDay);
    const endKeyExclusive = instance.isFullDay
      ? dateKeyFor(instance.end, true)
      : timedEndKeyExclusive(instance.end, startKey);

    const days = daysForInstance(startKey, endKeyExclusive, windowFromKey, windowToKey);

    for (const day of days) {
      events.push({
        id: `${event.uid}:${instance.start.toISOString()}:${day.dateKey}`,
        title,
        start: instance.start.toISOString(),
        end: instance.end.toISOString(),
        allDay: instance.isFullDay,
        location,
        dateKey: day.dateKey,
        // Katkaistulle (epäluotettavan pitkälle) kestolle jätetään badge
        // kokonaan pois sen sijaan että näytettäisiin harhaanjohtava
        // kokonaislukema — ks. daysForInstance.
        span: !day.truncated && day.totalDays > 1 ? { day: day.day, totalDays: day.totalDays } : undefined,
      });
    }
  }
  return events;
}

async function fetchCalendar(): Promise<CalendarData> {
  if (!config.calendarIcsUrl) {
    // Not a network hiccup — retrying on a schedule would just hammer nothing.
    // FatalProviderError trips the circuit breaker instead.
    throw new FatalProviderError("NotConfigured", "Kalenterin ICS-osoitetta ei ole asetettu");
  }

  const parsed = await fromURL(config.calendarIcsUrl, {
    signal: AbortSignal.timeout(15_000),
  });

  const from = new Date();
  const to = new Date(from.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];

  for (const item of Object.values(parsed)) {
    if (!item || typeof item !== "object" || item.type !== "VEVENT") continue;
    // Handles both plain events and RRULE recurrence, EXDATE exclusions,
    // RECURRENCE-ID overrides, and — via expandEvent — multi-day expansion.
    events.push(...expandEvent(item as VEvent, from, to));
  }

  // dateKey ensisijaisena avaimena pitää päiväryhmät oikeassa järjestyksessä,
  // vaikka monipäiväisen tapahtuman kaikki rivit jakavat saman `start`-hetken.
  events.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.start.localeCompare(b.start));

  return { events };
}

export function createCalendarProvider(): Provider<CalendarData> {
  return new Provider<CalendarData>({
    id: "calendar",
    intervalMs: 15 * 60 * 1000,
    initialDelayMs: 10_000,
    fetch: fetchCalendar,
  });
}
