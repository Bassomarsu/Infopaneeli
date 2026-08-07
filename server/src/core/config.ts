import { fileURLToPath } from "node:url";
import path from "node:path";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = path.resolve(serverRoot, "..");

function str(name: string, fallback = ""): string {
  // Trimmed because a stray space after `=` in .env is easy to miss and turns
  // a base URL into an invalid one.
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? fallback : value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Default is `warn`, not `error`: only state transitions are ever logged, so
 * `warn` adds recovery lines at a cost of roughly one line per outage while
 * making the log actually readable. `debug` turns on per-fetch logging, console
 * output, and the Wilma library's own debug flag.
 */
const logLevel = str("LOG_LEVEL", "warn");

/**
 * Overridable so the test suite writes somewhere else. The log exists to answer
 * "what broke on the wall display", and rows from fake providers named
 * `test-flaky-1234` sitting in the middle of it make that harder, not easier.
 */
const logDirOverride = str("LOG_DIR");

/**
 * Same reason as LOG_DIR: the test suite must not write its fake providers into
 * the database the wall display actually reads. Cache rows named
 * `test-recover-1234` accumulating next to the real ones make the state on disk
 * impossible to reason about.
 */
const dbPathOverride = str("DB_PATH");

export const config = {
  projectRoot,
  dataDir: path.join(projectRoot, "data"),
  logDir: logDirOverride ? path.resolve(projectRoot, logDirOverride) : path.join(projectRoot, "data", "logs"),
  snapshotDir: path.join(projectRoot, "data", "snapshots"),
  dbPath: dbPathOverride ? path.resolve(projectRoot, dbPathOverride) : path.join(projectRoot, "data", "infonaytto.db"),
  webDist: path.join(projectRoot, "web", "dist"),

  port: num("PORT", 4173),
  host: str("HOST", "0.0.0.0"),

  logLevel,
  debugMode: logLevel === "debug" || logLevel === "trace",

  timezone: "Europe/Helsinki",

  weather: {
    latitude: num("WEATHER_LAT", 62.86667),
    longitude: num("WEATHER_LON", 24.78333),
    place: str("WEATHER_PLACE", "Karstula"),
  },

  wilma: {
    baseUrl: str("WILMA_BASE_URL", "https://karstulakyyjarvi.inschool.fi").replace(/\/+$/, ""),
    username: str("WILMA_USERNAME"),
    password: str("WILMA_PASSWORD"),
  },

  calendarIcsUrl: str("CALENDAR_ICS_URL"),

  editPin: str("EDIT_PIN"),
} as const;

export function isWilmaConfigured(): boolean {
  return Boolean(config.wilma.baseUrl && config.wilma.username && config.wilma.password);
}
