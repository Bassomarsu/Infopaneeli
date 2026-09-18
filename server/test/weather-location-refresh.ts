/**
 * Postinumeron vaihto asetuspaneelista: sääkortin on vaihduttava heti, eikä se
 * saa missään vaiheessa esittää toisen sijainnin säätä nykyisen sijainnin
 * tietona.
 *
 * Tämä testi on kirjoitettu mitattuja vikoja vasten (18.9.2026), ei
 * kuvitteellisia vastaan. Jokainen osa alla vastaa yhtä havaintoa:
 *
 *   1) Kortin otsikko luetaan koontinäkymän `place`-kentästä, joka ratkaistaan
 *      joka pyynnöllä, mutta lämpötilat providerin datasta, joka päivittyi
 *      vasta 20 minuutin kierrolla. Kortissa luki "Sodankylä" ja näkyi
 *      Karstulan 8,9 °C — tilana `ok`, tuoreella aikaleimalla, 17 min 31 s.
 *   2) `Provider` asettaa `stale`n myös lämpimässä käynnistyksessä, jolloin
 *      mikään ei ole epäonnistunut. Naiivi `stale -> failed` näytti viisi
 *      sekuntia punaista "EI YHTEYTTÄ" joka käynnistyksellä.
 *   3) Kun hakukierroksen yritysten katto tuli vastaan, vanhentunut tulos jäi
 *      viimeiseksi sanaksi: kortti sanoi "Haetaan…" eikä mitään ollut
 *      ajastettuna ennen seuraavaa 20 minuutin kiertoa.
 *   4) Paikannimi ei yksilöi sijaintia: 00100 ja 00101 ovat molemmat
 *      "Helsinki", 252 km erillään.
 *
 * Aja:  npm run test:weather-location-refresh --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import Fastify from "fastify";
import { registry, type ProviderSnapshot } from "../src/core/provider.ts";
import { config } from "../src/core/config.ts";
import { registerApiRoutes } from "../src/routes/api.ts";
import { getSettings, updateSettings } from "../src/core/settings.ts";
import { writeCache } from "../src/core/store.ts";
import { lookupPostalCode } from "../src/core/postal-codes.ts";
import {
  createWeatherProvider,
  currentWeatherLocation,
  fetchWeather,
  projectWeatherSnapshot,
  type WeatherData,
} from "../src/providers/weather.ts";
import type { WeatherLocation } from "../src/core/weather-location.ts";

const KARSTULA: WeatherLocation = { place: "Karstula", latitude: 62.86667, longitude: 24.78333 };

function paikka(code: string): WeatherLocation {
  const found = lookupPostalCode(code);
  assert.ok(found, `testin oletus: postinumero ${code} löytyy aineistosta`);
  return { place: found.place, latitude: found.latitude, longitude: found.longitude };
}

const SODANKYLA = paikka("99600");
const HELSINKI = paikka("00100");

/** Riittävä WeatherData: vain sijainti ja yksi lämpötila ovat tässä merkityksellisiä. */
function weatherData(location: WeatherLocation, temperature: number): WeatherData {
  return {
    place: location.place,
    latitude: location.latitude,
    longitude: location.longitude,
    current: {
      temperature,
      apparentTemperature: temperature,
      condition: { code: 0, description: "Selkeää", icon: "clear" },
      windSpeed: 1,
      precipitation: 0,
    },
    todayRemainingHours: [],
    days: [],
  };
}

function snapshotOf(
  data: unknown,
  status: ProviderSnapshot["status"],
  error: ProviderSnapshot["error"] = null,
): ProviderSnapshot<unknown> {
  return { id: "weather", status, data, fetchedAt: "2026-09-18T05:34:48.804Z", error };
}

/** Pienin Open-Meteo-vastaus jonka jäsennin hyväksyy. */
function openMeteoBody(): unknown {
  return {
    current: {
      time: "2026-09-18T08:00",
      temperature_2m: 8.9,
      apparent_temperature: 7.1,
      weather_code: 0,
      wind_speed_10m: 2.4,
      precipitation: 0,
    },
    hourly: {
      time: [],
      temperature_2m: [],
      apparent_temperature: [],
      precipitation: [],
      precipitation_probability: [],
      weather_code: [],
      wind_speed_10m: [],
    },
    daily: {
      time: [],
      weather_code: [],
      temperature_2m_max: [],
      temperature_2m_min: [],
      precipitation_sum: [],
      wind_speed_10m_max: [],
      sunrise: [],
      sunset: [],
    },
  };
}

const odota = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sääproviderin lokirivit levyltä. Sama kuvio kuin provider-transitions.ts:ssä.
 * Tarpeen siksi, että sijainnin vaihtuminen kesken haun EI SAA näyttää
 * lokissa katkokselta: heitto tuottaisi `provider_still_failing`- ja
 * `provider_recovered`-rivit tapahtumasta jossa mikään ei rikkoutunut.
 */
function saaLokirivit(): Array<Record<string, unknown>> {
  let tiedostot: string[];
  try {
    tiedostot = fs.readdirSync(config.logDir);
  } catch {
    return [];
  }
  const uusin = tiedostot
    .filter((f) => f.endsWith(".log"))
    .map((f) => `${config.logDir}/${f}`)
    .sort()
    .at(-1);
  if (uusin === undefined) return [];
  return fs
    .readFileSync(uusin, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((rivi) => JSON.parse(rivi) as Record<string, unknown>)
    .filter((entry) => entry["provider"] === "weather");
}

// ---------------------------------------------------------------------------
// 1) projectWeatherSnapshot: mikä data kelpaa ja millä tilalla
// ---------------------------------------------------------------------------

// Sama sijainti -> tilannekuva menee läpi KOSKEMATTOMANA. Tämä puoli pitää
// "viimeisin onnistunut data" -lupauksen voimassa: vanhentunutkin data näkyy
// aikaleimoineen niin kauan kuin se kuuluu nyt valittuun sijaintiin.
{
  const sama = snapshotOf(weatherData(KARSTULA, 8.9), "stale", { type: "Error", message: "katko" });
  assert.equal(projectWeatherSnapshot(sama, KARSTULA), sama, "sama sijainti: sama olio, ei muutosta");
}

// Eri sijainti, haku kunnossa -> ei dataa, ei aikaleimaa, tila `idle`.
{
  const out = projectWeatherSnapshot(snapshotOf(weatherData(KARSTULA, 8.9), "ok"), SODANKYLA);
  assert.equal(out.data, null, "toisen sijainnin dataa ei saa esittää");
  assert.equal(out.fetchedAt, null, "vanha aikaleima ei kuvaa uutta sijaintia");
  assert.equal(out.status, "idle", "haku on kunnossa -> Haetaan…");
}

// LÄMMIN KÄYNNISTYS EI OLE VERKKOVIKA. `stale` + `error === null` tarkoittaa
// että provideri lämmitteli levyvälimuistista eikä mikään ole epäonnistunut.
{
  const out = projectWeatherSnapshot(snapshotOf(weatherData(KARSTULA, 8.9), "stale", null), SODANKYLA);
  assert.equal(out.data, null);
  assert.equal(out.status, "idle", "lämmin käynnistys ei saa näyttää EI YHTEYTTÄ -virhettä");
}

// Virhe jota EI ole kirjattu tälle sijainnille ei saa näkyä sen virheenä.
// Tässä ei ole ajettu yhtään hakua, joten `lastFailureLocation` on tyhjä —
// juuri se tilanne jossa naiivi `stale -> failed` valehteli.
{
  const virhe = { type: "Error", message: "Open-Meteo returned HTTP 503" };
  for (const status of ["stale", "failed"] as const) {
    const out = projectWeatherSnapshot(snapshotOf(weatherData(KARSTULA, 8.9), status, virhe), SODANKYLA);
    assert.equal(out.data, null);
    assert.equal(out.status, "idle", `${status}: toisen sijainnin virhe ei ole tämän sijainnin vika`);
    assert.equal(out.error, null, "toisen sijainnin virheteksti ei saa näkyä tämän nimen alla");
  }
}

// PAIKANNIMI EI YKSILÖI SIJAINTIA. 00100 ja 00101 ovat molemmat "Helsinki"
// mutta 252 km erillään; nimivertailu olisi päästänyt tämän läpi.
{
  const helsinki101 = paikka("00101");
  assert.equal(helsinki101.place, HELSINKI.place, "testin oletus: sama paikannimi");
  assert.notEqual(helsinki101.latitude, HELSINKI.latitude, "testin oletus: eri koordinaatit");
  const out = projectWeatherSnapshot(snapshotOf(weatherData(helsinki101, 8.9), "ok"), HELSINKI);
  assert.equal(out.data, null, "sama nimi eri koordinaateilla on eri sijainti");
}

// PÄIVITYSPOLKU. Koordinaatiton välimuistirivi on kirjoitettu ennen näitä
// kenttiä, ja se on OIKEAN sijainnin dataa — käyttäjä ei ole vaihtanut mitään.
// Se täsmätään nimellä, jotta `store.ts`:n lupaus eilisillan ennusteesta pysyy
// voimassa myös silloin kun päivityksen jälkeinen ensimmäinen haku kaatuu.
{
  const vanha = { place: "Karstula", current: { temperature: 8.9 }, todayRemainingHours: [], days: [] };
  const sama = snapshotOf(vanha, "stale");
  assert.equal(projectWeatherSnapshot(sama, KARSTULA), sama, "vanha rivi samalta paikkakunnalta kelpaa yhä");

  // ...mutta vain saman nimen alla. Toisen paikkakunnan vanha rivi ei kelpaa.
  assert.equal(
    projectWeatherSnapshot(snapshotOf(vanha, "stale"), SODANKYLA).data,
    null,
    "vanha rivi toiselta paikkakunnalta ei kelpaa tämänkään jälkeen",
  );
}

// Uusi rivi täsmätään VAIN koordinaateilla — päivityspolku ei löysää sitä.
{
  const helsinki101 = paikka("00101");
  const uusi = weatherData(helsinki101, 8.9);
  assert.equal(
    projectWeatherSnapshot(snapshotOf(uusi, "ok"), HELSINKI).data,
    null,
    "koordinaatillinen rivi ei saa pelastua nimellä",
  );
}

// Tyhjä data ei ole minkään sijainnin dataa -> ei kosketa.
{
  const tyhja = snapshotOf(null, "idle");
  assert.equal(projectWeatherSnapshot(tyhja, SODANKYLA), tyhja);
}

// ---------------------------------------------------------------------------
// 2) Lämmin käynnistys oikean Providerin kanssa
// ---------------------------------------------------------------------------
//
// Tässä ei rakenneta tilannekuvaa käsin vaan luetaan se providerilta, jotta
// testi nojaa Providerin todelliseen käyttäytymiseen eikä oletukseen siitä.
{
  writeCache("weather", weatherData(KARSTULA, 8.9), "2026-09-18T05:34:48.804Z");
  updateSettings({ weatherPostalCode: "99600" });

  const kylma = createWeatherProvider({
    fetcher: (async () => {
      throw new Error("lämmin käynnistys ei saa hakea mitään tässä testissä");
    }) as typeof fetch,
  });
  const lammin = kylma.snapshot();
  assert.equal(lammin.status, "stale", "Provider lämmittelee välimuistista tilaan stale");
  assert.equal(lammin.error, null, "lämmin käynnistys ei aseta virhettä — tämä on erotteleva signaali");

  const nakyy = projectWeatherSnapshot(lammin, currentWeatherLocation().location);
  assert.equal(nakyy.status, "idle", "käynnistyksen jälkeen kortti hakee, ei ilmoita verkkovikaa");
  assert.equal(nakyy.data, null);
  kylma.stop();
  updateSettings({ weatherPostalCode: null });
}

// Päivitystilanne kokonaisuudessaan: levyllä on eilinen ennuste vanhassa
// muodossa, käyttäjä ei ole vaihtanut mitään, ja päivityksen jälkeinen
// ENSIMMÄINEN HAKU KAATUU (näyttö käynnistyi ennen reititintä). Juuri tätä
// varten viimeisin-onnistunut on olemassa, joten kortin on näytettävä eilinen
// ennuste aikaleimoineen eikä "Tietoja ei saatu".
{
  const eilinen = { place: "Karstula", current: { temperature: 5.8 }, todayRemainingHours: [], days: [] };
  writeCache("weather", eilinen, "2026-09-17T18:00:00.000Z");
  assert.equal(getSettings().weatherPostalCode, null, "käyttäjä ei ole vaihtanut mitään");

  const paivitetty = createWeatherProvider({
    fetcher: (async () => {
      throw new Error("verkko ei vastaa");
    }) as typeof fetch,
  });
  const sijainti = currentWeatherLocation().location;

  const lammin = projectWeatherSnapshot(paivitetty.snapshot(), sijainti);
  assert.equal((lammin.data as WeatherData | null)?.place, "Karstula", "eilinen ennuste kelpaa yhä");
  assert.equal(lammin.fetchedAt, "2026-09-17T18:00:00.000Z", "aikaleima kertoo kuinka vanhaa se on");

  await paivitetty.runOnce();
  const haunJalkeen = paivitetty.snapshot();
  assert.equal(haunJalkeen.status, "stale");
  assert.notEqual(haunJalkeen.error, null, "haku kaatui oikeasti");

  const kortilla = projectWeatherSnapshot(haunJalkeen, sijainti);
  assert.equal((kortilla.data as WeatherData | null)?.current.temperature, 5.8, "eilinen ennuste jää näkyviin");
  assert.equal(kortilla.fetchedAt, "2026-09-17T18:00:00.000Z", "vanhentunut-merkintä, ei tyhjää korttia");
  paivitetty.stop();
}

// ---------------------------------------------------------------------------
// 3) Koko polku reitin läpi oikealla providerilla
// ---------------------------------------------------------------------------

let hakuja = 0;
/** Pyydetyt leveysasteet järjestyksessä — näistä näkee mille sijainnille haettiin. */
const pyynnot: string[] = [];
/** Avataan käsin, jotta "haku on kesken" -hetki on mitattavissa eikä kilpaile. */
let avaa: (() => void) | null = null;
let portti: Promise<void> | null = null;
/** Ajetaan jokaisen haun alussa — näin testi voi vaihtaa sijainnin kesken haun. */
let haunAikana: (() => void) | null = null;
/** Kun tämä on asetettu, haku kaatuu annetulla viestillä — oikea verkkovika. */
let kaada: string | null = null;

const fetcher = (async (url: string | URL | Request) => {
  hakuja++;
  pyynnot.push(new URL(String(url)).searchParams.get("latitude") ?? "?");
  haunAikana?.();
  if (portti) await portti;
  if (kaada !== null) throw new Error(kaada);
  return Response.json(openMeteoBody());
}) as typeof fetch;

const provider = createWeatherProvider({ fetcher, rerunDelayMs: 50 });
registry.register(provider);

const app = Fastify();
await registerApiRoutes(app);

interface Kortti {
  place: string;
  placeSource: string;
  dataPlace: string | null;
  status: string;
  setting: string | null;
}

async function kortti(): Promise<Kortti> {
  const body = (await app.inject({ method: "GET", url: "/api/dashboard", remoteAddress: "127.0.0.1" })).json();
  const w = body.providers.weather as ProviderSnapshot<WeatherData>;
  return {
    place: body.place,
    placeSource: body.placeSource,
    dataPlace: w.data?.place ?? null,
    status: w.status,
    setting: body.settings.weatherPostalCode,
  };
}

async function tallenna(weatherPostalCode: string | null): Promise<number> {
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    remoteAddress: "127.0.0.1",
    payload: { weatherPostalCode },
  });
  // `runOnce()` lähtee liikkeelle `void`illa eli vasta vastauksen jälkeen;
  // annetaan sen edetä hakuun asti ennen kuin mitään väitetään.
  await odota(30);
  return res.statusCode;
}

/** Päästää portitetun haun valmiiksi ja odottaa providerin tilan päivittyvän. */
async function paastaLapi(): Promise<void> {
  const oli = avaa;
  portti = null;
  avaa = null;
  oli?.();
  await odota(30);
}

function suljePortti(): void {
  portti = new Promise<void>((r) => {
    avaa = r;
  });
}

/** Odottaa että kortti näyttää annetun paikkakunnan dataa. Palauttaa kuluneet ms. */
async function odotaKorttia(paikkakunta: string, maxMs = 3000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const k = await kortti();
    if (k.dataPlace === paikkakunta && k.status === "ok") return Date.now() - t0;
    assert.ok(Date.now() - t0 < maxMs, `kortti ei päätynyt paikkakuntaan ${paikkakunta} ${maxMs} ms:ssa`);
    await odota(10);
  }
}

// Lähtötilanne: ei asetusten postinumeroa -> .env:n sijainti (oletus Karstula).
assert.equal(getSettings().weatherPostalCode, null);
await provider.runOnce();
{
  const k = await kortti();
  assert.deepEqual(
    { place: k.place, src: k.placeSource, data: k.dataPlace, status: k.status },
    { place: "Karstula", src: "env", data: "Karstula", status: "ok" },
    "lähtötila: .env:n paikkakunta sekä otsikossa että datassa",
  );
}

// Postinumeron vaihto. Portti kiinni, eli haku on KESKEN juuri sillä hetkellä
// kun kortti luetaan — täsmälleen se hetki jolloin vika näkyi käyttäjälle.
{
  const ennen = hakuja;
  suljePortti();
  assert.equal(await tallenna("99600"), 200);
  assert.equal(hakuja, ennen + 1, "postinumeron vaihdon pitää laukaista uusi haku heti, ei 20 min päästä");

  const kesken = await kortti();
  assert.equal(kesken.place, "Sodankylä", "otsikko vaihtuu heti");
  assert.equal(kesken.placeSource, "settings");
  assert.equal(kesken.dataPlace, null, "Karstulan lämpötilat eivät saa näkyä Sodankylän nimen alla");
  assert.equal(kesken.status, "idle", "haun ajan kortti kertoo hakevansa eikä näytä vanhaa");

  await paastaLapi();
  const k = await kortti();
  assert.deepEqual(
    { place: k.place, data: k.dataPlace, status: k.status },
    { place: "Sodankylä", data: "Sodankylä", status: "ok" },
    "haun valmistuttua sekä otsikko että data ovat uudelta paikkakunnalta",
  );
}

// Toinen vaihto, selvästi eri paikkakunta.
{
  const ennen = hakuja;
  assert.equal(await tallenna("00100"), 200);
  assert.equal(hakuja, ennen + 1, "toinenkin vaihto hakee heti");
  const k = await kortti();
  assert.deepEqual(
    { place: k.place, data: k.dataPlace, status: k.status },
    { place: "Helsinki", data: "Helsinki", status: "ok" },
  );
}

// Tuntematon postinumero EI saa pudottaa sijaintia .env:n oletukseen. Edellinen
// sijainti jää voimaan (WeatherLocationResolver.lastGood), joten myös sen data
// kelpaa yhä — koordinaatit täsmäävät, eikä suodatus koske siihen.
//
// `12345` eikä `99999`: jälkimmäinen NÄYTTÄÄ tuntemattomalta mutta on oikea
// postinumero (Korvatunturi), ja tällä testillä se olisi mitannut aivan muuta
// kuin miltä se lukee. Tarkistettu aineistosta, ks. src/data/postinumerot.json.
{
  assert.equal(await tallenna("12345"), 200);
  const k = await kortti();
  assert.equal(k.setting, "12345", "tuntematonkin numero tallentuu — käyttäjä näkee mitä kirjoitti");
  assert.equal(k.place, "Helsinki", "tuntematon numero pitää edellisen sijainnin, ei pudota Karstulaan");
  assert.equal(k.placeSource, "retained");
  assert.equal(k.dataPlace, "Helsinki", "voimassa olevan sijainnin data pysyy näkyvissä");
  assert.equal(k.status, "ok");
}

// Takaisin ensimmäiseen: Helsingin dataa ei ole tallessa tarjoiltavaksi.
{
  const ennen = hakuja;
  suljePortti();
  assert.equal(await tallenna("99600"), 200);
  assert.equal(hakuja, ennen + 1);
  const kesken = await kortti();
  assert.equal(kesken.place, "Sodankylä");
  assert.equal(kesken.dataPlace, null, "Helsingin lämpötilat eivät saa jäädä Sodankylän nimen alle");
  await paastaLapi();
  assert.equal((await kortti()).dataPlace, "Sodankylä");
}

// Kentän tyhjennys palaa .env:n sijaintiin ja hakee sen datan.
{
  const ennen = hakuja;
  assert.equal(await tallenna(null), 200);
  assert.equal(hakuja, ennen + 1);
  const k = await kortti();
  assert.deepEqual(
    { place: k.place, src: k.placeSource, data: k.dataPlace, status: k.status },
    { place: "Karstula", src: "env", data: "Karstula", status: "ok" },
  );
}

// Asetus, joka ei koske sijaintiin, ei saa laukaista sääpyyntöä.
{
  const ennen = hakuja;
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    remoteAddress: "127.0.0.1",
    payload: { breakfastTime: "07:15" },
  });
  assert.equal(res.statusCode, 200);
  await odota(30);
  assert.equal(hakuja, ennen, "muu asetus ei saa hakea säätä");
}

// ---------------------------------------------------------------------------
// 5) UMPIKUJA: sijainti vaihtuu jokaisella yrityksellä
// ---------------------------------------------------------------------------
//
// Ilman ajastettua uusintaa kierros päättyi vanhentuneeseen sijaintiin,
// projektio suodatti sen pois, eikä mitään ollut ajastettuna ennen seuraavaa
// 20 minuutin kiertoa: kortissa luki "Haetaan…" vaikka kukaan ei hakenut.
// Ehto jota vastaan tämä mittaa: ei saa olla tilaa jossa kortti hakee eikä
// mitään ole ajastettuna.
// ---------------------------------------------------------------------------
// 4) OIKEA VERKKOVIKA näkyy yhä — korjaus ei saa niellä sitä
// ---------------------------------------------------------------------------
//
// Lämpimän käynnistyksen korjaus tekee `idle`stä oletuksen, joten tässä
// mitataan se toinen suunta: kun haku oikeasti epäonnistuu NYKYISELLE
// sijainnille, kortin on sanottava se.
{
  kaada = "Open-Meteo returned HTTP 503";
  assert.equal(await tallenna("99600"), 200);
  const k = await kortti();
  assert.equal(k.place, "Sodankylä");
  assert.equal(k.dataPlace, null, "Karstulan dataa ei esitetä Sodankylän tietona");
  assert.equal(k.status, "failed", "oikea verkkovika PITÄÄ näkyä virheenä");
  const w = (await app.inject({ method: "GET", url: "/api/dashboard", remoteAddress: "127.0.0.1" })).json()
    .providers.weather as ProviderSnapshot<WeatherData>;
  assert.match(w.error?.message ?? "", /503/, "virheteksti on kortin ainoa selitys");
}

// ...mutta EDELLISEN sijainnin virhe ei ole tämän sijainnin vika. Sodankylän
// 503 ei saa näkyä Helsingin nimen alla sillä hetkellä kun Helsingin haku on
// vasta matkalla. Sama kirjanpito kuin jätehuollon `lastFailureRevision`illa.
{
  kaada = null;
  suljePortti();
  assert.equal(await tallenna("00100"), 200);
  const kesken = await kortti();
  assert.equal(kesken.place, "Helsinki");
  assert.equal(kesken.status, "idle", "toisen sijainnin virhe ei saa jäädä tämän päälle");
  const w = (await app.inject({ method: "GET", url: "/api/dashboard", remoteAddress: "127.0.0.1" })).json()
    .providers.weather as ProviderSnapshot<WeatherData>;
  assert.equal(w.error, null, "toisen sijainnin virheteksti ei saa näkyä tämän nimen alla");
  await paastaLapi();
  assert.equal((await kortti()).dataPlace, "Helsinki");
}

// Palautetaan tunnettu lähtötila ennen umpikujakoetta.
assert.equal(await tallenna(null), 200);
await odotaKorttia("Karstula");

/** Mitattu toipumisaika umpikujasta — tulostetaan lopuksi, ks. RERUN_DELAY_MS. */
let umpikujaMs = 0;
{
  // Vain TUNNETTUJA ja keskenään eri numeroita. Tuntematon numero olisi
  // pitänyt edellisen sijainnin voimassa (`retained`), jolloin kierros olisi
  // osunut oikeaan sijaintiin vahingossa eikä umpikujaa olisi syntynyt — mitattu.
  const jono = ["00100", "99600", "00100"];
  let i = 0;
  haunAikana = () => {
    const seuraava = jono[i++];
    if (seuraava !== undefined) updateSettings({ weatherPostalCode: seuraava });
  };
  // Lokin lähtötaso ENNEN tätä lohkoa: aiemmat lohkot kaatoivat haun tahallaan
  // ja kirjasivat siitä normaalisti, joten koko tiedoston lukeminen mittaisi
  // väärää asiaa. Pino kirjoittaa asynkronisesti, joten annetaan sen ehtiä.
  await odota(300);
  const lokiEnnen = saaLokirivit().length;

  const ennen = hakuja;
  await provider.runOnce();
  haunAikana = null;

  assert.equal(hakuja - ennen, 3, "yksi kierros yrittää enintään kolmesti");
  const heti = await kortti();
  assert.equal(heti.dataPlace, null, "vanhentunutta sijaintia ei esitetä nykyisenä");

  // EI `failed`. Uusi haku on oikeasti ajastettu, joten "Haetaan…" on tosi ja
  // "Tietoja ei saatu" olisi epätosi. Tämä väite kaatuu jos heitto palautetaan.
  assert.equal(heti.status, "idle", "sijainnin vaihtuminen ei ole verkkovika");
  const w = (await app.inject({ method: "GET", url: "/api/dashboard", remoteAddress: "127.0.0.1" })).json()
    .providers.weather as ProviderSnapshot<WeatherData>;
  assert.equal(w.error, null, "sijainnin vaihtumisesta ei jää virhettä kortille");

  // Tämä on se väite joka kaataa umpikuja-version: kortin ON päädyttävä
  // oikeaan dataan ilman että kukaan tallentaa mitään uutta.
  umpikujaMs = await odotaKorttia("Helsinki");
  const k = await kortti();
  assert.equal(k.place, "Helsinki");
  assert.ok(umpikujaMs < 1000, `uusinta-ajastus toimi ${umpikujaMs} ms:ssa ilman uutta tallennusta`);

  // EIKÄ LOKIIN JÄÄNYT RIVIÄ. Nollan minuutin sääkatkos lokissa olisi
  // postinumeron vaihto eikä verkkovika, ja juuri sellaisia rivejä
  // logging.ts ja provider.ts ovat olemassa estämään. `runOnce` kirjoittaa
  // pinon kautta, joten annetaan transportin ehtiä levylle ennen väitettä.
  await odota(300);
  const vaarat = saaLokirivit()
    .slice(lokiEnnen)
    .filter(
      (r) =>
        r["event"] === "provider_failed" ||
        r["event"] === "provider_still_failing" ||
        r["event"] === "provider_recovered",
    );
  assert.deepEqual(
    vaarat.map((r) => r["event"]),
    [],
    `sijainnin vaihtuminen ei saa kirjata katkosta: ${JSON.stringify(vaarat)}`,
  );
}

provider.stop();
await app.close();

// ---------------------------------------------------------------------------
// 6) Sijainti vaihtuu KESKEN haun — tavallinen tapaus, ilman uusinta-ajastusta
// ---------------------------------------------------------------------------
//
// Reitin `runOnce()` ohittaa itsensä kun provider on varattu, joten pelkkä
// laukaisu ei riitä: kierroksen itsensä on huomattava vaihdos.
{
  updateSettings({ weatherPostalCode: "99600" });
  assert.equal(currentWeatherLocation().location.place, "Sodankylä");

  const ladut: string[] = [];
  const kesken = (async (url: string | URL | Request) => {
    ladut.push(new URL(String(url)).searchParams.get("latitude") ?? "?");
    if (ladut.length === 1) updateSettings({ weatherPostalCode: "00100" });
    return Response.json(openMeteoBody());
  }) as typeof fetch;

  const data = await fetchWeather(kesken);
  assert.equal(ladut.length, 2, "kesken vaihtunut sijainti uusii kierroksen");
  assert.equal(data.place, "Helsinki", "kierros ei saa päättyä vanhan sijainnin dataan");
  assert.equal(data.latitude, HELSINKI.latitude);
  assert.notEqual(ladut[0], ladut[1], "toinen pyyntö menee eri koordinaateille");

  // Muuttumaton sijainti ei aiheuta yhtään lisäpyyntöä.
  const vakaa: string[] = [];
  const rauhassa = (async (url: string | URL | Request) => {
    vakaa.push(new URL(String(url)).searchParams.get("latitude") ?? "?");
    return Response.json(openMeteoBody());
  }) as typeof fetch;
  assert.equal((await fetchWeather(rauhassa)).place, "Helsinki");
  assert.equal(vakaa.length, 1, "tavallinen kierros on tasan yksi haku");

  updateSettings({ weatherPostalCode: null });
}

console.log(
  "Weather location refresh: koordinaattiavain, lämmin käynnistys, välitön uusi haku, tuntematon numero, " +
    `paluu edelliseen, kesken vaihtuva sijainti ja umpikujasta toipuminen ${umpikujaMs} ms:ssa ` +
    "(testin uusintaviive 50 ms, tuotannossa 2000 ms) passed",
);
