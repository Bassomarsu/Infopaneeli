import { Provider } from "../core/provider.ts";
import { config } from "../core/config.ts";
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
  precipitationProbability: number | null;
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
  weather_code: number[];
  precipitation_probability: number[];
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

/** Only the rest of today is useful on a display; six days of hourly data is not. */
function remainingHoursToday(hourly: OpenMeteoHourly): WeatherHour[] {
  const todayKey = localDateKey();
  const currentHour = localParts().hour;
  const hours: WeatherHour[] = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    if (!time || dateKeyOf(time) !== todayKey) continue;
    const hour = hourOf(time);
    if (hour < currentHour) continue;
    hours.push({
      time,
      hour,
      temperature: hourly.temperature_2m[i] ?? 0,
      precipitationProbability: hourly.precipitation_probability[i] ?? null,
      condition: conditionFor(hourly.weather_code[i] ?? 0),
    });
  }

  return hours;
}

function dailyForecast(daily: OpenMeteoDaily): WeatherDay[] {
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
    });
  }

  return days;
}

async function fetchWeather(): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: String(config.weather.latitude),
    longitude: String(config.weather.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    timezone: config.timezone,
    forecast_days: "6",
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
    place: config.weather.place,
    current: {
      temperature: body.current.temperature_2m,
      apparentTemperature: body.current.apparent_temperature,
      condition: conditionFor(body.current.weather_code),
      windSpeed: body.current.wind_speed_10m,
      precipitation: body.current.precipitation,
    },
    todayRemainingHours: remainingHoursToday(body.hourly),
    days: dailyForecast(body.daily),
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
