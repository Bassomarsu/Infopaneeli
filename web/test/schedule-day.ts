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

console.log("\nall schedule day tests passed");
process.exit(0);
