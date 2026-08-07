/**
 * Lukujärjestyskortin päivänvalinta on mennyt väärin jo kahdesti, ja molemmilla
 * kerroilla vika oli sama: otsikko väitti jotain, mikä ei ollut totta. Tämä
 * testi lukitsee säännöt.
 *
 * Aja:  npm run test:schedule --workspace=web
 */
import assert from "node:assert/strict";
import { ref } from "vue";
import { useScheduleDay, type ScheduleDay } from "../src/composables/useScheduleDay.ts";
import type { ScheduleLesson, WilmaData } from "../src/types.ts";

// Elokuu 2026: 10.8. on maanantai, 14.8. perjantai, 15.8. lauantai, 17.8. maanantai.
const SCHOOL_DAYS = [
  "2026-08-10",
  "2026-08-11",
  "2026-08-12",
  "2026-08-13",
  "2026-08-14",
  "2026-08-17",
  "2026-08-18",
];

function lesson(date: string): ScheduleLesson {
  return {
    date,
    dayOfWeek: 1,
    start: "08:30",
    end: "09:15",
    subject: "Matematiikka",
    subjectCode: "MA",
    teacher: "Opettaja",
    teacherCode: "OP",
    groupId: 1,
  };
}

/** Palautustyyppi on tarkoituksella WilmaData, jotta testi hajoaa jos rajapinta muuttuu. */
function wilmaWith(dates: string[]): WilmaData {
  return {
    students: [{ studentNumber: "1", name: "Testilapsi" }],
    byStudent: {
      "1": {
        student: { studentNumber: "1", name: "Testilapsi" },
        lessons: dates.map(lesson),
        homework: [],
        upcomingExams: [],
        coveredDates: dates,
        nextWeekCheckedAt: null,
      },
    },
    messages: [],
    unreadCount: 0,
  };
}

/** `month` on 1-pohjainen, toisin kuin Daten oma. */
function at(year: number, month: number, day: number, hour: number) {
  return new Date(year, month - 1, day, hour, 0, 0);
}

function show(dates: string[], now: Date): ScheduleDay {
  const { day } = useScheduleDay(
    ref<WilmaData | null>(wilmaWith(dates)),
    ref(now),
    ref("12:00"),
    ref<string[] | null>(null),
  );
  const value = day.value;
  assert.ok(value, "päivää ei ratkennut lainkaan");
  return value;
}

function check(
  name: string,
  actual: ScheduleDay,
  expected: { date: string; label: string; rolledOver: boolean },
): void {
  assert.equal(actual.date, expected.date, `${name}: väärä päivä`);
  assert.equal(actual.label, expected.label, `${name}: väärä otsikko`);
  assert.equal(actual.rolledOver, expected.rolledOver, `${name}: väärä vaihtumisvihje`);
  console.log(`ok  ${name}`);
}

// Aamulla näytetään kuluva päivä eikä väitetä mitään vaihtumisesta.
check("ennen vaihtoaikaa näytetään tämä päivä", show(SCHOOL_DAYS, at(2026, 8, 11, 8)), {
  date: "2026-08-11",
  label: "Tänään 11.8.",
  rolledOver: false,
});

// Iltapäivällä siirrytään huomiseen — ja tämän vihjeen saa näyttää.
check("vaihtoajan jälkeen siirrytään huomiseen", show(SCHOOL_DAYS, at(2026, 8, 11, 13)), {
  date: "2026-08-12",
  label: "Huomenna 12.8.",
  rolledOver: true,
});

// Perjantai-iltapäivä: kello vei pois perjantaista, joten vihje on totta,
// vaikka viikonloppu vie näkymän vasta maanantaihin.
check("perjantaista hypätään maanantaihin", show(SCHOOL_DAYS, at(2026, 8, 14, 13)), {
  date: "2026-08-17",
  label: "Maanantaina 17.8.",
  rolledOver: true,
});

// Lauantaina maanantai näkyisi kellonajasta riippumatta, joten vihjettä ei saa
// näyttää: tyhjän viikonlopun ohittaminen ei ole kellon ansiota.
check("viikonloppuna vihjettä ei näytetä", show(SCHOOL_DAYS, at(2026, 8, 15, 13)), {
  date: "2026-08-17",
  label: "Maanantaina 17.8.",
  rolledOver: false,
});

// Loma: seuraavat tunnit ovat yhtä kaukana riippumatta siitä, onko klo 12
// mennyt. Tämä on se tapaus, joka oikeasti sattui 7.8.2026.
check("lomalla vihjettä ei näytetä", show(["2026-08-12", "2026-08-13"], at(2026, 8, 7, 13)), {
  date: "2026-08-12",
  label: "Keskiviikkona 12.8.",
  rolledOver: false,
});

// Kun mitään ei löydy, otsikon pitää kertoa mikä päivä on tyhjä.
const empty = show([], at(2026, 8, 11, 8));
assert.equal(empty.totalLessons, 0);
assert.equal(empty.label, "Tänään 11.8.", "tyhjänäkin otsikon pitää nimetä päivä");
console.log("ok  tunniton päivä nimetään silti");

/**
 * Selaustestit tarvitsevat suoran pääsyn composableen (ei vain `day.value`),
 * jotta navigointifunktioita voi kutsua ja kelloa voi siirtää eteenpäin.
 */
function browsable(dates: string[], nowValue: Date, rolloverTimeValue = "12:00") {
  const now = ref(nowValue);
  return {
    now,
    api: useScheduleDay(
      ref<WilmaData | null>(wilmaWith(dates)),
      now,
      ref(rolloverTimeValue),
      ref<string[] | null>(null),
    ),
  };
}

function dateOf(api: ReturnType<typeof browsable>["api"]): string {
  const value = api.day.value;
  assert.ok(value, "päivää ei ratkennut lainkaan");
  return value.date;
}

// Perjantai-aamu: automaattivalinta on itse perjantai (14.8., tunteja on).
// Selaus eteenpäin ei saa hypätä suoraan maanantaihin, vaikka automaattinäkymä
// tekisi niin — jokaisen napin painalluksen pitää tuottaa yksi näkyvä muutos.
{
  const { api } = browsable(SCHOOL_DAYS, at(2026, 8, 14, 8));
  assert.equal(dateOf(api), "2026-08-14");

  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-15", "lauantaihin pitää päästä yksi päivä kerrallaan");
  assert.equal(api.day.value?.totalLessons, 0);
  // "Huomenna" siksi, että se on kalenterissa seuraava päivä tästä hetkestä —
  // describe() nimeää huomisen aina näin, myös selattaessa.
  assert.equal(api.day.value?.label, "Huomenna 15.8.");

  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-16", "sunnuntaihin pitää päästä yksi päivä kerrallaan");
  assert.equal(api.day.value?.totalLessons, 0);

  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-17", "maanantaina on taas tunteja");
  assert.ok((api.day.value?.totalLessons ?? 0) > 0);
  console.log("ok  selaus etenee päivä kerrallaan myös tyhjän päivän yli");
}

// Taaksepäin ei pääse tätä päivää (todellista tätä hetkeä) aikaisemmaksi,
// vaikka automaattinäkymä olisi hypännyt monta päivää eteenpäin.
{
  const { api } = browsable(SCHOOL_DAYS, at(2026, 8, 11, 13));
  assert.equal(dateOf(api), "2026-08-12", "vaihtoajan jälkeen automaattivalinta on huominen");

  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-13");

  api.goToPreviousDay();
  assert.equal(dateOf(api), "2026-08-12");
  api.goToPreviousDay();
  assert.equal(dateOf(api), "2026-08-11", "taakse pääsee tähän päivään asti");

  assert.equal(api.canGoBack.value, false, "tätä päivää aikaisemmalle ei saa päästä");
  api.goToPreviousDay();
  assert.equal(dateOf(api), "2026-08-11", "painallus ei saa siirtää päivää enää taaksepäin");
  console.log("ok  taaksepäin ei pääse tätä päivää pidemmälle");
}

// Eteenpäin selaus ei saa mennä tunnetun datan ohi — muuten selaus johtaisi
// loputtomaan tyhjään.
{
  const { api } = browsable(["2026-08-12", "2026-08-13"], at(2026, 8, 7, 13));
  assert.equal(dateOf(api), "2026-08-12");

  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-13", "viimeinen tunnettu päivä on vielä selattavissa");

  assert.equal(api.canGoForward.value, false, "tunnetun datan ohi ei saa päästä");
  api.goToNextDay();
  assert.equal(dateOf(api), "2026-08-13", "painallus ei saa siirtää päivää tunnetun datan ohi");
  console.log("ok  eteenpäin ei pääse tunnetun datan ohi");
}

// Automaattinäkymässä vaihtumisvihje voi olla totta, mutta käyttäjän oma
// valinta ei ole kellon ansiota — vihjeen pitää hävitä heti kun selataan.
{
  const { api } = browsable(SCHOOL_DAYS, at(2026, 8, 11, 13));
  assert.equal(api.day.value?.rolledOver, true, "automaattinäkymässä vihje näkyy ennallaan");

  api.goToNextDay();
  assert.equal(api.day.value?.rolledOver, false, "selaustilassa vihje ei saa näkyä");

  api.goToPreviousDay();
  assert.equal(api.day.value?.rolledOver, false, "vihje pysyy pois myös takaisin selattaessa");
  console.log("ok  selaustilassa rolledOver on false");
}

// Selaus ei saa jäädä jumiin: viiden minuutin hiljaisuuden jälkeen näkymä
// palaa itsestään automaattivalintaan, ilman erillistä ajastinta — pelkkä
// kellon (`now`) eteneminen riittää. Aikaleima otetaan tarkoituksella samasta
// `now`-refistä eikä koneen omasta kellosta (ks. kommentti useScheduleDay.ts:ssä).
{
  const { api, now } = browsable(SCHOOL_DAYS, at(2026, 8, 11, 8));
  assert.equal(dateOf(api), "2026-08-11");

  api.goToNextDay();
  assert.equal(api.browsing.value, true);
  assert.equal(dateOf(api), "2026-08-12");

  // Neljä minuuttia myöhemmin selaus on yhä voimassa.
  now.value = new Date(now.value.getTime() + 4 * 60_000);
  assert.equal(api.browsing.value, true, "selauksen pitää pysyä voimassa alle viisi minuuttia");
  assert.equal(dateOf(api), "2026-08-12");

  // Viiden minuutin ja hetken jälkeen selaus on jo rauennut.
  now.value = new Date(now.value.getTime() + 61_000);
  assert.equal(api.browsing.value, false, "selauksen pitää raueta viiden minuutin jälkeen");
  assert.equal(dateOf(api), "2026-08-11", "näkymän pitää palata automaattivalintaan");
  console.log("ok  selaus palautuu automaattitilaan viiden minuutin jälkeen");
}

console.log("\nall schedule day tests passed");
process.exit(0);
