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
  alarmsDueNow,
  alarmTargetForDate,
  describeOccurrence,
  nextAlarmOccurrence,
  useAlarms,
  type AlarmSoundPlayer,
  type StorageLike,
} from "../src/composables/useAlarms.ts";
import type { Alarm, AlarmWeekdayRule, ScheduleLesson, WilmaData, WilmaStudent } from "../src/types.ts";

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

await testEngineWorksBeforeSettingsHaveLoaded();
await testAcknowledgedAlarmDoesNotReturnWithinTheSameWindow();
await testUnacknowledgedAlarmStaysVisibleAfterWindowCloses();
await testReloadRestoresUnacknowledgedAlarmFromSharedStorage();
await testAcknowledgeStopsSoundEvenWithNothingQueuedNext();
await testAcknowledgeStopsCurrentAndStartsNextQueuedAlarm();
await testRetrySoundUnlocksAndReplaysActiveAlarm();

console.log("\nall alarm trigger tests passed");
process.exit(0);
