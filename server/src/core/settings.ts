import { getSetting, setSetting } from "./store.ts";
import { parseClockTime } from "./time.ts";

/**
 * The wall display is one screen that never scrolls, so panels are placed on a
 * fixed grid rather than flowed. Six columns and eight rows is fine enough to
 * express the sizes anyone actually wants, and coarse enough that a fingertip
 * on a 12" touch screen can hit a cell.
 */
export const GRID_COLUMNS = 6;
export const GRID_ROWS = 8;

/**
 * Kortti leikkaa ylivuotavan sisältönsä piiloon (`overflow: hidden`), eikä
 * otsikko voi kutistua. Liian pieneksi kutistettu paneeli ei siis kaadu vaan
 * katoaa hiljaa — myös otsikkonsa ja "vanhentunut"-merkkinsä osalta, jolloin
 * rikkinäistä lähdettä ei enää huomaa. Alaraja on siksi rajapinnassa asti,
 * eikä pelkkä käyttöliittymän sääntö.
 */
export const MIN_PANEL_SPAN = 2;

export const PANEL_IDS = [
  "schedule",
  "messages",
  "weather",
  "electricity",
  "calendar",
  "notes",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export interface PanelPlacement {
  /** 1-based, inclusive. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export type PanelLayout = Record<PanelId, PanelPlacement>;

/** Reproduces the layout the display shipped with, expressed on the grid. */
export const defaultPanelLayout: PanelLayout = {
  schedule: { col: 1, row: 1, colSpan: 4, rowSpan: 3 },
  messages: { col: 1, row: 4, colSpan: 4, rowSpan: 3 },
  calendar: { col: 1, row: 7, colSpan: 4, rowSpan: 2 },
  weather: { col: 5, row: 1, colSpan: 2, rowSpan: 3 },
  electricity: { col: 5, row: 4, colSpan: 2, rowSpan: 3 },
  notes: { col: 5, row: 7, colSpan: 2, rowSpan: 2 },
};

/**
 * Koulukello: laukeaa X minuuttia ennen päivän ensimmäisen oppitunnin alkua.
 * Pidettävä samana kuin web/src/types.ts:n Alarm.
 */
export interface Alarm {
  id: string;
  label: string;
  /** Minuuttia ennen päivän ensimmäisen oppitunnin alkua. */
  minutesBefore: number;
  /** Null = mikä tahansa oppilas — aikaisin tunneista kaikkien lasten kesken. */
  studentNumber: string | null;
  enabled: boolean;
  /**
   * Äänen tunniste, ei tiedostopolku. Tämä pitää oven auki myöhemmin
   * lisättävälle omalle äänitiedostolle ilman skeemamuutosta — kenttä ei siis
   * ole suljettu enum, vaikka validointi tänään tunteekin vain sisäänrakennetut
   * äänet (ks. parseAlarms).
   */
  soundId: string;
  /** 0–1. */
  volume: number;
  /** Montako kertaa ääni toistetaan laukeamisen yhteydessä. */
  repeatCount: number;
}

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
  /** Where each panel sits. Null means "never edited", so the default is used. */
  panelLayout: PanelLayout | null;
  alarms: Alarm[];
}

export const defaultSettings: Settings = {
  visibleStudents: null,
  scheduleLayout: "split",
  rolloverTime: "12:00",
  hideMessagePreviews: false,
  nightModeStart: "21:30",
  nightModeEnd: "06:00",
  panelLayout: null,
  alarms: [],
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

  if ("panelLayout" in input) {
    next.panelLayout = parsePanelLayout(input["panelLayout"]);
  }

  if ("alarms" in input) {
    next.alarms = parseAlarms(input["alarms"]);
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

function positiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new SettingsValidationError(`panelLayout.${label}: kokonaisluku väliltä 1–${max}`);
  }
  return value;
}

/**
 * A layout that does not fit the grid would push panels off the wall display
 * with no way to drag them back, so the bounds are enforced here rather than
 * trusted from the client. Every panel must be present: a partial layout would
 * silently drop a card.
 */
export function parsePanelLayout(value: unknown): PanelLayout | null {
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new SettingsValidationError("panelLayout: objekti tai null");
  }
  const input = value as Record<string, unknown>;
  const layout = {} as PanelLayout;

  for (const id of PANEL_IDS) {
    const raw = input[id];
    if (typeof raw !== "object" || raw === null) {
      throw new SettingsValidationError(`panelLayout.${id}: puuttuu`);
    }
    const item = raw as Record<string, unknown>;
    const col = positiveInt(item["col"], `${id}.col`, GRID_COLUMNS);
    const row = positiveInt(item["row"], `${id}.row`, GRID_ROWS);
    const colSpan = positiveInt(item["colSpan"], `${id}.colSpan`, GRID_COLUMNS);
    const rowSpan = positiveInt(item["rowSpan"], `${id}.rowSpan`, GRID_ROWS);

    if (colSpan < MIN_PANEL_SPAN || rowSpan < MIN_PANEL_SPAN) {
      throw new SettingsValidationError(
        `panelLayout.${id}: paneelin on oltava vähintään ${MIN_PANEL_SPAN}×${MIN_PANEL_SPAN} solua`,
      );
    }

    if (col + colSpan - 1 > GRID_COLUMNS) {
      throw new SettingsValidationError(`panelLayout.${id}: ei mahdu leveyssuunnassa`);
    }
    if (row + rowSpan - 1 > GRID_ROWS) {
      throw new SettingsValidationError(`panelLayout.${id}: ei mahdu korkeussuunnassa`);
    }
    layout[id] = { col, row, colSpan, rowSpan };
  }

  return layout;
}

/**
 * Yläraja hälytysten määrälle — nämä säilytetään yhdessä JSON-blobissa
 * (ks. store.ts), joten mikään ei muuten estäisi listaa kasvamasta rajatta.
 */
export const MAX_ALARMS = 20;
const ALARM_LABEL_MAX_LENGTH = 60;
const ALARM_MINUTES_MIN = 1;
const ALARM_MINUTES_MAX = 240;
const ALARM_REPEAT_MIN = 1;
const ALARM_REPEAT_MAX = 8;
const ALARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALARM_SOUND_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

function numberInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsValidationError(`${label}: luku väliltä ${min}–${max}`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const num = numberInRange(value, label, min, max);
  if (!Number.isInteger(num)) {
    throw new SettingsValidationError(`${label}: kokonaisluku väliltä ${min}–${max}`);
  }
  return num;
}

/**
 * Hälytykset tulevat kotiverkon puhelimelta siinä missä muutkin asetukset,
 * joten jokainen kenttä rajataan tässä eikä luoteta clientin lähettämään
 * muotoon. soundId ei ole suljettu enum (ks. kommentti Alarm-tyypissä), joten
 * se hyväksytään minä tahansa tunnisteenomaisena merkkijonona sen sijaan että
 * torjuttaisiin kaikki paitsi tämänhetkiset sisäänrakennetut äänet.
 */
export function parseAlarms(value: unknown): Alarm[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError("alarms: lista");
  }
  if (value.length > MAX_ALARMS) {
    throw new SettingsValidationError(`alarms: enintään ${MAX_ALARMS} hälytystä`);
  }

  const seenIds = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new SettingsValidationError(`alarms[${index}]: objekti`);
    }
    const item = raw as Record<string, unknown>;

    const id = item["id"];
    if (typeof id !== "string" || !ALARM_ID_PATTERN.test(id)) {
      throw new SettingsValidationError(`alarms[${index}].id: tunniste`);
    }
    if (seenIds.has(id)) {
      throw new SettingsValidationError(`alarms[${index}].id: sama tunniste toistuu useammassa hälytyksessä`);
    }
    seenIds.add(id);

    const label = item["label"];
    if (typeof label !== "string" || label.trim().length === 0 || label.length > ALARM_LABEL_MAX_LENGTH) {
      throw new SettingsValidationError(`alarms[${index}].label: teksti 1–${ALARM_LABEL_MAX_LENGTH} merkkiä`);
    }

    const minutesBefore = integerInRange(
      item["minutesBefore"],
      `alarms[${index}].minutesBefore`,
      ALARM_MINUTES_MIN,
      ALARM_MINUTES_MAX,
    );

    const studentNumber = item["studentNumber"];
    if (studentNumber !== null && typeof studentNumber !== "string") {
      throw new SettingsValidationError(`alarms[${index}].studentNumber: merkkijono tai null`);
    }

    const enabled = item["enabled"];
    if (typeof enabled !== "boolean") {
      throw new SettingsValidationError(`alarms[${index}].enabled: true tai false`);
    }

    const soundId = item["soundId"];
    if (typeof soundId !== "string" || !ALARM_SOUND_ID_PATTERN.test(soundId)) {
      throw new SettingsValidationError(`alarms[${index}].soundId: tunniste`);
    }

    const volume = numberInRange(item["volume"], `alarms[${index}].volume`, 0, 1);

    const repeatCount = integerInRange(
      item["repeatCount"],
      `alarms[${index}].repeatCount`,
      ALARM_REPEAT_MIN,
      ALARM_REPEAT_MAX,
    );

    return {
      id,
      label,
      minutesBefore,
      studentNumber: studentNumber as string | null,
      enabled,
      soundId,
      volume,
      repeatCount,
    };
  });
}
