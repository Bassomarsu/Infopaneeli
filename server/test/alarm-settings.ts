/**
 * Hälytysasetukset tulevat kotiverkon puhelimelta siinä missä muutkin
 * asetukset (PUT /api/settings), joten parseAlarms on ainoa este virheellistä
 * tai haitallista syötettä vastaan ennen kuin se päätyy tietokantaan.
 *
 * Aja:  npm run test:alarm-settings --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { MAX_ALARMS, parseAlarms, SettingsValidationError, updateSettings } from "../src/core/settings.ts";
import type { Alarm } from "../src/core/settings.ts";

function validAlarm(overrides: Partial<Alarm> = {}): Alarm {
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
  rejects([validAlarm({ minutesBefore: 0 })], "0 minuuttia torjutaan");
  rejects([validAlarm({ minutesBefore: 241 })], "yli 240 minuuttia torjutaan");
  rejects([validAlarm({ minutesBefore: 30.5 })], "puolikas minuutti torjutaan");
  assert.equal(parseAlarms([validAlarm({ minutesBefore: 1 })])[0]?.minutesBefore, 1);
  assert.equal(parseAlarms([validAlarm({ minutesBefore: 240 })])[0]?.minutesBefore, 240);
  console.log("ok  minutesBefore-rajat ovat voimassa");
}

function testStudentNumberAcceptsStringOrNull(): void {
  assert.equal(parseAlarms([validAlarm({ studentNumber: null })])[0]?.studentNumber, null);
  assert.equal(parseAlarms([validAlarm({ studentNumber: "123" })])[0]?.studentNumber, "123");
  rejects([{ ...validAlarm(), studentNumber: 123 }], "numeerinen studentNumber torjutaan");
  // Palvelin ei voi luotettavasti tietää mitkä oppilasnumerot ovat juuri nyt
  // olemassa Wilmassa (data voi olla hetkellisesti tyhjä), joten se EI saa
  // hylätä tuntematontakaan mutta muodoltaan kelvollista tunnistetta — muuten
  // käyttäjä lukkiutuisi ulos omista asetuksistaan jos lapsi katoaa Wilmasta
  // tai tunniste vaihtuu. Roikkuvan viittauksen tunnistaminen ja siitä
  // varoittaminen on käyttöliittymän (AlarmsPanel.vue) vastuulla.
  assert.equal(
    parseAlarms([validAlarm({ studentNumber: "ei-olemassa-oleva-oppilas" })])[0]?.studentNumber,
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

function testUpdateSettingsRoundTripsThroughAlarmsKey(): void {
  const alarm = validAlarm({ id: "roundtrip" });
  const next = updateSettings({ alarms: [alarm] });
  assert.deepEqual(next.alarms, [alarm]);
  // Muita asetuksia ei saa koskea kun patch sisältää vain alarms-kentän.
  assert.equal(next.rolloverTime, "12:00");
  console.log("ok  updateSettings tallentaa ja palauttaa alarms-kentän muita asetuksia koskematta");
}

function testUpdateSettingsRejectsInvalidAlarms(): void {
  assert.throws(() => updateSettings({ alarms: [{ ...validAlarm(), minutesBefore: -5 }] }), SettingsValidationError);
  console.log("ok  updateSettings hylkää kelvottoman hälytyksen PUT /api/settingsin kautta");
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
testUpdateSettingsRoundTripsThroughAlarmsKey();
testUpdateSettingsRejectsInvalidAlarms();

console.log("\nall alarm settings tests passed");
process.exit(0);
