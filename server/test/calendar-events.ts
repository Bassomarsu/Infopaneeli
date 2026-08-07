/**
 * Testaa monipäiväisten kalenteritapahtumien laajennuksen ilman verkkoa: ICS-
 * tekstilohkot rakennetaan käsin ja jäsennetään synkronisesti `ical.parseICS`-
 * kutsulla, jonka jälkeen tarkistetaan `expandEvent`in tuottamat rivit.
 *
 * Kaikkien testien `DTSTART`/`DTEND` käyttävät joko `VALUE=DATE`-muotoa (koko
 * päivän tapahtuma) tai `Z`-loppuista UTC-hetkeä (kellonaikaan sidottu
 * tapahtuma). Koko päivän tapahtumien osalta node-ical tulkitsee `VALUE=DATE`
 * -arvon prosessin omassa paikallisessa aikavyöhykkeessä sekä kirjoitus- että
 * lukuvaiheessa (ks. calendar.ts:n `dateKeyFor`-kommentti), joten tulos on
 * itsessään johdonmukainen riippumatta siitä missä aikavyöhykkeessä testi
 * ajetaan. Kellonaikaan sidottujen tapahtumien päivämääräraja lasketaan aina
 * Europe/Helsinki-ajassa (server/src/core/time.ts), joten `from`/`to`-ikkunan
 * rajat on valittu turvamarginaalilla keskellä päivää sekaannusten välttämiseksi.
 *
 * Run with:  npm run test:calendar --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import ical from "node-ical";
import type { VEvent } from "node-ical";
import { expandEvent, MAX_EVENT_SPAN_DAYS } from "../src/providers/calendar.ts";

function buildIcs(veventBlocks: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//infonaytto//calendar-events-test//EN",
    ...veventBlocks,
    "END:VCALENDAR",
  ].join("\r\n");
}

let uidCounter = 0;
function vevent(lines: string[]): string {
  uidCounter += 1;
  return [
    "BEGIN:VEVENT",
    `UID:test-${process.pid}-${uidCounter}@infonaytto`,
    "DTSTAMP:20260101T000000Z",
    "SUMMARY:Testitapahtuma",
    ...lines,
    "END:VEVENT",
  ].join("\r\n");
}

/** Jäsentää yhden käsin kirjoitetun ICS-tekstin ja palauttaa sen ainoan VEVENTin. */
function singleEvent(icsBody: string): VEvent {
  const parsed = ical.sync.parseICS(icsBody);
  const events = Object.values(parsed).filter(
    (item): item is VEvent => Boolean(item) && typeof item === "object" && item.type === "VEVENT",
  );
  assert.equal(events.length, 1, "testifixtuurin pitää sisältää täsmälleen yksi VEVENT");
  const event = events[0];
  assert.ok(event, "VEVENT puuttuu");
  return event;
}

/** Tiivistää tulokset vertailua varten: ei koskettele otsikkoa tai muuta sisältöä. */
function summarize(events: ReturnType<typeof expandEvent>) {
  return events.map((e) => ({ dateKey: e.dateKey, allDay: e.allDay, span: e.span ?? null }));
}

function testFullDayMultiDayEvent(): void {
  // 10.-12.8.2026 = 3 päivää; DTEND 13.8. on eksklusiivinen.
  const event = singleEvent(
    buildIcs([vevent(["DTSTART;VALUE=DATE:20260810", "DTEND;VALUE=DATE:20260813"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  assert.deepEqual(summarize(result), [
    { dateKey: "2026-08-10", allDay: true, span: { day: 1, totalDays: 3 } },
    { dateKey: "2026-08-11", allDay: true, span: { day: 2, totalDays: 3 } },
    { dateKey: "2026-08-12", allDay: true, span: { day: 3, totalDays: 3 } },
  ]);

  console.log("ok  koko päivän monipäiväinen tapahtuma laajenee jokaiselle päivälle (eksklusiivinen DTEND)");
}

function testTimedMultiDayEvent(): void {
  // 10.8. klo 21:00 (Helsinki, kesäaika) - 12.8. klo 12:00 = kolme kalenteripäivää.
  const event = singleEvent(
    buildIcs([vevent(["DTSTART:20260810T180000Z", "DTEND:20260812T090000Z"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  assert.deepEqual(summarize(result), [
    { dateKey: "2026-08-10", allDay: false, span: { day: 1, totalDays: 3 } },
    { dateKey: "2026-08-11", allDay: false, span: { day: 2, totalDays: 3 } },
    { dateKey: "2026-08-12", allDay: false, span: { day: 3, totalDays: 3 } },
  ]);

  console.log("ok  kellonaikaan sidottu monipäiväinen tapahtuma laajenee jokaiselle päivälle");
}

function testSingleDayEventUnchanged(): void {
  const event = singleEvent(
    buildIcs([vevent(["DTSTART:20260811T090000Z", "DTEND:20260811T103000Z"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  assert.equal(result.length, 1, "yhden päivän tapahtuma tuottaa täsmälleen yhden rivin");
  assert.equal(result[0]?.dateKey, "2026-08-11");
  assert.equal(result[0]?.span, undefined, "yhden päivän tapahtumalla ei saa olla span-tietoa");

  console.log("ok  yhden päivän tapahtuma pysyy ennallaan");
}

function testEventSpanningBeforeWindow(): void {
  // 1.-8.8.2026 (8 päivää, DTEND 9.8. eksklusiivinen), ikkuna alkaa vasta 5.8.
  const event = singleEvent(
    buildIcs([vevent(["DTSTART;VALUE=DATE:20260801", "DTEND;VALUE=DATE:20260809"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  // Vain ikkunaan osuvat päivät 5.-8.8. näkyvät, mutta monesko-päivä-numerointi
  // (5/8 ... 8/8) huomioi koko jakson, ei vain ikkunaan osuvaa osaa.
  assert.deepEqual(summarize(result), [
    { dateKey: "2026-08-05", allDay: true, span: { day: 5, totalDays: 8 } },
    { dateKey: "2026-08-06", allDay: true, span: { day: 6, totalDays: 8 } },
    { dateKey: "2026-08-07", allDay: true, span: { day: 7, totalDays: 8 } },
    { dateKey: "2026-08-08", allDay: true, span: { day: 8, totalDays: 8 } },
  ]);

  console.log("ok  ennen ikkunaa alkanut ja ikkunan sisälle jatkuva tapahtuma näkyy oikealla numeroinnilla");
}

function testRecurringMultiDayEvent(): void {
  // Joka viikko toistuva 2 päivän tapahtuma (to-pe), 3 esiintymää: 6.-7.8., 13.-14.8., 20.-21.8.
  const event = singleEvent(
    buildIcs([
      vevent([
        "DTSTART;VALUE=DATE:20260806",
        "DTEND;VALUE=DATE:20260808",
        "RRULE:FREQ=WEEKLY;COUNT=3",
      ]),
    ]),
  );

  // Ikkuna kattaa vain kaksi ensimmäistä esiintymää: kolmas (20.-21.8.) jää ulkopuolelle.
  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  assert.deepEqual(summarize(result), [
    { dateKey: "2026-08-06", allDay: true, span: { day: 1, totalDays: 2 } },
    { dateKey: "2026-08-07", allDay: true, span: { day: 2, totalDays: 2 } },
    { dateKey: "2026-08-13", allDay: true, span: { day: 1, totalDays: 2 } },
    { dateKey: "2026-08-14", allDay: true, span: { day: 2, totalDays: 2 } },
  ]);

  console.log("ok  toistuva monipäiväinen tapahtuma numeroi jokaisen esiintymän erikseen");
}

function testMalformedSpanIsCapped(): void {
  // DTEND vuosisatoja DTSTARTin jälkeen — selvästi virheellinen syöte.
  const event = singleEvent(
    buildIcs([vevent(["DTSTART;VALUE=DATE:20260805", "DTEND;VALUE=DATE:22000101"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);

  const result = expandEvent(event, from, to);

  // Turvaraja ei enää saa estää ikkunaan osuvien päivien näkymistä (se oli
  // juuri äsken korjattu bugi) — vain "monesko päivä" -badge jätetään pois,
  // ettei se väitä epäluotettavaa ~63000 päivän kokonaiskestoa todeksi.
  assert.equal(result.length, 15, "kaikki ikkunaan osuvat 15 päivää näkyvät turvarajatustakin jaksosta");
  assert.ok(
    result.every((row) => row.span === undefined),
    "epäluotettavan pitkälle kestolle ei näytetä monesko päivä -badgea",
  );

  console.log("ok  virheellisen pitkä tapahtuma näkyy joka ikkunapäivänä, mutta ilman harhaanjohtavaa numerointia");
}

/** Päivien lukumäärä a:sta b:hen, YYYY-MM-DD-avaimista — testin oma kopio calendar.ts:n diffDayKeys-logiikasta. */
function dayDiff(aKey: string, bKey: string): number {
  const [ay, am, ad] = aKey.split("-").map(Number);
  const [by, bm, bd] = bKey.split("-").map(Number);
  return Math.round((Date.UTC(by ?? 1970, (bm ?? 1) - 1, bd ?? 1) - Date.UTC(ay ?? 1970, (am ?? 1) - 1, ad ?? 1)) / 86_400_000);
}

function testLongOngoingEventStartedLongBeforeWindow(): void {
  // Regressiotesti raportoidulle bugille: tapahtuma joka on alkanut selvästi
  // yli (vanhan turvarajan, 60 päivän) verran ennen ikkunaa ja on yhä
  // käynnissä (esim. pitkä vanhempainvapaa) katosi kokonaan, koska
  // daysForInstance laajensi ennen tätä korjausta tapahtuman alusta lähtien
  // turvarajaan asti ja vasta sitten suodatti ikkunaan — jolloin laajennus
  // ehti loppua ennen kuin ikkuna edes alkoi.
  //
  // 1.1.2026 - 1.9.2026 (DTEND eksklusiivinen) = reilusti yli 60 mutta alle
  // MAX_EVENT_SPAN_DAYS(400) päivää, joten badge pysyy tarkkana.
  const event = singleEvent(
    buildIcs([vevent(["DTSTART;VALUE=DATE:20260101", "DTEND;VALUE=DATE:20260901"])]),
  );

  const from = new Date(2026, 7, 5, 12, 0, 0);
  const to = new Date(2026, 7, 19, 12, 0, 0);
  const result = expandEvent(event, from, to);

  const totalDays = dayDiff("2026-01-01", "2026-09-01");
  const firstWindowDay = dayDiff("2026-01-01", "2026-08-05") + 1;

  assert.ok(totalDays < MAX_EVENT_SPAN_DAYS, "testitapauksen kokonaiskeston pitää alittaa turvaraja");
  assert.ok(firstWindowDay > 60, "testitapauksen pitää alkaa yli 60 päivää ennen ikkunaa (vanha turvaraja)");

  // Kaikki 15 ikkunapäivää näkyvät edelleen, numerointi jatkuu oikein tapahtuman
  // todellisesta alusta laskien eikä nollaudu ikkunan alkuun.
  assert.equal(result.length, 15, "koko ikkuna näkyy, vaikka tapahtuma alkoi kauan ennen sitä");
  assert.deepEqual(
    result.map((row) => row.dateKey),
    [
      "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09",
      "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
      "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19",
    ],
  );
  result.forEach((row, index) => {
    assert.equal(row.span?.day, firstWindowDay + index, `väärä monesko päivä riville ${row.dateKey}`);
    assert.equal(row.span?.totalDays, totalDays);
  });

  console.log("ok  kauan sitten alkanut, yhä käynnissä oleva tapahtuma näkyy koko ikkunassa oikealla numeroinnilla");
}

testFullDayMultiDayEvent();
testTimedMultiDayEvent();
testSingleDayEventUnchanged();
testEventSpanningBeforeWindow();
testRecurringMultiDayEvent();
testMalformedSpanIsCapped();
testLongOngoingEventStartedLongBeforeWindow();

console.log("\nall calendar event tests passed");
process.exit(0);
