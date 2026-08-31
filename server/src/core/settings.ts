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
 * Ankkuri jota vasten "minuuttia ennen" lasketaan relative-tilan
 * hälytyksessä: joko päivän ensimmäisen oppitunnin alku tai globaali
 * aamupalan alkuaika (ks. Settings.breakfastTime).
 */
export type AlarmAnchor = "schoolStart" | "breakfast";

/**
 * Yhden viikonpäivän sääntö relative-tilan hälytykselle: viikonpäivä
 * (Date.getDayn numerointi, 0 = sunnuntai … 6 = lauantai — sama kuin
 * web/src/composables/useAlarms.ts:n WEEKDAYS-taulukko) kantaa mukanaan
 * sinä päivänä käytettävän ankkurin. Näin sama hälytys voi maanantaina
 * seurata aamupalaa ja tiistaina koulun alkua ilman erillistä per-päivä
 * enable-lippua ja ankkuria toisistaan irrallaan.
 */
export interface AlarmWeekdayRule {
  weekday: number;
  anchor: AlarmAnchor;
}

/**
 * Kahden toisensa poissulkevan hälytystyypin unioni. Tämä (eikä yhteinen
 * "minutesBefore + anchor + fixedTime" -kenttäjoukko) on tahallinen valinta:
 * kiinteän kellonajan hälytykselle (`fixed`) EI OLE minuutteja, oppilasta
 * eikä ankkuria — se ei seuraa mitään — ja relative-hälytykselle ei ole
 * kellonaikaa. Kelvottomia yhdistelmiä (esim. kiinteä aika + "30 min ennen
 * koulun alkua") ei siis voi edes muodostaa, ei vain validointi torju niitä.
 */
export type AlarmTrigger =
  | {
      mode: "relative";
      /** Minuuttia ennen kunkin päivän ankkuria. */
      minutesBefore: number;
      /** Null = mikä tahansa oppilas — aikaisin tunneista kaikkien lasten kesken. */
      studentNumber: string | null;
      /** Viikonpäivät joina hälytys on aktiivinen; kukin omalla ankkurillaan. Tyhjä lista = ei koskaan. */
      weekdays: AlarmWeekdayRule[];
    }
  | {
      mode: "fixed";
      /** "HH:MM" paikallista aikaa. */
      time: string;
      /** Viikonpäivät joina hälytys on aktiivinen. Tyhjä lista = ei koskaan. */
      weekdays: number[];
    };

/**
 * Koulukello. Pidettävä samana kuin web/src/types.ts:n Alarm.
 *
 * Vanhoja (ennen trigger-kenttää tallennettuja) hälytyksiä ei enää ole
 * tässä muodossa muistissa — ne muunnetaan tähän heti luvun yhteydessä, ks.
 * parseTrigger ja getSettings alla. Levylle tallennettuna ne voivat silti
 * olla vanhaa muotoa kunnes käyttäjä tallentaa jotain, koska getSettings ei
 * kirjoita normalisoitua muotoa takaisin — vain lukee sen läpinäkyvästi.
 */
export interface Alarm {
  id: string;
  label: string;
  trigger: AlarmTrigger;
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
  /** Päikyn näytettävät lapset. null = kaikki. Arvot ovat PaikkyChild.id. */
  visiblePaikkyChildren: string[] | null;
  /** `single` shows one child at a time, `split` shows them side by side. */
  scheduleLayout: "single" | "split";
  /** Local time of day when the schedule switches to the next school day. */
  rolloverTime: string;
  /** Hide message bodies on the wall display; sender and unread count remain. */
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
  /**
   * Aamupalan alkuaika, "HH:MM" paikallista aikaa. Yksi globaali asetus —
   * ei hälytys- eikä lapsikohtainen (ks. AlarmTrigger.mode "relative"
   * -haaran anchor: "breakfast").
   */
  breakfastTime: string;
  /** Where each panel sits. Null means "never edited", so the default is used. */
  panelLayout: PanelLayout | null;
  alarms: Alarm[];
}

export const defaultSettings: Settings = {
  visibleStudents: null,
  visiblePaikkyChildren: null,
  scheduleLayout: "split",
  rolloverTime: "12:00",
  hideMessagePreviews: false,
  nightModeStart: "21:30",
  nightModeEnd: "06:00",
  breakfastTime: "08:00",
  panelLayout: null,
  alarms: [],
};

const KEY = "settings";

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY);
  const merged = { ...defaultSettings, ...(stored ?? {}) };
  merged.alarms = normalizeStoredAlarms(merged.alarms);
  return merged;
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
    next.visibleStudents = parseVisibleIds(
      input["visibleStudents"],
      "visibleStudents: lista opiskelijanumeroita tai null",
    );
  }

  if ("visiblePaikkyChildren" in input) {
    next.visiblePaikkyChildren = parseVisibleIds(
      input["visiblePaikkyChildren"],
      "visiblePaikkyChildren: lista lapsitunnisteita tai null",
    );
  }

  if ("scheduleLayout" in input) {
    const value = input["scheduleLayout"];
    if (value !== "single" && value !== "split") {
      throw new SettingsValidationError("scheduleLayout: 'single' tai 'split'");
    }
    next.scheduleLayout = value;
  }

  for (const key of ["rolloverTime", "nightModeStart", "nightModeEnd", "breakfastTime"] as const) {
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

/**
 * `visibleStudents` (Wilma) ja `visiblePaikkyChildren` (Päikky) ovat sama
 * asetus kahdelle lähteelle: null = näytä kaikki, muuten lista tunnisteita.
 * Suodatus tehdään selaimessa — palvelin ei tiedä keitä lapsia lähde tänään
 * palauttaa, eikä poistuneen lapsen tunniste listassa siksi ole virhe — joten
 * tässä varmistetaan vain muoto ennen tallennusta. Virheteksti tulee kutsujalta,
 * jotta se nimeää oikean kentän.
 */
function parseVisibleIds(value: unknown, message: string): string[] | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  throw new SettingsValidationError(message);
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

/** Kaikki viikonpäivät Date.getDayn numeroinnilla, sunnuntaista alkaen. */
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

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

function parseWeekdayNumber(value: unknown, label: string): number {
  return integerInRange(value, label, 0, 6);
}

/**
 * Relative-tilan viikonpäivälista: jokainen alkio kantaa oman ankkurinsa
 * (ks. AlarmWeekdayRule), ja sama viikonpäivä saa esiintyä listassa vain
 * kerran — muuten kaksi sääntöä kilpailisi samasta päivästä.
 */
function parseRelativeWeekdays(value: unknown, index: number): AlarmWeekdayRule[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: lista`);
  }
  const seen = new Set<number>();
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays[${i}]: objekti`);
    }
    const item = raw as Record<string, unknown>;
    const weekday = parseWeekdayNumber(item["weekday"], `alarms[${index}].trigger.weekdays[${i}].weekday`);
    if (seen.has(weekday)) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: viikonpäivä ${weekday} toistuu`);
    }
    seen.add(weekday);
    const anchor = item["anchor"];
    if (anchor !== "schoolStart" && anchor !== "breakfast") {
      throw new SettingsValidationError(
        `alarms[${index}].trigger.weekdays[${i}].anchor: 'schoolStart' tai 'breakfast'`,
      );
    }
    return { weekday, anchor };
  });
}

/** Fixed-tilan viikonpäivälista: pelkkiä viikonpäivänumeroita, ei ankkuria. */
function parseFixedWeekdays(value: unknown, index: number): number[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: lista`);
  }
  const seen = new Set<number>();
  return value.map((raw, i) => {
    const weekday = parseWeekdayNumber(raw, `alarms[${index}].trigger.weekdays[${i}]`);
    if (seen.has(weekday)) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: viikonpäivä ${weekday} toistuu`);
    }
    seen.add(weekday);
    return weekday;
  });
}

/** Tiukka validointi uuden muodon trigger-oliolle (ks. AlarmTrigger). */
function parseTriggerObject(value: unknown, index: number): AlarmTrigger {
  if (typeof value !== "object" || value === null) {
    throw new SettingsValidationError(`alarms[${index}].trigger: objekti`);
  }
  const t = value as Record<string, unknown>;
  const mode = t["mode"];

  if (mode === "relative") {
    const minutesBefore = integerInRange(
      t["minutesBefore"],
      `alarms[${index}].trigger.minutesBefore`,
      ALARM_MINUTES_MIN,
      ALARM_MINUTES_MAX,
    );
    const studentNumberRaw = t["studentNumber"];
    if (studentNumberRaw !== null && typeof studentNumberRaw !== "string") {
      throw new SettingsValidationError(`alarms[${index}].trigger.studentNumber: merkkijono tai null`);
    }
    const weekdays = parseRelativeWeekdays(t["weekdays"], index);
    return { mode: "relative", minutesBefore, studentNumber: studentNumberRaw as string | null, weekdays };
  }

  if (mode === "fixed") {
    const time = t["time"];
    if (typeof time !== "string" || parseClockTime(time) === null) {
      throw new SettingsValidationError(`alarms[${index}].trigger.time: kellonaika muodossa HH:MM`);
    }
    const weekdays = parseFixedWeekdays(t["weekdays"], index);
    return { mode: "fixed", time, weekdays };
  }

  throw new SettingsValidationError(`alarms[${index}].trigger.mode: 'relative' tai 'fixed'`);
}

/**
 * Palauttaa hälytyksen triggerin — joko uuden muodon `trigger`-kentästä, tai
 * jos sitä ei ole, tulkitsee ennen tätä muutosta tallennetun vanhan muodon
 * (pelkkä top-level minutesBefore + studentNumber, ei viikonpäiviä eikä
 * ankkuria) migraationa.
 *
 * Migraation oletus on KAIKKI viikonpäivät, ei esim. ma–pe: vanha hälytys
 * laukesi aiemmin minä tahansa päivänä jolloin päivän ensimmäinen tunti
 * löytyi, riippumatta viikonpäivästä (ks. entinen alarmTargetForDate web-
 * puolella). Jos migraatio rajaisi sen ma–pe:hen, poikkeuksellinen
 * koulupäivä (esim. lauantaityöpäivä) hiljenisi äänettömästi — sama
 * hälytyksen pitää siis jatkaa toimimista TÄSMÄLLEEN entiseen tapaan ilman
 * että käyttäjä koskee siihen, ei "järkevän oloisesti mutta eri tavalla".
 */
function parseTrigger(item: Record<string, unknown>, index: number): AlarmTrigger {
  if (item["trigger"] !== undefined) {
    return parseTriggerObject(item["trigger"], index);
  }

  const minutesBefore = integerInRange(
    item["minutesBefore"],
    `alarms[${index}].minutesBefore`,
    ALARM_MINUTES_MIN,
    ALARM_MINUTES_MAX,
  );
  const studentNumberRaw = item["studentNumber"];
  if (studentNumberRaw !== null && typeof studentNumberRaw !== "string" && studentNumberRaw !== undefined) {
    throw new SettingsValidationError(`alarms[${index}].studentNumber: merkkijono tai null`);
  }
  const studentNumber = typeof studentNumberRaw === "string" ? studentNumberRaw : null;

  return {
    mode: "relative",
    minutesBefore,
    studentNumber,
    weekdays: ALL_WEEKDAYS.map((weekday) => ({ weekday, anchor: "schoolStart" })),
  };
}

/**
 * Hälytykset tulevat kotiverkon puhelimelta siinä missä muutkin asetukset,
 * joten jokainen kenttä rajataan tässä eikä luoteta clientin lähettämään
 * muotoon. soundId ei ole suljettu enum (ks. kommentti Alarm-tyypissä), joten
 * se hyväksytään minä tahansa tunnisteenomaisena merkkijonona sen sijaan että
 * torjuttaisiin kaikki paitsi tämänhetkiset sisäänrakennetut äänet.
 */
function parseAlarm(raw: unknown, index: number): Alarm {
  if (typeof raw !== "object" || raw === null) {
    throw new SettingsValidationError(`alarms[${index}]: objekti`);
  }
  const item = raw as Record<string, unknown>;

  const id = item["id"];
  if (typeof id !== "string" || !ALARM_ID_PATTERN.test(id)) {
    throw new SettingsValidationError(`alarms[${index}].id: tunniste`);
  }

  const label = item["label"];
  if (typeof label !== "string" || label.trim().length === 0 || label.length > ALARM_LABEL_MAX_LENGTH) {
    throw new SettingsValidationError(`alarms[${index}].label: teksti 1–${ALARM_LABEL_MAX_LENGTH} merkkiä`);
  }

  const trigger = parseTrigger(item, index);

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

  return { id, label, trigger, enabled, soundId, volume, repeatCount };
}

export function parseAlarms(value: unknown): Alarm[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError("alarms: lista");
  }
  if (value.length > MAX_ALARMS) {
    throw new SettingsValidationError(`alarms: enintään ${MAX_ALARMS} hälytystä`);
  }

  const seenIds = new Set<string>();
  return value.map((raw, index) => {
    const alarm = parseAlarm(raw, index);
    if (seenIds.has(alarm.id)) {
      throw new SettingsValidationError(`alarms[${index}].id: sama tunniste toistuu useammassa hälytyksessä`);
    }
    seenIds.add(alarm.id);
    return alarm;
  });
}

/**
 * Sama muunnos kuin parseAlarms, mutta lukua varten: ei koskaan heitä.
 * Tallennettu data on normaalisti aina joko jo tätä muotoa (parseAlarmsin
 * kautta kirjoitettu) tai ennen tätä muutosta tallennettua vanhaa muotoa
 * (parseTrigger tulkitsee sen migraationa, ks. yllä) — kummankin pitäisi
 * onnistua aina. Yksittäisen rivin odottamaton hylkääminen on siis
 * viimesijainen suoja aidosti korruptoitunutta dataa vastaan, ei odotettu
 * polku: sellaisen ei pidä kaataa koko infonäyttöä, joten rivi jätetään pois
 * ja virhe kirjataan konsoliin sen sijaan.
 */
function normalizeStoredAlarms(value: unknown): Alarm[] {
  if (!Array.isArray(value)) return [];
  const out: Alarm[] = [];
  value.forEach((raw, index) => {
    try {
      out.push(parseAlarm(raw, index));
    } catch (err) {
      console.error(`Tallennettu hälytys #${index} ei kelpaa, jätetään pois asetuksista:`, err);
    }
  });
  return out;
}
