import { computed, type Ref } from "vue";
import type { ScheduleLesson, WilmaData } from "../types";

const MAX_LOOKAHEAD_DAYS = 10;

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shift(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

function minutesOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface ScheduleDay {
  /** The date actually shown, which is not always today or tomorrow. */
  date: string;
  /** "Tänään", "Huomenna" or a weekday name — always explicit on screen. */
  label: string;
  /**
   * True only when the configured time of day actually changed which day is on
   * screen. Skipping an empty weekend is a different reason and must not claim
   * the clock did it — and during a holiday, when the next lessons are days
   * away either way, the rollover changes nothing and says nothing.
   */
  rolledOver: boolean;
  lessonsByStudent: Array<{ studentNumber: string; name: string; lessons: ScheduleLesson[] }>;
  totalLessons: number;
}

const WEEKDAYS = [
  "sunnuntaina",
  "maanantaina",
  "tiistaina",
  "keskiviikkona",
  "torstaina",
  "perjantaina",
  "lauantaina",
];

function describe(target: string, today: string): string {
  if (target === today) return "Tänään";
  if (target === shift(today, 1)) return "Huomenna";
  const [y, m, d] = target.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const weekday = WEEKDAYS[date.getDay()] ?? "";
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`;
}

function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d}.${m}.`;
}

/**
 * Decides which day's lessons the wall display shows.
 *
 * Before the configured rollover time it is today; after it, the next day. If
 * that day has no lessons at all — a weekend, a holiday — the view skips
 * forward to the next day that does, so the card is never just empty.
 */
export function useScheduleDay(
  wilma: Ref<WilmaData | null>,
  now: Ref<Date>,
  rolloverTime: Ref<string>,
  visibleStudents: Ref<string[] | null>,
) {
  const students = computed(() => {
    const data = wilma.value;
    if (!data) return [];
    const allowed = visibleStudents.value;
    return data.students.filter(
      (student) => allowed === null || allowed.length === 0 || allowed.includes(student.studentNumber),
    );
  });

  const day = computed<ScheduleDay | null>(() => {
    const data = wilma.value;
    if (!data || students.value.length === 0) return null;

    const today = dateKey(now.value);
    const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
    const pastRolloverTime = nowMinutes >= minutesOfDay(rolloverTime.value);

    const lessonsOn = (date: string) =>
      students.value.map((student) => ({
        studentNumber: student.studentNumber,
        name: student.name,
        lessons: (data.byStudent[student.studentNumber]?.lessons ?? []).filter(
          (lesson) => lesson.date === date,
        ),
      }));

    // Walk forward until a day with lessons is found. Falling back to the
    // starting day keeps the header honest when the whole window is empty
    // (school holidays), instead of silently showing a date weeks away.
    const firstDayWithLessons = (from: string): string => {
      for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
        const candidate = shift(from, offset);
        if (lessonsOn(candidate).some((entry) => entry.lessons.length > 0)) return candidate;
      }
      return from;
    };

    const shown = firstDayWithLessons(pastRolloverTime ? shift(today, 1) : today);

    // The hint on the card claims the clock moved the view. That is only true
    // if it did: on a holiday the next lessons are the same days away whether
    // the rollover has happened or not, and saying otherwise is a small lie
    // that makes the display harder to trust.
    const rolledOver = pastRolloverTime && shown !== firstDayWithLessons(today);

    const grouped = lessonsOn(shown);
    return {
      date: shown,
      label: `${describe(shown, today)} ${shortDate(shown)}`,
      rolledOver,
      lessonsByStudent: grouped,
      totalLessons: grouped.reduce((sum, entry) => sum + entry.lessons.length, 0),
    };
  });

  return { day, students };
}
