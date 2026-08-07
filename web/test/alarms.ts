/**
 * Kouluhälytysten laukaisulogiikka (useAlarms.ts) on tässä eristetty puhtaiksi
 * funktioiksi juuri jotta se voidaan testata ilman selainta, localStoragea tai
 * Web Audiota. Kaksi sääntöä ovat kriittisimmät: hälytys ei saa laueta
 * jälkijunassa (sivun lataus keskellä päivää) eikä koskaan kahdesti samana
 * aamuna.
 *
 * Aja:  npm run test:alarms --workspace=web
 */
import assert from "node:assert/strict";
import {
  alarmsDueNow,
  alarmTargetForDate,
  describeOccurrence,
  nextAlarmOccurrence,
} from "../src/composables/useAlarms.ts";
import type { Alarm, ScheduleLesson, WilmaData } from "../src/types.ts";

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

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "a1",
    label: "Herätys",
    minutesBefore: 30,
    studentNumber: null,
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

// Laukeaa oikeaan aikaan: 30 min ennen 08:00-tuntia on 07:30.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ minutesBefore: 30 });
  const target = alarmTargetForDate(a, wilma, wilma.students, "2026-08-11");
  assert.ok(target, "tavoiteaika pitää löytyä kun tunteja on");
  assert.equal(target.getHours(), 7);
  assert.equal(target.getMinutes(), 30);

  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), neverRung);
  assert.equal(due.length, 1, "hälytyksen pitää laueta tavoitehetkellä");
  assert.equal(due[0]?.alarm.id, a.id);
  console.log("ok  hälytys laukeaa 30 min ennen ensimmäistä tuntia");
}

// Laukeamisikkuna on tarkalleen kapea — enintään yksi minuutti tavoiteajan jälkeen.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ minutesBefore: 30 });
  assert.equal(alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30, 0), neverRung).length, 1);
  assert.equal(
    alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30, 59), neverRung).length,
    1,
    "59 sekuntia myöhässä on vielä ikkunan sisällä",
  );
  assert.equal(
    alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 31, 1), neverRung).length,
    0,
    "yli minuutin myöhässä ei saa enää laueta",
  );
  console.log("ok  laukeamisikkuna on tasan yhden minuutin levyinen");
}

// Ei laukea tunnittomana päivänä (viikonloppu/loma).
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm();
  assert.equal(alarmTargetForDate(a, wilma, wilma.students, "2026-08-15"), null);
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 15, 7, 30), neverRung);
  assert.equal(due.length, 0, "tunniton päivä ei saa laueta");
  console.log("ok  tunniton päivä ei laukaise hälytystä");
}

// Ei laukea jälkijunassa — esim. sivun lataus keskellä päivää.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ minutesBefore: 30 });
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 13, 0), neverRung);
  assert.equal(due.length, 0, "kauan sitten mennyt tavoiteaika ei saa laueta jälkikäteen");
  console.log("ok  hälytys ei laukea jälkijunassa kun aika on jo kauan sitten mennyt");
}

// Ei laukea kahdesti — alreadyRung palauttaa true.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ minutesBefore: 30 });
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), () => true);
  assert.equal(due.length, 0, "jo soinut hälytys ei saa laueta uudestaan");
  console.log("ok  jo soinut hälytys ei laukea toistamiseen");
}

// Pois kytketty hälytys ei laukea, vaikka aika muuten täsmäisi.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a = alarm({ minutesBefore: 30, enabled: false });
  const due = alarmsDueNow([a], wilma, wilma.students, at(2026, 8, 11, 7, 30), neverRung);
  assert.equal(due.length, 0, "pois päältä oleva hälytys ei saa laueta");
  console.log("ok  pois kytketty hälytys ei laukea");
}

// Useampi hälytys samalle aamulle: kaksi eri hälytystä samalla tavoiteajalla laukeavat molemmat.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  const a1 = alarm({ id: "a1", label: "Herätys", minutesBefore: 30 });
  const a2 = alarm({ id: "a2", label: "Lähtö", minutesBefore: 30 });
  const due = alarmsDueNow([a1, a2], wilma, wilma.students, at(2026, 8, 11, 7, 30), neverRung);
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
  const anyChild = alarmTargetForDate(alarm({ studentNumber: null, minutesBefore: 30 }), wilma, wilma.students, "2026-08-11");
  assert.ok(anyChild);
  assert.equal(anyChild.getHours(), 7);
  assert.equal(anyChild.getMinutes(), 30, "mikä tahansa oppilas -hälytyksen pitää käyttää aikaisinta tuntia");

  const specific = alarmTargetForDate(
    alarm({ studentNumber: "1", minutesBefore: 30 }),
    wilma,
    wilma.students,
    "2026-08-11",
  );
  assert.ok(specific);
  assert.equal(specific.getHours(), 8, "tiettyyn oppilaaseen sidotun hälytyksen pitää käyttää vain hänen tuntejaan");
  console.log("ok  studentNumber null käyttää aikaisinta tuntia kaikista lapsista");
}

// nextAlarmOccurrence: esikatselu paneelia varten — tänään jos aika ei ole vielä mennyt,
// muuten seuraava koulupäivä jolla on tunteja.
{
  const wilma = wilmaFor({ "1": [lesson("2026-08-11", "08:00"), lesson("2026-08-12", "09:00")] });
  const a = alarm({ studentNumber: "1", minutesBefore: 30 });

  const occToday = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 6, 0));
  assert.ok(occToday);
  assert.equal(occToday.dateKey, "2026-08-11");
  assert.equal(occToday.isToday, true);
  assert.equal(describeOccurrence(occToday, at(2026, 8, 11, 6, 0)), "tänään klo 7.30");

  const occNext = nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 8, 0));
  assert.ok(occNext);
  assert.equal(occNext.dateKey, "2026-08-12");
  assert.equal(occNext.isToday, false);
  assert.equal(describeOccurrence(occNext, at(2026, 8, 11, 8, 0)), "huomenna klo 8.30");
  console.log("ok  esikatselu näyttää tänään tai seuraavan koulupäivän oikein");
}

// Ei tunteja lähipäivinä ollenkaan -> esikatselu palauttaa null eikä kaadu.
{
  const wilma = wilmaFor({ "1": [] });
  const a = alarm({ studentNumber: "1" });
  assert.equal(nextAlarmOccurrence(a, wilma, wilma.students, at(2026, 8, 11, 6, 0)), null);
  console.log("ok  ei tunteja lähipäivinä -> esikatselu on null");
}

console.log("\nall alarm trigger tests passed");
process.exit(0);
