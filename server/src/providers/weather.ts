import { Provider } from "../core/provider.ts";
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

async function fetchWeather(): Promise<WeatherData> {
  const { location } = currentWeatherLocation();
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

  const response = await fetch(`${API_URL}?${params.toString()}`, {
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

export function createWeatherProvider(): Provider<WeatherData> {
  return new Provider<WeatherData>({
    id: "weather",
    // Hourly-resolution data does not need to be polled more often than this;
    // the initial delay staggers it away from the other providers' own startup.
    intervalMs: 20 * 60 * 1000,
    initialDelayMs: 5_000,
    fetch: fetchWeather,
  });
}
