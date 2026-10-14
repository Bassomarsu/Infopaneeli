/**
 * Sääproviderin kestävyys ja päiväsymboli.
 *
 *   A) Open-Meteon ohimenevä 503 (lokissa 1–2 kertaa päivässä) ei saa maksaa
 *      koko hakukierrosta: haku uusii lyhyesti, kertoo selvästi jos kaikki
 *      yritykset epäonnistuvat, ja kortti pitää viimeisimmän datan näkyvissä.
 *   B) Päivän symboli johdetaan tuntiennusteesta eikä Open-Meteon
 *      `daily.weather_code`sta, joka on päivän VAKAVIN koodi: yksi yön
 *      tihkutunti teki koko päivästä sateisen.
 *
 * Ei verkkoa, ei oikeita viiveitä (fetcher ja sleep injektoitu), eikä
 * riipu koneen aikavyöhykkeestä: päivämäärät ja tunnit ovat merkkijonoja.
 *
 * Aja:  npm run test:weather-resilience --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mock } from "node:test";
import { config } from "../src/core/config.ts";
import { fetchWithRetry } from "../src/core/http-retry.ts";
import { updateSettings } from "../src/core/settings.ts";
import { Provider } from "../src/core/provider.ts";
import {
  createWeatherProvider,
  dailyForecast,
  fetchWeather,
  representativeCondition,
  type HourSample,
  type OpenMeteoDaily,
  type OpenMeteoHourly,
  type WeatherData,
} from "../src/providers/weather.ts";

const odota = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A) Uusintayritykset
// ---------------------------------------------------------------------------

/** Pienin Open-Meteo-vastaus jonka jäsennin hyväksyy. */
function openMeteoBody(): unknown {
  return {
    current: {
      time: "2026-10-14T08:00",
      temperature_2m: 5,
      apparent_temperature: 3,
      weather_code: 3,
      wind_speed_10m: 2,
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

type Vastaus = Response | Error;

/** Antaa vastaukset järjestyksessä; viimeinen toistuu. Laskee kutsut. */
function skriptattu(vastaukset: Array<() => Vastaus>): { fetcher: typeof fetch; kutsuja: () => number } {
  let n = 0;
  const fetcher = (async () => {
    const vastaus = vastaukset[Math.min(n, vastaukset.length - 1)]!();
    n++;
    if (vastaus instanceof Error) throw vastaus;
    return vastaus;
  }) as typeof fetch;
  return { fetcher, kutsuja: () => n };
}

const ok = (): Response => Response.json(openMeteoBody());
const status = (code: number, headers?: Record<string, string>): Response => new Response("", { status: code, headers });

function viiveet(): { sleep: (ms: number) => Promise<void>; lista: number[] } {
  const lista: number[] = [];
  return {
    lista,
    sleep: async (ms) => {
      lista.push(ms);
    },
  };
}

// 503 ja sitten 200 -> onnistuu, tasan yksi viive.
{
  const { fetcher, kutsuja } = skriptattu([() => status(503), ok]);
  const v = viiveet();
  const data = await fetchWeather(fetcher, { sleep: v.sleep, random: () => 0.5 });
  assert.equal(kutsuja(), 2, "503 uusitaan kerran");
  assert.equal(v.lista.length, 1);
  assert.equal(v.lista[0], 2_000, "ensimmäinen viive on 2 s (jitter keskellä)");
  assert.equal(data.current.temperature, 5);
}

// 503 kahdesti ja sitten 200 -> onnistuu kolmannella; viive kaksinkertaistuu.
{
  const { fetcher, kutsuja } = skriptattu([() => status(503), () => status(502), ok]);
  const v = viiveet();
  await fetchWeather(fetcher, { sleep: v.sleep, random: () => 0.5 });
  assert.equal(kutsuja(), 3);
  assert.deepEqual(v.lista, [2_000, 4_000]);
}

// Jitter pitää viiveen ±25 %:n sisällä.
{
  for (const r of [0, 0.999]) {
    const { fetcher } = skriptattu([() => status(503), ok]);
    const v = viiveet();
    await fetchWeather(fetcher, { sleep: v.sleep, random: () => r });
    assert.ok(v.lista[0]! >= 1_500 && v.lista[0]! <= 2_500, `viive ${v.lista[0]} ei ole 2 s ±25 %`);
  }
}

// Kaikki yritykset 503 -> selkeä virhe, jossa on tila ja yritysmäärä.
{
  const { fetcher, kutsuja } = skriptattu([() => status(503)]);
  const v = viiveet();
  await assert.rejects(
    fetchWeather(fetcher, { sleep: v.sleep }),
    (err: Error) => /Open-Meteo returned HTTP 503/.test(err.message) && /3 attempts/.test(err.message),
  );
  assert.equal(kutsuja(), 3, "kolme yritystä, ei enempää");
  assert.equal(v.lista.length, 2);
}

// 400 ei uusita.
{
  const { fetcher, kutsuja } = skriptattu([() => status(400)]);
  const v = viiveet();
  await assert.rejects(fetchWeather(fetcher, { sleep: v.sleep }), /Open-Meteo returned HTTP 400$/);
  assert.equal(kutsuja(), 1, "4xx ei korjaudu toistamalla");
  assert.equal(v.lista.length, 0);
}

// 429 uusitaan, ja kohtuullinen Retry-After kunnioitetaan.
{
  const { fetcher, kutsuja } = skriptattu([() => status(429, { "retry-after": "4" }), ok]);
  const v = viiveet();
  await fetchWeather(fetcher, { sleep: v.sleep, random: () => 0.5 });
  assert.equal(kutsuja(), 2);
  assert.equal(v.lista[0], 4_000, "Retry-After 4 s > oma viive 2 s");
}

// Kohtuuton Retry-After (2 min) -> ei uusita lainkaan, ei lyhyempää odotusta.
{
  const { fetcher, kutsuja } = skriptattu([() => status(429, { "retry-after": "120" })]);
  const v = viiveet();
  await assert.rejects(fetchWeather(fetcher, { sleep: v.sleep }), /Open-Meteo returned HTTP 429/);
  assert.equal(kutsuja(), 1);
  assert.equal(v.lista.length, 0);
}

// 429 ILMAN Retry-After:ia ei uusita: emme tiedä milloin rajoitus päättyy.
{
  const { fetcher, kutsuja } = skriptattu([() => status(429), ok]);
  const v = viiveet();
  await assert.rejects(fetchWeather(fetcher, { sleep: v.sleep }), /Open-Meteo returned HTTP 429$/);
  assert.equal(kutsuja(), 1);
  assert.equal(v.lista.length, 0);
}

// Retry-After: 0 on kelvollinen (uusitaan heti, mutta oman viiveen verran), samoin HTTP-päivämäärä.
{
  const { fetcher, kutsuja } = skriptattu([() => status(429, { "retry-after": "0" }), ok]);
  const v = viiveet();
  await fetchWeather(fetcher, { sleep: v.sleep, random: () => 0.5 });
  assert.equal(kutsuja(), 2, "Retry-After 0 uusitaan");
  assert.equal(v.lista[0], 2_000, "0 s < oma viive -> oma viive");

  const nyt = 1_800_000_000_000; // kokonaisia sekunteja, jotta päivämäärämuoto on tarkka
  const paivamaara = new Date(nyt + 5_000).toUTCString();
  const pvm = skriptattu([() => status(503, { "retry-after": paivamaara }), ok]);
  const v2 = viiveet();
  await fetchWeather(pvm.fetcher, { sleep: v2.sleep, random: () => 0.5, now: () => nyt });
  assert.equal(pvm.kutsuja(), 2);
  assert.equal(v2.lista[0], 5_000, "HTTP-päivämäärä muunnetaan viiveeksi");

  const mennyt = skriptattu([() => status(503, { "retry-after": new Date(nyt - 60_000).toUTCString() }), ok]);
  const v3 = viiveet();
  await fetchWeather(mennyt.fetcher, { sleep: v3.sleep, random: () => 0.5, now: () => nyt });
  assert.equal(v3.lista[0], 2_000, "menneisyydessä oleva päivämäärä = 0 s");

  const roska = skriptattu([() => status(503, { "retry-after": "pian" }), ok]);
  const v4 = viiveet();
  await fetchWeather(roska.fetcher, { sleep: v4.sleep, random: () => 0.5 });
  assert.equal(v4.lista[0], 2_000, "tuntematon muoto ohitetaan");
}

// Verkkovirhe uusitaan; lopullinen virhe kertoo syyn.
{
  const { fetcher, kutsuja } = skriptattu([() => new TypeError("fetch failed"), ok]);
  const v = viiveet();
  await fetchWeather(fetcher, { sleep: v.sleep });
  assert.equal(kutsuja(), 2);

  const kaatuu = skriptattu([() => new TypeError("fetch failed")]);
  await assert.rejects(
    fetchWeather(kaatuu.fetcher, { sleep: viiveet().sleep }),
    /Open-Meteo request failed: fetch failed \(3 attempts\)/,
  );
  assert.equal(kaatuu.kutsuja(), 3);
}

// Runko luetaan ja jäsennetään uusinnan SISÄLLÄ: 200 + HTML (välityspalvelin),
// katkennut runko ja puuttuvat kentät saavat uusinnan kuten 503.
{
  const html = skriptattu([() => new Response("<html>Bad gateway</html>", { status: 200 }), ok]);
  const v = viiveet();
  const data = await fetchWeather(html.fetcher, { sleep: v.sleep });
  assert.equal(html.kutsuja(), 2, "200 + HTML uusitaan");
  assert.equal(data.current.temperature, 5);

  const katkennut = skriptattu([
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      ),
    ok,
  ]);
  await fetchWeather(katkennut.fetcher, { sleep: viiveet().sleep });
  assert.equal(katkennut.kutsuja(), 2, "katkennut runko uusitaan");

  const tyhja = skriptattu([() => Response.json({})]);
  await assert.rejects(
    fetchWeather(tyhja.fetcher, { sleep: viiveet().sleep }),
    /missing expected fields \(3 attempts\)/,
  );
  assert.equal(tyhja.kutsuja(), 3);

  const roskaa = skriptattu([() => new Response("<html>", { status: 200 })]);
  await assert.rejects(
    fetchWeather(roskaa.fetcher, { sleep: viiveet().sleep }),
    /Open-Meteo response could not be read.*\(3 attempts\)/,
  );
}

// Uusinnassa hylätyn vastauksen runko perutaan (yhteys vapautuu).
{
  let peruttu = 0;
  const { fetcher } = skriptattu([
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            peruttu++;
          },
        }),
        { status: 503 },
      ),
    ok,
  ]);
  await fetchWeather(fetcher, { sleep: viiveet().sleep });
  assert.equal(peruttu, 1, "503-vastauksen runko perutaan ennen uusintaa");
}

// Yhteinen deadline: uusinta ei saa alkaa jos viive + seuraavan yrityksen
// oma aikaraja ei enää mahdu. Kello on valekello, joten viiveet ovat ilmaisia.
{
  let t = 1_000_000;
  const kello = (): number => t;
  let kutsuja = 0;
  const hidas = (async () => {
    kutsuja++;
    t += 30_000; // jokainen yritys kuluttaa 30 s
    return status(503);
  }) as typeof fetch;
  await assert.rejects(
    fetchWithRetry(
      hidas,
      "https://example.invalid/",
      {},
      {
        label: "Testi",
        attemptTimeoutMs: 15_000,
        deadlineAt: t + 75_000,
        now: kello,
        sleep: async (ms) => {
          t += ms;
        },
        random: () => 0.5,
      },
      async (r) => r,
    ),
    /Testi returned HTTP 503 \(2 attempts\)/,
  );
  // Yritys 1: t=+30 s, viive 2 s -> +32 s, +15 s <= 75 s joten uusitaan.
  // Yritys 2: t=+62 s, viive 4 s + 15 s = 81 s > 75 s -> ei kolmatta.
  assert.equal(kutsuja, 2, "deadline katkaisee kolmannen yrityksen");

  // Deadline jo ylitetty -> ei yritetä lainkaan.
  let yritetty = 0;
  await assert.rejects(
    fetchWithRetry(
      (async () => {
        yritetty++;
        return ok();
      }) as typeof fetch,
      "https://example.invalid/",
      {},
      { label: "Testi", attemptTimeoutMs: 15_000, deadlineAt: t - 1, now: kello },
      async (r) => r,
    ),
    /time budget exhausted/,
  );
  assert.equal(yritetty, 0);
}

// Sama deadline koskee sijaintisilmukan kierroksia: jos ensimmäinen kierros
// söi lähes koko ajan eikä kokonaista yritystä ole jäljellä, ei aloiteta toista
// (sijainnin uusinnan hoitaa provider ajastettuna), vaan palautetaan se mitä saatiin.
{
  let t = 5_000_000;
  let kutsuja = 0;
  updateSettings({ weatherPostalCode: "99600" });
  const fetcher = (async () => {
    kutsuja++;
    if (kutsuja === 1) {
      updateSettings({ weatherPostalCode: "00100" }); // sijainti vaihtuu kesken haun
      t += 70_000; // ja haku vei lähes koko 75 s
    }
    return ok();
  }) as typeof fetch;
  const data = await fetchWeather(fetcher, { now: () => t, sleep: async () => undefined });
  assert.equal(kutsuja, 1, "yhteinen deadline estää toisen kierroksen");
  assert.equal(data.place, "Sodankylä", "palautetaan ensimmäisen kierroksen tulos");
  updateSettings({ weatherPostalCode: null });
}

// Provider: haku onnistuu ensin, sitten kaikki yritykset kaatuvat -> kortti
// pitää viimeisimmän datan (stale, ei failed) ja lokiin tulee yksi
// provider_failed selkeällä viestillä. (Lämpimänä käynnistetty provider ei
// ole "terve", joten se kirjaisi provider_still_failing; siksi onnistuva haku ensin.)
{
  let toimii = true;
  let kutsuja = 0;
  const fetcher = (async () => {
    kutsuja++;
    return toimii ? ok() : status(503);
  }) as typeof fetch;
  const provider = createWeatherProvider({ fetcher, retry: { sleep: async () => undefined } });
  await provider.runOnce();
  assert.equal(provider.snapshot().status, "ok");
  assert.equal(kutsuja, 1);

  toimii = false;
  await provider.runOnce();
  provider.stop();

  const snap = provider.snapshot();
  assert.equal(kutsuja, 4, "kolme uutta yritystä");
  assert.equal(snap.status, "stale", "ohimenevä häiriö ei saa tyhjentää korttia");
  assert.equal((snap.data as WeatherData).current.temperature, 5, "viimeisin onnistunut data säilyy");
  assert.match(snap.error?.message ?? "", /HTTP 503.*3 attempts/);

  const rivit = await lokirivit("provider_failed");
  assert.equal(rivit.length, 1, "tasan yksi provider_failed-rivi");
  const err = rivit[0]!["err"] as { message?: string } | undefined;
  assert.match(err?.message ?? "", /HTTP 503.*3 attempts/, "lokin virhe kertoo että kaikki yritykset epäonnistuivat");
}

async function lokirivit(event: string): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 40; i++) {
    let tiedostot: string[] = [];
    try {
      tiedostot = fs.readdirSync(config.logDir);
    } catch {
      /* hakemistoa ei ole vielä */
    }
    const uusin = tiedostot
      .filter((f) => f.endsWith(".log"))
      .map((f) => `${config.logDir}/${f}`)
      .sort()
      .at(-1);
    if (uusin !== undefined) {
      const rivit = fs
        .readFileSync(uusin, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((r) => JSON.parse(r) as Record<string, unknown>)
        .filter((e) => e["provider"] === "weather" && e["event"] === event);
      if (rivit.length > 0) {
        await odota(150); // ylimääräinen rivi ehtisi näkyä
        return fs
          .readFileSync(uusin, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((r) => JSON.parse(r) as Record<string, unknown>)
          .filter((e) => e["provider"] === "weather" && e["event"] === event);
      }
    }
    await odota(100);
  }
  return [];
}

// Provider.quickRetryMs: ensimmäinen peräkkäinen epäonnistuminen uusitaan
// pian, toinen palaa tavalliseen perääntymiseen (ei takomista). Ajastimet
// ovat valeajastimia (node:test mock), joten testi ei odota oikeaa aikaa.
{
  /** Päästää odottavat promisejen jatkot ajoon ilman valeajastimia (setImmediate ei ole valeistettu). */
  const tyhjenna = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let kutsuja = 0;
    let kaada = true;
    const provider = new Provider<number>({
      id: `test-quick-retry-${process.pid}`,
      intervalMs: 60_000, // tavallinen perääntyminen 120 s
      quickRetryMs: 40,
      fetch: async () => {
        kutsuja++;
        if (kaada) throw new Error("ohimenevä");
        return 1;
      },
    });
    await provider.runOnce();
    assert.equal(kutsuja, 1);
    kaada = false;
    mock.timers.tick(50); // 40 ms ±10 % jitter
    await tyhjenna();
    assert.equal(kutsuja, 2, "nopea uusinta ajettiin");
    assert.equal(provider.snapshot().status, "ok", "ja se toipui");
    provider.stop();

    // Kaksi epäonnistumista peräkkäin: kolmatta yritystä ei tule nopeasti.
    let toinen = 0;
    const sitkea = new Provider<number>({
      id: `test-quick-retry-twice-${process.pid}`,
      intervalMs: 60_000,
      quickRetryMs: 40,
      fetch: async () => {
        toinen++;
        throw new Error("pysyvä");
      },
    });
    await sitkea.runOnce();
    mock.timers.tick(50);
    await tyhjenna();
    assert.equal(toinen, 2, "toinen yritys nopea");
    mock.timers.tick(60_000);
    await tyhjenna();
    assert.equal(toinen, 2, "toisen epäonnistumisen jälkeen perääntyminen (120 s), ei 40 ms:n rytmiä");
    mock.timers.tick(210_000); // perääntyminen 60 s · 4 = 240 s ±10 %, yhteensä 270 s
    await tyhjenna();
    assert.equal(toinen, 3, "tavallinen perääntyminen kuitenkin jatkuu");
    sitkea.stop();

    // Ilman quickRetryMs:ää käytös on ennallaan (muut providerit).
    let vanha = 0;
    const tavallinen = new Provider<number>({
      id: `test-no-quick-retry-${process.pid}`,
      intervalMs: 60_000,
      fetch: async () => {
        vanha++;
        throw new Error("x");
      },
    });
    await tavallinen.runOnce();
    mock.timers.tick(60_000);
    await tyhjenna();
    assert.equal(vanha, 1, "oletuksena ei nopeaa uusintaa");
    mock.timers.tick(80_000); // perääntyminen 120 s ±10 %, yhteensä 140 s
    await tyhjenna();
    assert.equal(vanha, 2, "vasta tavallisen perääntymisen jälkeen");
    tavallinen.stop();
  } finally {
    mock.timers.reset();
  }
}

// ---------------------------------------------------------------------------
// B) Päivän edustava kunto
// ---------------------------------------------------------------------------

const DATE = "2026-10-14";

/** 24 tuntia yhdelle päivälle; `koodi(h)` ja `sade(h)` kuvaavat tunnin. */
function paiva(
  koodi: (h: number) => number | null,
  sade: (h: number) => number = () => 0,
  date = DATE,
): OpenMeteoHourly {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return {
    time: hours.map((h) => `${date}T${String(h).padStart(2, "0")}:00`),
    temperature_2m: hours.map(() => 5),
    apparent_temperature: hours.map(() => 3),
    precipitation: hours.map(sade),
    precipitation_probability: hours.map(() => 50),
    weather_code: hours.map(koodi) as number[],
    wind_speed_10m: hours.map(() => 2),
  };
}

function dailyOf(dailyCode: number, date = DATE): OpenMeteoDaily {
  return {
    time: [date],
    weather_code: [dailyCode],
    temperature_2m_max: [8],
    temperature_2m_min: [2],
    precipitation_sum: [0.1],
    wind_speed_10m_max: [5],
    sunrise: [`${date}T07:50`],
    sunset: [`${date}T18:30`],
  };
}

function tulos(hourly: OpenMeteoHourly, dailyCode: number) {
  const day = dailyForecast(dailyOf(dailyCode), hourly)[0]!;
  return day.condition;
}

const valilla = (h: number, alku: number, loppu: number): boolean => h >= alku && h < loppu;

// Pääoire: yksi tihkutunti yöllä + muuten selkeä. Open-Meteon päiväkoodi on
// 51 (vakavin), mutta päivä on selkeä.
{
  const c = tulos(paiva((h) => (h === 3 ? 51 : 0), (h) => (h === 3 ? 0.1 : 0)), 51);
  assert.equal(c.icon, "clear", "yön tihku ei tee päivästä sateista");
  assert.equal(c.code, 0);
  assert.equal(c.description, "Selkeää", "kuvaus ja ikoni yhtenäiset");
}

// Yksi tihkutunti keskellä päivääkään ei riitä (alle 4 h, alle 2 mm).
{
  const c = tulos(paiva((h) => (h === 12 ? 53 : 1), (h) => (h === 12 ? 0.3 : 0)), 53);
  assert.equal(c.icon, "clear");
  assert.equal(c.description, "Enimmäkseen selkeää");
}

// Sateinen päivä -> sade, ja kuvaus on päivän yleisin sadekoodi.
{
  const c = tulos(paiva((h) => (valilla(h, 8, 17) ? 63 : 3), (h) => (valilla(h, 8, 17) ? 1.2 : 0)), 63);
  assert.equal(c.icon, "rain");
  assert.equal(c.code, 63);
  assert.equal(c.description, "Vesisadetta");
}

// Neljä sateista tuntia riittää (kynnys), kolme ei.
{
  const nelja = tulos(paiva((h) => (valilla(h, 9, 13) ? 61 : 3), (h) => (valilla(h, 9, 13) ? 0.3 : 0)), 61);
  assert.equal(nelja.icon, "rain", "4 sadetuntia, yhteensä 1,2 mm = sadepäivä");
  const tihku = tulos(paiva((h) => (valilla(h, 9, 13) ? 51 : 3), (h) => (valilla(h, 9, 13) ? 0.1 : 0)), 51);
  assert.equal(tihku.icon, "cloudy", "4 tuntia × 0,1 mm (0,4 mm) on pilvinen päivä, ei sadepäivä");
  const kolme = tulos(paiva((h) => (valilla(h, 9, 12) ? 61 : 3), (h) => (valilla(h, 9, 12) ? 0.3 : 0)), 61);
  assert.equal(kolme.icon, "cloudy", "3 heikkoa sadetuntia + pilvinen päivä = pilvistä");
}

// Yksi rankka kuuro (6 mm tunnissa) näkyy, vaikka tunteja on vain yksi.
{
  const c = tulos(paiva((h) => (h === 14 ? 82 : 1), (h) => (h === 14 ? 6 : 0)), 82);
  assert.equal(c.icon, "rain");
  assert.equal(c.code, 82);
}

// Kuvaus on rankimman sadetunnin koodi, ei lukumääräenemmistö: kuusi tihkutuntia
// ja kaksi rankkaa tuntia (yht. 11,7 mm) on "Rankkaa vesisadetta", ei "Tihkusadetta".
{
  const c = tulos(
    paiva(
      (h) => (valilla(h, 8, 14) ? 53 : valilla(h, 14, 16) ? 65 : 3),
      (h) => (valilla(h, 8, 14) ? 0.1 : valilla(h, 14, 16) ? 5.55 : 0),
    ),
    65,
  );
  assert.equal(c.code, 65);
  assert.equal(c.description, "Rankkaa vesisadetta");
  assert.equal(c.icon, "rain");
}

// Lumi; tasatilanteessa lumi voittaa sateen.
{
  const lumi = tulos(paiva((h) => (valilla(h, 8, 14) ? 73 : 3), (h) => (valilla(h, 8, 14) ? 0.5 : 0)), 73);
  assert.equal(lumi.icon, "snow");
  assert.equal(lumi.description, "Lumisadetta");

  const risteys = tulos(
    paiva((h) => (valilla(h, 8, 11) ? 73 : valilla(h, 11, 13) ? 61 : 3), (h) => (valilla(h, 8, 13) ? 0.5 : 0)),
    73,
  );
  assert.equal(risteys.icon, "snow", "enemmän lumituntia kuin vesituntia -> lumi");
}

// Ukkonen: yksi heikko tunti ei riitä, kaksi tuntia tai yksi 1 mm:n tunti riittää.
{
  const yksi = tulos(paiva((h) => (h === 15 ? 95 : 2), (h) => (h === 15 ? 0.2 : 0)), 95);
  assert.equal(yksi.icon, "partly", "yksi heikko ukkoskoodi ei tee päivästä ukkospäivää");
  assert.equal(yksi.description, "Puolipilvistä");

  const kaksi = tulos(paiva((h) => (valilla(h, 15, 17) ? 95 : 2), (h) => (valilla(h, 15, 17) ? 0.2 : 0)), 95);
  assert.equal(kaksi.icon, "thunder");
  assert.equal(kaksi.description, "Ukkosta");

  const kuuro = tulos(paiva((h) => (h === 15 ? 96 : 2), (h) => (h === 15 ? 3 : 0)), 96);
  assert.equal(kuuro.icon, "thunder", "yksi ukkostunti jolla oikeaa sadetta riittää");
  assert.equal(kuuro.code, 96);
}

// Yöllä (ikkunan ulkopuolella) tapahtuva voimakas sade tai ukkonen ei vaikuta.
{
  const yo = (h: number): boolean => h < 6 || h >= 23;
  const c = tulos(paiva((h) => (yo(h) ? 95 : 0), (h) => (yo(h) ? 5 : 0)), 95);
  assert.equal(c.icon, "clear", "yön ukkonen ei kuulu päivän symboliin");

  // Mutta iltasade klo 21–23 kuuluu: kortti näyttää saman vuorokauden mm-summan.
  const ilta = tulos(paiva((h) => (valilla(h, 19, 23) ? 63 : 1), (h) => (valilla(h, 19, 23) ? 0.5 : 0)), 63);
  assert.equal(ilta.icon, "rain", "iltasade ei jää symbolin ulkopuolelle");
}

// Vallitseva pilvisyys: keskiarvoa lähin koodi.
{
  const pilvinen = tulos(paiva((h) => (valilla(h, 7, 17) ? 3 : 2)), 3);
  assert.equal(pilvinen.icon, "cloudy");
  assert.equal(pilvinen.description, "Pilvistä");

  const puoli = tulos(paiva((h) => (valilla(h, 7, 14) ? 1 : 3)), 3);
  assert.equal(puoli.icon, "partly", "puolet selkeää, puolet pilvistä -> puolipilvistä");
  assert.equal(puoli.code, 2);

  const selkea = tulos(paiva((h) => (valilla(h, 7, 14) ? 0 : 1)), 1);
  assert.equal(selkea.icon, "clear");
}

// Sumu: vain jos se kattaa vähintään puolet päivästä.
{
  const sumuinen = tulos(paiva((h) => (valilla(h, 6, 16) ? 45 : 3)), 45);
  assert.equal(sumuinen.icon, "fog");
  assert.equal(sumuinen.description, "Sumua");

  const aamusumu = tulos(paiva((h) => (valilla(h, 5, 10) ? 45 : 0)), 45);
  assert.equal(aamusumu.icon, "clear", "aamusumu joka hälvenee ei ole päivän sää");

  // Sumu + sade: merkittävä sade voittaa sumun, merkityksetön sade ei.
  const sumuJaSade = tulos(
    paiva((h) => (valilla(h, 12, 17) ? 61 : valilla(h, 6, 12) ? 45 : 3), (h) => (valilla(h, 12, 17) ? 0.6 : 0)),
    61,
  );
  assert.equal(sumuJaSade.icon, "rain", "sumu 6–12 ja sade 12–17 (3 mm) -> sade");
  const sumuJaTihku = tulos(
    paiva((h) => (valilla(h, 15, 18) ? 51 : valilla(h, 6, 15) ? 45 : 3), (h) => (valilla(h, 15, 18) ? 0.1 : 0)),
    51,
  );
  assert.equal(sumuJaTihku.icon, "fog", "sumu + 3 tihkutuntia -> sumu");
}

// Puuttuva tuntidata -> daily.weather_code.
{
  const tyhja: OpenMeteoHourly = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    precipitation: [],
    precipitation_probability: [],
    weather_code: [],
    wind_speed_10m: [],
  };
  const c = tulos(tyhja, 61);
  assert.equal(c.code, 61, "ei tunteja -> päiväkoodi");
  assert.equal(c.icon, "rain");

  // Osittainen päivä (esim. ennusteen reuna): alle 7 ikkunatuntia -> päiväkoodi.
  const osittain = paiva((h) => (h < 14 ? 0 : null));
  assert.equal(tulos(osittain, 3).code, 3, "8 ikkunatuntia on liian vähän (väh. 9)");

  // Puuttuva (null) tuntikoodi ei muutu "selkeäksi" vaan jää pois.
  const aukkoinen = paiva((h) => (valilla(h, 7, 21) && h % 3 === 0 ? 3 : null));
  assert.equal(tulos(aukkoinen, 63).code, 63, "10 tuntia puuttuu -> päiväkoodi, ei hiljaa 'selkeää'");
}

// Useampi päivä: kullekin omat tuntinsa; päivä ilman tunteja käyttää päiväkoodia.
{
  const toinen = "2026-10-15";
  const hourly = paiva((h) => (valilla(h, 8, 18) ? 65 : 3), (h) => (valilla(h, 8, 18) ? 2 : 0), toinen);
  const daily: OpenMeteoDaily = {
    time: [DATE, toinen],
    weather_code: [71, 3],
    temperature_2m_max: [8, 9],
    temperature_2m_min: [2, 3],
    precipitation_sum: [0, 20],
    wind_speed_10m_max: [5, 6],
    sunrise: [`${DATE}T07:50`, `${toinen}T07:52`],
    sunset: [`${DATE}T18:30`, `${toinen}T18:28`],
  };
  const days = dailyForecast(daily, hourly);
  assert.equal(days[0]!.condition.code, 71, "ensimmäisellä päivällä ei tunteja -> päiväkoodi");
  assert.equal(days[1]!.condition.icon, "rain", "toisen päivän tunnit voittavat päiväkoodin 3");
  assert.equal(days[1]!.hours.length, 24, "päivänäkymän tunnit ovat ennallaan");
  assert.equal(days[0]!.hours.length, 0);
}

// representativeCondition: ikkunan rajat (6 mukana, 23 ei).
{
  const nayte = (hour: number, code: number, precipitation = 0): HourSample => ({ hour, code, precipitation });
  const sade = [6, 7, 8, 9].map((h) => nayte(h, 63, 1));
  const taustaa = [10, 11, 12, 13, 14, 15, 16].map((h) => nayte(h, 0));
  assert.equal(representativeCondition([...sade, ...taustaa], 0).icon, "rain", "klo 6 kuuluu ikkunaan");

  const ulkona = [23, 0, 1, 2].map((h) => nayte(h, 63, 1));
  const paiva9 = [6, 7, 8, 9, 10, 11, 12, 13, 14].map((h) => nayte(h, 0));
  assert.equal(representativeCondition([...ulkona, ...paiva9], 63).icon, "clear", "klo 23 ja yö ei kuulu ikkunaan");
}

console.log(
  "Weather resilience: uusinnat (503/429/verkko, ei 4xx), Retry-After, selkeä virhe lokissa, " +
    "stale-data säilyy, nopea uusinta vain ensimmäiselle virheelle, päiväsymboli tunneista " +
    "(yön tihku, sade/lumi/ukkonen-kynnykset, pilvisyys, sumu, puuttuva data) OK",
);
