import { getSetting, setSetting } from "./store.ts";
import { parseClockTime } from "./time.ts";

export interface Settings {
  /** Student numbers to show; null means every child found in Wilma. */
  visibleStudents: string[] | null;
  /** `single` shows one child at a time, `split` shows them side by side. */
  scheduleLayout: "single" | "split";
  /** Local time of day when the schedule switches to the next school day. */
  rolloverTime: string;
  /** Hide message bodies on the wall display; sender and unread count remain. */
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
}

export const defaultSettings: Settings = {
  visibleStudents: null,
  scheduleLayout: "split",
  rolloverTime: "12:00",
  hideMessagePreviews: false,
  nightModeStart: "21:30",
  nightModeEnd: "06:00",
};

const KEY = "settings";

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY);
  return { ...defaultSettings, ...(stored ?? {}) };
}

export class SettingsValidationError extends Error {}

/**
 * Only known keys are accepted and each is validated, because these come
 * straight from a phone on the home network.
 */
export function updateSettings(patch: unknown): Settings {
  if (typeof patch !== "object" || patch === null) {
    throw new SettingsValidationError("Asetusten täytyy olla objekti");
  }
  const input = patch as Record<string, unknown>;
  const next: Settings = { ...getSettings() };

  if ("visibleStudents" in input) {
    const value = input["visibleStudents"];
    if (value === null) {
      next.visibleStudents = null;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      next.visibleStudents = value as string[];
    } else {
      throw new SettingsValidationError("visibleStudents: lista opiskelijanumeroita tai null");
    }
  }

  if ("scheduleLayout" in input) {
    const value = input["scheduleLayout"];
    if (value !== "single" && value !== "split") {
      throw new SettingsValidationError("scheduleLayout: 'single' tai 'split'");
    }
    next.scheduleLayout = value;
  }

  for (const key of ["rolloverTime", "nightModeStart", "nightModeEnd"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "string" || parseClockTime(value) === null) {
      throw new SettingsValidationError(`${key}: kellonaika muodossa HH:MM`);
    }
    next[key] = value;
  }

  if ("hideMessagePreviews" in input) {
    const value = input["hideMessagePreviews"];
    if (typeof value !== "boolean") {
      throw new SettingsValidationError("hideMessagePreviews: true tai false");
    }
    next.hideMessagePreviews = value;
  }

  setSetting(KEY, next);
  return next;
}
