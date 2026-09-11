import ical from "node-ical";
import type { CalendarResponse, FetchOptions, VEvent } from "node-ical";
import { FatalProviderError, Provider } from "../core/provider.ts";
import { config } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { localDateKey, localParts, shiftDateKey } from "../core/time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kuinka monta kokonaista kuukautta nykyisen ympäriltä ICS laajennetaan.
 *
 * Ikkuna oli aiemmin 14 päivää eteenpäin, mikä riitti kortille mutta teki
 * kuukausinäkymästä mahdottoman: edellinen kuukausi olisi ollut kokonaan ja
 * seuraava lähes kokonaan tyhjä. `fromURL` lataa ja jäsentää joka tapauksessa
 * KOKO ICS-tiedoston joka hakukierroksella, joten ikkunan leventäminen ei
 * maksa verkossa mitään — hinta on laajennusaika, muistissa oleva rivimäärä
 * ja `provider_cache`-rivin koko.
 *
 * Mitattuna tämän kodin omasta kalenterista (33 KiB, 103 VEVENTiä, 5 RRULEa):
 * 14 päivää = 13 riviä / 3,5 KiB JSONia / 4,6 ms laajennusta; −3…+12 kk noin
 * 200 riviä / ~55 KiB / ~4 ms. Laajennus ei siis käytännössä hidastu lainkaan
 * (työ on jäsennyksessä, ~16 ms, ei laajennuksessa), ja koko lisähinta on yksi
 * kymmenien kilotavujen välimuistirivi 15 minuutin välein. Sitä vastaan
 * saadaan yksi hakupolku, yksi vanhentumistila ja kuukausinäkymä joka toimii
 * välimuistista heti uudelleenkäynnistyksen jälkeen.
 *
 * Taaksepäin kolme kuukautta eikä yksi: selaamisen raja on joka tapauksessa
 * jossakin, ja kuukausi taaksepäin tarkoittaisi että jo toissakuukausi
 * vastaisi "emme tiedä". Eteenpäin vuosi riittää kaikkeen mitä seinänäytöltä
 * katsotaan.
 */
const WINDOW_MONTHS_BACK = 3;
const WINDOW_MONTHS_FORWARD = 12;

/**
 * Kalenterikortin oma ikkuna dashboardilla. `/api/dashboard` lähtee selaimelle
 * 60 sekunnin välein, ja kortti piirtää kaiken minkä saa — koko laajennettu
 * ikkuna ei siis vain kasvattaisi liikennettä vaan myös rikkoisi kortin.
 * Rajaus tehdään vastausta koottaessa, ks. trimToDashboardWindow.
 */
export const DASHBOARD_WINDOW_DAYS = 14;

// Turvaraja "monesko päivä" -badgen luotettavuudelle — EI rajaa mitä päiviä
// ikkunaan tuotetaan (se on aina rajattu ikkunan omaan pituuteen, ks.
// daysForInstance). Ilman tätä virheellinen syöte (esim. DTEND vuosisatojen
// päässä DTSTARTista) näyttäisi mielivaltaisen suuria lukuja kuten "45/58000".
// Reilusti yli vuoden pituinen, jotta oikeatkin pitkät tapahtumat (esim.
// vanhempainvapaa tai remontti) saavat silti tarkan numeroinnin.
export const MAX_EVENT_SPAN_DAYS = 400;

/**
 * Yläraja sille montako riviä YKSI VEVENT saa tuottaa ikkunaan.
 *
 * Tarpeen vasta kun ikkuna on kuukausia eikä kaksi viikkoa: rajaton tuntitason
 * toisto (`RRULE:FREQ=HOURLY;INTERVAL=2`) tuottaa 16 kuukauden ikkunaan 5840
 * riviä eli yli megatavun JSONia yhdestä ainoasta tapahtumasta, ja se
 * kirjoitettaisiin `provider_cache`-riviksi 15 minuutin välein. 14 päivän
 * ikkunassa sama tapahtuma oli 180 riviä eikä ongelmaa ollut.
 *
 * 1500 on valittu mitatun todellisen ylärajan mukaan: laillinen päivittäinen
 * toisto tuottaa koko ikkunaan 487 riviä, ja kahden vuorokauden mittainen
 * päivittäin toistuva jakso noin 970. Katto on siis reilusti yli kaiken
 * uskottavan oikean käytön mutta selvästi alle karanneen toiston.
 *
 * Katkaisu säilyttää AIKAISIMMAT rivit (esiintymät tulevat aikajärjestyksessä),
 * jotta kortin oma kahden viikon ikkuna on aina oikein silloinkin kun kaukaiset
 * kuukaudet jäävät vajaiksi. `covered` ei muutu tästä: yksi karannut tapahtuma
 * ei saa muuttaa koko kalenteria tuntemattomaksi.
 */
export const MAX_EVENT_ROWS = 1500;

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

/**
 * Ensimmäinen ja viimeinen paikallinen päivä (YYYY-MM-DD) jotka seurassa
 * kulkeva `events` kattaa. Kenttä kuvaa AINA juuri sitä tapahtumalistaa jonka
 * mukana se tulee: dashboardin karsittu vastaus jättää sen pois sen sijaan
 * että väittäisi kattavansa koko laajennetun ikkunan.
 */
export interface CalendarCoverage {
  fromKey: string;
  toKey: string;
}

export interface CalendarData {
  /**
   * Chronological, recurrences already expanded. A multi-day event contributes
   * one row per day it touches within the window — see `dateKey` and `span` on
   * CalendarEvent. Ikkunan laajuus kerrotaan `coverage`-kentässä.
   */
  events: CalendarEvent[];
  /**
   * Puuttuu kun kattavuutta ei tiedetä: joko vanhasta `provider_cache`-rivistä
   * luettu hyötykuorma (kirjoitettu ennen kuin tätä kenttää oli) tai
   * tarkoituksella karsittu vastaus. Puuttuva kattavuus tarkoittaa "emme
   * tiedä", ei "ei tapahtumia" — ks. buildCalendarMonth.
   */
  coverage?: CalendarCoverage;
}

/** Yhden VEVENTin laajennuksen tulos. */
export interface EventExpansion {
  events: CalendarEvent[];
  /**
   * Tosi kun rivikatto (MAX_EVENT_ROWS) tuli vastaan, eli tapahtuman kaukaisimmat
   * esiintymät jätettiin pois. Erillinen kenttä eikä pääteltävä rivimäärästä:
   * tasan katon verran rivejä voisi periaatteessa syntyä myös laillisesti.
   */
  capped: boolean;
}

/** Yksi ohitettu tai katkaistu tapahtuma — ks. expandCalendarEvents. */
export interface EventProblem {
  uid: string;
  title: string;
  /** "failed" = laajennus heitti eikä tapahtumasta saatu mitään; "capped" = rivikatto. */
  reason: "failed" | "capped";
  detail: string;
  /** Montako riviä tapahtumasta kaikesta huolimatta saatiin. */
  rows: number;
}

export interface CalendarExpansion {
  events: CalendarEvent[];
  problems: EventProblem[];
}

/** Yhden kuukauden näkymä, ks. GET /api/calendar/month. */
export interface CalendarMonth {
  /** "YYYY-MM" */
  month: string;
  /**
   * Päiväavain ("YYYY-MM-DD") → sen päivän tapahtumat aikajärjestyksessä.
   * Päivä jolla ei ole tapahtumia PUUTTUU kokonaan — tyhjää taulukkoa ei
   * kirjoiteta. Monipäiväinen tapahtuma esiintyy jokaisena päivänään omana
   * rivinään (sama sopimus kuin CalendarEvent.dateKey/span jo käyttää).
   */
  days: Record<string, CalendarEvent[]>;
  /**
   * Kattaako lähdedata tämän kuukauden. false = emme tiedä, EI "ei
   * tapahtumia". Näiden sekoittaminen on tämän ominaisuuden helpoin tapa
   * valehdella: tyhjä maaliskuu näyttäisi samalta kuin hakematon maaliskuu.
   */
  covered: boolean;
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

/** Hyväksytty kuukausiavain: nelinumeroinen vuosi ja kuukausi 01-12. */
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Kelpaako arvo kuukausiavaimeksi. Tyyppivartija, koska arvo tulee
 * kyselymerkkijonosta: TypeScriptin `string` ei kerro ajonaikana mitään, ja
 * ilman tätä "2026-13" tai "kissa" päätyisi kuukausiaritmetiikkaan ja
 * tuottaisi NaN-avaimia.
 */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY_PATTERN.test(value);
}

/**
 * Siirtää "YYYY-MM"-avainta kuukausilla. Puhdasta aritmetiikkaa ilman
 * Date-oliota: kuukausiraja on paikallinen käsite, ja `new Date(y, m, 1)`
 * lukisi käyttöjärjestelmän aikavyöhykkeen — Raspberry Pi OS:n oletus on UTC
 * (ks. core/time.ts), jolloin kehityskoneella mikään ei näyttäisi vialta.
 */
export function shiftMonthKey(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const total = (y ?? 1970) * 12 + ((m ?? 1) - 1) + months;
  const year = Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * Kuukauden ensimmäinen ja viimeinen päivä paikallisina päiväavaimina.
 * Viimeinen päivä johdetaan seuraavan kuukauden ensimmäisestä, joten
 * karkausvuodet ja 30/31 päivän kuukaudet hoituvat ilman omaa taulukkoa.
 */
export function monthDayRange(monthKey: string): { fromKey: string; toKey: string } {
  return {
    fromKey: `${monthKey}-01`,
    toKey: shiftDateKey(`${shiftMonthKey(monthKey, 1)}-01`, -1),
  };
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
 * Tämän ansiosta silmukka on aina rajattu ikkunan omaan pituuteen riippumatta
 * tapahtuman todellisesta kestosta, joten MAX_EVENT_SPAN_DAYS ei enää tarvitse
 * rajata silmukkaa — se rajaa vain `totalDays`-luvun luotettavuutta (ks.
 * `truncated`).
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
 * Laajennuksen ydin. Hakuväli [from, to] annetaan hetkinä (node-ical tarvitsee
 * ne sellaisina), mutta päivärajat erikseen avaimina — nämä kaksi eivät ole
 * sama asia. Hetkiväli saa olla reilusti päivärajojen ulkopuolella, koska
 * ylimenevät päivät karsiutuvat joka tapauksessa daysForInstancessa. Juuri sitä
 * expandEventForDays käyttää hyväkseen.
 */
function expandInWindow(
  event: VEvent,
  from: Date,
  to: Date,
  windowFromKey: string,
  windowToKey: string,
): EventExpansion {
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
      // Katko keskeltä eikä lopusta: rivit ovat aikajärjestyksessä, joten
      // katkaisu tässä säilyttää aikaisimmat ja pudottaa kaukaisimmat.
      if (events.length >= MAX_EVENT_ROWS) return { events, capped: true };

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
  return { events, capped: false };
}

/**
 * Laajentaa yhden VEVENTin (toistuva tai ei) CalendarEvent-riveiksi ikkunassa
 * [from, to] — yksi rivi jokaista päivää kohti jota tapahtuma koskee, jotta
 * monipäiväinen tapahtuma näkyy kortissa joka päivänään eikä vain
 * alkupäivänään. Puhdas funktio (ei verkkokutsuja), joten testattavissa
 * käsin rakennetuilla VEVENT-olioilla.
 */
export function expandEvent(event: VEvent, from: Date, to: Date): CalendarEvent[] {
  return expandInWindow(event, from, to, localDateKey(from), localDateKey(to)).events;
}

/**
 * Sama laajennus, mutta ikkuna annetaan paikallisina päiväavaimina — juuri se
 * mitä sekä hakuikkuna että kuukausiraja oikeasti ovat.
 *
 * Hakuväli venytetään tarkoituksella vuorokaudella taakse ja kahdella
 * eteenpäin. Paikallinen keskiyö ei ole 00:00Z (Helsinki on UTC+2/+3), joten
 * suoraan avaimesta rakennettu `${key}T00:00:00Z` osuisi vasta paikallisen
 * keskiyön JÄLKEEN ja pudottaisi ensimmäisen ikkunapäivän varhaiset
 * tapahtumat. Väljyys ei voi tuoda mukanaan ylimääräisiä päiviä, koska
 * päivärajat tulevat avaimista eivätkä hetkistä.
 */
export function expandEventForDays(event: VEvent, windowFromKey: string, windowToKey: string): EventExpansion {
  const from = new Date(Date.parse(`${windowFromKey}T00:00:00Z`) - DAY_MS);
  const to = new Date(Date.parse(`${windowToKey}T00:00:00Z`) + 2 * DAY_MS);
  return expandInWindow(event, from, to, windowFromKey, windowToKey);
}

/**
 * Laajentaa koko jäsennetyn kalenterin. Yksikään yksittäinen VEVENT ei saa
 * kaataa tätä: `ical.expandRecurringEvent` heittää rajattomalla tuntitason
 * toistolla ("Maximum iterations (10000) exceeded in all()"), ja ilman
 * per-tapahtuma-try/catchia yksi tällainen merkintä veisi koko kalenterin.
 * Se olisi erityisen ilkeä vika, koska ICS ei muutu itsestään: haku kaatuisi
 * joka kierroksella samalla tavalla, katkaisija ei avautuisi (virhe ei ole
 * FatalProviderError), ja kortti jäisi pysyvästi virheeseen. Sama vikaluokka
 * kuin Wilmasta juuri korjattu jumi, josta ei pääse ulos ilman
 * uudelleenkäynnistystä.
 *
 * Ongelmat palautetaan kutsujalle sen sijaan että ne lokitettaisiin täällä:
 * lokitus kuuluu hakukierroksen tasolle, jossa tiedetään onko kyse uudesta
 * ongelmasta vai samasta joka 15. minuutti (ks. reportEventProblems).
 */
export function expandCalendarEvents(
  parsed: CalendarResponse,
  windowFromKey: string,
  windowToKey: string,
): CalendarExpansion {
  const events: CalendarEvent[] = [];
  const problems: EventProblem[] = [];

  for (const item of Object.values(parsed)) {
    if (!item || typeof item !== "object" || item.type !== "VEVENT") continue;
    const event = item as VEvent;
    const uid = typeof event.uid === "string" && event.uid ? event.uid : "(uid puuttuu)";
    const title = textValue(event.summary) || "(nimetön)";

    try {
      // Handles both plain events and RRULE recurrence, EXDATE exclusions,
      // RECURRENCE-ID overrides, and multi-day expansion.
      const expansion = expandEventForDays(event, windowFromKey, windowToKey);
      events.push(...expansion.events);
      if (expansion.capped) {
        problems.push({ uid, title, reason: "capped", detail: `rivikatto ${MAX_EVENT_ROWS} täynnä`, rows: expansion.events.length });
      }
    } catch (err) {
      problems.push({ uid, title, reason: "failed", detail: err instanceof Error ? err.message : String(err), rows: 0 });
    }
  }

  return { events, problems };
}

/**
 * Kokoaa yhden kuukauden näkymän jo laajennetusta datasta. Puhdas funktio: ei
 * verkkoa, ei laajennusta, ei providerin tilaa — reitti (routes/api.ts) vain
 * syöttää tähän viimeisimmän hyötykuorman. Siksi myös mahdoton kuukausi
 * (vuosi 3000) on ilmainen: se ei osu kattavuuteen, joten mitään ei lasketa.
 *
 * `covered` vaatii että lähdedata kattaa kuukauden KOKONAAN, ja osittain
 * katettu kuukausi palautetaan tyhjänä eikä vajaana: vajaa kuukausi näyttäisi
 * käyttöliittymässä täsmälleen samalta kuin oikeasti hiljainen kuukausi, ja
 * juuri se sekaannus on tämän ominaisuuden helpoin tapa valehdella.
 */
export function buildCalendarMonth(month: string, data: CalendarData | null): CalendarMonth {
  const { fromKey, toKey } = monthDayRange(month);
  const coverage = data?.coverage;
  const covered = Boolean(coverage && coverage.fromKey <= fromKey && coverage.toKey >= toKey);

  const days: Record<string, CalendarEvent[]> = {};
  if (covered && data) {
    for (const event of data.events) {
      // Päiväavaimet ovat YYYY-MM-DD, joten merkkijonovertailu on samalla
      // aikajärjestysvertailu — Date-olioita ei tarvita eikä haluta.
      if (event.dateKey < fromKey || event.dateKey > toKey) continue;
      const list = days[event.dateKey];
      if (list) list.push(event);
      else days[event.dateKey] = [event];
    }
    // Provider lajittelee jo, mutta vanha välimuistirivi on voitu kirjoittaa
    // millä tahansa aiemmalla versiolla — päiväkohtainen järjestys varmistetaan
    // tässä sen sijaan että luotettaisiin siihen mitä levyltä sattui tulemaan.
    for (const list of Object.values(days)) list.sort((a, b) => a.start.localeCompare(b.start));
  }

  return { month, days, covered };
}

/**
 * Rajaa hyötykuorman kalenterikortin omaan 14 päivän ikkunaan.
 *
 * Säilyttää tarkoituksella vanhan käyttäytymisen siltä ajalta kun provider
 * laajensi vain 14 päivää hakuhetkestä: tänään jo päättynyt tapahtuma ei näy
 * kortissa (`end > now`), koska se putosi ennenkin pois — expandRecurringEventin
 * hakuväli alkoi hakuhetkestä. Ilman tuota ehtoa aamun palaveri jäisi kortille
 * roikkumaan koko loppupäiväksi, mikä olisi näkyvä muutos jota kukaan ei
 * pyytänyt.
 *
 * `coverage` jätetään pois: karsittu lista ei kata laajennettua ikkunaa, eikä
 * puolitotuus ole tässä parempi kuin "emme tiedä". Kuukausinäkymä lukee
 * kattavuuden providerin omasta tilasta, ei dashboardin vastauksesta.
 */
export function trimToDashboardWindow(data: CalendarData, now: Date = new Date()): CalendarData {
  const fromKey = localDateKey(now);
  const toKey = shiftDateKey(fromKey, DASHBOARD_WINDOW_DAYS);
  const nowMs = now.getTime();

  const events = data.events.filter(
    (event) => event.dateKey >= fromKey && event.dateKey <= toKey && Date.parse(event.end) > nowMs,
  );
  return { events };
}

/**
 * Ongelmat joista on jo kirjoitettu lokiin. Sama periaate kuin providerin omalla
 * tilamuutoslokituksella (ks. core/provider.ts): rikkinäinen kalenterimerkintä
 * ei muutu itsestään, joten se kirjoittaisi rivin joka 15. minuutti — eli
 * hukuttaisi lokin juuri sillä tiedolla jonka takia loki on olemassa. Muisti
 * korvataan joka kierroksella nykyisillä ongelmilla, jotta korjattu ja sitten
 * uudelleen rikkoutunut tapahtuma raportoidaan uudestaan.
 */
const reportedEventProblems = new Set<string>();

export function reportEventProblems(problems: EventProblem[]): void {
  const current = new Set<string>();
  for (const problem of problems) {
    const key = `${problem.uid}:${problem.reason}`;
    current.add(key);
    if (reportedEventProblems.has(key)) continue;

    // warn, ei error: kalenteri kokonaisuutena toimii yhä, ja loput
    // tapahtumista näkyvät normaalisti. Otsikko mukaan, koska UID on
    // ihmiselle täysin läpinäkymätön eikä vikaa voi korjata kalenterissa
    // ilman että tietää mistä merkinnästä on kyse.
    logger.warn(
      {
        event: problem.reason === "failed" ? "calendar_event_skipped" : "calendar_event_capped",
        uid: problem.uid,
        title: problem.title,
        rows: problem.rows,
        detail: problem.detail,
      },
      problem.reason === "failed"
        ? "kalenterimerkinnän laajennus epäonnistui — merkintä ohitettiin, muu kalenteri näytetään"
        : "kalenterimerkintä tuotti liikaa rivejä — kaukaisimmat esiintymät jätettiin pois",
    );
  }

  reportedEventProblems.clear();
  for (const key of current) reportedEventProblems.add(key);
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

  // Ikkuna rajataan kokonaisiin paikallisiin kuukausiin eikä "±n päivää
  // nyt-hetkestä": kuukausinäkymän `covered` on kuukausikohtainen väite, ja
  // päiväpohjainen ikkuna tekisi siitä sattumanvaraisen kuukausien reunoilla.
  const currentMonth = localDateKey().slice(0, 7);
  const { fromKey } = monthDayRange(shiftMonthKey(currentMonth, -WINDOW_MONTHS_BACK));
  const { toKey } = monthDayRange(shiftMonthKey(currentMonth, WINDOW_MONTHS_FORWARD));

  const { events, problems } = expandCalendarEvents(parsed, fromKey, toKey);
  reportEventProblems(problems);

  // dateKey ensisijaisena avaimena pitää päiväryhmät oikeassa järjestyksessä,
  // vaikka monipäiväisen tapahtuman kaikki rivit jakavat saman `start`-hetken.
  events.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.start.localeCompare(b.start));

  return { events, coverage: { fromKey, toKey } };
}

export function createCalendarProvider(): Provider<CalendarData> {
  return new Provider<CalendarData>({
    id: "calendar",
    intervalMs: 15 * 60 * 1000,
    initialDelayMs: 10_000,
    fetch: fetchCalendar,
  });
}
