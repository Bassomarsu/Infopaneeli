/** `hidden` = the server withheld this payload because the client is not the display. */
export type ProviderStatus = "ok" | "stale" | "failed" | "idle" | "hidden";

export interface ProviderSnapshot<T> {
  id: string;
  status: ProviderStatus;
  data: T | null;
  fetchedAt: string | null;
  error: { type: string; message: string } | null;
}

export interface CalendarEvent {
  id: string;
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  title: string;
  allDay: boolean;
  location: string | null;
  /** Local day this row falls on — a multi-day event contributes one row per day. */
  dateKey: string;
  /** Present only for multi-day events: which day of the span this row is, and the span length. */
  span?: { day: number; totalDays: number };
}

/**
 * Yhden kuukauden tapahtumat kuukausinäkymää varten (`GET /api/calendar/month`).
 *
 * `covered` on tämän rajapinnan tärkein kenttä eikä sitä saa ohittaa: lähde ei
 * välttämättä kata koko kuukautta (esim. haku hakee vain lähiviikot), jolloin
 * päivä josta `days` vaikenee EI ole tapahtumaton päivä vaan päivä josta ei
 * tiedetä. Nämä kaksi näytetään käyttöliittymässä eri tavalla — ks.
 * CalendarMonthDialog.vue ja `dayKind` calendarMonth.ts:ssä.
 */
export interface CalendarMonth {
  /** "YYYY-MM". */
  month: string;
  /** Päiväavain "YYYY-MM-DD" → tapahtumat aikajärjestyksessä. Tapahtumaton päivä puuttuu. */
  days: Record<string, CalendarEvent[]>;
  /** false = emme tiedä koko kuukautta, EI "ei tapahtumia". */
  covered: boolean;
}

export interface PriceHour {
  hour: number;
  price: number | null;
  startsAt: string | null;
}

export interface PriceDay {
  date: string;
  /** Always 24 entries indexed by local hour. */
  hours: PriceHour[];
  min: number;
  max: number;
  average: number;
  knownHours: number;
}

/** Kuukauden keskihinta. Erillinen tyyppi, koska lähde ja tuoreus ovat eri kuin vuorokausihinnoilla. */
export interface MonthAverage {
  /** "2026-08" */
  month: string;
  /** Valmiiksi suomeksi, esim. "Elokuu 2026". */
  label: string;
  average: number | null;
  /** Montako tuntia keskiarvoon oikeasti saatiin — osittainen kuukausi on normaali, ei virhe. */
  knownHours: number;
  expectedHours: number;
}

export interface ElectricityData {
  unit: string;
  today: PriceDay | null;
  tomorrow: PriceDay | null;
  tomorrowAvailable: boolean;
  currentPrice: number | null;
  currentHour: number;
  /** Null jos historiaa ei saatu — kortin muut osat toimivat silti. */
  currentMonth: MonthAverage | null;
  previousMonth: MonthAverage | null;
}

/** Yhden tunnin sää. Käytetään päivän tuntinäkymässä. */
export interface WeatherHour {
  /** Paikallinen aika, "2026-08-07T14:00". */
  time: string;
  hour: number;
  temperature: number;
  apparentTemperature: number | null;
  precipitation: number;
  precipitationProbability: number | null;
  windSpeed: number;
  condition: { code: number; description: string; icon: string };
}

export interface ScheduleLesson {
  date: string;
  dayOfWeek: number;
  start: string;
  end: string;
  subject: string;
  subjectCode: string;
  teacher: string;
  teacherCode: string;
  groupId: number;
}

export interface HomeworkItem {
  date: string;
  subject: string;
  subjectCode: string;
  homework: string;
  teacher: string;
  teacherCode: string;
}

export interface UpcomingExam {
  examId: number;
  date: string;
  name: string;
  subject: string;
  subjectCode: string;
  topic: string | null;
  teacher: string;
  teacherCode: string;
}

export interface WilmaStudent {
  studentNumber: string;
  name: string;
}

export interface WilmaMessage {
  id: number;
  subject: string;
  sentAt: string;
  /** Null until the message detail has been fetched. */
  senderName: string | null;
  /** Null means "not known yet", which is different from "read". Wilma does not report this today — see server/src/providers/wilma.ts. */
  unread: boolean | null;
  content: string | null;
  detailCheckedAt: string | null;
  studentNumber: string;
  /** Whether the message has been opened on this display. Local bookkeeping, not Wilma's own read state. */
  localRead: boolean;
}

export interface WilmaStudentData {
  student: WilmaStudent;
  lessons: ScheduleLesson[];
  homework: HomeworkItem[];
  upcomingExams: UpcomingExam[];
  coveredDates: string[];
  nextWeekCheckedAt: string | null;
}

export interface WilmaData {
  students: WilmaStudent[];
  byStudent: Record<string, WilmaStudentData>;
  messages: WilmaMessage[];
  unreadCount: number;
}

/**
 * Päikyn tyypit peilaavat palvelimen tuottamaa muotoa (server/src/providers/paikky.ts).
 *
 * Kellonajat ovat jo valmiiksi Europe/Helsinki -paikallista aikaa muodossa
 * "HH:MM" — palvelin on tehnyt muunnoksen, koska Päikyn kalenteri antaa
 * UTC-ISO-aikoja ja saldo paikallisia merkkijonoja (ks. docs/paikky-rajapinta.md).
 * Selaimessa EI siis tehdä aikavyöhykemuunnoksia näille kentille.
 */
export interface PaikkyChild {
  id: string;
  firstName: string;
  lastName: string;
}

export interface PaikkyTimeRange {
  type: string;
  from: string;
  /** Null = alkuaika tiedossa mutta loppuaika ei (esim. kesken oleva päivä). */
  to: string | null;
}

export interface PaikkyDay {
  /** "YYYY-MM-DD" */
  date: string;
  /**
   * "unknown" = palvelin ei tunnistanut Päikyn antamaa tyyppiä. Se on oma
   * arvonsa eikä vaivu "unplannableksi", koska tuntematon päivä ei saa
   * renderöityä rauhoittavana "ei hoitoa" -rivinä — ks. PaikkyCareDays.vue.
   */
  type: "past" | "current" | "locked" | "plannable" | "unplannable" | "unknown";
  /** Tyhjä = ei hoitoa kyseisenä päivänä. */
  planned: PaikkyTimeRange[];
  /** Esim. "SCHEDULED_DAY_OFF". Tuntematon arvo näytetään sellaisenaan, ei piiloteta. */
  markingType: string | null;
  needsAttention: boolean;
  /**
   * Milloin varaus lukittuu. ISO-8601 UTC-aikaleima — HUOM: eri muoto kuin
   * from/to-kentät, jotka ovat paikallisia "HH:MM"-merkkijonoja.
   */
  lockingAt: string | null;
}

/**
 * Toteuma ja suunnitelma ovat tässä eri kentissä, eivätkä ne saa sekoittua
 * käyttöliittymässä: `planned` on VARAUS, `status`/`presentFrom` on se mitä
 * oikeasti tapahtui. Sairaana kotona oleva lapsi tuottaa varauksen ilman
 * statusta, joten varatun ajan näyttäminen läsnäolona olisi suoraan väärä
 * tieto seinällä.
 *
 * Uloskirjausaikaa ei ole: se olisi vaatinut oman balance-kutsunsa ja
 * valmistuisi vasta illalla, joten `LEFT_FOR_TODAY` näytetään ilman kelloa.
 */
export interface PaikkyToday {
  date: string;
  /** "PRESENT" | "NOT_PRESENT" | "LEFT_FOR_TODAY" | poissaolotyyppi. Null = ei tiedossa. */
  status: string | null;
  /** Toteutunut sisäänkirjaus, "HH:MM". Ainoa "paikalla nyt" -lähde. */
  presentFrom: string | null;
  /** Varaus, ei toteuma. */
  planned: PaikkyTimeRange[];
}

export interface PaikkyChildData {
  child: PaikkyChild;
  days: PaikkyDay[];
  /** Null jos kuluvasta päivästä ei ole tietoa (viikonloppu, sulku, hakuvirhe). */
  today: PaikkyToday | null;
}

export interface PaikkyMessage {
  id: string;
  /** "message" | "bulletin" | "answered-form" | "unanswered-form" — ei suljettu joukko. */
  type: string;
  title: string;
  sender: string | null;
  sentAt: string | null;
  /** Null = lukutila ei ole tiedossa. Eri asia kuin "luettu" — ks. WilmaMessage.unread. */
  unread: boolean | null;
  preview: string | null;
  /** Tämän näytön oma kirjanpito, sama kuin Wilmalla. Vain paikallisessa pyynnössä. */
  localRead?: boolean;
}

export interface PaikkyData {
  children: PaikkyChildData[];
  messages: PaikkyMessage[];
  /**
   * Viestihaun virhe silloin kun hoitoajat onnistuivat. null = ei virhettä.
   * Näytetään VAIN viestivälilehdellä: hoitoajat ovat tässä tilanteessa
   * kunnossa, eikä toimivan datan päälle kuulu virheilmoitusta.
   */
  messagesError: string | null;
}

export interface Note {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

/** Pidettävä samana kuin server/src/core/settings.ts. */
export const GRID_COLUMNS = 6;
export const GRID_ROWS = 8;

/**
 * Tätä pienempi paneeli leikkaisi sisältönsä piiloon otsikkoa ja
 * "vanhentunut"-merkkiä myöten, jolloin rikkinäistä lähdettä ei enää huomaisi.
 * Palvelin torjuu tätä pienemmät myös rajapinnassa.
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
  /** 1-pohjainen, inklusiivinen. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export type PanelLayout = Record<PanelId, PanelPlacement>;

export const PANEL_TITLES: Record<PanelId, string> = {
  schedule: "Lukujärjestys",
  messages: "Wilma-viestit",
  weather: "Sää",
  electricity: "Pörssisähkö",
  calendar: "Kalenteri",
  notes: "Muistilista",
};

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
 * hälytyksessä. Pidettävä samana kuin server/src/core/settings.ts:n
 * AlarmAnchor.
 */
export type AlarmAnchor = "schoolStart" | "breakfast";

/**
 * Yhden viikonpäivän sääntö relative-tilan hälytykselle — viikonpäivä
 * (Date.getDayn numerointi, 0 = sunnuntai … 6 = lauantai) kantaa mukanaan
 * sinä päivänä käytettävän ankkurin. Pidettävä samana kuin
 * server/src/core/settings.ts:n AlarmWeekdayRule.
 */
export interface AlarmWeekdayRule {
  weekday: number;
  anchor: AlarmAnchor;
}

/**
 * Kahden toisensa poissulkevan hälytystyypin unioni: `fixed` ei seuraa
 * mitään (ei minuutteja, ei oppilasta, ei ankkuria), `relative` ei tunne
 * kellonaikaa. Pidettävä samana kuin server/src/core/settings.ts:n
 * AlarmTrigger.
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
 * Koulukello. Pidettävä samana kuin server/src/core/settings.ts:n Alarm.
 */
export interface Alarm {
  id: string;
  label: string;
  trigger: AlarmTrigger;
  enabled: boolean;
  /**
   * Äänen tunniste, ei tiedostopolku — ks. alarmSounds.ts. Kenttä ei ole
   * suljettu enum, jotta oma äänitiedosto voidaan lisätä myöhemmin samaan
   * paikkaan ilman skeemamuutosta.
   */
  soundId: string;
  /** 0–1. */
  volume: number;
  /** Montako kertaa ääni toistetaan laukeamisen yhteydessä. */
  repeatCount: number;
}

export interface Settings {
  visibleStudents: string[] | null;
  /** Päikyn näytettävät lapset. null = kaikki. Arvot ovat PaikkyChild.id. */
  visiblePaikkyChildren: string[] | null;
  scheduleLayout: "single" | "split";
  rolloverTime: string;
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
  /**
   * Aamupalan alkuaika, "HH:MM" paikallista aikaa. Yksi globaali asetus —
   * ei hälytys- eikä lapsikohtainen.
   */
  breakfastTime: string;
  /** Null = ei koskaan muokattu, käytetään oletusasettelua. */
  panelLayout: PanelLayout | null;
  alarms: Alarm[];
  /**
   * Sään sijainti postinumerona. null = käytetään .env:n arvoja.
   *
   * Palvelimen etusijajärjestys on asetus > .env-postinumero >
   * .env-koordinaatit > oletus, joten `null` EI tarkoita "ei sijaintia" vaan
   * "sijainti tulee .env:stä" — ks. SettingsPanel.vue, joka näyttää nykyisen
   * sijainnin ja sen lähteen erikseen tämän kentän arvosta riippumatta.
   */
  weatherPostalCode: string | null;
}

export interface Dashboard {
  generatedAt: string;
  timezone: string;
  place: string;
  settings: Settings;
  notes: Note[];
  localClient: boolean;
  providers: {
    electricity?: ProviderSnapshot<ElectricityData>;
    wilma?: ProviderSnapshot<WilmaData>;
    /** Puuttuu kokonaan jos Päikkyä ei ole konfiguroitu — kortit piilottavat välilehdet silloin. */
    paikky?: ProviderSnapshot<PaikkyData>;
    [key: string]: ProviderSnapshot<unknown> | undefined;
  };
}
