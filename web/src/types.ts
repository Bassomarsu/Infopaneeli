/** `hidden` = the server withheld this payload because the client is not the display. */
export type ProviderStatus = "ok" | "stale" | "failed" | "idle" | "hidden";

export interface ProviderSnapshot<T> {
  id: string;
  status: ProviderStatus;
  data: T | null;
  fetchedAt: string | null;
  error: { type: string; message: string } | null;
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

export interface Settings {
  visibleStudents: string[] | null;
  scheduleLayout: "single" | "split";
  rolloverTime: string;
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
  /** Null = ei koskaan muokattu, käytetään oletusasettelua. */
  panelLayout: PanelLayout | null;
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
    [key: string]: ProviderSnapshot<unknown> | undefined;
  };
}
