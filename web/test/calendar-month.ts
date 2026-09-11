/**
 * Kuukausinäkymän logiikka.
 *
 * Kaksi asiaa on tässä tärkeämpiä kuin muut, ja molemmat ovat sellaisia joista
 * kalenterit erehtyvät hiljaa:
 *
 *  1. `covered: false` EI tarkoita "ei tapahtumia". Jos tyhjä ja tuntematon
 *     päivä sulautuvat samaksi, näkymä valehtelee juuri siinä kohdassa jossa
 *     käyttäjä sitä eniten uskoo.
 *  2. Kuukausien selaus ei saa vyöryä kuukauden yli. `Date#setMonth` tekee
 *     31. päivänä juuri niin (31.1. + 1 kk = 3.3.).
 *
 * Aja:  npm run test:calendar-month --workspace=web
 */
import assert from "node:assert/strict";
import {
  GRID_WEEKS,
  buildMonthGrid,
  chipCapacity,
  chipTime,
  dayHeading,
  dayKind,
  dayViewTime,
  monthLabel,
  planChips,
  shiftMonth,
  splitDayEvents,
  weekdayIndex,
} from "../src/components/calendarMonth.ts";
import type { CalendarEvent, CalendarMonth } from "../src/types.ts";

function event(partial: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: "Tapahtuma",
    start: "2026-09-11T06:15:00.000Z",
    end: "2026-09-11T07:30:00.000Z",
    allDay: false,
    location: null,
    dateKey: "2026-09-11",
    ...partial,
  };
}

function month(days: Record<string, CalendarEvent[]>, covered: boolean): CalendarMonth {
  return { month: "2026-09", days, covered };
}

// ── Kuukausien selaus ────────────────────────────────────────────────────────
{
  assert.equal(shiftMonth("2026-09", 1), "2026-10");
  assert.equal(shiftMonth("2026-09", -1), "2026-08");
  assert.equal(shiftMonth("2026-12", 1), "2027-01", "vuodenvaihde eteenpäin");
  assert.equal(shiftMonth("2026-01", -1), "2025-12", "vuodenvaihde taaksepäin");
  assert.equal(shiftMonth("2026-01", -13), "2024-12", "usean vuoden hyppy taaksepäin");
  assert.equal(shiftMonth("2026-03", 0), "2026-03");

  // Tämä on se kohta jossa Date#setMonth hajoaisi: tammikuun 31. päivä.
  assert.equal(shiftMonth("2026-01", 1), "2026-02", "31-päiväisestä kuukaudesta ei saa vyöryä yli");
  assert.equal(shiftMonth("2026-01", 2), "2026-03");
  console.log("ok  kuukausien selaus ei vyöry kuukauden yli");
}

// ── Otsikot ──────────────────────────────────────────────────────────────────
{
  assert.equal(monthLabel("2026-09"), "syyskuu 2026");
  assert.equal(monthLabel("2026-01"), "tammikuu 2026");
  assert.equal(monthLabel("2026-12"), "joulukuu 2026");

  // 11.9.2026 on perjantai.
  assert.equal(dayHeading("2026-09-11"), "Perjantai 11. syyskuuta");
  assert.equal(dayHeading("2026-03-01"), "Sunnuntai 1. maaliskuuta");
  console.log("ok  kuukausi- ja päiväotsikot ovat suomeksi");
}

// ── Viikko alkaa maanantaista ────────────────────────────────────────────────
{
  assert.equal(weekdayIndex("2026-09-07"), 0, "7.9.2026 on maanantai");
  assert.equal(weekdayIndex("2026-09-11"), 4, "11.9.2026 on perjantai");
  assert.equal(weekdayIndex("2026-09-12"), 5, "lauantai");
  assert.equal(weekdayIndex("2026-09-13"), 6, "sunnuntai on viikon VIIMEINEN sarake");
  console.log("ok  viikko alkaa maanantaista");
}

// ── Ruudukko ─────────────────────────────────────────────────────────────────
{
  const grid = buildMonthGrid("2026-09");
  assert.equal(grid.length, GRID_WEEKS * 7, "ruudukko on aina kuusi täyttä viikkoa");

  // 1.9.2026 on tiistai, joten edeltä tulee yksi täytepäivä: 31.8.
  assert.equal(grid[0]?.dateKey, "2026-08-31");
  assert.equal(grid[0]?.inMonth, false);
  assert.equal(grid[1]?.dateKey, "2026-09-01");
  assert.equal(grid[1]?.inMonth, true);
  assert.equal(grid[1]?.dayOfMonth, 1);

  // Jokainen rivi alkaa maanantaista.
  for (let i = 0; i < grid.length; i += 7) {
    assert.equal(grid[i]?.weekday, 0, `solu ${i} on rivin ensimmäinen ja siten maanantai`);
  }

  // Kuukauden päivät ovat mukana täsmälleen kerran.
  const inMonth = grid.filter((d) => d.inMonth);
  assert.equal(inMonth.length, 30, "syyskuussa on 30 päivää");
  assert.equal(new Set(inMonth.map((d) => d.dateKey)).size, 30);

  // Peräkkäisyys: ruudukko on yhtenäinen päiväketju ilman aukkoja.
  for (let i = 1; i < grid.length; i += 1) {
    const previous = new Date(`${grid[i - 1]?.dateKey}T12:00:00Z`).getTime();
    const current = new Date(`${grid[i]?.dateKey}T12:00:00Z`).getTime();
    assert.equal(current - previous, 86_400_000, `solujen ${i - 1} ja ${i} välissä on aukko`);
  }

  // Helmikuu joka alkaa sunnuntaista on ahtain tapaus: 28 päivää + 6 edeltävää.
  const feb = buildMonthGrid("2026-02");
  assert.equal(feb.length, GRID_WEEKS * 7);
  assert.equal(feb[0]?.dateKey, "2026-01-26", "1.2.2026 on sunnuntai");
  assert.equal(feb.filter((d) => d.inMonth).length, 28);

  // Karkausvuosi.
  assert.equal(buildMonthGrid("2028-02").filter((d) => d.inMonth).length, 29);
  console.log("ok  ruudukko on kuusi viikkoa, maanantaista, ilman aukkoja");
}

// ── covered: false ≠ tyhjä päivä ─────────────────────────────────────────────
{
  const withEvents = "2026-09-11";
  const withoutEvents = "2026-09-12";

  const days = { "2026-09-11": [event({ id: "a" })] };

  // Katettu kuukausi: hiljaisuus tarkoittaa "ei tapahtumia".
  assert.equal(dayKind(withEvents, month(days, true), false), "events");
  assert.equal(dayKind(withoutEvents, month(days, true), false), "empty");

  // Kattamaton kuukausi: sama hiljaisuus tarkoittaa "emme tiedä".
  assert.equal(dayKind(withoutEvents, month(days, false), false), "unknown");
  assert.equal(
    dayKind(withEvents, month(days, false), false),
    "events",
    "tapahtumat ovat tiedossa myös kattamattomassa kuukaudessa",
  );

  // Nämä kaksi EIVÄT saa olla sama arvo — koko erottelu on tässä.
  assert.notEqual(
    dayKind(withoutEvents, month(days, true), false),
    dayKind(withoutEvents, month(days, false), false),
  );

  // Haku kesken tai epäonnistunut: mitään ei tiedetä.
  assert.equal(dayKind(withoutEvents, null, true), "unknown");
  assert.equal(dayKind(withEvents, null, true), "unknown");
  assert.equal(
    dayKind(withoutEvents, month(days, true), true),
    "unknown",
    "kesken oleva haku ei saa näyttää tyhjältä päivältä",
  );

  // Tyhjä lista käyttäytyy kuin puuttuva avain.
  assert.equal(dayKind(withEvents, month({ "2026-09-11": [] }, true), false), "empty");
  assert.equal(dayKind(withEvents, month({ "2026-09-11": [] }, false), false), "unknown");
  console.log("ok  covered:false erottuu tyhjästä päivästä");
}

// ── Viereisen kuukauden solu lukee oman kuukautensa vastauksen ───────────────
{
  // Ruudukko ei enää päätä täytesolun tilaa sen perusteella että solu on
  // näytettävän kuukauden ulkopuolella: se saa naapurin vastauksen, joten
  // 31.8. on tiedossa vaikka ruudukko näyttää syyskuuta. Ilman tätä reunojen
  // 4–6 solua olisivat systemaattisesti tyhjiä vaikka data on jo haettu.
  const grid = buildMonthGrid("2026-09");
  const outside = grid.find((d) => d.dateKey === "2026-08-31");
  assert.ok(outside);
  assert.equal(outside.inMonth, false, "31.8. on syyskuun ruudukossa täytesolu");

  const august: CalendarMonth = {
    month: "2026-08",
    days: { "2026-08-31": [event({ id: "elokuu", dateKey: "2026-08-31" })] },
    covered: true,
  };

  assert.equal(dayKind(outside.dateKey, august, false), "events");

  // Jos naapuria ei ole haettu, se on "ei tietoa" eikä tyhjä päivä — sama
  // sääntö kuin näytettävän kuukauden sisällä.
  assert.equal(dayKind(outside.dateKey, null, true), "unknown");

  // Ja jos naapuri on haettu ja katettu, tyhjä päivä on oikeasti tyhjä.
  assert.equal(dayKind("2026-08-30", august, false), "empty");
  console.log("ok  viereisen kuukauden solu lukee oman kuukautensa vastauksen");
}

// ── Mahtuvuus ────────────────────────────────────────────────────────────────
{
  assert.equal(chipCapacity(100, 20), 5);
  assert.equal(chipCapacity(99, 20), 4);
  assert.equal(chipCapacity(19, 20), 1, "solu ei saa koskaan väittää ettei mitään mahdu");
  assert.equal(chipCapacity(0, 20), 1);
  assert.equal(chipCapacity(100, 0), 1, "mittaamaton rivikorkeus ei saa kaataa laskentaa");
  assert.equal(chipCapacity(Number.NaN, 20), 1);

  const three = [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })];

  // Kaikki mahtuvat.
  assert.deepEqual(planChips(three, 3), { shown: three, hidden: 0 });
  assert.deepEqual(planChips(three, 5), { shown: three, hidden: 0 });

  // Ylivuotorivi vie yhden paikan, joten kolmesta näkyy yksi ja kaksi jää.
  const plan = planChips(three, 2);
  assert.equal(plan.shown.length, 1);
  assert.equal(plan.hidden, 2);
  assert.equal(plan.shown.length + plan.hidden, three.length, "yksikään tapahtuma ei saa kadota");

  // Ahtain tapaus: yksi rivi tilaa, kolme tapahtumaa.
  const tight = planChips(three, 1);
  assert.deepEqual(tight.shown, []);
  assert.equal(tight.hidden, 3, "kun mikään ei mahdu, luku kertoo kaikki kolme");

  assert.deepEqual(planChips([], 3), { shown: [], hidden: 0 });
  console.log("ok  päiväsoluun mahtuvat rivit lasketaan eikä yksikään tapahtuma katoa");
}

// ── Kellonajat ───────────────────────────────────────────────────────────────
{
  // Koko päivän tapahtumalla ei ole kellonaikaa kummassakaan näkymässä.
  const allDay = event({ id: "a", allDay: true });
  assert.equal(chipTime(allDay), null);
  assert.equal(dayViewTime(allDay), "koko päivä");

  // Yhden päivän tapahtuma saa alkuajan ruudukkoon ja välin päivänäkymään.
  const single = event({ id: "b" });
  const chip = chipTime(single);
  assert.ok(chip !== null && /\d/.test(chip), "kellonaika puuttui ruudukon riviltä");
  assert.ok(dayViewTime(single).includes("–"), "päivänäkymässä näytetään väli");

  // Monipäiväisen tapahtuman start/end ovat samat jokaisella rivillä, joten
  // vain ensimmäinen päivä saa ruudukossa kellonajan. Muuten viimeisen päivän
  // loppuaika näyttäisi alkuajalta.
  const first = event({ id: "c", span: { day: 1, totalDays: 3 } });
  const middle = event({ id: "d", span: { day: 2, totalDays: 3 } });
  const last = event({ id: "e", span: { day: 3, totalDays: 3 } });
  assert.ok(chipTime(first) !== null, "ensimmäinen päivä kertoo milloin tapahtuma alkaa");
  assert.equal(chipTime(middle), null);
  assert.equal(chipTime(last), null, "loppuaika ei saa näkyä ruudukossa alkuajan paikalla");

  assert.ok(dayViewTime(first).startsWith("alkaa "));
  assert.equal(dayViewTime(middle), "jatkuu koko päivän");
  assert.ok(dayViewTime(last).startsWith("päättyy "));

  // Kelvoton aikaleima ei saa tuottaa "Invalid Date" -tekstiä ruudulle.
  const broken = event({ id: "f", start: "ei-aika", end: "ei-aika" });
  assert.equal(chipTime(broken), null);
  assert.equal(dayViewTime(broken), "");
  console.log("ok  kellonaika näytetään vain kun se tarkoittaa jotain");
}

// ── Päivänäkymän ryhmittely ──────────────────────────────────────────────────
{
  const allDay = event({ id: "a", allDay: true });
  const middle = event({ id: "b", span: { day: 2, totalDays: 4 } });
  const timed = event({ id: "c" });
  const first = event({ id: "d", span: { day: 1, totalDays: 2 } });
  const last = event({ id: "e", span: { day: 2, totalDays: 2 } });

  const groups = splitDayEvents([timed, allDay, middle, first, last]);
  assert.deepEqual(
    groups.allDay.map((e) => e.id),
    ["a", "b"],
    "koko päivän kestävät ja monipäiväisen välipäivät ovat omana ryhmänään",
  );
  assert.deepEqual(
    groups.timed.map((e) => e.id),
    ["c", "d", "e"],
    "alku- ja loppupäivä ovat kellonaikaan sidottuja",
  );

  // Järjestys säilyy ryhmien sisällä — palvelin lähettää tapahtumat
  // aikajärjestyksessä eikä ryhmittely saa sekoittaa sitä.
  const ordered = splitDayEvents([
    event({ id: "1" }),
    event({ id: "2" }),
    event({ id: "3" }),
  ]);
  assert.deepEqual(
    ordered.timed.map((e) => e.id),
    ["1", "2", "3"],
  );

  assert.deepEqual(splitDayEvents([]), { allDay: [], timed: [] });
  console.log("ok  koko päivän tapahtumat erottuvat kellonaikaan sidotuista");
}

console.log("\nall calendar month tests passed");
process.exit(0);
