import { computed, ref, type Ref } from "vue";
import type { ScheduleLesson, WilmaData } from "../types";

const MAX_LOOKAHEAD_DAYS = 10;

/**
 * Selaustila palautuu automaattivalintaan tämän ajan kuluttua viimeisestä
 * kosketuksesta.
 *
 * Kosketushetken aikaleima otetaan tarkoituksella kellosykkeestä (`now.value`),
 * ei koneen omasta kellosta (`new Date()`), vaikka `now` päivittyy vain 20
 * sekunnin välein (`useClock`) ja aikaleima voi siis olla juuri sen verran
 * vanha. Tämä on tietoinen valinta: yksi kellolähde koko composablessa pitää
 * `browsing`-tilan sisäisesti johdonmukaisena ja testattavana, eikä ole
 * riippuvainen siitä mitä oikea seinäkello sanoo — jos `now` joskus jäätyy tai
 * sitä siirretään, selaus ei jää kahden eri ajan väliin roikkumaan. Käytännön
 * vaikutus on merkityksetön: ikkuna on 5 min ± yksi kellosykli, ei havaittavissa
 * seinänäytöltä. Älä korjaa tätä ottamalla `new Date()` käyttöön — se on jo
 * kokeiltu ja peruutettu, koska se sekoittaa kaksi kelloa keskenään ja rikkoo
 * testit, joissa `now` on tarkoituksella eri aikaa kuin koneen oma kello.
 */
const BROWSE_RESET_MS = 5 * 60 * 1000;

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
   * away either way, the rollover changes nothing and says nothing. Always
   * false while the user is browsing: they picked the day, not the clock.
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
 * Decides which day's lessons the wall display shows, and lets the touch
 * screen browse away from that choice without losing it — the automatic pick
 * is always what browsing starts from and always what it falls back to.
 *
 * Before the configured rollover time it is today; after it, the next day. If
 * that day has no lessons at all — a weekend, a holiday — the automatic view
 * skips forward to the next day that does, so the card is never just empty.
 * Manual browsing does the opposite on purpose: it moves one day at a time,
 * including empty ones, because a "next" button that silently jumps past days
 * feels broken.
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

  const todayKey = computed(() => dateKey(now.value));

  const lessonsOn = (date: string) => {
    const data = wilma.value;
    if (!data) return [];
    return students.value.map((student) => ({
      studentNumber: student.studentNumber,
      name: student.name,
      lessons: (data.byStudent[student.studentNumber]?.lessons ?? []).filter(
        (lesson) => lesson.date === date,
      ),
    }));
  };

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

  const autoShown = computed(() => {
    const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
    const pastRolloverTime = nowMinutes >= minutesOfDay(rolloverTime.value);
    return firstDayWithLessons(pastRolloverTime ? shift(todayKey.value, 1) : todayKey.value);
  });

  // The hint on the card claims the clock moved the view. That is only true
  // if it did: on a holiday the next lessons are the same days away whether
  // the rollover has happened or not, and saying otherwise is a small lie
  // that makes the display harder to trust.
  const autoRolledOver = computed(() => {
    const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
    const pastRolloverTime = nowMinutes >= minutesOfDay(rolloverTime.value);
    return pastRolloverTime && autoShown.value !== firstDayWithLessons(todayKey.value);
  });

  // The last date Wilma has actually told us anything about, across every
  // visible student. Browsing forward stops here instead of wandering into
  // weeks the server never fetched, which would just be empty forever.
  const maxKnownDate = computed<string | null>(() => {
    const data = wilma.value;
    if (!data) return null;
    let max: string | null = null;
    for (const student of students.value) {
      const entry = data.byStudent[student.studentNumber];
      if (!entry) continue;
      for (const lesson of entry.lessons) {
        if (max === null || lesson.date > max) max = lesson.date;
      }
      for (const covered of entry.coveredDates) {
        if (max === null || covered > max) max = covered;
      }
    }
    return max;
  });

  // null = automatic. Once set, this is an explicit date the user picked and
  // it stays shown regardless of what the automatic pick would be.
  const browseDate = ref<string | null>(null);
  const lastInteractionAt = ref<Date | null>(null);

  const browsing = computed(() => {
    if (browseDate.value === null || lastInteractionAt.value === null) return false;
    return now.value.getTime() - lastInteractionAt.value.getTime() < BROWSE_RESET_MS;
  });

  // What is currently on screen, whether that came from the clock or from a
  // touch. Navigation always steps from here, so "next" after an automatic
  // weekend-skip moves one day past what is actually shown, not past today.
  const displayedDate = computed(() => (browsing.value ? (browseDate.value as string) : autoShown.value));

  const canGoBack = computed(() => shift(displayedDate.value, -1) >= todayKey.value);
  const canGoForward = computed(() => {
    const known = maxKnownDate.value;
    if (known === null) return false;
    return shift(displayedDate.value, 1) <= known;
  });

  function goToPreviousDay(): void {
    if (!canGoBack.value) return;
    browseDate.value = shift(displayedDate.value, -1);
    lastInteractionAt.value = now.value;
  }

  function goToNextDay(): void {
    if (!canGoForward.value) return;
    browseDate.value = shift(displayedDate.value, 1);
    lastInteractionAt.value = now.value;
  }

  /** Palaa heti automaattivalintaan, esim. "Tänään"-painikkeesta. */
  function returnToToday(): void {
    browseDate.value = null;
    lastInteractionAt.value = null;
  }

  const day = computed<ScheduleDay | null>(() => {
    const data = wilma.value;
    if (!data || students.value.length === 0) return null;

    const shown = displayedDate.value;
    const rolledOver = browsing.value ? false : autoRolledOver.value;

    const grouped = lessonsOn(shown);
    return {
      date: shown,
      label: `${describe(shown, todayKey.value)} ${shortDate(shown)}`,
      rolledOver,
      lessonsByStudent: grouped,
      totalLessons: grouped.reduce((sum, entry) => sum + entry.lessons.length, 0),
    };
  });

  return {
    day,
    students,
    browsing,
    canGoBack,
    canGoForward,
    goToPreviousDay,
    goToNextDay,
    returnToToday,
  };
}

/** Kortti ottaa koko composablen propsina, joten sen muoto on osa rajapintaa. */
export type UseScheduleDay = ReturnType<typeof useScheduleDay>;
