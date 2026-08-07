/**
 * Perhe pudottaa omat hälytysäänitiedostonsa data/sounds-kansioon käsin (ei
 * latausta käyttöliittymästä), ja core/alarm-sounds.ts listaa ne ja ratkaisee
 * soittopyynnön tunnisteen ($id) turvallisesti tiedostopoluksi. Tässä
 * testataan erityisesti: suomalaiset ää/ö-kirjaimet ja välilyönnit
 * tiedostonimissä, tunnettujen päätteiden suodatus, ja ettei mikä tahansa
 * pyydetty tunniste (myös polkuhyökkäysyritys) koskaan tuota polkua kansion
 * ulkopuolelle.
 *
 * Aja:  npm run test:alarm-sounds --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlarmSoundLibrary } from "../src/core/alarm-sounds.ts";

/**
 * Oma väliaikaiskansio jokaiselle testille — nimessä on tarkoituksella
 * ä-kirjain, koska projektin oma polku (".../Infonäyttö/...") sisältää niitä
 * jo nyt, ja tämän täytyy kestää se ilman erikoiskäsittelyä.
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infonaytto-äänet-"));
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function testMissingDirIsCreatedAutomatically(): void {
  const parent = makeTempDir();
  const dir = path.join(parent, "vielä-ei-olemassa");
  assert.equal(fs.existsSync(dir), false, "kansiota ei ole vielä olemassa ennen kirjastoa");
  new AlarmSoundLibrary(dir);
  assert.equal(fs.existsSync(dir), true, "kirjaston pitää luoda äänikansio jos sitä ei ole");
  cleanup(parent);
  console.log("ok  puuttuva äänikansio luodaan automaattisesti");
}

function testEmptyDirListsNothing(): void {
  const dir = makeTempDir();
  const lib = new AlarmSoundLibrary(dir);
  assert.deepEqual(lib.listCustomSounds(true), []);
  cleanup(dir);
  console.log("ok  tyhjä kansio listaa tyhjän listan (ei kaadu)");
}

function testFinnishFilenameWithSpacesIsListedWithSafeId(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "herätys aamulla.mp3"), "dummy-mp3-data");
  const lib = new AlarmSoundLibrary(dir);
  const list = lib.listCustomSounds(true);
  assert.equal(list.length, 1, "suomenkielinen tiedostonimi löytyy listauksesta");
  assert.equal(list[0]?.label, "herätys aamulla", "label näyttää alkuperäisen (ääkkösellisen) tiedostonimen ilman päätettä");
  // Sama sääntö kuin server/src/core/settings.ts:n ALARM_SOUND_ID_PATTERN:issa
  // — tunnisteen on kelvattava soundId-kenttään ilman muutoksia.
  assert.match(list[0]?.id ?? "", /^[a-z0-9_-]{1,40}$/, "tunniste kelpaa Alarm.soundId-kenttään sellaisenaan");
  cleanup(dir);
  console.log("ok  suomenkielinen, välilyönnillinen tiedostonimi listataan turvallisella tunnisteella");
}

function testUnknownExtensionIsIgnored(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "muistiinpano.txt"), "not audio");
  fs.writeFileSync(path.join(dir, "kuva.png"), "not audio either");
  fs.writeFileSync(path.join(dir, ".piilotiedosto"), "dotfile");
  const lib = new AlarmSoundLibrary(dir);
  assert.deepEqual(lib.listCustomSounds(true), [], "tuntemattomat päätteet ja piilotiedostot ohitetaan hiljaa");
  cleanup(dir);
  console.log("ok  tuntemattomat tiedostopäätteet ohitetaan");
}

function testAllKnownExtensionsAreAccepted(): void {
  const dir = makeTempDir();
  const names = ["a.mp3", "b.wav", "c.ogg", "d.m4a", "e.aac"];
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
  const lib = new AlarmSoundLibrary(dir);
  assert.equal(lib.listCustomSounds(true).length, names.length, "kaikki tunnetut äänipäätteet hyväksytään");
  cleanup(dir);
  console.log("ok  mp3/wav/ogg/m4a/aac hyväksytään kaikki");
}

function testSameFilenameAlwaysProducesSameId(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "sama.mp3"), "x");
  const lib = new AlarmSoundLibrary(dir);
  const first = lib.listCustomSounds(true)[0]?.id;
  const second = lib.listCustomSounds(true)[0]?.id;
  assert.equal(first, second, "sama tiedostonimi tuottaa aina saman tunnisteen peräkkäisillä listauksilla");

  const otherInstance = new AlarmSoundLibrary(dir);
  assert.equal(otherInstance.listCustomSounds(true)[0]?.id, first, "tunniste ei riipu kirjaston instanssista, vain tiedostonimestä");
  cleanup(dir);
  console.log("ok  tunniste on pysyvä samalle tiedostonimelle");
}

function testDifferentExtensionsProduceDifferentIds(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "herätys.mp3"), "x");
  fs.writeFileSync(path.join(dir, "herätys.wav"), "x");
  const lib = new AlarmSoundLibrary(dir);
  const ids = lib.listCustomSounds(true).map((s) => s.id);
  assert.equal(new Set(ids).size, 2, "sama perusnimi eri päätteellä ei saa törmätä samaan tunnisteeseen");
  cleanup(dir);
  console.log("ok  eri päätteet samalla perusnimellä saavat eri tunnisteet");
}

function testResolveFindsRealPathForListedSound(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "kello.mp3"), "x");
  const lib = new AlarmSoundLibrary(dir);
  const id = lib.listCustomSounds(true)[0]?.id ?? "";
  const resolved = lib.resolveCustomSound(id);
  assert.ok(resolved, "listattu tunniste ratkeaa tiedostoksi");
  assert.equal(resolved?.mimeType, "audio/mpeg", "mp3 saa oikean MIME-tyypin");
  assert.equal(path.basename(resolved?.path ?? ""), "kello.mp3");
  cleanup(dir);
  console.log("ok  resolveCustomSound löytää listatun äänen todellisen polun");
}

/**
 * Ydinvaatimus: mikä tahansa pyydetty tunniste (myös ilmiselvä
 * polkuhyökkäysyritys) EI SAA KOSKAAN palauttaa polkua kansion ulkopuolelta.
 * resolveCustomSound ei rakenna polkua parametrista lainkaan — se etsii
 * tunnisteen listauksesta — joten tämä pitäisi olla rakenteellisesti
 * mahdotonta murtaa, mutta testataan silti eksplisiittisesti koska tämä on
 * koko toteutuksen turvallisuuskriittisin kohta.
 */
function testUnknownOrMaliciousIdNeverResolves(): void {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "kelvollinen.mp3"), "x");
  // Tiedosto kansion ULKOPUOLELLA, jota hyökkäys yrittäisi tavoittaa.
  const outsideFile = path.join(path.dirname(dir), "salainen.txt");
  fs.writeFileSync(outsideFile, "ei kuulu tänne");

  const lib = new AlarmSoundLibrary(dir);
  lib.listCustomSounds(true);

  const maliciousIds = [
    "../salainen.txt",
    "..\\salainen.txt",
    "../../etc/passwd",
    "..%2f..%2fsalainen.txt",
    "kelvollinen.mp3", // tiedostonimi itse EI ole kelvollinen tunniste
    "",
    "file-kelvollinen-0000000000",
    "chime", // sisäänrakennettu ääni ei ole tiedostotunniste
  ];
  for (const id of maliciousIds) {
    assert.equal(lib.resolveCustomSound(id), null, `tunniste "${id}" ei saa ratketa mihinkään tiedostoon`);
  }

  fs.rmSync(outsideFile, { force: true });
  cleanup(dir);
  console.log("ok  tuntematon tai haitallinen tunniste ei koskaan ratkea tiedostoksi kansion ulkopuolella tai sisällä ilman listausta");
}

function testCacheServesStaleListUntilForceRefresh(): void {
  const dir = makeTempDir();
  const lib = new AlarmSoundLibrary(dir, 60_000); // pitkä TTL, jotta testi ei ole ajoituksesta riippuvainen
  assert.deepEqual(lib.listCustomSounds(false), [], "kansio on aluksi tyhjä");

  fs.writeFileSync(path.join(dir, "uusi.mp3"), "x");
  assert.deepEqual(lib.listCustomSounds(false), [], "välimuisti tarjoilee vanhan (tyhjän) listan kunnes pakotetaan päivitys");
  assert.equal(lib.listCustomSounds(true).length, 1, "forceRefresh=true näkee juuri lisätyn tiedoston heti");
  assert.equal(lib.listCustomSounds(false).length, 1, "seuraava kutsu käyttää nyt tuoretta välimuistia");

  cleanup(dir);
  console.log("ok  välimuisti ei lue kansiota jokaisella kutsulla, mutta forceRefresh ohittaa sen");
}

testMissingDirIsCreatedAutomatically();
testEmptyDirListsNothing();
testFinnishFilenameWithSpacesIsListedWithSafeId();
testUnknownExtensionIsIgnored();
testAllKnownExtensionsAreAccepted();
testSameFilenameAlwaysProducesSameId();
testDifferentExtensionsProduceDifferentIds();
testResolveFindsRealPathForListedSound();
testUnknownOrMaliciousIdNeverResolves();
testCacheServesStaleListUntilForceRefresh();

console.log("\nall alarm sound library tests passed");
process.exit(0);
