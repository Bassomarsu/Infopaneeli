/**
 * Kalenterin kuukausinäkymän datapuoli (GET /api/calendar/month, ks.
 * server/src/providers/calendar.ts): kuukausiaritmetiikka, päiväkohtainen
 * ryhmittely, kattavuuden rehellisyys ja dashboardin karsittu ikkuna.
 *
 * Tämän testin tärkein tehtävä on pitää kuukausiraja PAIKALLISENA
 * (Europe/Helsinki). Siksi kesäajan vaihtokuukausien reunat testataan
 * nimenomaan hetkillä jotka ovat UTC:ssä eri kuukautta kuin Helsingissä:
 * 2026-03-31T21:15Z on Helsingissä jo huhtikuuta ja 2026-10-31T22:15Z jo
 * marraskuuta. UTC-pohjainen toteutus läpäisisi kaikki muut testit mutta
 * kaatuisi näihin.
 *
 * Toinen tehtävä on erottaa "emme tiedä" sanasta "ei tapahtumia": kattamaton
 * tai vain osittain katettu kuukausi palautuu tyhjänä JA `covered: false`,
 * eikä tyhjä kuukausi saa koskaan näyttää katetulta.
 *
 * Koko päivän tapahtumien `VALUE=DATE`-tulkinnasta ks. calendar-events.ts:n
 * alkukommentti — node-ical lukee ne prosessin omassa aikavyöhykkeessä, joten
 * ne ovat itsessään johdonmukaisia ajopaikasta riippumatta. Kellonaikaan
 * sidotut tapahtumat (joita tämän testin rajatapaukset käyttävät) ovat aitoja
 * hetkiä, ja niiden päiväraja lasketaan aina Helsingin ajassa.
 *
 * Aja:  npm run test:calendar-month --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import ical from "node-ical";
import type { VEvent } from "node-ical";
import { config } from "../src/core/config.ts";
import {
  buildCalendarMonth,
  expandCalendarEvents,
  expandEventForDays,
  isMonthKey,
  MAX_EVENT_ROWS,
  monthDayRange,
  reportEventProblems,
  shiftMonthKey,
  trimToDashboardWindow,
  type CalendarData,
  type CalendarEvent,
  type EventProblem,
} from "../src/providers/calendar.ts";

/**
 * Lokirivien luku samalla tavalla kuin provider-transitions.ts:ssä: pino
 * kirjoittaa asynkronisen transportin läpi, joten lokitettu rivi ei ole vielä
 * levyllä. Odotetaan odotettu määrä ja rauhoitutaan sen jälkeen hetki, jotta
 * YLIMÄÄRÄISIÄ rivejä tuottava bugi kaataa väitteen sen sijaan että testi
 * kiitäisi ohi.
 */
function logLines(event: string, uid: string): Array<Record<string, unknown>> {
  let files: string[];
  try {
    files = fs.readdirSync(config.logDir);
  } catch {
    return [];
  }
  const file = files
    .filter((name) => name.endsWith(".log"))
    .map((name) => `${config.logDir}/${name}`)
    .sort()
    .at(-1);
  if (!file) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === event && entry["uid"] === uid);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitLogLines(
  event: string,
  uid: string,
  expected: number,
  timeoutMs = 5_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && logLines(event, uid).length < expected) {
    await sleep(50);
  }
  await sleep(250);
  return logLines(event, uid);
}

function buildIcs(veventBlocks: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//infonaytto//calendar-month-test//EN",
    ...veventBlocks,
    "END:VCALENDAR",
  ].join("\r\n");
}

let uidCounter = 0;
function vevent(summary: string, lines: string[]): string {
  uidCounter += 1;
  return [
    "BEGIN:VEVENT",
    `UID:test-${process.pid}-${uidCounter}@infonaytto`,
    "DTSTAMP:20260101T000000Z",
    `SUMMARY:${summary}`,
    ...lines,
    "END:VEVENT",
  ].join("\r\n");
}

function parseEvents(veventBlocks: string[]): VEvent[] {
  const parsed = ical.sync.parseICS(buildIcs(veventBlocks));
  return Object.values(parsed).filter(
    (item): item is VEvent => Boolean(item) && typeof item === "object" && item.type === "VEVENT",
  );
}

/**
 * Rakentaa providerin hyötykuorman samalla polulla kuin fetchCalendar: jäsennä
 * ICS, laajenna päiväavaimilla rajattuun ikkunaan, lajittele. Näin testit
 * kohdistuvat samaan ketjuun jota tuotanto käyttää, eivät käsin väärennettyihin
 * riveihin.
 */
function calendarData(veventBlocks: string[], fromKey: string, toKey: string): CalendarData {
  const events: CalendarEvent[] = [];
  for (const event of parseEvents(veventBlocks)) {
    events.push(...expandEventForDays(event, fromKey, toKey).events);
  }
  events.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.start.localeCompare(b.start));
  return { events, coverage: { fromKey, toKey } };
}

/** Kuukauden päiväavaimet ja kunkin päivän otsikot — riittävä tiiviste vertailuun. */
function titlesByDay(data: CalendarData, month: string): Record<string, string[]> {
  const result = buildCalendarMonth(month, data);
  const out: Record<string, string[]> = {};
  for (const [dateKey, events] of Object.entries(result.days)) {
    out[dateKey] = events.map((event) => event.title);
  }
  return out;
}

function testMonthKeyValidation(): void {
  for (const valid of ["2026-01", "2026-12", "1999-07", "3000-05"]) {
    assert.equal(isMonthKey(valid), true, `${valid} pitää kelvata kuukausiavaimeksi`);
  }
  // "2026-1" ja "2026-013" ovat tässä olennaisimmat: kumpikin menisi läpi
  // löysästä /^\d{4}-\d{1,2}/-tarkistuksesta ja tuottaisi vääriä päiväavaimia.
  for (const invalid of ["2026-00", "2026-13", "2026-1", "2026-013", "26-01", "2026", "2026-1a", "", "kissa"]) {
    assert.equal(isMonthKey(invalid), false, `${invalid} ei saa kelvata kuukausiavaimeksi`);
  }
  for (const invalid of [undefined, null, 202601, ["2026-01"], { month: "2026-01" }]) {
    assert.equal(isMonthKey(invalid), false, "vain merkkijono saa kelvata");
  }
  console.log("ok  kuukausiavaimen validointi hylkää kaiken muun kuin YYYY-MM:n");
}

function testMonthArithmetic(): void {
  assert.equal(shiftMonthKey("2026-01", -1), "2025-12", "vuosiraja taaksepäin");
  assert.equal(shiftMonthKey("2026-12", 1), "2027-01", "vuosiraja eteenpäin");
  assert.equal(shiftMonthKey("2026-03", -3), "2025-12", "hakuikkunan taaksepäin-siirto");
  assert.equal(shiftMonthKey("2026-03", 12), "2027-03", "hakuikkunan eteenpäin-siirto");
  assert.equal(shiftMonthKey("2026-06", 0), "2026-06");

  assert.deepEqual(monthDayRange("2026-02"), { fromKey: "2026-02-01", toKey: "2026-02-28" }, "tavallinen helmikuu");
  assert.deepEqual(monthDayRange("2028-02"), { fromKey: "2028-02-01", toKey: "2028-02-29" }, "karkausvuoden helmikuu");
  assert.deepEqual(monthDayRange("2026-04"), { fromKey: "2026-04-01", toKey: "2026-04-30" }, "30 päivän kuukausi");
  assert.deepEqual(monthDayRange("2026-12"), { fromKey: "2026-12-01", toKey: "2026-12-31" }, "joulukuu");
  console.log("ok  kuukausiaritmetiikka kestää vuosirajat, karkausvuodet ja eripituiset kuukaudet");
}

function testSpringDstMonthBoundary(): void {
  // Kesäaika alkaa 29.3.2026, joten 31.3. Helsinki on UTC+3.
  //   20:00Z -> 31.3. klo 23:00 (maaliskuuta)
  //   21:15Z -> 1.4.  klo 00:15 (huhtikuuta)
  // UTC:ssä molemmat ovat 31.3. — juuri se ero jonka takia tämä testi on
  // olemassa.
  const data = calendarData(
    [
      vevent("Maaliskuun viimeinen", ["DTSTART:20260331T200000Z", "DTEND:20260331T210000Z"]),
      vevent("Huhtikuun ensimmäinen", ["DTSTART:20260331T211500Z", "DTEND:20260331T221500Z"]),
      vevent("Kesäajan vaihtopäivä ennen", ["DTSTART:20260329T003000Z", "DTEND:20260329T010000Z"]),
      vevent("Kesäajan vaihtopäivä jälkeen", ["DTSTART:20260329T013000Z", "DTEND:20260329T020000Z"]),
    ],
    "2026-02-01",
    "2026-05-31",
  );

  assert.deepEqual(titlesByDay(data, "2026-03"), {
    // Sama paikallinen päivä kellojen siirrosta huolimatta: 02:30 on ennen
    // siirtoa ja 04:30 sen jälkeen, mutta kumpikin on 29.3.
    "2026-03-29": ["Kesäajan vaihtopäivä ennen", "Kesäajan vaihtopäivä jälkeen"],
    "2026-03-31": ["Maaliskuun viimeinen"],
  });
  assert.deepEqual(titlesByDay(data, "2026-04"), {
    "2026-04-01": ["Huhtikuun ensimmäinen"],
  });
  console.log("ok  kevään kesäaikakuukauden raja on paikallinen, ei UTC (31.3. klo 23 vs. 1.4. klo 00:15)");
}

function testAutumnDstMonthBoundary(): void {
  // Kesäaika päättyy 25.10.2026, joten 31.10. Helsinki on UTC+2.
  //   21:00Z -> 31.10. klo 23:00 (lokakuuta)
  //   22:15Z -> 1.11.  klo 00:15 (marraskuuta)
  const data = calendarData(
    [
      vevent("Lokakuun viimeinen", ["DTSTART:20261031T210000Z", "DTEND:20261031T213000Z"]),
      vevent("Marraskuun ensimmäinen", ["DTSTART:20261031T221500Z", "DTEND:20261031T224500Z"]),
    ],
    "2026-09-01",
    "2026-12-31",
  );

  assert.deepEqual(titlesByDay(data, "2026-10"), { "2026-10-31": ["Lokakuun viimeinen"] });
  assert.deepEqual(titlesByDay(data, "2026-11"), { "2026-11-01": ["Marraskuun ensimmäinen"] });
  console.log("ok  syksyn kesäaikakuukauden raja on paikallinen, ei UTC (31.10. klo 23 vs. 1.11. klo 00:15)");
}

function testWindowEdgesIncludeLocalMidnightEvents(): void {
  // Ikkunan ensimmäisen ja viimeisen päivän reunatapahtumat. Kumpikin katoaisi,
  // jos hakuväli rakennettaisiin suoraan avaimesta muodossa
  // `${key}T00:00:00Z`: paikallinen keskiyö on Helsingissä 21:00Z tai 22:00Z
  // EDELLISENÄ päivänä, joten tarkka UTC-keskiyö osuu vasta paikallisen
  // vuorokauden alettua ja ohittaa vuorokauden viimeiset tunnit.
  const events = parseEvents([
    // 28.2. klo 22:15Z = 1.3. klo 00:15 Helsinki (talviaika, UTC+2).
    vevent("Kuun ensimmäinen yö", ["DTSTART:20260228T221500Z", "DTEND:20260228T231500Z"]),
    // 31.3. klo 20:45Z = 31.3. klo 23:45 Helsinki (kesäaika, UTC+3).
    vevent("Kuun viimeinen yö", ["DTSTART:20260331T204500Z", "DTEND:20260331T211500Z"]),
  ]);

  const rows: CalendarEvent[] = [];
  for (const event of events) rows.push(...expandEventForDays(event, "2026-03-01", "2026-03-31").events);

  assert.deepEqual(
    rows.map((row) => ({ title: row.title, dateKey: row.dateKey })),
    [
      { title: "Kuun ensimmäinen yö", dateKey: "2026-03-01" },
      { title: "Kuun viimeinen yö", dateKey: "2026-03-31" },
    ],
  );
  console.log("ok  ikkunan ensimmäisen ja viimeisen vuorokauden yötapahtumat pysyvät mukana");
}

function testMultiDayEventAcrossMonthBoundary(): void {
  // 30.3.-2.4.2026 (DTEND 3.4. eksklusiivinen) = 4 päivää kahden kuukauden yli.
  const data = calendarData(
    [vevent("Kevätleiri", ["DTSTART;VALUE=DATE:20260330", "DTEND;VALUE=DATE:20260403"])],
    "2026-02-01",
    "2026-05-31",
  );

  const march = buildCalendarMonth("2026-03", data);
  const april = buildCalendarMonth("2026-04", data);

  // Jokainen päivä omana rivinään, ja "monesko päivä" -numerointi jatkuu
  // kuukauden vaihtuessa — ei nollaudu huhtikuun alkuun.
  assert.deepEqual(
    Object.entries(march.days).map(([dateKey, list]) => [dateKey, list[0]?.span]),
    [
      ["2026-03-30", { day: 1, totalDays: 4 }],
      ["2026-03-31", { day: 2, totalDays: 4 }],
    ],
  );
  assert.deepEqual(
    Object.entries(april.days).map(([dateKey, list]) => [dateKey, list[0]?.span]),
    [
      ["2026-04-01", { day: 3, totalDays: 4 }],
      ["2026-04-02", { day: 4, totalDays: 4 }],
    ],
  );
  console.log("ok  monipäiväinen tapahtuma näkyy kummassakin kuukaudessa oikealla numeroinnilla");
}

function testRecurringEventFillsWholeMonth(): void {
  // Joka torstai 5.3.2026 alkaen, 20 kertaa — ulottuu maaliskuusta heinäkuuhun.
  const data = calendarData(
    [
      vevent("Harrastus", [
        "DTSTART:20260305T150000Z",
        "DTEND:20260305T160000Z",
        "RRULE:FREQ=WEEKLY;COUNT=20",
      ]),
    ],
    "2026-02-01",
    "2026-05-31",
  );

  // Maaliskuun 2026 torstait: 5., 12., 19., 26.
  assert.deepEqual(Object.keys(buildCalendarMonth("2026-03", data).days), [
    "2026-03-05",
    "2026-03-12",
    "2026-03-19",
    "2026-03-26",
  ]);
  // Huhtikuun torstait: 2., 9., 16., 23., 30. Toisto siis jatkuu kuukaudesta
  // toiseen eikä katkea ikkunan sisällä.
  assert.deepEqual(Object.keys(buildCalendarMonth("2026-04", data).days), [
    "2026-04-02",
    "2026-04-09",
    "2026-04-16",
    "2026-04-23",
    "2026-04-30",
  ]);
  // Helmikuu on katettu mutta tyhjä: päiviä ei ole yhtään, ja se on eri asia
  // kuin kattamaton kuukausi.
  const february = buildCalendarMonth("2026-02", data);
  assert.equal(february.covered, true, "helmikuu on ikkunan sisällä, joten se on katettu");
  assert.deepEqual(february.days, {}, "katettu mutta tapahtumaton kuukausi on tyhjä");
  console.log("ok  toistuva tapahtuma laajenee jokaiseen kuukauteen, ja tyhjä kuukausi on silti katettu");
}

function testEmptyDaysAreAbsent(): void {
  const data = calendarData(
    [vevent("Yksinäinen", ["DTSTART:20260610T080000Z", "DTEND:20260610T090000Z"])],
    "2026-06-01",
    "2026-06-30",
  );
  const result = buildCalendarMonth("2026-06", data);

  assert.deepEqual(Object.keys(result.days), ["2026-06-10"], "vain tapahtumapäivä saa olla avaimena");
  assert.equal(result.days["2026-06-09"], undefined, "tapahtumaton päivä puuttuu kokonaan");
  assert.equal("2026-06-09" in result.days, false, "tyhjää taulukkoa ei kirjoiteta");
  console.log("ok  tapahtumattomia päiviä ei kirjoiteta tyhjinä taulukkoina");
}

function testEventsWithinDayAreChronological(): void {
  // Käsin käänteiseen järjestykseen rakennettu hyötykuorma: vanha
  // välimuistirivi on voitu kirjoittaa millä tahansa aiemmalla versiolla,
  // joten päiväkohtaista järjestystä ei saa jättää lähteen varaan.
  const row = (title: string, start: string): CalendarEvent => ({
    id: `${title}:${start}`,
    title,
    start,
    end: start,
    allDay: false,
    location: null,
    dateKey: "2026-05-04",
  });
  const data: CalendarData = {
    events: [
      row("Ilta", "2026-05-04T15:00:00.000Z"),
      row("Aamu", "2026-05-04T05:00:00.000Z"),
      row("Keskipäivä", "2026-05-04T09:00:00.000Z"),
    ],
    coverage: { fromKey: "2026-05-01", toKey: "2026-05-31" },
  };

  assert.deepEqual(buildCalendarMonth("2026-05", data).days["2026-05-04"]?.map((e) => e.title), [
    "Aamu",
    "Keskipäivä",
    "Ilta",
  ]);
  console.log("ok  päivän tapahtumat palautuvat aikajärjestyksessä lähteen järjestyksestä riippumatta");
}

function testUncoveredMonths(): void {
  const data = calendarData(
    [vevent("Kesäkuun tapahtuma", ["DTSTART:20260610T080000Z", "DTEND:20260610T090000Z"])],
    "2026-03-01",
    "2027-03-31",
  );

  // Ikkunan ulkopuolinen kuukausi kumpaankin suuntaan.
  for (const month of ["2026-02", "2027-04"]) {
    const result = buildCalendarMonth(month, data);
    assert.equal(result.covered, false, `${month} on ikkunan ulkopuolella`);
    assert.deepEqual(result.days, {});
    assert.equal(result.month, month, "pyydetty kuukausi palautuu sellaisenaan");
  }

  // Kohtuuton mutta muodollisesti kelvollinen kuukausi: ei laajennusta, ei
  // kaatumista, vain rehellinen "emme tiedä".
  const far = buildCalendarMonth("3000-01", data);
  assert.equal(far.covered, false);
  assert.deepEqual(far.days, {});

  // Ei dataa lainkaan (provider ei ole vielä hakenut kertaakaan).
  const none = buildCalendarMonth("2026-06", null);
  assert.equal(none.covered, false, "hakematon kalenteri ei ole katettu");
  assert.deepEqual(none.days, {});

  console.log("ok  kattamaton, mahdoton ja hakematon kuukausi palautuvat tyhjinä ja covered: false");
}

function testMissingCoverageIsNotCovered(): void {
  // Vanha `provider_cache`-rivi: tapahtumat ovat tallessa mutta kattavuutta ei
  // ole kirjattu. Tällöin ei voi tietää mitä ikkunaa lista edustaa — "on
  // tapahtumia" ei ole todiste kattavuudesta.
  const withCoverage = calendarData(
    [vevent("Vanha rivi", ["DTSTART:20260610T080000Z", "DTEND:20260610T090000Z"])],
    "2026-06-01",
    "2026-06-30",
  );
  const legacy: CalendarData = { events: withCoverage.events };
  assert.ok(legacy.events.length > 0, "testin oletus: rivejä on olemassa");

  const result = buildCalendarMonth("2026-06", legacy);
  assert.equal(result.covered, false, "kattavuutta ilmoittamaton hyötykuorma ei ole katettu");
  assert.deepEqual(result.days, {}, "kattamattomasta kuukaudesta ei palauteta vajaata listaa");
  console.log("ok  kattavuustiedoton (vanha välimuisti) hyötykuorma ei väitä kattavansa mitään");
}

function testPartialCoverageIsNotCovered(): void {
  // Kattavuus alkaa kesken helmikuun. Helmikuussa on tapahtumia, mutta vain
  // osa kuukaudesta tunnetaan — vajaa kuukausi näyttäisi käyttöliittymässä
  // samalta kuin hiljainen kuukausi, joten se palautetaan tyhjänä.
  const data = calendarData(
    [vevent("Loppukuun tapahtuma", ["DTSTART:20260220T080000Z", "DTEND:20260220T090000Z"])],
    "2026-02-15",
    "2026-05-31",
  );
  assert.ok(
    data.events.some((event) => event.dateKey === "2026-02-20"),
    "testin oletus: helmikuussa on tapahtuma kattavuuden sisällä",
  );

  const february = buildCalendarMonth("2026-02", data);
  assert.equal(february.covered, false, "vain osittain katettu kuukausi ei ole katettu");
  assert.deepEqual(february.days, {}, "vajaata kuukautta ei palauteta täytenä");

  // Seuraava kokonaan katettu kuukausi on silti normaali.
  assert.equal(buildCalendarMonth("2026-03", data).covered, true);
  console.log("ok  osittain katettu kuukausi on covered: false eikä palauta vajaata listaa");
}

function testDashboardTrim(): void {
  // Kortin ikkuna lasketaan pyyntöhetkestä. 15.3.2026 klo 09:00Z = Helsingissä
  // klo 11:00 (talviaika, kesäaika alkaa vasta 29.3.).
  const now = new Date("2026-03-15T09:00:00.000Z");

  const data = calendarData(
    [
      vevent("Eilen", ["DTSTART:20260314T080000Z", "DTEND:20260314T090000Z"]),
      vevent("Tänään ohi", ["DTSTART:20260315T060000Z", "DTEND:20260315T070000Z"]),
      vevent("Tänään kesken", ["DTSTART:20260315T080000Z", "DTEND:20260315T100000Z"]),
      vevent("Tänään myöhemmin", ["DTSTART:20260315T160000Z", "DTEND:20260315T170000Z"]),
      vevent("Ikkunan viimeinen", ["DTSTART:20260329T100000Z", "DTEND:20260329T110000Z"]),
      vevent("Ikkunan jälkeen", ["DTSTART:20260330T100000Z", "DTEND:20260330T110000Z"]),
    ],
    "2026-01-01",
    "2027-03-31",
  );

  const trimmed = trimToDashboardWindow(data, now);
  assert.deepEqual(
    trimmed.events.map((event) => event.title),
    ["Tänään kesken", "Tänään myöhemmin", "Ikkunan viimeinen"],
  );
  // Karsittu lista ei enää edusta laajennettua ikkunaa, joten se ei myöskään
  // saa väittää kattavansa sitä.
  assert.equal(trimmed.coverage, undefined, "karsitusta hyötykuormasta jätetään kattavuus pois");
  // Alkuperäistä ei muuteta: kuukausinäkymä lukee samaa oliota.
  assert.ok(data.events.length > trimmed.events.length, "karsinta ei saa muuttaa providerin omaa listaa");
  assert.ok(
    data.events.some((event) => event.title === "Ikkunan jälkeen"),
    "providerin oma lista säilyy koskemattomana",
  );
  console.log("ok  dashboardin karsinta jättää 14 päivän ikkunan ja pudottaa jo päättyneen tapahtuman");
}

function testDashboardTrimKeepsOngoingMultiDayEvent(): void {
  const now = new Date("2026-03-15T09:00:00.000Z");
  const data = calendarData(
    [vevent("Remontti", ["DTSTART;VALUE=DATE:20260310", "DTEND;VALUE=DATE:20260320"])],
    "2026-01-01",
    "2027-03-31",
  );

  const trimmed = trimToDashboardWindow(data, now);
  // Eilen ja sitä ennen olleet päivät putoavat pois, mutta tästä päivästä
  // eteenpäin jakso näkyy — juuri kuten ennen ikkunan laajentamista.
  assert.deepEqual(
    trimmed.events.map((event) => event.dateKey),
    ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19"],
  );
  assert.deepEqual(trimmed.events[0]?.span, { day: 6, totalDays: 10 }, "numerointi jatkuu jakson alusta");
  console.log("ok  käynnissä oleva monipäiväinen tapahtuma säilyy karsinnassa tästä päivästä eteenpäin");
}

function testEventCrossingMidnightAtMonthBoundary(): void {
  // REGRESSIOTESTI. 31.3.2026 klo 22:00 - 1.4.2026 klo 01:00 Helsingissä
  // (kesäaika, UTC+3, joten 19:00Z - 22:00Z saman UTC-vuorokauden sisällä).
  // Tapahtuma kuuluu MOLEMPIIN kuukausiin, omana rivinään kumpanakin päivänä.
  //
  // Kolme uskottavaa "siistimistä" rikkoisi tämän, kukin eri tavalla:
  //   1. maaliskuun ikkunan `to` UTC-keskiyönä tai kiinteänä +02:00-siirtona
  //      -> 2026-04-01 vuotaa maaliskuun päiviin,
  //   2. huhtikuun ikkunan `from` tarkalleen 2026-04-01T00:00:00Z
  //      -> tapahtuma (päättyy 22:00Z 31.3.) katoaa huhtikuusta KOKONAAN, ja
  //      jos se samalla vuoti maaliskuuhun, se on näkymätön joka näkymässä,
  //   3. maaliskuun ikkunan `to` viimeisen päivän paikallisena keskiyönä
  //      -> 31.3. illan tapahtumat katoavat.
  // Juuri siksi hetkiväli ja päiväavaimet ovat expandEventForDaysissa eri
  // asioita, eikä niitä saa yhdistää.
  const [event] = parseEvents([
    vevent("Yön yli", ["DTSTART:20260331T190000Z", "DTEND:20260331T220000Z"]),
  ]);
  assert.ok(event, "testifixtuuri puuttuu");

  const march = expandEventForDays(event, "2026-03-01", "2026-03-31").events;
  assert.deepEqual(
    march.map((row) => ({ dateKey: row.dateKey, span: row.span })),
    [{ dateKey: "2026-03-31", span: { day: 1, totalDays: 2 } }],
    "maaliskuun ikkuna: illan tapahtuma näkyy, mutta 1.4. ei saa vuotaa mukaan",
  );

  const april = expandEventForDays(event, "2026-04-01", "2026-04-30").events;
  assert.deepEqual(
    april.map((row) => ({ dateKey: row.dateKey, span: row.span })),
    [{ dateKey: "2026-04-01", span: { day: 2, totalDays: 2 } }],
    "huhtikuun ikkuna: edellisenä iltana alkanut tapahtuma ei saa kadota",
  );

  // Sama koko ikkunan laajennuksessa ja kuukausiviipaloinnissa: kumpikin päivä
  // päätyy omaan kuukauteensa, ei kumpikaan molempiin eikä kumpikaan hukkaan.
  const data = calendarData(
    [vevent("Yön yli", ["DTSTART:20260331T190000Z", "DTEND:20260331T220000Z"])],
    "2026-02-01",
    "2026-05-31",
  );
  assert.deepEqual(Object.keys(buildCalendarMonth("2026-03", data).days), ["2026-03-31"]);
  assert.deepEqual(Object.keys(buildCalendarMonth("2026-04", data).days), ["2026-04-01"]);

  console.log("ok  keskiyön yli kuukausirajalla jatkuva tapahtuma näkyy molemmissa kuukausissa eikä vuoda kumpaankaan väärin");
}

function testUnboundedRecurrenceDoesNotKillTheWholeCalendar(): void {
  // Rajaton tuntitason toisto saa node-icalin (rrule) heittämään 16 kuukauden
  // ikkunassa: "Maximum iterations (10000) exceeded in all()". 14 päivän
  // ikkunassa sama merkintä ei kaatanut mitään, joten tämä on nimenomaan
  // laajennetun ikkunan tuoma vika.
  //
  // Ilman per-tapahtuma-try/catchia yksi tällainen merkintä kaataisi koko
  // haun. ICS ei muutu itsestään, joten haku kaatuisi joka kierroksella
  // samalla tavalla eikä katkaisija avautuisi — kortti jäisi pysyvästi
  // virheeseen ja kuukausinäkymä pysyvästi tilaan covered: false.
  const parsed = ical.sync.parseICS(
    buildIcs([
      vevent("Karannut toisto", ["DTSTART:20260601T060000Z", "DTEND:20260601T070000Z", "RRULE:FREQ=HOURLY"]),
      vevent("Tavallinen palaveri", ["DTSTART:20260610T080000Z", "DTEND:20260610T090000Z"]),
      vevent("Tavallinen viikkotoisto", [
        "DTSTART:20260604T100000Z",
        "DTEND:20260604T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4",
      ]),
    ]),
  );

  const { events, problems } = expandCalendarEvents(parsed, "2026-06-01", "2027-09-30");

  // Terveet tapahtumat säilyvät kokonaan.
  assert.deepEqual(
    events.filter((row) => row.title === "Tavallinen palaveri").map((row) => row.dateKey),
    ["2026-06-10"],
  );
  assert.equal(
    events.filter((row) => row.title === "Tavallinen viikkotoisto").length,
    4,
    "viikkotoiston kaikki esiintymät säilyvät",
  );

  // Rikkinäinen merkintä raportoidaan, ei niellä hiljaa.
  assert.equal(problems.length, 1, "täsmälleen yksi ongelmallinen merkintä");
  assert.equal(problems[0]?.title, "Karannut toisto");
  // "failed" eikä vain "jompikumpi": rajaton tuntitoisto EI pääse rivikattoon
  // asti, vaan rrule heittää iteraatiorajallaan ensin. Jos tämä väite joskus
  // kaatuu siihen että arvo on "capped", kyse ei ole tämän suojan
  // rikkoutumisesta vaan node-icalin/rrulen päivittyneestä käytöksestä —
  // tarkista se ennen kuin löysäät väitettä.
  assert.equal(problems[0]?.reason, "failed", "kaatuva merkintä raportoidaan ohitettuna, ei katkaistuna");
  assert.match(
    problems[0]?.detail ?? "",
    /Maximum iterations/,
    "lokiin viedään laajennuksen oma virheilmoitus, ei keksittyä tekstiä",
  );

  console.log("ok  rajaton tuntitason toisto ohitetaan ja raportoidaan — muu kalenteri säilyy");
}

function testRunawayRecurrenceIsCapped(): void {
  // Tämä ei kaadu vaan tuottaa 5840 riviä (yli megatavun JSONia) yhdestä
  // tapahtumasta, ja se kirjoitettaisiin provider_cacheen 15 minuutin välein.
  const parsed = ical.sync.parseICS(
    buildIcs([
      vevent("Joka toinen tunti", [
        "DTSTART:20260601T060000Z",
        "DTEND:20260601T070000Z",
        "RRULE:FREQ=HOURLY;INTERVAL=2",
      ]),
    ]),
  );

  const { events, problems } = expandCalendarEvents(parsed, "2026-06-01", "2027-09-30");

  assert.equal(events.length, MAX_EVENT_ROWS, "yksittäisen tapahtuman rivimäärä katkaistaan kattoon");
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.reason, "capped");
  assert.equal(problems[0]?.rows, MAX_EVENT_ROWS);

  // Sama suoraan laajennuksen omasta lipusta: `capped` on se kenttä johon
  // fetchCalendarin lokitus nojaa, joten se pitää olla tosi eikä pelkästään
  // pääteltävissä rivimäärästä.
  const [event] = parseEvents([
    vevent("Joka toinen tunti", [
      "DTSTART:20260601T060000Z",
      "DTEND:20260601T070000Z",
      "RRULE:FREQ=HOURLY;INTERVAL=2",
    ]),
  ]);
  assert.ok(event, "testifixtuuri puuttuu");
  const expansion = expandEventForDays(event, "2026-06-01", "2027-09-30");
  assert.equal(expansion.capped, true, "rivikaton osuminen näkyy capped-lippuna");
  assert.equal(expansion.events.length, MAX_EVENT_ROWS);

  // Katkaisu säilyttää AIKAISIMMAT rivit, jotta kortin oma kahden viikon
  // ikkuna on oikein vaikka kaukaiset kuukaudet jäisivät vajaiksi.
  assert.equal(events[0]?.dateKey, "2026-06-01", "ensimmäinen rivi on ikkunan alusta");
  assert.ok(
    events.every((row, index) => index === 0 || row.dateKey >= (events[index - 1]?.dateKey ?? "")),
    "rivit pysyvät aikajärjestyksessä",
  );

  console.log("ok  karannut mutta kaatumaton toisto katkaistaan rivikattoon aikaisimmat rivit säilyttäen");
}

function testLegitimateDailyRecurrenceIsNotCapped(): void {
  // Rivikatto ei saa osua lailliseen käyttöön. Päivittäin toistuva tapahtuma
  // koko 16 kuukauden ikkunassa on lähes 500 riviä, ja kahden vuorokauden
  // mittaisena noin kaksinkertainen — kumpikin mahtuu kattoon.
  const parsed = ical.sync.parseICS(
    buildIcs([
      vevent("Päivittäinen", ["DTSTART:20260601T060000Z", "DTEND:20260601T070000Z", "RRULE:FREQ=DAILY"]),
      vevent("Päivittäinen kaksipäiväinen", [
        "DTSTART;VALUE=DATE:20260601",
        "DTEND;VALUE=DATE:20260603",
        "RRULE:FREQ=DAILY",
      ]),
    ]),
  );

  const { events, problems } = expandCalendarEvents(parsed, "2026-06-01", "2027-09-30");

  assert.deepEqual(problems, [], "laillinen päivittäinen toisto ei saa osua kattoon");
  const daily = events.filter((row) => row.title === "Päivittäinen").length;
  assert.ok(daily > 450 && daily < MAX_EVENT_ROWS, `päivittäisiä rivejä ${daily}, pitää mahtua kattoon`);

  console.log("ok  laillinen päivittäinen toisto mahtuu rivikaton alle koko ikkunassa");
}

/**
 * Rikkinäinen kalenterimerkintä ei korjaannu itsestään: ICS pysyy samana, joten
 * haku törmää siihen joka 15. minuutti. Rivi per kierros hukuttaisi lokin juuri
 * sillä tiedolla jonka takia loki on olemassa (sama periaate kuin providerin
 * omassa tilamuutoslokituksessa, ks. core/provider.ts ja provider-transitions.ts).
 */
async function testProblemsAreLoggedOncePerState(): Promise<void> {
  const uid = `karannut-${process.pid}@infonaytto`;
  const problem: EventProblem = {
    uid,
    title: "Karannut toisto",
    reason: "failed",
    detail: "Maximum iterations (10000) exceeded in all()",
    rows: 0,
  };

  // Kolme peräkkäistä hakukierrosta samalla rikkinäisellä merkinnällä.
  reportEventProblems([problem]);
  reportEventProblems([problem]);
  reportEventProblems([problem]);

  let lines = await awaitLogLines("calendar_event_skipped", uid, 1);
  assert.equal(lines.length, 1, "sama rikkinäinen merkintä lokitetaan vain kerran, ei kerran per hakukierros");
  assert.equal(lines[0]?.["title"], "Karannut toisto", "otsikko mukaan, koska UID ei auta ihmistä korjaamaan vikaa");

  // Merkintä korjataan kalenterissa ja rikkoutuu myöhemmin uudelleen: se on
  // uusi tilamuutos ja kuuluu lokiin.
  reportEventProblems([]);
  reportEventProblems([problem]);

  lines = await awaitLogLines("calendar_event_skipped", uid, 2);
  assert.equal(lines.length, 2, "korjaantunut ja uudelleen rikkoutunut merkintä raportoidaan uudestaan");

  // Muistin nollaus, jotta tämä testi ei jätä tilaa muille.
  reportEventProblems([]);
  console.log("ok  ohitettu merkintä lokitetaan kerran tilaa kohti, ei kerran per hakukierros");
}

testMonthKeyValidation();
testMonthArithmetic();
testSpringDstMonthBoundary();
testAutumnDstMonthBoundary();
testWindowEdgesIncludeLocalMidnightEvents();
testMultiDayEventAcrossMonthBoundary();
testRecurringEventFillsWholeMonth();
testEmptyDaysAreAbsent();
testEventsWithinDayAreChronological();
testUncoveredMonths();
testMissingCoverageIsNotCovered();
testPartialCoverageIsNotCovered();
testDashboardTrim();
testDashboardTrimKeepsOngoingMultiDayEvent();
testEventCrossingMidnightAtMonthBoundary();
testUnboundedRecurrenceDoesNotKillTheWholeCalendar();
testRunawayRecurrenceIsCapped();
testLegitimateDailyRecurrenceIsNotCapped();
await testProblemsAreLoggedOncePerState();

console.log("\nall calendar month tests passed");
process.exit(0);
