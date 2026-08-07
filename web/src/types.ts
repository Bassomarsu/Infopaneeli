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

export interface ElectricityData {
  unit: string;
  today: PriceDay | null;
  tomorrow: PriceDay | null;
  tomorrowAvailable: boolean;
  currentPrice: number | null;
  currentHour: number;
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
  /** Null means "not known yet", which is different from "read". */
  unread: boolean | null;
  content: string | null;
  detailCheckedAt: string | null;
  studentNumber: string;
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

export interface Settings {
  visibleStudents: string[] | null;
  scheduleLayout: "single" | "split";
  rolloverTime: string;
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
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
