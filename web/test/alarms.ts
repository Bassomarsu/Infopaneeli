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
import { nextTick, ref } from "vue";
import {
  alarmsDueNow,
  alarmTargetForDate,
  describeOccurrence,
  nextAlarmOccurrence,
  useAlarms,
  type StorageLike,
} from "../src/composables/useAlarms.ts";
import type { Alarm, ScheduleLesson, WilmaData, WilmaStudent } from "../src/types.ts";

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

  const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, storage: memoryStorage() });
  await nextTick();
  assert.equal(active.value === null, true, "ei saa kaatua eikä näyttää mitään ennen kuin hälytyksiä on ladattu");

  // Asetukset saapuvat myöhemmin (esim. /api/dashboard vastaa vasta nyt):
  // moottorin, joka on jo käynnissä tyhjillä hälytyksillä, pitää reagoida.
  const wilmaData = wilmaFor({ "1": [lesson("2026-08-11", "08:00")] });
  wilma.value = wilmaData;
  students.value = wilmaData.students;
  alarmsRef.value = [alarm({ id: "a1", minutesBefore: 30 })];
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
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", minutesBefore: 30 })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);

  const { active, acknowledge } = useAlarms({ wilma, now, alarms: alarmsRef, students, storage: memoryStorage() });
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
  const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", minutesBefore: 30 })]);
  const students = ref<WilmaStudent[]>(wilmaData.students);

  const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, storage: memoryStorage() });
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
    const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", minutesBefore: 30, label: "Herätys" })]);
    const students = ref<WilmaStudent[]>(wilmaData.students);
    const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, storage });
    await nextTick();
    assert.ok(active.value, "ensimmäisen \"sivulatauksen\" pitää laueta normaalisti");
  }
  // Tämä lohko sulkeutuu ilman kuittausta — juuri se tilanne joka simuloi
  // sivun sulkeutumista kesken hälytyksen.

  // "Uudelleenlataus" kymmenen sekuntia myöhemmin, ennen kuin kukaan kuittasi.
  {
    const now = ref(at(2026, 8, 11, 7, 30, 10));
    const wilma = ref<WilmaData | null>(wilmaData);
    const alarmsRef = ref<Alarm[]>([alarm({ id: "a1", minutesBefore: 30, label: "Herätys" })]);
    const students = ref<WilmaStudent[]>(wilmaData.students);
    const { active } = useAlarms({ wilma, now, alarms: alarmsRef, students, storage });
    await nextTick();
    const restored = active.value;
    assert.ok(restored, "uudelleenlatauksen jälkeen kuittaamattoman hälytyksen pitää palautua näkyviin");
    assert.equal(restored.alarm.id, "a1");
  }
  console.log("ok  uudelleenlataus palauttaa kuittaamattoman hälytyksen näkyviin jaetusta tallennustilasta");
}

await testEngineWorksBeforeSettingsHaveLoaded();
await testAcknowledgedAlarmDoesNotReturnWithinTheSameWindow();
await testUnacknowledgedAlarmStaysVisibleAfterWindowCloses();
await testReloadRestoresUnacknowledgedAlarmFromSharedStorage();

console.log("\nall alarm trigger tests passed");
process.exit(0);
