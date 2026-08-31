/**
 * Hälytysasetukset tulevat kotiverkon puhelimelta siinä missä muutkin
 * asetukset (PUT /api/settings), joten parseAlarms on ainoa este virheellistä
 * tai haitallista syötettä vastaan ennen kuin se päätyy tietokantaan.
 *
 * Aja:  npm run test:alarm-settings --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { getSettings, MAX_ALARMS, parseAlarms, SettingsValidationError, updateSettings } from "../src/core/settings.ts";
import type { Alarm, AlarmWeekdayRule } from "../src/core/settings.ts";
import { setSetting } from "../src/core/store.ts";

function weekdaysMonFri(anchor: AlarmWeekdayRule["anchor"] = "schoolStart"): AlarmWeekdayRule[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({ weekday, anchor }));
}

function validAlarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "a1",
    label: "Herätys",
    trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: weekdaysMonFri() },
    enabled: true,
    soundId: "chime",
    volume: 0.8,
    repeatCount: 3,
    ...overrides,
  };
}

function rejects(value: unknown, why: string): void {
  assert.throws(() => parseAlarms(value), SettingsValidationError, why);
}

function testValidListIsAccepted(): void {
  const parsed = parseAlarms([validAlarm()]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], validAlarm());
  console.log("ok  kelvollinen hälytyslista hyväksytään sellaisenaan");
}

function testEmptyListIsAccepted(): void {
  assert.deepEqual(parseAlarms([]), []);
  console.log("ok  tyhjä lista on kelvollinen");
}

function testNonArrayIsRejected(): void {
  rejects({}, "objekti ei ole lista");
  rejects("alarms", "merkkijono ei ole lista");
  rejects(null, "null ei ole lista");
  console.log("ok  muu kuin lista torjutaan");
}

function testTooManyAlarmsIsRejected(): void {
  const many = Array.from({ length: MAX_ALARMS + 1 }, (_, i) => validAlarm({ id: `a${i}` }));
  rejects(many, "yli MAX_ALARMS hälytystä torjutaan");
  assert.equal(parseAlarms(Array.from({ length: MAX_ALARMS }, (_, i) => validAlarm({ id: `a${i}` }))).length, MAX_ALARMS);
  console.log("ok  hälytysten enimmäismäärä on voimassa");
}

function testDuplicateIdIsRejected(): void {
  rejects([validAlarm({ id: "a1" }), validAlarm({ id: "a1" })], "sama tunniste kahdesti torjutaan");
  console.log("ok  toistuva id torjutaan");
}

function testMissingOrBadIdIsRejected(): void {
  rejects([validAlarm({ id: "" })], "tyhjä id torjutaan");
  rejects([{ ...validAlarm(), id: 5 }], "numeerinen id torjutaan");
  rejects([{ ...validAlarm(), id: "sisältää välilyönnin id" }], "id ei saa sisältää välilyöntejä");
  console.log("ok  kelvoton id torjutaan");
}

function testEmptyOrTooLongLabelIsRejected(): void {
  rejects([validAlarm({ label: "" })], "tyhjä selite torjutaan");
  rejects([validAlarm({ label: "   " })], "pelkkää tyhjettä oleva selite torjutaan");
  rejects([validAlarm({ label: "x".repeat(61) })], "liian pitkä selite torjutaan");
  console.log("ok  tyhjä tai liian pitkä selite torjutaan");
}

function testMinutesBeforeOutOfRangeIsRejected(): void {
  const withMinutes = (minutesBefore: number): Alarm =>
    validAlarm({ trigger: { mode: "relative", minutesBefore, studentNumber: null, weekdays: weekdaysMonFri() } });
  rejects([withMinutes(0)], "0 minuuttia torjutaan");
  rejects([withMinutes(241)], "yli 240 minuuttia torjutaan");
  rejects([withMinutes(30.5)], "puolikas minuutti torjutaan");
  assert.equal((parseAlarms([withMinutes(1)])[0]?.trigger as { minutesBefore: number }).minutesBefore, 1);
  assert.equal((parseAlarms([withMinutes(240)])[0]?.trigger as { minutesBefore: number }).minutesBefore, 240);
  console.log("ok  minutesBefore-rajat ovat voimassa");
}

function testStudentNumberAcceptsStringOrNull(): void {
  const withStudent = (studentNumber: string | null): Alarm =>
    validAlarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber, weekdays: weekdaysMonFri() } });
  assert.equal((parseAlarms([withStudent(null)])[0]?.trigger as { studentNumber: string | null }).studentNumber, null);
  assert.equal((parseAlarms([withStudent("123")])[0]?.trigger as { studentNumber: string | null }).studentNumber, "123");
  rejects(
    [{ ...validAlarm(), trigger: { mode: "relative", minutesBefore: 30, studentNumber: 123, weekdays: weekdaysMonFri() } }],
    "numeerinen studentNumber torjutaan",
  );
  // Palvelin ei voi luotettavasti tietää mitkä oppilasnumerot ovat juuri nyt
  // olemassa Wilmassa (data voi olla hetkellisesti tyhjä), joten se EI saa
  // hylätä tuntematontakaan mutta muodoltaan kelvollista tunnistetta — muuten
  // käyttäjä lukkiutuisi ulos omista asetuksistaan jos lapsi katoaa Wilmasta
  // tai tunniste vaihtuu. Roikkuvan viittauksen tunnistaminen ja siitä
  // varoittaminen on käyttöliittymän (AlarmsPanel.vue) vastuulla.
  assert.equal(
    (parseAlarms([withStudent("ei-olemassa-oleva-oppilas")])[0]?.trigger as { studentNumber: string | null })
      .studentNumber,
    "ei-olemassa-oleva-oppilas",
    "tuntematon mutta muodoltaan kelvollinen studentNumber ei saa torjua koko hälytystä",
  );
  console.log("ok  studentNumber hyväksyy merkkijonon tai nullin, ei muuta");
}

function testEnabledMustBeBoolean(): void {
  rejects([{ ...validAlarm(), enabled: "true" }], "merkkijono enabled-kentässä torjutaan");
  rejects([{ ...validAlarm(), enabled: 1 }], "numero enabled-kentässä torjutaan");
  console.log("ok  enabled hyväksyy vain true/false");
}

function testSoundIdPattern(): void {
  rejects([validAlarm({ soundId: "" })], "tyhjä soundId torjutaan");
  rejects([validAlarm({ soundId: "Chime!" })], "erikoismerkkejä sisältävä soundId torjutaan");
  rejects([validAlarm({ soundId: "UPPERCASE" })], "isoja kirjaimia sisältävä soundId torjutaan");
  // soundId ei ole suljettu enum: tuntematonkin id kelpaa muodoltaan, koska
  // kenttä on suunniteltu kantamaan myöhemmin lisättävän oman äänen tunniste.
  assert.equal(parseAlarms([validAlarm({ soundId: "future-custom-sound" })])[0]?.soundId, "future-custom-sound");
  console.log("ok  soundId hyväksyy tunnisteenomaisen merkkijonon, myös tulevan mukautetun äänen");
}

function testVolumeRange(): void {
  rejects([validAlarm({ volume: -0.1 })], "negatiivinen volume torjutaan");
  rejects([validAlarm({ volume: 1.1 })], "yli 1 oleva volume torjutaan");
  assert.equal(parseAlarms([validAlarm({ volume: 0 })])[0]?.volume, 0);
  assert.equal(parseAlarms([validAlarm({ volume: 1 })])[0]?.volume, 1);
  console.log("ok  volume-rajat 0–1 ovat voimassa");
}

function testRepeatCountRange(): void {
  rejects([validAlarm({ repeatCount: 0 })], "0 toistoa torjutaan");
  rejects([validAlarm({ repeatCount: 9 })], "yli 8 toistoa torjutaan");
  rejects([validAlarm({ repeatCount: 2.5 })], "puolikas toistomäärä torjutaan");
  console.log("ok  repeatCount-rajat ovat voimassa");
}

// --- Trigger-kohtainen validointi: viikonpäivät, ankkuri, mode ---

function testTriggerModeMustBeKnown(): void {
  rejects(
    [{ ...validAlarm(), trigger: { mode: "sometime", weekdays: [] } }],
    "tuntematon trigger.mode torjutaan",
  );
  console.log("ok  tuntematon trigger.mode torjutaan");
}

function testRelativeWeekdayOutOfRangeIsRejected(): void {
  rejects(
    [validAlarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: [{ weekday: 7, anchor: "schoolStart" }] } })],
    "viikonpäivä 7 (yli sallitun 0-6) torjutaan",
  );
  rejects(
    [validAlarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: [{ weekday: -1, anchor: "schoolStart" }] } })],
    "negatiivinen viikonpäivä torjutaan",
  );
  console.log("ok  relative-triggerin viikonpäivän vaihteluväli on voimassa");
}

function testRelativeDuplicateWeekdayIsRejected(): void {
  rejects(
    [
      validAlarm({
        trigger: {
          mode: "relative",
          minutesBefore: 30,
          studentNumber: null,
          weekdays: [
            { weekday: 1, anchor: "schoolStart" },
            { weekday: 1, anchor: "breakfast" },
          ],
        },
      }),
    ],
    "sama viikonpäivä kahdesti relative-triggerissä torjutaan",
  );
  console.log("ok  toistuva viikonpäivä relative-triggerissä torjutaan");
}

function testRelativeAnchorMustBeKnown(): void {
  rejects(
    [
      validAlarm({
        trigger: {
          mode: "relative",
          minutesBefore: 30,
          studentNumber: null,
          weekdays: [{ weekday: 1, anchor: "lunch" }] as unknown as AlarmWeekdayRule[],
        },
      }),
    ],
    "tuntematon ankkuri torjutaan",
  );
  console.log("ok  tuntematon ankkuri torjutaan");
}

function testRelativeAcceptsEmptyWeekdaysAndMixedAnchors(): void {
  // Tyhjä viikonpäivälista on kelvollinen (hälytys ei vain koskaan laukea) —
  // sama periaate kuin muuallakin: ei estetä tallentamasta, vaan
  // käyttöliittymä varoittaa (ks. AlarmsPanel.vue).
  assert.equal(
    parseAlarms([validAlarm({ trigger: { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: [] } })])[0]
      ?.trigger.weekdays.length,
    0,
  );
  // Eri ankkuri eri päivinä (vaatimus 5: sama hälytys seuraa maanantaina
  // aamupalaa ja tiistaina koulun alkua) on kelvollinen yhdistelmä.
  const mixed = parseAlarms([
    validAlarm({
      trigger: {
        mode: "relative",
        minutesBefore: 15,
        studentNumber: null,
        weekdays: [
          { weekday: 1, anchor: "breakfast" },
          { weekday: 2, anchor: "schoolStart" },
        ],
      },
    }),
  ])[0];
  assert.ok(mixed);
  if (mixed.trigger.mode !== "relative") throw new Error("odotettiin relative-triggeriä");
  assert.deepEqual(mixed.trigger.weekdays, [
    { weekday: 1, anchor: "breakfast" },
    { weekday: 2, anchor: "schoolStart" },
  ]);
  console.log("ok  tyhjä viikonpäivälista ja päiväkohtaisesti vaihteleva ankkuri hyväksytään");
}

function testFixedTriggerRequiresValidTime(): void {
  rejects(
    [validAlarm({ trigger: { mode: "fixed", time: "not-a-time", weekdays: [1, 2, 3, 4, 5] } })],
    "kelvoton kellonaika fixed-triggerissä torjutaan",
  );
  rejects(
    [validAlarm({ trigger: { mode: "fixed", time: "25:00", weekdays: [1, 2, 3, 4, 5] } })],
    "yli 23 tunti torjutaan",
  );
  const parsed = parseAlarms([validAlarm({ trigger: { mode: "fixed", time: "07:30", weekdays: [1, 2, 3, 4, 5] } })])[0];
  assert.ok(parsed);
  if (parsed.trigger.mode !== "fixed") throw new Error("odotettiin fixed-triggeriä");
  assert.equal(parsed.trigger.time, "07:30");
  console.log("ok  fixed-triggerin kellonaika validoidaan ja kelvollinen läpäisee");
}

function testFixedTriggerHasNoMinutesOrStudent(): void {
  // Tyyppitasolla mahdotonta muodostaa (AlarmTrigger on unioni), mutta
  // rajapinnan pitää silti torjua käsin rakennettu JSON jossa fixed-triggerille
  // yritetään liittää relative-tilan kenttiä — nämä yksinkertaisesti
  // jätetään huomiotta koska parseTriggerObject lukee fixed-haarasta vain
  // time+weekdays, joten "minutesBefore" vuotaisi läpi vain jos sitä
  // vahingossa luettaisiin. Tämä testi dokumentoi ettei niin käy.
  const parsed = parseAlarms([
    validAlarm({
      trigger: { mode: "fixed", time: "07:30", weekdays: [1, 2, 3, 4, 5], minutesBefore: 30 } as never,
    }),
  ])[0];
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.trigger).sort(), ["mode", "time", "weekdays"].sort());
  console.log("ok  fixed-trigger ei kanna minuutteja eikä oppilasta vaikka ne annettaisiin");
}

function testFixedWeekdayDuplicateIsRejected(): void {
  rejects(
    [validAlarm({ trigger: { mode: "fixed", time: "07:30", weekdays: [1, 1] } })],
    "toistuva viikonpäivä fixed-triggerissä torjutaan",
  );
  rejects(
    [validAlarm({ trigger: { mode: "fixed", time: "07:30", weekdays: [8] } })],
    "yli sallitun vaihteluvälin viikonpäivä fixed-triggerissä torjutaan",
  );
  console.log("ok  fixed-triggerin viikonpäivät validoidaan samoin kuin relativessa");
}

// --- Yhteensopivuus: vanhan (ennen trigger-kenttää tallennetun) muotoisen hälytyksen tulkinta ---

function testLegacyShapeAlarmIsMigratedByParseAlarms(): void {
  // Tarkalleen sellainen olio kuin ennen tätä muutosta tallennettiin: ei
  // trigger-kenttää lainkaan, minutesBefore ja studentNumber suoraan
  // ylätasolla.
  const legacy = {
    id: "legacy1",
    label: "Vanha herätys",
    minutesBefore: 45,
    studentNumber: "123",
    enabled: true,
    soundId: "chime",
    volume: 0.8,
    repeatCount: 3,
  };
  const parsed = parseAlarms([legacy])[0];
  assert.ok(parsed);
  assert.equal(parsed.trigger.mode, "relative");
  if (parsed.trigger.mode !== "relative") throw new Error("odotettiin relative-triggeriä");
  assert.equal(parsed.trigger.minutesBefore, 45);
  assert.equal(parsed.trigger.studentNumber, "123");
  // Migraation oletus on KAIKKI viikonpäivät, ei ma-pe: vanha hälytys laukesi
  // aiemmin minä tahansa päivänä jolloin oli tunteja, riippumatta
  // viikonpäivästä, joten migraatio ei saa hiljaisesti kaventaa sitä.
  assert.deepEqual(
    parsed.trigger.weekdays.map((r) => r.weekday).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.ok(parsed.trigger.weekdays.every((r) => r.anchor === "schoolStart"));
  console.log("ok  vanhan muotoinen hälytys tulkitaan kaikkina viikonpäivinä koulun alkuun");
}

function testLegacyShapeAlarmWithNullStudentIsMigrated(): void {
  const legacy = {
    id: "legacy2",
    label: "Vanha herätys 2",
    minutesBefore: 20,
    studentNumber: null,
    enabled: false,
    soundId: "chime",
    volume: 0.5,
    repeatCount: 1,
  };
  const parsed = parseAlarms([legacy])[0];
  assert.ok(parsed);
  if (parsed.trigger.mode !== "relative") throw new Error("odotettiin relative-triggeriä");
  assert.equal(parsed.trigger.studentNumber, null);
  assert.equal(parsed.enabled, false);
  console.log("ok  vanhan muotoinen hälytys jolla studentNumber on null migroituu myös");
}

/**
 * Vanhan hälytyksen on jatkettava soimista käyttäjän koskematta siihen —
 * tämä testaa koko luentapolun (getSettings), ei vain parseAlarmsia
 * suoraan, koska getSettings on se mistä sekä /api/dashboard että
 * /api/settings lukevat. Tallennus ohittaa updateSettingsin ja kirjoittaa
 * suoraan storeen, jotta testi vastaa aidosti sitä mitä levylle jäi ennen
 * tätä muutosta — updateSettings/parseAlarms tuottaisi jo uuden muodon.
 */
function testGetSettingsMigratesLegacyAlarmFromStore(): void {
  setSetting("settings", {
    alarms: [
      {
        id: "legacy3",
        label: "Ikivanha herätys",
        minutesBefore: 25,
        studentNumber: null,
        enabled: true,
        soundId: "chime",
        volume: 0.7,
        repeatCount: 2,
      },
    ],
  });
  const settings = getSettings();
  assert.equal(settings.alarms.length, 1);
  const alarm = settings.alarms[0];
  assert.ok(alarm);
  assert.equal(alarm.trigger.mode, "relative");
  if (alarm.trigger.mode !== "relative") throw new Error("odotettiin relative-triggeriä");
  assert.equal(alarm.trigger.minutesBefore, 25);
  assert.equal(alarm.trigger.weekdays.length, 7, "kaikki viikonpäivät, ei vain ma-pe");
  console.log("ok  getSettings migroi levyltä luetun vanhan muotoisen hälytyksen ilman käyttäjän toimia");
}

function testUpdateSettingsRoundTripsThroughAlarmsKey(): void {
  const alarm = validAlarm({ id: "roundtrip" });
  const next = updateSettings({ alarms: [alarm] });
  assert.deepEqual(next.alarms, [alarm]);
  // Muita asetuksia ei saa koskea kun patch sisältää vain alarms-kentän.
  assert.equal(next.rolloverTime, "12:00");
  console.log("ok  updateSettings tallentaa ja palauttaa alarms-kentän muita asetuksia koskematta");
}

function testUpdateSettingsRejectsInvalidAlarms(): void {
  assert.throws(
    () =>
      updateSettings({
        alarms: [{ ...validAlarm(), trigger: { mode: "relative", minutesBefore: -5, studentNumber: null, weekdays: weekdaysMonFri() } }],
      }),
    SettingsValidationError,
  );
  console.log("ok  updateSettings hylkää kelvottoman hälytyksen PUT /api/settingsin kautta");
}

// --- Aamupalan alkuaika (Settings.breakfastTime) ---

function testBreakfastTimeDefaultsAndValidates(): void {
  assert.equal(getSettings().breakfastTime, "08:00");
  assert.equal(updateSettings({ breakfastTime: "07:45" }).breakfastTime, "07:45");
  assert.throws(() => updateSettings({ breakfastTime: "not-a-time" }), SettingsValidationError);
  assert.throws(() => updateSettings({ breakfastTime: "25:00" }), SettingsValidationError);
  console.log("ok  breakfastTime oletusarvo on 08:00 ja validoidaan kellonaikana");
}

// --- Näytettävät lapset (Settings.visibleStudents / visiblePaikkyChildren) ---

/**
 * Kaksi lähdettä, sama sääntö: null = näytä kaikki, muuten lista tunnisteita.
 * Suodatus tehdään selaimessa, joten palvelimen ainoa tehtävä on olla
 * päästämättä läpi muotoa jota selain ei osaa lukea — ja pitää kentät erillään
 * toisistaan, koska Wilman opiskelijanumero ja Päikyn lapsen id eivät ole sama
 * avaruus.
 */
function testVisiblePaikkyChildrenDefaultsAndValidates(): void {
  assert.equal(getSettings().visiblePaikkyChildren, null, "oletus on null eli kaikki lapset");

  const next = updateSettings({ visiblePaikkyChildren: ["104", "107"] });
  assert.deepEqual(next.visiblePaikkyChildren, ["104", "107"]);
  assert.equal(next.visibleStudents, null, "Päikyn lapsivalinta ei saa koskea Wilman valintaan");
  assert.deepEqual(updateSettings({ visiblePaikkyChildren: [] }).visiblePaikkyChildren, [], "tyhjä lista on kelvollinen");
  assert.equal(updateSettings({ visiblePaikkyChildren: null }).visiblePaikkyChildren, null, "null palauttaa kaikki");

  assert.throws(() => updateSettings({ visiblePaikkyChildren: [104] }), SettingsValidationError, "numerot torjutaan");
  assert.throws(() => updateSettings({ visiblePaikkyChildren: "104" }), SettingsValidationError, "merkkijono ei ole lista");
  assert.throws(() => updateSettings({ visibleStudents: [1] }), SettingsValidationError, "visibleStudents validoi yhä samoin");
  console.log("ok  visiblePaikkyChildren oletus on null ja validoidaan kuten visibleStudents");
}

testValidListIsAccepted();
testEmptyListIsAccepted();
testNonArrayIsRejected();
testTooManyAlarmsIsRejected();
testDuplicateIdIsRejected();
testMissingOrBadIdIsRejected();
testEmptyOrTooLongLabelIsRejected();
testMinutesBeforeOutOfRangeIsRejected();
testStudentNumberAcceptsStringOrNull();
testEnabledMustBeBoolean();
testSoundIdPattern();
testVolumeRange();
testRepeatCountRange();
testTriggerModeMustBeKnown();
testRelativeWeekdayOutOfRangeIsRejected();
testRelativeDuplicateWeekdayIsRejected();
testRelativeAnchorMustBeKnown();
testRelativeAcceptsEmptyWeekdaysAndMixedAnchors();
testFixedTriggerRequiresValidTime();
testFixedTriggerHasNoMinutesOrStudent();
testFixedWeekdayDuplicateIsRejected();
testLegacyShapeAlarmIsMigratedByParseAlarms();
testLegacyShapeAlarmWithNullStudentIsMigrated();
testGetSettingsMigratesLegacyAlarmFromStore();
testUpdateSettingsRoundTripsThroughAlarmsKey();
testUpdateSettingsRejectsInvalidAlarms();
testBreakfastTimeDefaultsAndValidates();
testVisiblePaikkyChildrenDefaultsAndValidates();

console.log("\nall alarm settings tests passed");
process.exit(0);
