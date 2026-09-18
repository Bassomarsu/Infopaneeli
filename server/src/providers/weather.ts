import { Provider, type ProviderSnapshot } from "../core/provider.ts";
import { config } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { getSettings } from "../core/settings.ts";
import {
  WeatherLocationResolver,
  type WeatherLocation,
  type WeatherLocationSource,
} from "../core/weather-location.ts";
import { localDateKey, localParts } from "../core/time.ts";

const API_URL = "https://api.open-meteo.com/v1/forecast";

/** Small icon set the UI renders as inline SVG — no external icon library involved. */
export type WeatherIcon = "clear" | "partly" | "cloudy" | "rain" | "snow" | "thunder" | "fog";

export interface WeatherCondition {
  code: number;
  description: string;
  icon: WeatherIcon;
}

export interface WeatherHour {
  /** ISO-ish local time string as returned by Open-Meteo, e.g. "2026-08-06T14:00". */
  time: string;
  hour: number;
  temperature: number;
  apparentTemperature: number | null;
  precipitation: number;
  precipitationProbability: number | null;
  windSpeed: number;
  condition: WeatherCondition;
}

export interface WeatherDay {
  date: string;
  condition: WeatherCondition;
  min: number;
  max: number;
  precipitation: number;
  windMax: number;
  sunrise: string | null;
  sunset: string | null;
  /** Full 24h of that day, oldest first. Used by the day-tap hourly view. */
  hours: WeatherHour[];
}

export interface WeatherData {
  place: string;
  /**
   * Koordinaatit joille TÄMÄ hyötykuorma haettiin.
   *
   * Paikannimi ei kelpaa sijainnin tunnisteeksi: aineistossa on 353 nimeä
   * jotka kattavat useamman postinumeron, ja koordinaatit voivat erota
   * rajusti saman nimen sisällä (00100 "Helsinki" 60.171/24.932, 00101
   * "Helsinki" 62.157/27.198 — 252 km erillään). Nimivertailu päästäisi siis
   * läpi juuri sen tapauksen jonka tämän kentän on tarkoitus estää.
   */
  latitude: number;
  longitude: number;
  current: {
    temperature: number;
    apparentTemperature: number;
    condition: WeatherCondition;
    windSpeed: number;
    precipitation: number;
  };
  /** Remaining hours of the current local day, oldest first. */
  todayRemainingHours: WeatherHour[];
  days: WeatherDay[];
}

interface OpenMeteoCurrent {
  time: string;
  temperature_2m: number;
  apparent_temperature: number;
  weather_code: number;
  wind_speed_10m: number;
  precipitation: number;
}

interface OpenMeteoHourly {
  time: string[];
  temperature_2m: number[];
  apparent_temperature: number[];
  precipitation: number[];
  precipitation_probability: number[];
  weather_code: number[];
  wind_speed_10m: number[];
}

interface OpenMeteoDaily {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  wind_speed_10m_max: number[];
  sunrise: string[];
  sunset: string[];
}

interface OpenMeteoResponse {
  current?: OpenMeteoCurrent;
  hourly?: OpenMeteoHourly;
  daily?: OpenMeteoDaily;
}

/**
 * WMO weather interpretation codes, as used by Open-Meteo, mapped to a Finnish
 * description and one of the icon ids the card knows how to draw. Covers the
 * full 0-99 range defined by the spec; a code outside it still renders as a
 * plain cloudy sky instead of throwing.
 */
const WEATHER_CODES: Record<number, { description: string; icon: WeatherIcon }> = {
  0: { description: "Selkeää", icon: "clear" },
  1: { description: "Enimmäkseen selkeää", icon: "clear" },
  2: { description: "Puolipilvistä", icon: "partly" },
  3: { description: "Pilvistä", icon: "cloudy" },
  45: { description: "Sumua", icon: "fog" },
  48: { description: "Huurtavaa sumua", icon: "fog" },
  51: { description: "Heikkoa tihkusadetta", icon: "rain" },
  53: { description: "Tihkusadetta", icon: "rain" },
  55: { description: "Runsasta tihkusadetta", icon: "rain" },
  56: { description: "Jäätävää tihkua", icon: "rain" },
  57: { description: "Runsasta jäätävää tihkua", icon: "rain" },
  61: { description: "Heikkoa vesisadetta", icon: "rain" },
  63: { description: "Vesisadetta", icon: "rain" },
  65: { description: "Rankkaa vesisadetta", icon: "rain" },
  66: { description: "Jäätävää vesisadetta", icon: "rain" },
  67: { description: "Rankkaa jäätävää vesisadetta", icon: "rain" },
  71: { description: "Heikkoa lumisadetta", icon: "snow" },
  73: { description: "Lumisadetta", icon: "snow" },
  75: { description: "Rankkaa lumisadetta", icon: "snow" },
  77: { description: "Lumijyväsiä", icon: "snow" },
  80: { description: "Heikkoja sadekuuroja", icon: "rain" },
  81: { description: "Sadekuuroja", icon: "rain" },
  82: { description: "Rajuja sadekuuroja", icon: "rain" },
  85: { description: "Heikkoja lumikuuroja", icon: "snow" },
  86: { description: "Rankkoja lumikuuroja", icon: "snow" },
  95: { description: "Ukkosta", icon: "thunder" },
  96: { description: "Ukkosta ja heikkoa raekuuroa", icon: "thunder" },
  99: { description: "Ukkosta ja rajua raekuuroa", icon: "thunder" },
};

function conditionFor(code: number): WeatherCondition {
  const known = WEATHER_CODES[code];
  return known ? { code, ...known } : { code, description: "Pilvistä", icon: "cloudy" };
}

// Open-Meteo returns these as local wall-clock strings ("2026-08-06T14:00")
// because the request pins timezone=Europe/Helsinki. Slicing the string keeps
// the date/hour extraction independent of whatever timezone this process
// itself happens to run in, instead of parsing through `Date` and back.
function dateKeyOf(localTime: string): string {
  return localTime.slice(0, 10);
}

function hourOf(localTime: string): number {
  return Number(localTime.slice(11, 13));
}

function buildHour(hourly: OpenMeteoHourly, i: number, time: string): WeatherHour {
  return {
    time,
    hour: hourOf(time),
    temperature: hourly.temperature_2m[i] ?? 0,
    apparentTemperature: hourly.apparent_temperature[i] ?? null,
    precipitation: hourly.precipitation[i] ?? 0,
    precipitationProbability: hourly.precipitation_probability[i] ?? null,
    windSpeed: hourly.wind_speed_10m[i] ?? 0,
    condition: conditionFor(hourly.weather_code[i] ?? 0),
  };
}

/** Only the rest of today is useful on a display; six days of hourly data is not. */
function remainingHoursToday(hourly: OpenMeteoHourly): WeatherHour[] {
  const todayKey = localDateKey();
  const currentHour = localParts().hour;
  const hours: WeatherHour[] = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    if (!time || dateKeyOf(time) !== todayKey) continue;
    if (hourOf(time) < currentHour) continue;
    hours.push(buildHour(hourly, i, time));
  }

  return hours;
}

/** All hours Open-Meteo returned for one calendar day, oldest first — the day-tap view. */
function hoursForDate(hourly: OpenMeteoHourly, dateKey: string): WeatherHour[] {
  const hours: WeatherHour[] = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    if (!time || dateKeyOf(time) !== dateKey) continue;
    hours.push(buildHour(hourly, i, time));
  }

  return hours;
}

function dailyForecast(daily: OpenMeteoDaily, hourly: OpenMeteoHourly): WeatherDay[] {
  const days: WeatherDay[] = [];

  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    if (!date) continue;
    days.push({
      date,
      condition: conditionFor(daily.weather_code[i] ?? 0),
      min: daily.temperature_2m_min[i] ?? 0,
      max: daily.temperature_2m_max[i] ?? 0,
      precipitation: daily.precipitation_sum[i] ?? 0,
      windMax: daily.wind_speed_10m_max[i] ?? 0,
      sunrise: daily.sunrise[i] ?? null,
      sunset: daily.sunset[i] ?? null,
      hours: hoursForDate(hourly, date),
    });
  }

  return days;
}

/**
 * Yksi jaettu ratkaisija koko prosessin ajaksi, jotta "edellinen kelvollinen
 * sijainti" todella säilyy hakujen välillä (ks. core/weather-location.ts).
 * Myös routes/api.ts lukee sijainnin tämän kautta, jotta koontinäkymän
 * paikannimi ja haettu sää eivät voi kertoa kahdesta eri paikkakunnasta.
 */
const locationResolver = new WeatherLocationResolver();

/**
 * Nyt käytössä oleva sijainti ja se, mistä se tuli. Lähde kulkee mukana siksi,
 * että asetuspaneeli näyttää sen käyttäjälle — selain ei voi päätellä sitä itse
 * (ks. core/weather-location.ts), ja kun se aiemmin arvattiin tallennetusta
 * asetuksesta, paneeli väitti .env-sijaintia asetuksista tulleeksi.
 */
export interface CurrentWeatherLocation {
  location: WeatherLocation;
  source: WeatherLocationSource;
}

/**
 * Sijainti HAKUHETKELLÄ, ei moduulin latautuessa: asetuksista vaihdettu
 * postinumero vaihtaa paikkakunnan ilman palvelimen uudelleenkäynnistystä, ja
 * se on koko muutoksen tarkoitus.
 *
 * Varoitus lokitetaan `warn`-tasolla, joka on oletustaso (ks. core/config.ts) —
 * tuntematon postinumero on nimenomaan se tapaus jonka käyttäjän pitää nähdä
 * lokista ilman että hän ensin arvaa säätävänsä LOG_LEVELiä.
 */
export function currentWeatherLocation(): CurrentWeatherLocation {
  const { location, source, warning } = locationResolver.resolve({
    settingPostalCode: getSettings().weatherPostalCode,
    envPostalCode: config.weather.postalCode,
    envLocation: {
      place: config.weather.place,
      latitude: config.weather.latitude,
      longitude: config.weather.longitude,
    },
  });
  if (warning) {
    logger.warn({ event: "weather_postal_code_unknown", place: location.place }, warning);
  }
  return { location, source };
}

/**
 * Onko tämä hyötykuorma haettu sille sijainnille joka nyt on voimassa?
 *
 * Yksi ainoa vertailu, jota käytetään KAHDESSA paikassa: koontinäkymän
 * suodatuksessa (mitä kortti näyttää) ja hakukierroksen lopussa (tarvitaanko
 * uusi haku). Ne eivät saa olla eri mieltä — muuten kortti voi sanoa
 * "Haetaan…" ilman että kukaan hakee, tai päinvastoin.
 *
 * Vertailu tehdään KOORDINAATEILLA eikä paikannimellä. Nimi ei yksilöi
 * sijaintia (ks. WeatherData.latitude), ja koska molemmat arvot tulevat
 * samasta ratkaisijasta ja kulkevat JSONin läpi bittitarkasti, tarkka
 * yhtäsuuruus on tässä oikea vertailu eikä epsilonia tarvita.
 *
 * Poikkeus on kertaluonteinen päivityspolku vanhoille välimuistiriveille, ks.
 * funktion runko. Se ei löysää tätä sääntöä uudelle datalle.
 */
function isForLocation(data: WeatherData | null, location: WeatherLocation): boolean {
  if (!data) return false;

  // KERTALUONTEINEN PÄIVITYSPOLKU, EI PYSYVÄ VARATIE. Ennen `latitude`/
  // `longitude` -kenttiä kirjoitettu välimuistirivi ei voi vastata
  // koordinaateilla, joten se täsmätään paikannimellä.
  //
  // Tämä ei kelpuuta nimivertailua uudelle datalle eikä peruuta sitä päätöstä
  // että avain on koordinaatit. Nimi EI yksilöi sijaintia: aineistossa on 353
  // nimeä jotka kattavat useamman postinumeron, ja `00101` "Helsinki" osoittaa
  // koordinaatteihin 62.157/27.198 eli Savoon. Älä siis siirrä tätä haaraa
  // ensisijaiseksi.
  //
  // Haara vanhenee itsestään: ensimmäinen onnistunut haku ylikirjoittaa rivin
  // koordinaatteineen, eikä se aktivoidu siinä asennuksessa enää koskaan.
  //
  // Miksi tämä on olemassa: ilman sitä jokainen olemassa oleva asennus
  // menettäisi kerran `store.ts`:n lupauksen ("a schedule fetched yesterday
  // evening is still worth showing at breakfast") — ja tasan silloin kun
  // päivityksen jälkeinen ensimmäinen haku kaatuu, eli kun seinänäyttö
  // käynnistyy ennen reititintä. Kortti sanoisi "Tietoja ei saatu" siinä
  // missä se ennen näytti eilisen ennusteen vanhentunut-merkinnällä. Mitattu
  // 18.9.2026; juuri siinä tapauksessa koko viimeisin-onnistunut on olemassa.
  const koordinaatit = data as Partial<Pick<WeatherData, "latitude" | "longitude">>;
  if (typeof koordinaatit.latitude !== "number" || typeof koordinaatit.longitude !== "number") {
    return data.place === location.place;
  }

  return koordinaatit.latitude === location.latitude && koordinaatit.longitude === location.longitude;
}

function isSameLocation(a: WeatherLocation, b: WeatherLocation): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

/**
 * Sijainti jolle viimeisin epäonnistunut haku tehtiin, tai null jos viimeisin
 * haku onnistui eikä epäonnistumista ole voimassa.
 *
 * Sama kirjanpito kuin jätehuollon `lastFailureRevision`illa, ja samasta
 * syystä: VIRHEILMOITUS ON DATAA SEKIN, eikä toisen sijainnin virhettä saa
 * esittää tämän sijainnin virheenä. Ilman tätä Karstulan haun "HTTP 503" jäi
 * näkyviin Sodankylän nimen alle sillä hetkellä kun Sodankylän haku oli vasta
 * matkalla eikä mikään Sodankylässä ollut vielä epäonnistunut.
 */
let lastFailureLocation: WeatherLocation | null = null;

/**
 * Edellisen sijainnin sää EI SAA näkyä uuden sijainnin tuloksena.
 *
 * Providerilla on yksi datapaikka ja 20 minuutin kierto, joten heti
 * postinumeron vaihdon jälkeen se pitää yhä hallussaan EDELLISEN paikkakunnan
 * hyötykuormaa. Koontinäkymän `place` sen sijaan ratkaistaan joka pyynnöllä,
 * ja kortin otsikko lukee sen (`:note="place ?? data?.place"`). Ilman tätä
 * suodatusta kortti siis väitti uutta paikkakuntaa ja näytti vanhan
 * lämpötilat — tilana `ok` ja tuoreella aikaleimalla. Mitattu 18.9.2026:
 * postinumeron vaihto Karstulasta Sodankylään vaihtoi otsikon välittömästi,
 * mutta lämpötila pysyi Karstulan 8,9 °C:ssa 17 min 31 s ajan.
 *
 * Väärä data ilman merkintää on pahempi kuin puuttuva data, joten tässä
 * tehdään sama kuin uutisilla (`projectNewsSnapshot`), ruokalistalla
 * (`selectedMenuData`) ja jätehuollolla (`projectWasteData`:n revisiovertailu).
 *
 * "Viimeisin onnistunut data" ei riko tästä. Se koskee NYT VALITTUA sijaintia:
 * kun koordinaatit täsmäävät, tilannekuva menee läpi koskemattomana
 * aikaleimoineen ja `stale`-tiloineen. Pois jää vain se data, joka kuuluu
 * sijaintiin jota kortti ei enää esitä — eikä se ole koskaan ollut tämän
 * kortin viimeisin onnistunut data.
 *
 * TILAN VALINTA ON MITATTU, EI PÄÄTELTY. `Provider` asettaa `stale`n myös
 * silloin kun se vain lämmittelee levyvälimuistista eikä mikään ole
 * epäonnistunut, joten pelkkä `stale -> failed` -kuvaus näytti seinänäytöllä
 * viisi sekuntia punaista "EI YHTEYTTÄ · Lähde ei vastaa" jokaisella
 * käynnistyksellä jossa välimuistin sijainti ei täsmää. Erottelu on `error`:
 * se asetetaan VAIN oikeassa epäonnistumisessa, joten
 *
 *   stale + error === null   lämmin käynnistys, ensimmäinen haku tulossa
 *   stale + error !== null   haku on oikeasti rikki, vanha data oli sen tukena
 *
 * Lämmin käynnistys piirtyy siis "Haetaan…" eikä virheenä. Se on oikeampi
 * kuin "vanhentunut"-merkintäkin: hallussa oleva data on VÄÄRÄN sijainnin
 * dataa, joten vanhentuneeksi ei ole mitään merkittävää — ainoa tosi väite on
 * että tämän sijainnin säätä ei vielä ole ja sitä haetaan.
 */
export function projectWeatherSnapshot(
  snapshot: ProviderSnapshot<unknown>,
  location: WeatherLocation,
): ProviderSnapshot<unknown> {
  const data = snapshot.data as WeatherData | null;
  if (!data || isForLocation(data, location)) return snapshot;
  // Virhe esitetään vain jos se kuuluu TÄLLE sijainnille. Kolme ehtoa, ja
  // järjestys on tahallinen: epävarmassa tilanteessa pudotaan `idle`en eikä
  // valheelliseen verkkohälytykseen.
  const broken =
    snapshot.error !== null &&
    lastFailureLocation !== null &&
    isSameLocation(lastFailureLocation, location);
  return {
    ...snapshot,
    data: null,
    fetchedAt: null,
    status: broken ? "failed" : "idle",
    error: broken ? snapshot.error : null,
  };
}

async function fetchWeatherFor(location: WeatherLocation, fetcher: typeof fetch): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset",
    hourly: "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m",
    timezone: config.timezone,
    forecast_days: "6",
    // Open-Meteo antaa tuulen oletuksena km/h:na, mutta kortti on aina
    // merkinnyt sen m/s:ksi — 17,3 km/h näkyi siis lukemana "17,3 m/s", joka on
    // navakan tuulen sijaan myrsky. Yksikkö pyydetään suoraan oikeana, jottei
    // muunnosta tarvitse muistaa kahdessa eri näkymässä.
    wind_speed_unit: "ms",
  });

  const response = await fetcher(`${API_URL}?${params.toString()}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as OpenMeteoResponse;
  if (!body.current || !body.daily || !body.hourly) {
    throw new Error("Open-Meteo response is missing expected fields");
  }

  return {
    place: location.place,
    latitude: location.latitude,
    longitude: location.longitude,
    current: {
      temperature: body.current.temperature_2m,
      apparentTemperature: body.current.apparent_temperature,
      condition: conditionFor(body.current.weather_code),
      windSpeed: body.current.wind_speed_10m,
      precipitation: body.current.precipitation,
    },
    todayRemainingHours: remainingHoursToday(body.hourly),
    days: dailyForecast(body.daily, body.hourly),
  };
}

/**
 * Montako kertaa yksi hakukierros yrittää uudelleen kun sijainti vaihtuu
 * kesken haun. Tämä on tavallisen tapauksen nopeutus, EI takuu — takuun antaa
 * `RERUN_DELAY_MS` alla.
 */
const MAX_ATTEMPTS = 3;

/**
 * Kuinka pian kierros ajetaan uudelleen jos se päättyi vanhentuneeseen
 * sijaintiin. Tämä on se rivi joka estää umpikujan, ja sen olemassaolo on
 * mitattu: ilman sitä neljä peräkkäistä tallennusta yhden haun aikana jätti
 * providerin pitämään VANHAN sijainnin dataa, projektio suodatti sen pois, ja
 * kortissa luki "Haetaan…" vaikka mitään ei ollut ajastettuna ennen seuraavaa
 * 20 minuutin kiertoa. Ulospääsy olisi ollut vaihtaa johonkin ERI
 * postinumeroon tai käynnistää palvelin uudelleen, eikä kumpikaan johdu
 * mistään mitä käyttäjä näkee. Se olisi ollut pysyvä valhe siinä missä
 * alkuperäinen vika oli 20 minuutin viive.
 *
 * Uusinta EI kulje `onFailure`n kautta, koska mikään ei epäonnistunut: haku
 * onnistui, se vain ehti vanhentua. Perääntyminen ei kasva, katkaisija ei
 * liiku eikä lokiin jää riviä oletustasolla.
 *
 * Tämä on myös syy olla heittämättä virhettä katossa (ks. fetchWeather):
 * heitto maksaisi kaksi lokiriviä nollan minuutin "katkoksesta" jota ei ole.
 * Lisäksi `backoffMs()` on `min(intervalMs * 2^n, maxBackoffMs)` =
 * `min(20 min * 2^n, 30 min)`, joten KAIKKI n >= 1 antavat saman 30 minuuttia
 * — ero olisi näkymätön juuri tälle providerille. Se ei ole yleinen totuus
 * vaan seuraus siitä että katto (30 min) on pienempi kuin `intervalMs * 2`
 * (40 min): jos sään kierto joskus lasketaan alle 15 minuutin tai kattoa
 * nostetaan, tuo ero herää henkiin.
 */
const RERUN_DELAY_MS = 2_000;

/**
 * Yksi hakukierros, joka uusitaan jos sijainti vaihtuu kesken haun.
 *
 * Silmukka kattaa tavallisen tapauksen, jossa tallennus osuu juuri käynnissä
 * olevaan hakuun ja reitin `runOnce()` ohittaa itsensä providerin
 * varattuna-vahdin takia (`provider.ts`: `if (this.stopped || this.running) return;`).
 *
 * KATOSSA PALAUTETAAN SE MITÄ SAATIIN, EI HEITETÄ. Naapuriproviderit
 * (`fetchNews`, `fetchSelectedMenus`, `fetchWaste`) heittävät tässä kohdassa,
 * ja tämäkin heitti hetken — mutta hinta mitattiin eikä se ollut sen
 * arvoinen. Heitto tuottaa `provider_still_failing`- ja
 * `provider_recovered`-rivit tapahtumasta jossa mikään ei rikkoutunut:
 *
 *     ERROR provider_still_failing  weather  consecutiveFailures=1
 *     WARN  provider_recovered      weather  downForMinutes=0
 *
 * NOLLAN MINUUTIN SÄÄKATKOS LOKISSA ON POSTINUMERON VAIHTO, EI VERKKOVIKA —
 * ja juuri sellaisia rivejä `logging.ts` ja `provider.ts` ovat olemassa
 * estämään ("a log short enough to read", "one line per outage"). Kortin
 * puolella heitto olisi lisäksi VÄÄRÄSSÄ: uusi haku on oikeasti ajastettu
 * kahden sekunnin päähän, joten "Haetaan…" on tosi ja "Tietoja ei saatu" ei.
 *
 * Umpikujan estää `createWeatherProvider`in ajastettu uusinta, ei heitto.
 *
 * `fetcher` on injektoitavissa vain testiä varten (ks. menu.ts:n sama ratkaisu).
 */
export async function fetchWeather(fetcher: typeof fetch = fetch): Promise<WeatherData> {
  let data: WeatherData | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { location } = currentWeatherLocation();
    try {
      data = await fetchWeatherFor(location, fetcher);
    } catch (err) {
      // Kirjataan MILLE sijainnille tämä epäonnistuminen kuului, ks.
      // lastFailureLocation. Ilman tätä virheilmoitus vaeltaisi seuraavan
      // sijainnin nimen alle.
      lastFailureLocation = location;
      throw err;
    }
    // Haku onnistui, joten voimassa olevaa epäonnistumista ei enää ole.
    lastFailureLocation = null;
    if (isForLocation(data, currentWeatherLocation().location)) return data;
  }
  return data as WeatherData;
}

export interface WeatherProviderOptions {
  /** Vain testiä varten. */
  fetcher?: typeof fetch;
  /** Vain testiä varten, ks. RERUN_DELAY_MS. */
  rerunDelayMs?: number;
}

export function createWeatherProvider(options: WeatherProviderOptions = {}): Provider<WeatherData> {
  const fetcher = options.fetcher ?? fetch;
  const rerunDelayMs = options.rerunDelayMs ?? RERUN_DELAY_MS;

  const provider: Provider<WeatherData> = new Provider<WeatherData>({
    id: "weather",
    // Hourly-resolution data does not need to be polled more often than this;
    // the initial delay staggers it away from the other providers' own startup.
    intervalMs: 20 * 60 * 1000,
    initialDelayMs: 5_000,
    fetch: async () => {
      const data = await fetchWeather(fetcher);

      // YKSI TARKISTUS, KAKSI OVEA. Sijainti on voinut vaihtua joko niin monta
      // kertaa että kierroksen katto tuli vastaan, tai vielä `fetchWeather`in
      // paluun ja `onSuccess`in välissä. Molemmissa data päätyisi välimuistiin
      // sijainnille jota kortti ei esitä, eikä mitään olisi ajastettuna ennen
      // 20 minuutin kiertoa: kortissa lukisi "Haetaan…" vaikka kukaan ei hae.
      if (!isForLocation(data, currentWeatherLocation().location)) {
        // debug, ei warn: tässä ei ole vikaa. Oletusloki on `warn` (ks.
        // core/config.ts), joten tavallisessa ajossa tästä ei jää riviä
        // lainkaan — postinumeron vaihto ei saa näyttää lokissa katkokselta.
        logger.debug(
          { event: "weather_location_changed_during_fetch", place: currentWeatherLocation().location.place },
          "sijainti vaihtui haun aikana — kierros ajetaan uudelleen",
        );
        // Ajastus TÄSTÄ eikä suoraan `runOnce()`-kutsuna: olemme yhä
        // `runOnce()`in sisällä, joten sen oma `schedule(intervalMs)` ajetaan
        // vasta tämän jälkeen ja se korvaisi minkä tahansa ajastuksen jonka
        // tekisimme nyt. Viive myös päästää `running`-lipun laskeutumaan,
        // jottei uusi kierros katoa samaan varattuna-vahtiin jota se on
        // korjaamassa.
        const timer = setTimeout(() => void provider.runOnce(), rerunDelayMs);
        timer.unref?.();
      }
      return data;
    },
  });

  return provider;
}
