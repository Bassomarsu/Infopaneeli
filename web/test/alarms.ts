/**
 * Kouluhälytysten laukaisulogiikka (useAlarms.ts) on tässä eristetty puhtaiksi
 * funktioiksi juuri jotta se voidaan testata ilman selainta, localStoragea tai
 * Web Audiota. Kolme sääntöä ovat kriittisimmät: hälytys ei saa laueta
 * jälkijunassa (sivun lataus keskellä päivää), ei koskaan kahdesti samana
 * aamuna, eikä vääränä viikonpäivänä tai väärällä ankkurilla.
 *
 * Aja:  npm run test:alarms --workspace=web
 */
import assert from "node:assert/strict";
import { nextTick, ref } from "vue";
import {
  alarmPlanForDate,
  alarmsDueNow,
  alarmTargetForDate,
  describeOccurrence,
  describeOccurrenceShort,
  nextAlarmOccurrence,
  nextUpcomingAlarm,
  useAlarms,
  type AlarmSoundPlayer,
  type StorageLike,
} from "../src/composables/useAlarms.ts";
import type { Alarm, AlarmWeekdayRule, ScheduleLesson, WilmaData, WilmaStudent } from "../src/types.ts";

/**
 * Aikavyöhyke pakotetaan, koska kesäajan siirtoja koskevat testit kuvaavat
 * hetkiä joiden paikallinen kello riippuu vyöhykkeestä — koneen omalla
 * asetuksella ne olisivat sattumaa eivätkä testejä. Nodessa `process.env.TZ`
 * vaikuttaa heti seuraaviin Date-operaatioihin (>= v16); alla oleva tarkistus
 * kaataa ajon heti jos näin ei jostain syystä ole, koska hiljaa väärällä
 * vyöhykkeellä ajettu testi on pahempi kuin ei testiä lainkaan. Myös muut kuin
 * kesäaikatestit hyötyvät: koko tiedosto ajaa nyt samalla vyöhykkeellä
 * riippumatta siitä kenen koneella se ajetaan.
 */
process.env.TZ = "Europe/Helsinki";
assert.equal(
  new Date(2026, 2, 29, 3, 30).toISOString(),
  "2026-03-29T01:30:00.000Z",
  "aikavyöhykkeen pakotus ei toiminut — kaikki kesäaikatestit olisivat merkityksettömiä",
);

/** Ajaa lohkon toisella vyöhykkeellä ja palauttaa asetuksen ennalleen. */
function withTimeZone(timeZone: string, run: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    run();
  } finally {
    process.env.TZ = previous;
  }
}

/**
 * Muistinvarainen `localStorage`-korvike: Node ei tarjoa globaalia
 * `localStorage`ia, mutta useAlarms hyväksyy `storage`-parametrin juuri tätä
 * varten (ks. StorageLike). Sama olio jaettuna kahden `useAlarms()`-kutsun
 * kesken simuloi sivun uudelleenlatausta.
 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Vakoileva äänisoitin: Node ei tarjoa Web Audiota eikä <audio>-elementtiä,
 * joten useAlarms hyväksyy `soundPlayer`-parametrin (ks. AlarmSoundPlayer)
 * juuri tätä varten — sama ratkaisu kuin StorageLikellä yllä. `calls`
 * tallentaa kutsujärjestyksen ("play:a1", "stop", "play:a2", ...) jotta
 * testit voivat todentaa ETTÄ ja MISSÄ JÄRJESTYKSESSÄ stop() kutsutaan.
 */
function fakeSoundPlayer(): AlarmSoundPlayer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    play: (soundId) => {
      calls.push(`play:${soundId}`);
      return new Promise<void>(() => {}); // ei koskaan resolvoidu itsestään — vastaa oikeaa pitkää äänitiedostoa
    },
    stop: () => {
      calls.push("stop");
    },
    unlock: () => {
      calls.push("unlock");
    },
  };
}

function lesson(date: string, start: string): ScheduleLesson {
  return {
    date,
    dayOfWeek: 1,
    start,
    end: "09:00",
    subject: "Matematiikka",
    subjectCode: "MA",
    teacher: "Opettaja",
    teacherCode: "OP",
    groupId: 1,
  };
}

function wilmaFor(studentsLessons: Record<string, ScheduleLesson[]>): WilmaData {
  const students = Object.keys(studentsLessons).map((num) => ({ studentNumber: num, name: `Oppilas ${num}` }));
  const byStudent: WilmaData["byStudent"] = {};
  for (const [num, lessons] of Object.entries(studentsLessons)) {
    byStudent[num] = {
      student: { studentNumber: num, name: `Oppilas ${num}` },
      lessons,
      homework: [],
      upcomingExams: [],
      coveredDates: [...new Set(lessons.map((l) => l.date))],
      nextWeekCheckedAt: null,
    };
  }
  return { students, byStudent, messages: [], unreadCount: 0 };
}

/** Oletusarvoinen aamupalan alkuaika useimmissa testeissä — vain muutama testi vaihtaa tämän. */
const BREAKFAST = "08:00";

/** Kaikki viikonpäivät, sama ankkuri jokaiselle — vastaa "ma–pe" oletusta yhdellä lisätyllä viikonlopulla testejä varten. */
function allWeekdays(anchor: AlarmWeekdayRule["anchor"] = "schoolStart"): AlarmWeekdayRule[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, anchor }));
}

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "a1",
    label: "Herätys",
    trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: allWeekdays() },
    enabled: true,
    soundId: "chime",
    volume: 0.8,
    repeatCount: 3,
    ...overrides,
  };
}

/** `month` on 1-pohjainen, toisin kuin Daten oma. */
function at(year: number, month: number, day: number, hour: number, minute = 0, second = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

const neverRung = () => false;

// 2026-08-11 on tiistai (weekday 2), 2026-08-10 maanantai (weekday 1), 2026-08-15 lauantai (weekday 6).

// Laukeaa oikeaan aikaan: 30 min ennen 08:00-tuntia on 07:30.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: allWeekdays() } });
  const target = alarmTargetForDate(a, wilma, wilma.students, "2026-08-11", BREAKFAST);
  assert.ok(target, "tavoiteaika pitää löytyä kun tunteja on");
  assert.equal(target.getHours(), 7);
  assert.equal(target.getMinutes(), 30);

  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), BREAKFAST, neverRung);
  assert.equal(due.length, 1, "hälytyksen pitää laueta tavoitehetkellä");
  assert.equal(due[0]?.alarm.id, a.id);
  console.log("ok  hälytys laukeaa 30 min ennen ensimmäistä tuntia");
}

// Laukeamisikkuna on tarkalleen kapea — enintään yksi minuutti tavoiteajan jälkeen.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm();
  assert.equal(alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30, 0), BREAKFAST, neverRung).length, 1);
  assert.equal(
    alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30, 59), BREAKFAST, neverRung).length,
    1,
    "59 sekuntia myöhässä on vielä ikkunan sisällä",
  );
  assert.equal(
    alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 31, 1), BREAKFAST, neverRung).length,
    0,
    "yli minuutin myöhässä ei saa enää laueta",
  );
  console.log("ok  laukeamisikkuna on tasan yhden minuutin levyinen");
}

// Ei laukea tunnittomana päivänä (viikonloppu/loma), vaikka viikonpäivä olisi valittuna.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm();
  assert.equal(alarmTargetForDate(a, wilma, wilma.students, "2026-08-15", BREAKFAST), null);
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 15, 7, 30), BREAKFAST, neverRung);
  assert.equal(due.length, 0, "tunniton päivä ei saa laukaista");
  console.log("ok  tunniton päivä ei laukaise hälytystä");
}

// Ei laukea jälkijunassa — esim. sivun lataus keskellä päivää.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm();
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 13, 0), BREAKFAST, neverRung);
  assert.equal(due.length, 0, "kauan sitten mennyt tavoiteaika ei saa laueta jälkikäteen");
  console.log("ok  hälytys ei laukea jälkijunassa kun aika on jo kauan sitten mennyt");
}

// Ei laukea kahdesti — alreadyRung palauttaa true.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm();
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), BREAKFAST, () => true);
  assert.equal(due.length, 0, "jo soinut hälytys ei saa laueta uudestaan");
  console.log("ok  jo soinut hälytys ei laukea toistamiseen");
}

// Pois kytketty hälytys ei laukea, vaikka aika muuten täsmäisi.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ enabled: false });
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), BREAKFAST, neverRung);
  assert.equal(due.length, 0, "pois päältä oleva hälytys ei saa laueta");
  console.log("ok  pois kytketty hälytys ei laukea");
}

// Useampi hälytys samalle aamulle: kaksi eri hälytystä samalla tavoiteajalla laukeavat molemmat.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a1 = alarm({ id: "a1", label: "Herätys" });
  const a2 = alarm({ id: "a2", label: "Lähtö" });
  const due = alarmsDueNow([a1, a2], wilma, wilma.students, at(2026, 8, 11, 7, 30), BREAKFAST, neverRung);
  assert.equal(due.length, 2, "molempien samaan aikaan osuvien hälytysten pitää laueta yhdessä");
  console.log("ok  useampi hälytys samalle aamulle laukeaa yhdessä");
}

// studentNumber null = mikä tahansa oppilas: käyttää aikaisinta tuntia kaikista lapsista,
// kun taas tiettyyn oppilaaseen sidottu hälytys käyttää vain hänen tuntejaan.
{
  const wilma = wilmaFor({
    "1": [lesson("2026-08-11", "09:00")],
    "2": [lesson("2026-08-11", "08:00")],
  });
  const anyChild = alarmTargetForDate(
    alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: allWeekdays() } }),
    wilma,
    wilma.students,
    "2026-08-11",
    BREAKFAST,
  );
  assert.ok(anyChild);
  assert.equal(anyChild.getHours(), 7);
  assert.equal(anyChild.getMinutes(), 30, "mikä tahansa oppilas -hälytyksen pitää käyttää aikaisinta tuntia");

  const specific = alarmTargetForDate(
    alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } }),
    wilma,
    wilma.students,
    "2026-08-11",
    BREAKFAST,
  );
  assert.ok(specific);
  assert.equal(specific.getHours(), 8, "tiettyyn oppilaaseen sidotun hälytyksen pitää käyttää vain hänen tuntejaan");
  console.log("ok  studentNumber null käyttää aikaisinta tuntia kaikista lapsista");
}

// Viikonpäiväsuodatus: hälytys joka on valittu vain maanantaiksi ei laukea tiistaina,
// vaikka tunteja olisi ja aika muuten täsmäisi.
{
  const wilma = wilmaFor({
    "1": [lesson("2026-08-10", "08:00"), lesson("2026-08-11", "08:00")],
  });
  const mondayOnly = alarm({
    trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: [{ weekday: 1, anchor: "schoolStart" }] },
  });
  assert.ok(alarmTargetForDate(mondayOnly, wilma, wilma.students, "2026-08-10", BREAKFAST), "maanantai on valittu");
  assert.equal(
    alarmTargetForDate(mondayOnly, wilma, wilma.students, "2026-08-11", BREAKFAST),
    null,
    "tiistai ei ole valittu, vaikka tunteja on",
  );
  console.log("ok  hälytys ei laukea viikonpäivänä jota ei ole valittu");
}

// Ankkuri per viikonpäivä: sama hälytys seuraa maanantaina koulun alkua ja tiistaina aamupalaa.
{
  const wilma = wilmaFor({
    "1": [lesson("2026-08-10", "08:30"), lesson("2026-08-11", "09:00")],
  });
  const mixedAnchor = alarm({
    trigger: {
      mode: "relative",
      minutesBefore: 15,
      studentNumber: null,
      weekdays: [
        { weekday: 1, anchor: "schoolStart" },
        { weekday: 2, anchor: "breakfast" },
      ],
    },
  });

  const monday = alarmTargetForDate(mixedAnchor, wilma, wilma.students, "2026-08-10", "07:45");
  assert.ok(monday);
  assert.equal(monday.getHours(), 8);
  assert.equal(monday.getMinutes(), 15, "maanantaina 15 min ennen koulun alkua (08:30) on 08:15");

  const tuesday = alarmTargetForDate(mixedAnchor, wilma, wilma.students, "2026-08-11", "07:45");
  assert.ok(tuesday);
  assert.equal(tuesday.getHours(), 7);
  assert.equal(tuesday.getMinutes(), 30, "tiistaina 15 min ennen aamupalaa (07:45) on 07:30, ei riipu tunnin alkuajasta");
  console.log("ok  ankkuri vaihtuu päiväkohtaisesti saman hälytyksen sisällä");
}

// Aamupala-ankkuri ei laukea päivänä jolloin relevanteilla oppilailla ei ole
// ollenkaan tunteja — sama "ei koulupäivä = ei hälytystä" -sääntö kuin
// schoolStart-ankkurilla, koska aamupalakin on koulupäivän osa.
{
  const wilma = wilmaFor({ "1": [] }); // ei yhtään tuntia = loma
  const breakfastAlarm = alarm({
    trigger: { mode: "relative", minutesBefore: 10, studentNumber: "1", weekdays: allWeekdays("breakfast") },
  });
  assert.equal(alarmTargetForDate(breakfastAlarm, wilma, wilma.students, "2026-08-11", "08:00"), null);
  console.log("ok  aamupala-ankkuri ei laukea päivänä jolloin ei ole tunteja");
}

// Kiinteä kellonaika: soi valittuina viikonpäivinä riippumatta tunneista (tai niiden puutteesta).
{
  const wilma = wilmaFor({ "1": [] }); // ei tunteja — fixed-tila ei silti välitä
  const fixedAlarm = alarm({
    trigger: { mode: "fixed", time: "07:30", weekdays: [1, 2, 3, 4, 5] },
  });
  const monday = alarmTargetForDate(fixedAlarm, wilma, wilma.students, "2026-08-10", BREAKFAST);
  assert.ok(monday, "fixed-hälytys ei riipu tunneista");
  assert.equal(monday.getHours(), 7);
  assert.equal(monday.getMinutes(), 30);

  const saturday = alarmTargetForDate(fixedAlarm, wilma, wilma.students, "2026-08-15", BREAKFAST);
  assert.equal(saturday, null, "lauantai ei ole valittujen viikonpäivien joukossa");
  console.log("ok  kiinteä kellonaika soi valittuina viikonpäivinä riippumatta tunneista");
}

// Kiinteä kellonaika ei laukea jälkijunassa — sama suoja kuin relative-tilalla.
{
  const wilma = wilmaFor({ "1": [] });
  const fixedAlarm = alarm({ trigger: { mode: "fixed", time: "07:30", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  assert.equal(
    alarmsDueNow([fixedAlarm], wilma, wilma.students, at(2026, 8, 10, 13, 0), BREAKFAST, neverRung).length,
    0,
    "kauan sitten mennyt kiinteä kellonaika ei saa laueta jälkikäteen",
  );
  assert.equal(
    alarmsDueNow([fixedAlarm], wilma, wilma.students, at(2026, 8, 10, 7, 30, 30), BREAKFAST, neverRung).length,
    1,
    "laukeamisikkunan sisällä kiinteä kellonaika laukeaa normaalisti",
  );
  console.log("ok  kiinteä kellonaika ei laukea jälkijunassa");
}

// nextAlarmOccurrence: esikatselu paneelia varten — tänään jos aika ei ole vielä mennyt,
// muuten seuraava koulupäivä jolla on tunteja.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00"), lesson("2026-08-12", "09:00")] });
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });

  const occToday = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST);
  assert.ok(occToday);
  assert.equal(occToday.dateKey, "2026-08-11");
  assert.equal(occToday.isToday, true);
  assert.equal(describeOccurrence(occToday, at(2026, 8, 11, 6, 0)), "tänään klo 7.30");

  const occNext = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 8, 0), BREAKFAST);
  assert.ok(occNext);
  assert.equal(occNext.dateKey, "2026-08-12");
  assert.equal(occNext.isToday, false);
  assert.equal(describeOccurrence(occNext, at(2026, 8, 11, 8, 0)), "huomenna klo 8.30");
  console.log("ok  esikatselu näyttää tänään tai seuraavan koulupäivän oikein");
}

// Ei tunteja lähipäivinä ollenkaan -> esikatselu palauttaa null eikä kaadu.
{
  const wilma = wilmaFor({ "1": [] });
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });
  assert.equal(nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST), null);
  console.log("ok  ei tunteja lähipäivinä -> esikatselu on null");
}

// --- nextUpcomingAlarm: yläpalkin "seuraava hälytys" -banneri ---
//
// Banneri näkyy TÄSMÄLLEEN silloin kun tämä palauttaa muun kuin nullin, joten
// jokainen "ei näy" -vaatimus on tässä yksi null-tulos.

// Aikaisin soitto voittaa — ei listajärjestys eikä viimeisin.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const myohainen = alarm({ id: "myohainen", label: "Lähtö", trigger: { mode: "fixed", time: "07:45", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  const aikainen = alarm({ id: "aikainen", label: "Herätys", trigger: { mode: "fixed", time: "07:10", weekdays: [0, 1, 2, 3, 4, 5, 6] } });

  const next = nextUpcomingAlarm([myohainen, aikainen], wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST);
  assert.ok(next, "tulevan soiton pitää löytyä");
  assert.equal(next.alarm.id, "aikainen", "aikaisimman soiton hälytys voittaa, vaikka se on listassa jäljempänä");
  assert.equal(next.occurrence.time.getHours(), 7);
  assert.equal(next.occurrence.time.getMinutes(), 10);

  // Sama lista toisin päin: tulos ei saa riippua järjestyksestä.
  const sameBackwards = nextUpcomingAlarm([aikainen, myohainen], wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST);
  assert.equal(sameBackwards?.alarm.id, "aikainen", "järjestys ei saa vaikuttaa tulokseen");
  console.log("ok  banneri valitsee aikaisimman tulevan hälytyksen listajärjestyksestä riippumatta");
}

// Jo ohi mennyt aikaisempi hälytys ei voita — vertailu on SEURAAVASTA
// soitosta, ei kellonajasta sinänsä.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00"), lesson("2026-08-12", "08:00")] });
  const aamu = alarm({ id: "aamu", label: "Aamu", trigger: { mode: "fixed", time: "07:10", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  const ilta = alarm({ id: "ilta", label: "Ilta", trigger: { mode: "fixed", time: "20:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });

  const next = nextUpcomingAlarm([aamu, ilta], wilma, wilma.students, at(2026, 8, 11, 12, 0), BREAKFAST);
  assert.equal(next?.alarm.id, "ilta", "tänään jo mennyt 7.10 siirtyy huomiseen, joten tämän illan 20.00 on lähempänä");
  assert.equal(next?.occurrence.dateKey, "2026-08-11");
  console.log("ok  banneri vertaa seuraavia soittoja, ei pelkkiä kellonaikoja");
}

// Käytöstä poistettu hälytys ei näy bannerissa, vaikka se olisi aikaisin.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const poissa = alarm({ id: "poissa", label: "Pois", enabled: false, trigger: { mode: "fixed", time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  const paalla = alarm({ id: "paalla", label: "Päällä", trigger: { mode: "fixed", time: "07:30", weekdays: [0, 1, 2, 3, 4, 5, 6] } });

  const next = nextUpcomingAlarm([poissa, paalla], wilma, wilma.students, at(2026, 8, 11, 5, 0), BREAKFAST);
  assert.equal(next?.alarm.id, "paalla", "käytöstä poistettua ei lasketa mukaan vaikka se olisi aikaisin");

  assert.equal(
    nextUpcomingAlarm([poissa], wilma, wilma.students, at(2026, 8, 11, 5, 0), BREAKFAST),
    null,
    "pelkkä käytöstä poistettu hälytys ei tuota banneria",
  );
  console.log("ok  käytöstä poistettu hälytys ei näy bannerissa");
}

// Ei banneria ilman soittoja: tyhjä lista, ja hälytys jolle nextAlarmOccurrence
// palauttaa nullin (loma — ei tunteja lähipäivinä, viikonpäivät valittuina).
{
  const wilma = wilmaFor({ "1": [] });
  assert.equal(nextUpcomingAlarm([], wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST), null, "tyhjä hälytyslista");

  const koulu = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });
  assert.equal(nextAlarmOccurrence(koulu, wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST), null, "esiehto: yksittäinen soitto on null");
  assert.equal(
    nextUpcomingAlarm([koulu], wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST),
    null,
    "lomalla lukujärjestykseen sidottu hälytys ei tuota banneria",
  );

  const eiPaivia = alarm({ id: "eipaivia", trigger: { mode: "fixed", time: "07:00", weekdays: [] } });
  assert.equal(
    nextUpcomingAlarm([eiPaivia], wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST),
    null,
    "hälytys ilman valittuja viikonpäiviä ei tuota banneria",
  );
  console.log("ok  banneri jää kokonaan pois kun yksikään hälytys ei tuota soittoa");
}

// Puhelin (wilma === null) ei saa nähdä koulun alkamisaikaa: lukujärjestykseen
// sidottu hälytys katoaa bannerista itsestään, kiinteä kellonaika ei ole
// koulutietoa ja jää näkyviin.
{
  const koulu = alarm({ id: "koulu", label: "Kouluun", trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: allWeekdays() } });
  const aamupala = alarm({ id: "aamupala", label: "Aamupala", trigger: { mode: "relative", minutesBefore: 10, studentNumber: null, weekdays: allWeekdays("breakfast") } });
  const kiintea = alarm({ id: "kiintea", label: "Kiinteä", trigger: { mode: "fixed", time: "07:45", weekdays: [0, 1, 2, 3, 4, 5, 6] } });

  assert.equal(
    nextUpcomingAlarm([koulu, aamupala], null, [], at(2026, 8, 11, 6, 0), BREAKFAST),
    null,
    "ilman Wilma-dataa kumpikaan ankkuri ei tuota soittoa — banneri ei voi paljastaa koulun alkamisaikaa",
  );

  const next = nextUpcomingAlarm([koulu, aamupala, kiintea], null, [], at(2026, 8, 11, 6, 0), BREAKFAST);
  assert.equal(next?.alarm.id, "kiintea", "kiinteä kellonaika näkyy puhelimessakin");
  assert.equal(describeOccurrenceShort(next!.occurrence, at(2026, 8, 11, 6, 0)), "7.45");
  console.log("ok  puhelimella banneri näyttää vain kiinteät ajat, ei lukujärjestyksestä johdettuja");
}

// Tiivis muoto yläpalkkiin: tänään pelkkä kello, huomenna sanana, muuten
// kaksikirjaiminen viikonpäivä. Sama kello kuin pitkässä muodossa.
{
  const wilma = wilmaFor({
    "1": [lesson("2026-08-11", "08:00"), lesson("2026-08-12", "09:00"), lesson("2026-08-14", "10:25")],
  });
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });

  const today = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 6, 0), BREAKFAST);
  assert.equal(describeOccurrenceShort(today!, at(2026, 8, 11, 6, 0)), "7.30");
  assert.equal(describeOccurrence(today!, at(2026, 8, 11, 6, 0)), "tänään klo 7.30", "pitkä muoto kertoo saman kellonajan");

  const tomorrow = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 8, 0), BREAKFAST);
  assert.equal(describeOccurrenceShort(tomorrow!, at(2026, 8, 11, 8, 0)), "huomenna 8.30");

  // 2026-08-14 on perjantai — kahden päivän päässä, joten viikonpäivä lyhenteenä.
  const friday = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 12, 10, 0), BREAKFAST);
  assert.equal(friday?.dateKey, "2026-08-14");
  assert.equal(describeOccurrenceShort(friday!, at(2026, 8, 12, 10, 0)), "pe 9.55");
  assert.equal(describeOccurrence(friday!, at(2026, 8, 12, 10, 0)), "perjantaina klo 9.55", "pitkä muoto kertoo saman päivän ja kellonajan");
  console.log("ok  tiivis muoto: tänään pelkkä kello, huomenna sanana, muuten viikonpäivän lyhenne");
}

// Syysloman aatto: pelkkä viikonpäivän lyhenne ei kelpaa kun soitto on yli
// viikon päässä, koska "ma" tarkoittaisi yhtä hyvin kolmen kuin kymmenen
// päivän päässä olevaa hälytystä. Sama teksti ei saa tarkoittaa kahta eri
// päivää.
{
  // pe 9.10.2026, lomaviikko 42, tunnit jatkuvat ma 19.10. (10 päivän päässä).
  const loma = wilmaFor({ "1": [lesson("2026-10-19", "09:15")] });
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });
  const perjantaiIltapaiva = at(2026, 10, 9, 18, 0);

  const occ = nextAlarmOccurrence(a, loma, loma.students, perjantaiIltapaiva, BREAKFAST);
  assert.equal(occ?.dateKey, "2026-10-19", "esiehto: seuraava soitto on loman jälkeisenä maanantaina");
  assert.equal(
    describeOccurrenceShort(occ!, perjantaiIltapaiva),
    "ma 19.10. klo 8.45",
    "yli viikon päässä oleva soitto tarvitsee päiväyksen — pelkkä \"ma\" olisi kahdeksi eri päiväksi luettavissa",
  );

  // Tavallinen perjantai: sama viikonpäivä, sama kellonaika, mutta kolmen
  // päivän päässä -> lyhyt muoto riittää ja sen PITÄÄ erota lomatapauksesta.
  const arki = wilmaFor({ "1": [lesson("2026-10-12", "09:15")] });
  const arkiOcc = nextAlarmOccurrence(a, arki, arki.students, perjantaiIltapaiva, BREAKFAST);
  assert.equal(arkiOcc?.dateKey, "2026-10-12");
  assert.equal(describeOccurrenceShort(arkiOcc!, perjantaiIltapaiva), "ma 8.45");
  console.log("ok  yli viikon päässä oleva soitto saa päiväyksen, lähempi pelkän viikonpäivän");
}

// Lyhyen muodon raja on tasan kuusi päivää: kuudes päivä on vielä
// yksiselitteinen viikonpäivä, seitsemäs on jo sama viikonpäivä kuin tänään.
{
  const kuudes = wilmaFor({ "1": [lesson("2026-10-15", "08:30")] }); // to, 6 pv
  const seitsemas = wilmaFor({ "1": [lesson("2026-10-16", "08:30")] }); // pe, 7 pv
  const a = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: "1", weekdays: allWeekdays() } });
  const perjantai = at(2026, 10, 9, 18, 0);

  const o6 = nextAlarmOccurrence(a, kuudes, kuudes.students, perjantai, BREAKFAST);
  assert.equal(describeOccurrenceShort(o6!, perjantai), "to 8.00", "kuuden päivän päässä viikonpäivä riittää");

  const o7 = nextAlarmOccurrence(a, seitsemas, seitsemas.students, perjantai, BREAKFAST);
  assert.equal(
    describeOccurrenceShort(o7!, perjantai),
    "pe 16.10. klo 8.00",
    "seitsemän päivän päässä viikonpäivä on sama kuin tänään — päiväys pakollinen",
  );
  console.log("ok  lyhyen muodon raja on tasan kuusi päivää");
}

// --- Kesäajan siirrot: kevät (olematon kello) ja syksy (toistuva kello) ---
//
// Suomessa kello siirtyy maaliskuun viimeisenä sunnuntaina 03.00 -> 04.00,
// jolloin kellonaikoja 03.00-03.59 EI OLE OLEMASSA, ja lokakuun viimeisenä
// sunnuntaina 04.00 -> 03.00, jolloin samat kellonajat TULEVAT KAHDESTI.
// Vuonna 2026 nämä ovat su 29.3. ja su 25.10.
//
// Odotukset on kiinnitetty absoluuttisiin hetkiin (`toISOString`) eikä
// paikallisiin kenttiin juuri siksi, että paikallinen kello on näinä öinä
// monitulkintainen: "03.30" ei yksilöi hetkeä kumpanakaan yönä. Laukeamishetki
// ja näyttöteksti todennetaan erikseen — ne ovat eri asioita, ja kevään
// korjauksen koko pointti on että ne EROAVAT toisistaan.

/** Ensimmäinen olemassa oleva hetki kevään siirron jälkeen: 04.00 Suomen aikaa. */
const KEVAT_NELJA = "2026-03-29T01:00:00.000Z";
/** Syksyn 03.30 tulee kahdesti: ensin kesäajassa, tuntia myöhemmin talviajassa. */
const SYKSY_KOLME_PUOLI_ENSIN = "2026-10-25T00:30:00.000Z";
const SYKSY_KOLME_PUOLI_UUDELLEEN = "2026-10-25T01:30:00.000Z";

/** Kiinteä hälytys joka on valittu kaikille viikonpäiville — molemmat siirtopäivät ovat sunnuntaita. */
function fixedAt(time: string): Alarm {
  return alarm({ trigger: { mode: "fixed", time, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
}

/** Kaikki hetket joilla hälytys laukeaa annetulla aikavälillä, minuutin tarkkuudella. */
function firingInstants(a: Alarm, fromUtcMs: number, toUtcMs: number): string[] {
  const hits: string[] = [];
  for (let t = fromUtcMs; t <= toUtcMs; t += 60_000) {
    // alreadyRung on tahallaan VAKIO false: näin testi mittaa laukaisulogiikkaa
    // itseään eikä kirjanpitoa, joka voisi peittää kaksinkertaisen laukeamisen.
    if (alarmsDueNow([a], null, [], new Date(t), BREAKFAST, neverRung).length > 0) hits.push(new Date(t).toISOString());
  }
  return hits;
}

// Kevät, laukeamishetki: olematon kellonaika siirtyy ENSIMMÄISEEN olemassa
// olevaan hetkeen. Vanha käytös oli 04.30 — JS:n normalisoinnin sivutuote, eli
// kokonaisen tunnin viive siihen mitä käyttäjä asetti.
{
  const target = (time: string) => alarmTargetForDate(fixedAt(time), null, [], "2026-03-29", BREAKFAST);

  assert.equal(target("03:30")?.toISOString(), KEVAT_NELJA, "olematon 03.30 -> 04.00, EI 04.30");
  assert.equal(target("03:00")?.toISOString(), KEVAT_NELJA, "aukon alku -> 04.00");
  assert.equal(target("03:59")?.toISOString(), KEVAT_NELJA, "aukon loppu -> 04.00, ei 04.59");
  assert.equal(target("04:00")?.toISOString(), KEVAT_NELJA, "aukon jälkeinen kellonaika on ennallaan");
  assert.equal(target("02:59")?.toISOString(), "2026-03-29T00:59:00.000Z", "aukkoa ennen oleva kellonaika on ennallaan");
  console.log("ok  kevät: olematon kellonaika siirtyy ensimmäiseen olemassa olevaan hetkeen");
}

// Kevät, laukeaminen: hälytys laukeaa tasan kerran eikä jää soimatta — koko yö
// tikitettynä minuutti kerrallaan on täsmälleen yksi osuma.
{
  const a = fixedAt("03:30");
  assert.equal(alarmsDueNow([a], null, [], new Date(KEVAT_NELJA), BREAKFAST, neverRung).length, 1, "hälytyksen pitää laueta 04.00:ssa");
  assert.equal(
    alarmsDueNow([a], null, [], new Date(Date.parse(KEVAT_NELJA) + 30 * 60_000), BREAKFAST, neverRung).length,
    0,
    "vanha käytös (04.30) ei saa palata takaoven kautta",
  );
  assert.deepEqual(
    firingInstants(a, Date.UTC(2026, 2, 28, 21, 0), Date.UTC(2026, 2, 29, 9, 0)),
    [KEVAT_NELJA],
    "siirtoyön yli tikitettynä hälytys laukeaa tasan kerran — ei nollasti eikä kahdesti",
  );
  console.log("ok  kevät: hälytys laukeaa tasan kerran, ensimmäisellä olemassa olevalla hetkellä");
}

// Kevät, näyttö: kumpaakaan kellonaikaa ei saa näyttää hiljaa. Pelkkä "4.00"
// olisi aika jota käyttäjä ei asettanut, pelkkä "3.30" aika jolloin ei tapahdu
// mitään — molemmat luvut näkyvät siis kummassakin muodossa.
{
  const a = fixedAt("03:30");
  const lauantaiIlta = at(2026, 3, 28, 20, 0);
  const occ = nextAlarmOccurrence(a, null, [], lauantaiIlta, BREAKFAST);
  assert.ok(occ);
  assert.equal(occ.dateKey, "2026-03-29");
  assert.equal(occ.time.toISOString(), KEVAT_NELJA, "esikatselun hetki on sama kuin laukeamishetki");
  assert.equal(describeOccurrence(occ, lauantaiIlta), "huomenna klo 4.00 (kellonsiirto, normaalisti 3.30)");
  assert.equal(describeOccurrenceShort(occ, lauantaiIlta), "huomenna 3.30→4.00", "banneri kertoo samat kaksi lukua tiiviisti");
  console.log("ok  kevät: näyttö kertoo sekä asetetun että todellisen kellonajan");
}

// Syksy, laukeamishetki: toistuvasta kellonajasta valitaan ENSIMMÄINEN esiintymä.
{
  const target = (time: string) => alarmTargetForDate(fixedAt(time), null, [], "2026-10-25", BREAKFAST);

  assert.equal(target("03:30")?.toISOString(), SYKSY_KOLME_PUOLI_ENSIN, "toistuvasta kellonajasta valitaan ensimmäinen esiintymä");
  assert.notEqual(target("03:30")?.toISOString(), SYKSY_KOLME_PUOLI_UUDELLEEN, "ei jälkimmäinen — se olisi tunnin myöhässä");
  assert.equal(target("03:00")?.toISOString(), "2026-10-25T00:00:00.000Z", "toiston alku samoin ensimmäisestä esiintymästä");
  assert.equal(target("04:00")?.toISOString(), "2026-10-25T02:00:00.000Z", "siirron jälkeinen 04.00 esiintyy vain kerran, talviajassa");
  assert.equal(target("02:30")?.toISOString(), "2026-10-24T23:30:00.000Z", "ennen siirtoa oleva kellonaika on ennallaan");
  console.log("ok  syksy: toistuvasta kellonajasta valitaan ensimmäinen esiintymä");
}

// Syksy, laukeaminen: kello 03.30 tulee tänä yönä kahdesti, mutta hälytys saa
// soida vain kerran. Huomaa että `firingInstants` pitää "jo soinut" -muistin
// jatkuvasti tyhjänä: suoja ei saa tulla kirjanpidosta vaan siitä, että
// tavoiteaika on HETKI eikä kellonaika, jolloin jälkimmäinen esiintymä on
// tunnin myöhässä laukeamisikkunasta.
{
  assert.deepEqual(
    firingInstants(fixedAt("03:30"), Date.UTC(2026, 9, 24, 21, 0), Date.UTC(2026, 9, 25, 9, 0)),
    [SYKSY_KOLME_PUOLI_ENSIN],
    "toistuva tunti ei saa laukaista samaa hälytystä kahdesti",
  );
  console.log("ok  syksy: toistuva tunti ei laukaise hälytystä kahdesti");
}

// Syksy, näyttö: kello näyttää soidessa täsmälleen asetettua aikaa, joten
// lisäystä ei tarvita eikä sitä saa tulla.
{
  const a = fixedAt("03:30");
  const lauantaiIlta = at(2026, 10, 24, 20, 0);
  const occ = nextAlarmOccurrence(a, null, [], lauantaiIlta, BREAKFAST);
  assert.ok(occ);
  assert.equal(occ.time.toISOString(), SYKSY_KOLME_PUOLI_ENSIN);
  assert.equal(occ.plannedClock, null, "ei poikkeusta kerrottavaksi");
  assert.equal(describeOccurrence(occ, lauantaiIlta), "huomenna klo 3.30");
  assert.equal(describeOccurrenceShort(occ, lauantaiIlta), "huomenna 3.30");
  console.log("ok  syksy: näyttö näyttää asetetun kellonajan ilman lisäyksiä");
}

// Lukujärjestykseen sidottu hälytys: luvattu etuaika on KESTO, joten se on
// mitattava todellisena aikana. Kellotauluaritmetiikalla (vanha
// `target.setMinutes(getMinutes() - n)`) tunnin etuajasta tuli keväällä nolla
// minuuttia — 03.30 ei ole olemassa, joten se normalisoitui takaisin
// ankkurihetkeen — ja syksyllä 120 minuuttia, koska 03.30 tuli kahdesti.
{
  const rel = (mins: number) =>
    alarm({ trigger: { mode: "relative", minutesBefore: mins, studentNumber: null, weekdays: allWeekdays() } });
  const leadMinutes = (wilma: WilmaData, dateKey: string, mins: number): number => {
    const target = alarmTargetForDate(rel(mins), wilma, wilma.students, dateKey, BREAKFAST);
    const anchor = alarmTargetForDate(rel(0), wilma, wilma.students, dateKey, BREAKFAST);
    assert.ok(target && anchor, "esiehto: sekä ankkurilla että tavoiteajalla pitää olla arvo");
    return (anchor.getTime() - target.getTime()) / 60_000;
  };

  const kevat = wilmaFor({ "1": [lesson("2026-03-29", "04:30")] });
  assert.equal(leadMinutes(kevat, "2026-03-29", 60), 60, "keväällä tunnin etuajan pitää olla todellinen tunti (oli 0 min)");
  assert.equal(leadMinutes(kevat, "2026-03-29", 90), 90, "sama pidemmällä etuajalla (oli 30 min)");
  assert.equal(
    alarmTargetForDate(rel(60), kevat, kevat.students, "2026-03-29", BREAKFAST)?.toISOString(),
    "2026-03-29T00:30:00.000Z",
    "tunti ennen 04.30:tä on siirtoyönä kello 02.30 talviaikaa",
  );

  const syksy = wilmaFor({ "1": [lesson("2026-10-25", "04:30")] });
  assert.equal(leadMinutes(syksy, "2026-10-25", 60), 60, "syksyllä tunnin etuajan pitää olla todellinen tunti (oli 120 min)");
  assert.equal(leadMinutes(syksy, "2026-10-25", 90), 90, "sama pidemmällä etuajalla (oli 150 min)");
  assert.equal(
    alarmTargetForDate(rel(60), syksy, syksy.students, "2026-10-25", BREAKFAST)?.toISOString(),
    SYKSY_KOLME_PUOLI_UUDELLEEN,
    "syksyllä tunti ennen 04.30:tä on JÄLKIMMÄINEN 03.30",
  );
  console.log("ok  luvattu etuaika toteutuu todellisena aikana molemmissa siirroissa");
}

// Sama näytöllä: keväällä kellotaulusta laskettu 3.30 ei pidä paikkaansa, ja
// se on sanottava; syksyllä kello näyttää soidessa 3.30 eikä ole mitään
// kerrottavaa, vaikka laukeamishetki onkin toistuvan tunnin jälkimmäinen.
{
  const rel = alarm({ trigger: { mode: "relative", minutesBefore: 60, studentNumber: null, weekdays: allWeekdays() } });

  const kevat = wilmaFor({ "1": [lesson("2026-03-29", "04:30")] });
  const maaliskuunLauantai = at(2026, 3, 28, 20, 0);
  const kevatOcc = nextAlarmOccurrence(rel, kevat, kevat.students, maaliskuunLauantai, BREAKFAST);
  assert.ok(kevatOcc);
  assert.equal(describeOccurrence(kevatOcc, maaliskuunLauantai), "huomenna klo 2.30 (kellonsiirto, normaalisti 3.30)");
  assert.equal(describeOccurrenceShort(kevatOcc, maaliskuunLauantai), "huomenna 3.30→2.30");

  const syksy = wilmaFor({ "1": [lesson("2026-10-25", "04:30")] });
  const lokakuunLauantai = at(2026, 10, 24, 20, 0);
  const syksyOcc = nextAlarmOccurrence(rel, syksy, syksy.students, lokakuunLauantai, BREAKFAST);
  assert.ok(syksyOcc);
  assert.equal(syksyOcc.time.toISOString(), SYKSY_KOLME_PUOLI_UUDELLEEN, "esiehto: soi toistuvan tunnin jälkimmäisellä esiintymällä");
  assert.equal(syksyOcc.plannedClock, null, "kello näyttää silloin 3.30, joten lisäystä ei tarvita");
  assert.equal(describeOccurrence(syksyOcc, lokakuunLauantai), "huomenna klo 3.30");
  console.log("ok  näyttö kertoo myös lukujärjestykseen sidotun hälytyksen siirtymän");
}

// Syksyn siirtymän tahallinen poikkeus, ks. alarmPlanForDate.
//
// "Toistuvasta kellonajasta valitaan ensimmäinen esiintymä" on KELLONAJAN
// tulkintasääntö: se ratkaisee mihin käyttäjän kirjoittama "03.30" osoittaa,
// kun sellaisia hetkiä on kaksi. Lukujärjestykseen sidottu hälytys ei anna
// kellonaikaa vaan keston, eikä kesto ole monitulkintainen — sen tulos saa ja
// sen TÄYTYY osua toistuvan tunnin jälkimmäiseen esiintymään silloin kun
// ankkurista taaksepäin mitattuna päädytään sinne. Jos joku "yhtenäistää"
// tämän pakottamalla ensimmäisen esiintymän, hälytys soi tunnin luvattua
// aikaisemmin — eli juuri se vika joka äsken korjattiin, toisin päin.
{
  const rel = (mins: number) =>
    alarm({ trigger: { mode: "relative", minutesBefore: mins, studentNumber: null, weekdays: allWeekdays() } });
  const wilma = wilmaFor({ "1": [lesson("2026-10-25", "06:45")] });
  const ankkuri = alarmTargetForDate(rel(0), wilma, wilma.students, "2026-10-25", BREAKFAST);
  assert.ok(ankkuri);
  assert.equal(ankkuri.toISOString(), "2026-10-25T04:45:00.000Z", "esiehto: ankkuri 06.45 on siirron jälkeen, talviajassa");

  // 166–225 min ennen 06.45 osuu toistuvaan tuntiin — ja nimenomaan sen
  // jälkimmäiseen esiintymään. Molemmat reunat tarkistetaan.
  for (const [minutesBefore, expectedIso, expectedClock] of [
    [166, "2026-10-25T01:59:00.000Z", "3.59"],
    [225, "2026-10-25T01:00:00.000Z", "3.00"],
  ] as const) {
    const plan = alarmPlanForDate(rel(minutesBefore), wilma, wilma.students, "2026-10-25", BREAKFAST);
    assert.ok(plan);
    assert.equal(
      (ankkuri.getTime() - plan.time.getTime()) / 60_000,
      minutesBefore,
      `luvattu ${minutesBefore} minuutin etuaika on pidettävä myös toistuvan tunnin yli`,
    );
    assert.equal(plan.time.toISOString(), expectedIso, "jälkimmäinen esiintymä, ei ensimmäinen");
    assert.equal(
      describeOccurrenceShort({ dateKey: "2026-10-25", time: plan.time, isToday: true, plannedClock: plan.plannedClock }, plan.time),
      expectedClock,
      "kello näyttää soidessa tätä lukemaa",
    );
    assert.equal(plan.plannedClock, null, "ei ole mitään 'normaalia' kellonaikaa josta poikettaisiin — käyttäjä ei asettanut kellonaikaa");

    // Sama seinäkellon lukema KELLONAIKANA annettuna menee sääntöä pitkin
    // ensimmäiseen esiintymään, tuntia aikaisemmaksi. Kaksi eri vastausta
    // samalle kellotaulun lukemalle on tämän poikkeuksen koko sisältö.
    const kellonaikana = alarmTargetForDate(fixedAt(`0${expectedClock.replace(".", ":")}`), null, [], "2026-10-25", BREAKFAST);
    assert.ok(kellonaikana);
    assert.equal(
      (plan.time.getTime() - kellonaikana.getTime()) / 60_000,
      60,
      "kellonaikana sama lukema tarkoittaa ensimmäistä esiintymää, tuntia aikaisemmin",
    );
  }
  console.log("ok  syksy: relative-hälytys pitää luvatun etuajan myös toistuvan tunnin jälkimmäisellä esiintymällä");
}

// Tavallisena päivänä mikään ei muutu: ei poikkeusmerkintää, ei muuttunutta
// tekstiä, sama hetki kuin ennenkin.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const rel = alarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: allWeekdays() } });
  const kiintea = fixedAt("07:30");
  const aamu = at(2026, 8, 11, 6, 0);

  assert.equal(alarmPlanForDate(rel, wilma, wilma.students, "2026-08-11", BREAKFAST)?.plannedClock, null);
  assert.equal(alarmPlanForDate(kiintea, wilma, wilma.students, "2026-08-11", BREAKFAST)?.plannedClock, null);
  assert.equal(
    alarmPlanForDate(kiintea, wilma, wilma.students, "2026-08-11", BREAKFAST)?.time.toISOString(),
    at(2026, 8, 11, 7, 30).toISOString(),
    "tavallisen päivän hetki on täsmälleen asetettu kellonaika",
  );

  const occ = nextAlarmOccurrence(rel, wilma, wilma.students, aamu, BREAKFAST);
  assert.ok(occ);
  assert.equal(describeOccurrence(occ, aamu), "tänään klo 7.30", "tavallisen päivän teksti ei saa saada lisäystä");
  assert.equal(describeOccurrenceShort(occ, aamu), "7.30");
  console.log("ok  tavallisena päivänä siirtologiikka ei muuta mitään");
}

// Sääntö ei ole Suomeen kovakoodattu: sama koodi ratkaisee aukon ja toiston
// vyöhykkeellä jolla siirrot ovat eri päivinä ja eri kellonaikoina.
withTimeZone("America/New_York", () => {
  // 8.3.2026: 02.00 -> 03.00 (aukko). 1.11.2026: 02.00 -> 01.00 (toisto).
  assert.equal(
    alarmTargetForDate(fixedAt("02:30"), null, [], "2026-03-08", BREAKFAST)?.toISOString(),
    "2026-03-08T07:00:00.000Z",
    "olematon 02.30 -> ensimmäinen olemassa oleva hetki eli 03.00 kesäaikaa",
  );
  assert.equal(
    alarmTargetForDate(fixedAt("01:30"), null, [], "2026-11-01", BREAKFAST)?.toISOString(),
    "2026-11-01T05:30:00.000Z",
    "toistuva 01.30 -> ensimmäinen esiintymä eli vielä kesäaikaa",
  );
  console.log("ok  sama sääntö pätee muuallakin kuin Suomessa (America/New_York)");
});

/**
 * Seuraavat testit ajavat itse `useAlarms`-composablea (ei vain puhtaita
 * funktioita) — ne todentavat katselmoinnissa löydetyt kaksi bugia:
 *
 *   1. Hälytysmoottorin pitää toimia vaikka se käynnistetään ennen kuin
 *      oikeat asetukset ovat vielä latautuneet (App.vue ei enää piilota
 *      AlarmsPaneli komponenttia settingsin taakse).
 *   2. Hälytystä ei saa merkitä "soineeksi" ennen kuin se on kuitattu —
 *      muuten nopea kuittaus samalla 60 s ikkunalla toisi saman hälytyksen
 *      heti takaisin, ja sivun uudelleenlataus juuri ennen kuittausta
 *      hukkaisi ilmoituksen jäljettömiin.
 */

// Hälytysmoottori ei kaadu eikä jää passiiviseksi jos se käynnistetään ennen
// kuin todelliset hälytysasetukset ovat saapuneet, ja alkaa toimia heti kun
// ne saapuvat myöhemmin (ei vasta composablen luontihetkellä).
async function testEngineWorksBeforeSettingsHaveLoaded(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilma = ref<WilmaData | null>(null);
  const alarmsRef = ref<Alarm[]>([]); // "asetuksia ei ole vielä haettu palvelimelta"
  const students = ref<WilmaStudent[]>([]);
  const breakfastTime = ref(BREAKFAST);

  const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, breakfastTime, storage: memoryStorage() });
  await nextTick();
  assert.equal(active.value === null, true, "ei saa kaatua eikä näyttää mitään ennen kuin hälytyksiä on ladattu");

  // Asetukset saapuvat myöhemmin (esim. /api/dashboard vastaa vasta nyt):
  // moottorin, joka on jo käynnissä tyhjillä hälytyksillä, pitää reagoida.
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  wilma.value = wilmaData;
  students.value = wilmaData.students;
  alarmsRef.value = [alarm({ id: "a1" })];
  await nextTick();

  const entry = active.value;
  assert.ok(entry, "moottorin pitää alkaa laukaista heti kun hälytykset saapuvat, ei vain luontihetkellä");
  assert.equal(entry.alarm.id, "a1");
  console.log("ok  hälytysmoottori toimii vaikka se käynnistetään ennen asetusten latautumista");
}

// Nopea kuittaus (ikkuna on vielä auki) ei saa tuoda samaa hälytystä heti
// takaisin seuraavalla kellosyklillä.
async function testAcknowledgedAlarmDoesNotReturnWithinTheSameWindow(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const wilma = ref<WilmaData | null>(wilmaData);
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1" })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);
  const breakfastTime = ref(BREAKFAST);

  const { active, acknowledge } = useAlarms({ wilma, now, alarms: alarmsRef, students, breakfastTime, storage: memoryStorage() });
  await nextTick();
  const entry = active.value;
  assert.ok(entry, "hälytyksen pitää laueta ikkunan alussa");
  assert.equal(entry.alarm.id, "a1");

  acknowledge();
  assert.equal(active.value, null, "kuittaus tyhjentää aktiivisen ilmoituksen heti");

  // Kymmenen sekuntia myöhemmin, yhä saman 60 s ikkunan sisällä.
  now.value = at(2026, 8, 11, 7, 30, 10);
  await nextTick();
  assert.equal(active.value, null, "kuitattu hälytys ei saa ilmestyä uudestaan saman ikkunan sisällä");
  console.log("ok  kuitattu hälytys ei laukea uudestaan samalla laukeamisikkunalla");
}

// Kuittaamaton hälytys ei saa alkaa soida uudestaan kun ikkuna sulkeutuu,
// mutta sen pitää pysyä näkyvissä siihen asti kunnes joku kuittaa sen.
async function testUnacknowledgedAlarmStaysVisibleAfterWindowCloses(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const wilma = ref<WilmaData | null>(wilmaData);
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1" })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);
  const breakfastTime = ref(BREAKFAST);

  const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, breakfastTime, storage: memoryStorage() });
  await nextTick();
  const firstEntry = active.value;
  assert.ok(firstEntry, "hälytyksen pitää laueta");
  const firedAlarmId = firstEntry.alarm.id;

  // Ikkuna (60 s) on jo sulkeutunut, käyttäjä ei ole vielä kuitannut.
  now.value = at(2026, 8, 11, 7, 32, 0);
  await nextTick();
  const stillEntry = active.value;
  assert.ok(stillEntry, "kuittaamattoman hälytyksen pitää pysyä näkyvissä ikkunan sulkeuduttuakin");
  assert.equal(stillEntry.alarm.id, firedAlarmId, "sama ilmoitus pysyy, ei uutta laukeamista");
  console.log("ok  kuittaamaton hälytys pysyy näkyvissä eikä laukea uudestaan ikkunan sulkeuduttua");
}

// Sivun uudelleenlataus kesken kuittaamattoman hälytyksen ei saa hukata
// ilmoitusta: uusi useAlarms()-instanssi (uusi "sivulataus") jakaa saman
// tallennustilan edellisen kanssa ja palauttaa ilmoituksen näkyviin.
async function testReloadRestoresUnacknowledgedAlarmFromSharedStorage(): Promise<void> {
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const storage = memoryStorage(); // vastaa selaimen jaettua localStoragea

  {
    const now = ref(at(2026, 8, 11, 7, 30));
    const wilma = ref<WilmaData | null>(wilmaData);
    const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", label: "Herätys" })]);
    const students = ref<WilmaStudent[]>(wilmaData.students);
    const breakfastTime = ref(BREAKFAST);
    const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, breakfastTime, storage });
    await nextTick();
    assert.ok(active.value, "ensimmäisen \"sivulatauksen\" pitää laueta normaalisti");
  }
  // Tämä lohko sulkeutuu ilman kuittausta — juuri se tilanne joka simuloi
  // sivun sulkeutumista kesken hälytyksen.

  // "Uudelleenlataus" kymmenen sekuntia myöhemmin, ennen kuin kukaan kuittasi.
  {
    const now = ref(at(2026, 8, 11, 7, 30, 10));
    const wilma = ref<WilmaData | null>(wilmaData);
    const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", label: "Herätys" })]);
    const students = ref<WilmaStudent[]>(wilmaData.students);
    const breakfastTime = ref(BREAKFAST);
    const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, breakfastTime, storage });
    await nextTick();
    const restored = active.value;
    assert.ok(restored, "uudelleenlatauksen jälkeen kuittaamattoman hälytyksen pitää palautua näkyviin");
    assert.equal(restored.alarm.id, "a1");
  }
  console.log("ok  uudelleenlataus palauttaa kuittaamattoman hälytyksen näkyviin jaetusta tallennustilasta");
}

/**
 * Löydetty bugi: pitkä äänitiedosto (minuutteja) ei pysähtynyt millään muulla
 * tavalla kuin sivun päivittämällä — pahin tapaus oli että KUITTAUSKIN jätti
 * äänen soimaan taustalle. Seuraavat kolme testiä todentavat pysäytyslogiikan
 * `useAlarms`-tasolla käyttäen `soundPlayer`-injektiota (ks. yllä) — itse
 * Web Audio / <audio>-toteutus (alarmSounds.ts) vaatii oikean selaimen eikä
 * ole tästä testattavissa (ks. tiimille palautettu rajoitusten lista).
 */

// Kuittaus pysäyttää äänen VÄLITTÖMÄSTI, vaikka jonossa ei ole seuraavaa
// hälytystä joka muuten aloittaisi uuden — pelkkä "uusi ääni pysäyttää
// vanhan" ei riitä tähän tapaukseen.
async function testAcknowledgeStopsSoundEvenWithNothingQueuedNext(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const wilma = ref<WilmaData | null>(wilmaData);
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", soundId: "pitka-tiedosto" })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);
  const breakfastTime = ref(BREAKFAST);
  const player = fakeSoundPlayer();

  const { active, acknowledge } = useAlarms({
    wilma,
    now,
    alarms: alarmsRef,
    students,
    breakfastTime,
    storage: memoryStorage(),
    soundPlayer: player,
  });
  await nextTick();
  assert.ok(active.value, "hälytyksen pitää laueta");
  assert.deepEqual(player.calls, ["play:pitka-tiedosto"], "ääni käynnistyy laukeamisen yhteydessä");

  acknowledge();
  assert.equal(active.value, null, "kuittaus tyhjentää aktiivisen ilmoituksen");
  assert.deepEqual(
    player.calls,
    ["play:pitka-tiedosto", "stop"],
    "kuittauksen pitää pysäyttää ääni VÄLITTÖMÄSTI vaikka jonossa ei ole mitään seuraavaa",
  );
  console.log("ok  kuittaus pysäyttää äänen heti, vaikka jonossa ei ole seuraavaa hälytystä");
}

// Kaksi jonossa olevaa hälytystä: kuittaus pysäyttää ensimmäisen äänen JA
// käynnistää seuraavan — pysäytys ei saa estää jonon etenemistä.
async function testAcknowledgeStopsCurrentAndStartsNextQueuedAlarm(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const wilma = ref<WilmaData | null>(wilmaData);
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", label: "Herätys", soundId: "s1" }), alarm({ id: "a2", label: "Lähtö", soundId: "s2" })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);
  const breakfastTime = ref(BREAKFAST);
  const player = fakeSoundPlayer();

  const { active, acknowledge } = useAlarms({
    wilma,
    now,
    alarms: alarmsRef,
    students,
    breakfastTime,
    storage: memoryStorage(),
    soundPlayer: player,
  });
  await nextTick();
  assert.equal(active.value?.alarm.id, "a1", "molemmat osuvat samaan hetkeen, mutta vain yksi on aktiivinen kerrallaan");
  assert.deepEqual(player.calls, ["play:s1"]);

  acknowledge();
  assert.equal(active.value?.alarm.id, "a2", "kuittaus näyttää jonossa olevan seuraavan hälytyksen");
  assert.deepEqual(
    player.calls,
    ["play:s1", "stop", "play:s2"],
    "ensimmäinen ääni pysäytetään ennen kuin seuraava käynnistyy — ei koskaan päällekkäin",
  );
  console.log("ok  kuittaus pysäyttää nykyisen äänen ja käynnistää jonossa olevan seuraavan hälytyksen");
}

// retrySound avaa äänilukon uudelleen ja käynnistää saman aktiivisen
// hälytyksen äänen uudestaan (ei pysäytä mitään ensin — sen tekee
// playAlarmSound/registerSession itse "vain yksi ääni kerrallaan" -säännöllä).
async function testRetrySoundUnlocksAndReplaysActiveAlarm(): Promise<void> {
  const now = ref(at(2026, 8, 11, 7, 30));
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const wilma = ref<WilmaData | null>(wilmaData);
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", soundId: "s1" })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);
  const breakfastTime = ref(BREAKFAST);
  const player = fakeSoundPlayer();

  const { retrySound } = useAlarms({
    wilma,
    now,
    alarms: alarmsRef,
    students,
    breakfastTime,
    storage: memoryStorage(),
    soundPlayer: player,
  });
  await nextTick();
  assert.deepEqual(player.calls, ["play:s1"]);

  retrySound();
  assert.deepEqual(player.calls, ["play:s1", "unlock", "play:s1"], "uudelleenyritys avaa äänilukon ja soittaa saman hälytyksen äänen uudestaan");
  console.log("ok  retrySound avaa äänilukon ja soittaa aktiivisen hälytyksen äänen uudestaan");
}

/**
 * Kaksinkertainen hälytys yöllä olisi pahempi vika kuin väärin näytetty
 * kellonaika, joten toistuva tunti ajetaan läpi myös koko moottorilla — ei
 * pelkällä `alarmsDueNow`illa. Nämä kattavat kaksi eri kirjanpitoa: muistissa
 * oleva jono/aktiivinen ja `localStorage`iin tallennettu "jo soinut" -muisti.
 */

// Toistuva tunti kokonaisuudessaan minuutti kerrallaan: ääni saa käynnistyä
// tasan kerran, vaikka kello näyttää 03.30:tä kahtena eri hetkenä.
async function testAutumnRepeatedHourRingsOnceThroughTheEngine(): Promise<void> {
  const player = fakeSoundPlayer();
  const start = Date.UTC(2026, 9, 24, 23, 50); // 02.50 kesäaikaa, ennen ensimmäistä 03.30:tä
  const now = ref(new Date(start));
  const wilma = ref<WilmaData | null>(null);
  const alarmsRef = ref<Alarm[]>([fixedAt("03:30")]);
  const students = ref<WilmaStudent[]>([]);
  const breakfastTime = ref(BREAKFAST);

  const { active, acknowledge } = useAlarms({
    wilma,
    now,
    alarms: alarmsRef,
    students,
    breakfastTime,
    storage: memoryStorage(),
    soundPlayer: player,
  });
  await nextTick();

  const ringInstants: string[] = [];
  for (let t = start + 60_000; t <= Date.UTC(2026, 9, 25, 3, 0); t += 60_000) {
    now.value = new Date(t);
    await nextTick();
    if (active.value) {
      ringInstants.push(new Date(t).toISOString());
      acknowledge(); // herännyt ihminen kuittaa heti
    }
  }
  assert.deepEqual(ringInstants, [SYKSY_KOLME_PUOLI_ENSIN], "hälytyksen pitää soida tasan kerran toistuvan tunnin yli");
  assert.deepEqual(
    player.calls.filter((call) => call.startsWith("play:")),
    ["play:chime"],
    "ääni saa käynnistyä vain kerran — toinen 03.30 ei saa herättää uudestaan",
  );
  console.log("ok  syksy: moottori soittaa hälytyksen tasan kerran toistuvan tunnin yli");
}

// Sama tilanne sivun uudelleenlatauksen kanssa: "jo soinut" -muisti on
// päiväavaimessa (`infonaytto.alarms.rung.v1`), ja toistuvan tunnin molemmat
// esiintymät ovat samaa kalenteripäivää — joten kuittaus ensimmäisellä
// esiintymällä estää soiton myös uudelleenladatussa sivussa jälkimmäisellä.
async function testAutumnReloadDuringRepeatedHourDoesNotRingAgain(): Promise<void> {
  const storage = memoryStorage(); // vastaa selaimen jaettua localStoragea

  {
    const now = ref(new Date(SYKSY_KOLME_PUOLI_ENSIN));
    const { active, acknowledge } = useAlarms({
      wilma: ref<WilmaData | null>(null),
      now,
      alarms: ref<Alarm[]>([fixedAt("03:30")]),
      students: ref<WilmaStudent[]>([]),
      breakfastTime: ref(BREAKFAST),
      storage,
    });
    await nextTick();
    assert.ok(active.value, "esiehto: hälytyksen pitää soida ensimmäisellä 03.30:llä");
    acknowledge();
  }

  // Tunti myöhemmin kello näyttää taas 03.30:tä, ja sivu latautuu uudelleen.
  {
    const now = ref(new Date(SYKSY_KOLME_PUOLI_UUDELLEEN));
    const { active } = useAlarms({
      wilma: ref<WilmaData | null>(null),
      now,
      alarms: ref<Alarm[]>([fixedAt("03:30")]),
      students: ref<WilmaStudent[]>([]),
      breakfastTime: ref(BREAKFAST),
      storage,
    });
    await nextTick();
    assert.equal(active.value, null, "kuitattu hälytys ei saa soida uudestaan kun kello näyttää samaa aikaa toisen kerran");
  }
  console.log("ok  syksy: kuitattu hälytys ei palaa toistuvan tunnin jälkimmäisellä esiintymällä");
}

await testEngineWorksBeforeSettingsHaveLoaded();
await testAcknowledgedAlarmDoesNotReturnWithinTheSameWindow();
await testUnacknowledgedAlarmStaysVisibleAfterWindowCloses();
await testReloadRestoresUnacknowledgedAlarmFromSharedStorage();
await testAcknowledgeStopsSoundEvenWithNothingQueuedNext();
await testAcknowledgeStopsCurrentAndStartsNextQueuedAlarm();
await testRetrySoundUnlocksAndReplaysActiveAlarm();
await testAutumnRepeatedHourRingsOnceThroughTheEngine();
await testAutumnReloadDuringRepeatedHourDoesNotRingAgain();

console.log("\nall alarm trigger tests passed");
process.exit(0);
