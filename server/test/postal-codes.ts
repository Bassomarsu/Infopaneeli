/**
 * Sään sijainti annetaan postinumerona: asennus kysyy sen, asetuspaneeli
 * vaihtaa sen, ja palvelin muuntaa sen koordinaateiksi niputetusta
 * aineistosta (ks. core/postal-codes.ts ja core/weather-location.ts).
 *
 * Kaksi asiaa voi mennä vikaan tavalla jota kukaan ei huomaa:
 *   1. Tuntematon tai kirjoitusvirheellinen postinumero pudottaisi sijainnin
 *      oletukseen, ja sääkortti näyttäisi väärän paikkakunnan säätä ilman että
 *      mikään kertoo miksi.
 *   2. Etusijajärjestys menisi väärin päin, jolloin asetuksista vaihdettu
 *      numero ei vaikuttaisi mihinkään — .env voittaisi sen — ja käyttäjä
 *      luulisi asetuksen olevan rikki.
 *
 * Aja:  npm run test:postal-codes --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import {
  isPostalCode,
  lookupPostalCode,
  postalTableLoadMs,
  postalTableSize,
} from "../src/core/postal-codes.ts";
import { WeatherLocationResolver, type WeatherLocation } from "../src/core/weather-location.ts";
import { defaultSettings, getSettings, SettingsValidationError, updateSettings } from "../src/core/settings.ts";

/** Vastaa WEATHER_LAT/WEATHER_LON/WEATHER_PLACE:n oletuksia (ks. core/config.ts). */
const KARSTULA_ENV: WeatherLocation = { place: "Karstula", latitude: 62.86667, longitude: 24.78333 };

function testKnownPostalCodeResolves(): void {
  const karstula = lookupPostalCode("43500");
  assert.ok(karstula, "43500 on suomalainen postinumero ja sen on löydyttävä");
  assert.equal(karstula.place, "Karstula");
  assert.equal(karstula.code, "43500");
  // Karstulan kirkonkylä; tarkkuus riittää säähän, joten verrataan väljästi.
  assert.ok(Math.abs(karstula.latitude - 62.87) < 0.1, `leveysaste oli ${karstula.latitude}`);
  assert.ok(Math.abs(karstula.longitude - 24.8) < 0.1, `pituusaste oli ${karstula.longitude}`);

  assert.equal(lookupPostalCode("00100")?.place, "Helsinki");
  assert.equal(lookupPostalCode("99999")?.place, "Korvatunturi", "aineiston on katettava koko maa");

  // Ahvenanmaa puuttuu GeoNamesista kokonaan ja tulee Tilastokeskuksen
  // Paavosta — jos rakennusskriptin paikkaus katoaa, koko 22xxx häviää
  // hiljaa ja vain tämä rivi huomaa sen.
  const maarianhamina = lookupPostalCode("22100");
  assert.ok(maarianhamina, "22100 (Ahvenanmaa) on paikattava Paavosta");
  assert.ok(Math.abs(maarianhamina.latitude - 60.0997) < 0.05, `leveysaste oli ${maarianhamina.latitude}`);
  assert.ok(Math.abs(maarianhamina.longitude - 19.9432) < 0.05, `pituusaste oli ${maarianhamina.longitude}`);

  console.log(`ok  tunnettu postinumero muuntuu paikannimeksi ja koordinaateiksi (${postalTableSize()} kpl)`);
}

function testUnknownPostalCodeIsNotFound(): void {
  assert.equal(lookupPostalCode("00000"), null, "00000 ei ole käytössä oleva postinumero");
  assert.equal(lookupPostalCode("12399"), null, "varaamaton numero ei saa palauttaa lähintä osumaa");
  console.log("ok  tuntematon postinumero palauttaa null eikä arvaa lähintä");
}

function testMalformedInputIsRejected(): void {
  for (const bad of ["", "4350", "435000", "43 500", "abcde", "4350a", " ", "-4350"]) {
    assert.equal(lookupPostalCode(bad), null, `"${bad}" ei ole postinumero`);
    assert.equal(isPostalCode(bad), false, `"${bad}" ei ole postinumeron muotoinen`);
  }
  for (const bad of [null, undefined, 43500, {}, [], true]) {
    assert.equal(lookupPostalCode(bad), null, `${String(bad)} ei ole postinumero`);
    assert.equal(isPostalCode(bad), false, `${String(bad)} ei ole postinumeron muotoinen`);
  }
  // Ympäröivä välilyönti on käyttäjän näppäilyä eikä virhe: se siistitään.
  assert.equal(lookupPostalCode(" 43500 ")?.place, "Karstula");
  console.log("ok  virheellinen muoto torjutaan, ympäröivät välilyönnit siistitään");
}

function testSettingBeatsEnvPostalCode(): void {
  const resolver = new WeatherLocationResolver();
  const { location } = resolver.resolve({
    settingPostalCode: "00100",
    envPostalCode: "43500",
    envLocation: KARSTULA_ENV,
  });
  assert.equal(location.place, "Helsinki", "asetuksen postinumeron on voitettava .env:n postinumero");
  console.log("ok  asetusten postinumero voittaa WEATHER_POSTAL_CODE:n");
}

function testEnvPostalCodeBeatsCoordinates(): void {
  const resolver = new WeatherLocationResolver();
  const { location } = resolver.resolve({
    settingPostalCode: null,
    envPostalCode: "00100",
    envLocation: KARSTULA_ENV,
  });
  assert.equal(location.place, "Helsinki", "WEATHER_POSTAL_CODE:n on voitettava WEATHER_LAT/LON");
  assert.ok(Math.abs(location.latitude - 60.17) < 0.1, `leveysaste oli ${location.latitude}`);
  console.log("ok  WEATHER_POSTAL_CODE voittaa WEATHER_LAT/WEATHER_LON/WEATHER_PLACE:n");
}

function testCoordinatesStillWorkWithoutAnyPostalCode(): void {
  const resolver = new WeatherLocationResolver();
  const { location, warning } = resolver.resolve({
    settingPostalCode: null,
    envPostalCode: "",
    envLocation: { place: "Kyyjärvi", latitude: 63.0361, longitude: 24.5675 },
  });
  assert.deepEqual(location, { place: "Kyyjärvi", latitude: 63.0361, longitude: 24.5675 });
  assert.equal(warning, null, "olemassa oleva koordinaattiasennus ei saa valittaa mistään");
  console.log("ok  vanha WEATHER_LAT/LON/PLACE-asennus toimii ennallaan ilman varoitusta");
}

function testUnknownPostalCodeKeepsPreviousLocation(): void {
  const resolver = new WeatherLocationResolver();

  const first = resolver.resolve({ settingPostalCode: "00100", envPostalCode: "", envLocation: KARSTULA_ENV });
  assert.equal(first.location.place, "Helsinki");

  // Käyttäjä kirjoittaa asetuksiin numeron väärin. Sijainnin ON pysyttävä
  // Helsingissä eikä pudota Karstulaan — ja siitä on kuuluttava loki.
  const second = resolver.resolve({ settingPostalCode: "00199", envPostalCode: "", envLocation: KARSTULA_ENV });
  assert.equal(second.location.place, "Helsinki", "tuntematon postinumero ei saa pudottaa sijaintia oletukseen");
  assert.notEqual(second.location.place, KARSTULA_ENV.place);
  assert.ok(second.warning, "tuntemattomasta postinumerosta on varoitettava");
  assert.ok(second.warning.includes("00199"), `varoituksen on nimettävä numero: ${second.warning}`);

  // Sama virhe ei saa toistua lokissa 20 minuutin välein.
  const third = resolver.resolve({ settingPostalCode: "00199", envPostalCode: "", envLocation: KARSTULA_ENV });
  assert.equal(third.location.place, "Helsinki");
  assert.equal(third.warning, null, "sama varoitus ei saa toistua peräkkäisillä hauilla");

  // Korjattu numero kelpaa taas, ja uusi virhe valittaa uudestaan.
  const fixed = resolver.resolve({ settingPostalCode: "43500", envPostalCode: "", envLocation: KARSTULA_ENV });
  assert.equal(fixed.location.place, "Karstula");
  assert.equal(fixed.warning, null);
  const broken = resolver.resolve({ settingPostalCode: "00199", envPostalCode: "", envLocation: KARSTULA_ENV });
  assert.ok(broken.warning, "korjauksen jälkeen sama virhe on taas uusi ja siitä kuuluu varoittaa");

  console.log("ok  tuntematon postinumero säilyttää edellisen sijainnin ja varoittaa kerran");
}

function testUnknownEnvPostalCodeFallsBackToCoordinatesLoudly(): void {
  // Ei aiempaa kelvollista sijaintia: koordinaatit ovat ainoa jäljellä oleva
  // tieto, mutta pudotus ei saa tapahtua hiljaa.
  const resolver = new WeatherLocationResolver();
  const { location, warning } = resolver.resolve({
    settingPostalCode: null,
    envPostalCode: "00199",
    envLocation: KARSTULA_ENV,
  });
  assert.deepEqual(location, KARSTULA_ENV);
  assert.ok(warning, "tuntemattomasta .env-postinumerosta on varoitettava");
  assert.ok(warning.includes("WEATHER_POSTAL_CODE"), `varoituksen on nimettävä lähde: ${warning}`);
  console.log("ok  tuntematon .env-postinumero putoaa koordinaatteihin vasta varoituksen kera");
}

function testSettingAcceptsAndNormalizes(): void {
  assert.equal(defaultSettings.weatherPostalCode, null, "oletuksena postinumeroa ei ole asetettu");

  assert.equal(updateSettings({ weatherPostalCode: "43500" }).weatherPostalCode, "43500");
  assert.equal(getSettings().weatherPostalCode, "43500", "asetuksen on säilyttävä tietokannassa");

  assert.equal(updateSettings({ weatherPostalCode: " 00100 " }).weatherPostalCode, "00100", "välilyönnit siistitään");
  assert.equal(updateSettings({ weatherPostalCode: "" }).weatherPostalCode, null, "tyhjä kenttä = ei asetettu");
  assert.equal(updateSettings({ weatherPostalCode: null }).weatherPostalCode, null);

  // Muodollisesti kelvollinen mutta aineistolle tuntematon numero EI ole
  // tallennusvirhe: aineisto voi olla vanhentunut, ja sijainnin ratkaisu
  // hoitaa sen varoituksella (ks. testUnknownPostalCodeKeepsPreviousLocation).
  assert.equal(updateSettings({ weatherPostalCode: "00199" }).weatherPostalCode, "00199");

  for (const bad of ["4350", "435000", "abcde", "43 500", 43500, {}, []]) {
    assert.throws(
      () => updateSettings({ weatherPostalCode: bad }),
      SettingsValidationError,
      `${JSON.stringify(bad)} ei kelpaa postinumeroksi`,
    );
  }

  // Siivous: muut testit eivät saa nähdä tämän jättämää arvoa.
  updateSettings({ weatherPostalCode: null });
  console.log("ok  weatherPostalCode-asetus validoidaan, normalisoidaan ja tallentuu");
}

function testLoadTimeIsReported(): void {
  const ms = postalTableLoadMs();
  assert.ok(ms > 0, "aineiston on pitänyt latautua johonkin aiemmista testeistä");
  assert.ok(ms < 1000, `aineiston lataus kesti ${ms.toFixed(1)} ms — liian kauan yhdelle 133 kt:n tiedostolle`);
  console.log(`ok  aineiston lataus kesti ${ms.toFixed(1)} ms`);
}

/**
 * Löydetty ajamalla, ei lukemalla: tuntematon numero ASETUKSISSA jäi täysin
 * hiljaiseksi silloin kun .env tarjosi kelvollisen postinumeron, koska varoitus
 * annettiin vasta kun kumpikin lähde epäonnistui. Käyttäjän näppäilyvirhe
 * vaihtoi siis sääkortin paikkakunnan .env:n mukaiseksi kertomatta mitään —
 * juuri se hiljainen väärä tieto, jota tässä projektissa vältetään.
 *
 * Toinen puoli on yhtä tärkeä: varoitus ei saa toistua joka hakukierroksella.
 * Sääproviderin sykli on 20 minuuttia, joten toistuva varoitus täyttäisi lokin
 * rivillä joka ei kerro mitään uutta.
 */
function testUnknownSettingWarnsEvenWhenEnvPostalCodeResolves(): void {
  const resolver = new WeatherLocationResolver();
  const sources = { settingPostalCode: "00000", envPostalCode: "00100", envLocation: KARSTULA_ENV };

  const first = resolver.resolve(sources);
  assert.equal(first.location.place, "Helsinki", "kelvollinen .env-numero ratkaisee sijainnin");
  assert.ok(first.warning, "asetusten tuntemattomasta numerosta on varoitettava vaikka .env kelpaa");
  assert.ok(first.warning.includes("00000"), `varoituksen on nimettävä numero: ${first.warning}`);
  assert.ok(first.warning.includes("asetuksissa"), `varoituksen on kerrottava mistä numero tuli: ${first.warning}`);

  // Kolme peräkkäistä kierrosta: yksikään ei saa valittaa uudestaan. Yksi
  // kierros ei riittäisi todisteeksi — vika jonka löysin heilautti varoituksen
  // päälle joka toisella haulla, ja se olisi mennyt läpi kahden kierroksen
  // testistä.
  for (let i = 2; i <= 4; i += 1) {
    const again = resolver.resolve(sources);
    assert.equal(again.location.place, "Helsinki");
    assert.equal(again.warning, null, `sama varoitus ei saa toistua (kierros ${i})`);
  }

  // Korjattu numero nollaa valituksen, ja sama virhe on sen jälkeen taas uusi.
  const fixed = resolver.resolve({ ...sources, settingPostalCode: "96100" });
  assert.equal(fixed.location.place, "Rovaniemi");
  assert.equal(fixed.warning, null);
  const brokenAgain = resolver.resolve(sources);
  assert.ok(brokenAgain.warning, "korjauksen jälkeen sama virhe on taas uusi ja siitä kuuluu varoittaa");

  console.log("ok  asetusten tuntematon numero varoittaa kerran myös kelvollisen .env-numeron rinnalla");
}

testKnownPostalCodeResolves();
testUnknownPostalCodeIsNotFound();
testMalformedInputIsRejected();
testSettingBeatsEnvPostalCode();
testEnvPostalCodeBeatsCoordinates();
testCoordinatesStillWorkWithoutAnyPostalCode();
testUnknownPostalCodeKeepsPreviousLocation();
testUnknownEnvPostalCodeFallsBackToCoordinatesLoudly();
testSettingAcceptsAndNormalizes();
testLoadTimeIsReported();
testUnknownSettingWarnsEvenWhenEnvPostalCodeResolves();

console.log("\nKaikki postinumerotestit läpi.");
