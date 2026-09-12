/**
 * Sään sijainnin postinumerohaku (src/composables/useWeatherLocation.ts).
 *
 * Tässä testataan juuri se osa jota selaimessa ei voi silmällä todentaa:
 * milloin verkkopyyntö LÄHTEE ja milloin ei, ja mikä vastaus kelpaa kun
 * käyttäjä on jo ehtinyt kirjoittaa jotain muuta. Viive on testissä pieni
 * (ei tuotannon 350 ms) — logiikka ei riipu sen suuruudesta, sama kikka kuin
 * kiosk-exit-hotspot.ts:ssä.
 *
 * Aja:  npm run test:weather-location --workspace=web
 */
import assert from "node:assert/strict";
import {
  createPostalCodeLookup,
  fetchCurrentWeatherLocation,
  normalizePostalCode,
  isCompletePostalCode,
  type FetchLike,
} from "../src/composables/useWeatherLocation.ts";

const DEBOUNCE_MS = 20;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Antaa jokaiselle URLille sille määritellyn vastauksen ja kirjaa kutsut. */
function fakeFetch(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    urls.push(input);
    return handler(input);
  };
  return { fetchImpl, urls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const KARSTULA = { code: "43500", place: "Karstula", latitude: 62.86667, longitude: 24.78333 };

function testNormalize(): void {
  assert.equal(normalizePostalCode(" 43 500 "), "43500", "välilyönnit pois");
  assert.equal(normalizePostalCode("43500abc"), "43500", "kirjaimet pois");
  assert.equal(normalizePostalCode("435009"), "43500", "kuudes numero katkaistaan");
  assert.equal(normalizePostalCode("00100"), "00100", "etunolla säilyy");
  assert.equal(isCompletePostalCode("4350"), false);
  assert.equal(isCompletePostalCode("43500"), true);
  console.log("ok  postinumero siivotaan numeroiksi ja etunolla säilyy");
}

async function testNoRequestBeforeFiveDigits(): Promise<void> {
  const { fetchImpl, urls } = fakeFetch(() => json(200, KARSTULA));
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  for (const partial of ["4", "43", "435", "4350"]) {
    lookup.setInput(partial);
    assert.equal(lookup.state.value.kind, "incomplete", `${partial} on kesken, ei virhe`);
  }
  await wait(DEBOUNCE_MS + 15);
  assert.deepEqual(urls, [], "vajaasta numerosta ei saa lähteä yhtään pyyntöä");

  lookup.dispose();
  console.log("ok  vajaa postinumero ei laukaise pyyntöä eikä näytä virhettä");
}

async function testDebounceSendsOneRequest(): Promise<void> {
  const { fetchImpl, urls } = fakeFetch(() => json(200, KARSTULA));
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  // Käyttäjä kirjoittaa 43500, ehtii yliviisi-tilaan ja korjaa takaisin.
  lookup.setInput("43500");
  lookup.setInput("435001");
  lookup.setInput("43500");
  assert.equal(lookup.state.value.kind, "loading", "viisi numeroa siirtyy hakutilaan heti");
  await wait(DEBOUNCE_MS + 15);

  assert.deepEqual(urls, ["/api/postal-code/43500"], "kirjoittamisesta saa lähteä täsmälleen yksi pyyntö");
  assert.deepEqual(lookup.state.value, { kind: "found", code: "43500", place: KARSTULA });

  lookup.dispose();
  console.log("ok  näppäily viivästetään yhdeksi pyynnöksi ja paikkakunta löytyy");
}

async function testUnknownCodeIsItsOwnState(): Promise<void> {
  const { fetchImpl } = fakeFetch(() => json(404, { error: "tuntematon" }));
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  lookup.setInput("99999");
  await wait(DEBOUNCE_MS + 15);
  assert.deepEqual(lookup.state.value, { kind: "unknown", code: "99999" }, "404 on tuntematon, ei virhe");

  lookup.dispose();
  console.log("ok  tuntematon postinumero erottuu omaksi tilakseen");
}

async function testNetworkErrorIsNotCachedAsUnknown(): Promise<void> {
  let attempt = 0;
  const fetchImpl: FetchLike = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("verkko poikki");
    return json(200, KARSTULA);
  };
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  lookup.setInput("43500");
  await wait(DEBOUNCE_MS + 15);
  assert.equal(lookup.state.value.kind, "error", "verkkovirhe ei ole 'tuntematon postinumero'");

  // Sama numero uudestaan: virhettä ei saa muistaa välimuistissa, koska
  // numero voi olla aivan oikea.
  lookup.setInput("");
  lookup.setInput("43500");
  await wait(DEBOUNCE_MS + 15);
  assert.equal(lookup.state.value.kind, "found", "uusi yritys samalle numerolle pitää oikeasti hakea");

  lookup.dispose();
  console.log("ok  verkkovirhettä ei muisteta tuntemattomaksi postinumeroksi");
}

async function testStaleResponseIsIgnored(): Promise<void> {
  // Ensimmäinen vastaus on hidas, toinen nopea. Hidas saapuu viimeisenä
  // eikä se saa ylikirjoittaa sitä mitä käyttäjä oikeasti kirjoitti.
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith("/43500")) {
      await wait(60);
      return json(200, KARSTULA);
    }
    return json(200, { code: "00100", place: "Helsinki", latitude: 60.17, longitude: 24.94 });
  };
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  lookup.setInput("43500");
  await wait(DEBOUNCE_MS + 5); // hidas pyyntö on nyt lennossa
  lookup.setInput("00100");
  await wait(DEBOUNCE_MS + 100);

  const state = lookup.state.value;
  assert.equal(state.kind, "found");
  assert.equal(state.kind === "found" ? state.code : null, "00100", "vanha hidas vastaus ei saa voittaa uutta");

  lookup.dispose();
  console.log("ok  vanhentunut vastaus ei ylikirjoita tuoreempaa tulosta");
}

async function testClearingReturnsToEmpty(): Promise<void> {
  const { fetchImpl } = fakeFetch(() => json(200, KARSTULA));
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  lookup.setInput("43500");
  await wait(DEBOUNCE_MS + 15);
  assert.equal(lookup.state.value.kind, "found");

  lookup.setInput("");
  assert.deepEqual(lookup.state.value, { kind: "empty" }, "tyhjennys palauttaa tyhjään tilaan heti");

  lookup.dispose();
  console.log("ok  kentän tyhjennys palauttaa tyhjän tilan (eli .env-arvon)");
}

async function testDisposeCancelsPendingRequest(): Promise<void> {
  const { fetchImpl, urls } = fakeFetch(() => json(200, KARSTULA));
  const lookup = createPostalCodeLookup(fetchImpl, DEBOUNCE_MS);

  lookup.setInput("43500");
  lookup.dispose();
  await wait(DEBOUNCE_MS + 15);
  assert.deepEqual(urls, [], "purettu paneeli ei saa lähettää odottavaa pyyntöä");

  console.log("ok  dispose peruu odottavan haun");
}

/**
 * Sijainti ja sen lähde tulevat dashboardista, yhdellä pyynnöllä. Aiemmin tästä
 * yritettiin ensin `/api/weather-location`:ia, jota ei ole olemassa: jokainen
 * paneelin avaus teki turhan 404-pyynnön, ja lähde jäi aina tuntemattomaksi.
 */
async function testCurrentLocationReadsDashboardOnce(): Promise<void> {
  const { fetchImpl, urls } = fakeFetch(() => json(200, { place: "Karstula", placeSource: "settings" }));

  const result = await fetchCurrentWeatherLocation(fetchImpl);
  assert.deepEqual(result, { place: "Karstula", source: "settings" });
  assert.deepEqual(urls, ["/api/dashboard"], "yksi pyyntö, eikä olemattomaan päätepisteeseen");
  console.log("ok  nykyinen sijainti ja lähde luetaan yhdellä dashboard-haulla");
}

async function testCurrentLocationTrustsServerSource(): Promise<void> {
  const { fetchImpl } = fakeFetch(() => json(200, { place: "Tampere", placeSource: "env" }));
  const result = await fetchCurrentWeatherLocation(fetchImpl);
  assert.deepEqual(result, { place: "Tampere", source: "env" }, "palvelin tietää lähteen, selain ei arvaa");
  console.log("ok  palvelimen kertoma .env-lähde välittyy sellaisenaan");
}

/**
 * Tuntematon lähde EI saa muuttua arvaukseksi. `retained` (tuntemattoman
 * numeron takia voimassa pidetty vanha sijainti) ja puuttuva kenttä (vanhempi
 * palvelin) ovat molemmat "ei tiedetä", ja paneeli näyttää silloin pelkän
 * paikannimen ilman lähdeväitettä.
 */
async function testCurrentLocationClaimsNoSourceWhenUnknown(): Promise<void> {
  for (const body of [
    { place: "Karstula", placeSource: "retained" },
    { place: "Karstula" },
    { place: "Karstula", placeSource: 42 },
    { place: "Karstula", placeSource: null },
  ]) {
    const { fetchImpl } = fakeFetch(() => json(200, body));
    const result = await fetchCurrentWeatherLocation(fetchImpl);
    assert.deepEqual(result, { place: "Karstula", source: null }, `${JSON.stringify(body)} ei kerro lähdettä`);
  }
  console.log("ok  tuntematon lähde jää null:ksi eikä muutu arvaukseksi");
}

async function testCurrentLocationSurvivesTotalFailure(): Promise<void> {
  const fetchImpl: FetchLike = async () => {
    throw new Error("ei yhteyttä");
  };
  assert.equal(await fetchCurrentWeatherLocation(fetchImpl), null, "kaatuminen ei saa kaataa paneelia");

  const { fetchImpl: broken } = fakeFetch(() => json(500, { error: "rikki" }));
  assert.equal(await fetchCurrentWeatherLocation(broken), null, "virhevastaus ei saa tuottaa paikkaa");

  const { fetchImpl: placeless } = fakeFetch(() => json(200, { timezone: "Europe/Helsinki" }));
  assert.equal(await fetchCurrentWeatherLocation(placeless), null, "ilman place-kenttää ei ole mitään näytettävää");
  console.log("ok  kaatuminen, virhevastaus ja puuttuva paikka palauttavat null eivätkä heitä");
}

async function main(): Promise<void> {
  testNormalize();
  await testNoRequestBeforeFiveDigits();
  await testDebounceSendsOneRequest();
  await testUnknownCodeIsItsOwnState();
  await testNetworkErrorIsNotCachedAsUnknown();
  await testStaleResponseIsIgnored();
  await testClearingReturnsToEmpty();
  await testDisposeCancelsPendingRequest();
  await testCurrentLocationReadsDashboardOnce();
  await testCurrentLocationTrustsServerSource();
  await testCurrentLocationClaimsNoSourceWhenUnknown();
  await testCurrentLocationSurvivesTotalFailure();
  console.log("\nkaikki sään sijainnin testit läpi");
}

await main();
