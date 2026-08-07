import {
  APIError,
  AuthenticationError,
  MfaRequiredError,
  WilmaClient,
  type HomeworkItem,
  type Message,
  type OverviewData,
  type ScheduleLesson,
  type StudentInfo,
  type UpcomingExam,
  type WilmaProfile,
} from "@wilm-ai/wilma-client";
import { config, isWilmaConfigured } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { FatalProviderError, Provider } from "../core/provider.ts";
import { localDateKey, localParts, shiftDateKey, toFinnishDate } from "../core/time.ts";

export interface WilmaStudent {
  studentNumber: string;
  name: string;
}

export interface WilmaMessage {
  id: number;
  subject: string;
  sentAt: string;
  /** Null until the message detail has been fetched — the list does not carry it. */
  senderName: string | null;
  /** Null means "not known yet", which is different from "read". */
  unread: boolean | null;
  /** Plain-text body, fetched once per message and then reused from cache. */
  content: string | null;
  /** When the detail was last read from Wilma, so the read state can be refreshed. */
  detailCheckedAt: string | null;
  studentNumber: string;
}

export interface WilmaStudentData {
  student: WilmaStudent;
  lessons: ScheduleLesson[];
  homework: HomeworkItem[];
  upcomingExams: UpcomingExam[];
  /** Dates (YYYY-MM-DD) the lesson data is known to cover. */
  coveredDates: string[];
  /** Last time the following week was queried, regardless of whether it had lessons. */
  nextWeekCheckedAt: string | null;
}

export interface WilmaData {
  students: WilmaStudent[];
  byStudent: Record<string, WilmaStudentData>;
  messages: WilmaMessage[];
  unreadCount: number;
}

/** How many message details to pull per cycle for messages we have not seen. */
const MAX_NEW_DETAILS_PER_CYCLE = 8;

/**
 * Messages still marked unread are re-checked occasionally so the badge does
 * not keep counting something that was read on a phone hours ago. Capped hard,
 * because this is the one request that would otherwise repeat forever.
 */
const MAX_RECHECKS_PER_CYCLE = 3;
const RECHECK_AFTER_MS = 60 * 60 * 1000;

/** How long a "next week" lookup is trusted before it is worth asking again. */
const NEXT_WEEK_TTL_MS = 6 * 60 * 60 * 1000;

/** Gap between per-child requests so the school server never sees a burst. */
const STUDENT_STAGGER_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function profileFor(studentNumber?: string): WilmaProfile {
  return {
    baseUrl: config.wilma.baseUrl,
    username: config.wilma.username,
    password: config.wilma.password,
    studentNumber: studentNumber ?? null,
    debug: config.debugMode,
  };
}

/**
 * A wrong password retried in a loop is the fastest way to lock the whole
 * family out of Wilma, so authentication problems are marked fatal and the
 * provider's circuit breaker stops after three of them. Everything else is a
 * transient error and gets the normal backoff.
 */
function translateError(err: unknown): Error {
  if (err instanceof AuthenticationError) {
    return new FatalProviderError(
      "AuthenticationError",
      "Wilma-kirjautuminen epäonnistui. Tarkista käyttäjätunnus ja salasana.",
    );
  }
  if (err instanceof MfaRequiredError) {
    return new FatalProviderError(
      "MfaRequiredError",
      "Wilma vaatii kaksivaiheisen tunnistautumisen, jota infonäyttö ei tue.",
    );
  }
  if (err instanceof APIError) {
    return new Error(`Wilma vastasi virheellä HTTP ${err.status}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The library's cookie jar lives in memory only and its session re-logs in on
 * a 401, so clients are created once and kept for the lifetime of the process.
 * Recreating them per fetch would mean a login request every cycle.
 */
class WilmaClientPool {
  private students: StudentInfo[] | null = null;
  private readonly clients = new Map<string, WilmaClient>();

  async listStudents(): Promise<StudentInfo[]> {
    if (this.students) return this.students;
    this.students = await WilmaClient.listStudents(profileFor());
    logger.debug(
      { event: "wilma_students", count: this.students.length },
      "resolved Wilma students",
    );
    return this.students;
  }

  async clientFor(studentNumber: string): Promise<WilmaClient> {
    const existing = this.clients.get(studentNumber);
    if (existing) return existing;
    const client = await WilmaClient.login(profileFor(studentNumber));
    this.clients.set(studentNumber, client);
    return client;
  }

  /** Drops cached sessions so the next cycle logs in again. */
  reset(): void {
    this.students = null;
    this.clients.clear();
  }
}

const pool = new WilmaClientPool();

/**
 * Only the message *detail* carries a status; the list parser never sets one.
 * Wilma's status values are undocumented, but a zero or absent value on a
 * detail response means the message has not been opened.
 */
function isUnread(detail: Message): boolean {
  const status = detail.status;
  return status === null || status === undefined || status === 0;
}

/**
 * The status interpretation above has never been confirmed against real data:
 * on the first live run both the inbox and the archive were empty. Getting it
 * backwards would fail *silently* — a genuinely unread message from the school
 * would render as read, no error, no log line, in exactly the feature the card
 * exists for.
 *
 * So every distinct status value is recorded once. When the first real message
 * finally arrives, the log answers the question by itself, without anyone
 * having to remember to run the smoke test at that moment. Bounded by the set:
 * a handful of lines per process lifetime, never one per cycle.
 */
const seenStatusValues = new Set<string>();

function noteStatusValue(detail: Message, messageId: number): void {
  const key = JSON.stringify(detail.status ?? null);
  if (seenStatusValues.has(key)) return;
  seenStatusValues.add(key);
  logger.warn(
    {
      event: "wilma_status_observed",
      status: detail.status ?? null,
      treatedAsUnread: isUnread(detail),
      messageId,
    },
    "first sighting of a Wilma message status value — confirms or refutes the unread rule",
  );
}

/**
 * Only the parts of `WilmaClient` this provider actually uses. Narrowing it
 * here is what makes the schedule and message logic testable without a live
 * Wilma to talk to.
 */
export interface WilmaClientLike {
  overview: { get: () => Promise<OverviewData> };
  schedule: { list: (opts?: { date?: string }) => Promise<ScheduleLesson[]> };
  messages: {
    list: (folder?: "inbox") => Promise<Message[]>;
    get: (messageId: number) => Promise<Message>;
  };
}

export async function fetchStudent(
  client: WilmaClientLike,
  student: StudentInfo,
  previous: WilmaData | null,
): Promise<{ data: WilmaStudentData; messages: WilmaMessage[] }> {
  // One request covers schedule, homework and exams for the current week.
  const overview = await client.overview.get();
  const lessons = [...overview.schedule];
  const covered = new Set(lessons.map((lesson) => lesson.date));

  const today = localDateKey();
  covered.add(today);

  const cached = previous?.byStudent[student.studentNumber] ?? null;
  const addLesson = (lesson: ScheduleLesson): void => {
    const duplicate = lessons.some(
      (l) => l.date === lesson.date && l.start === lesson.start && l.subject === lesson.subject,
    );
    if (!duplicate) lessons.push(lesson);
    covered.add(lesson.date);
  };

  // Both today and the next school day have to be cached before the midday
  // rollover, or the switch itself would trigger a Wilma request. When nothing
  // in the current week falls after today — a Friday, a weekend, a holiday —
  // the answer is in the following week.
  //
  // The lookup is throttled by time rather than by result: during a weekend or
  // a school holiday the "is there anything after today" test is true on every
  // single cycle, so keying off the result alone would re-ask every 20 minutes
  // for days on end, including through the whole summer when the answer is
  // always "nothing".
  let nextWeekCheckedAt = cached?.nextWeekCheckedAt ?? null;
  const needsFutureDays = !lessons.some((lesson) => lesson.date > today);

  if (needsFutureDays) {
    // Reuse what the previous cycle already learned about days after today.
    for (const lesson of cached?.lessons ?? []) {
      if (lesson.date > today) addLesson(lesson);
    }

    const age = nextWeekCheckedAt === null ? Infinity : Date.now() - new Date(nextWeekCheckedAt).getTime();
    if (age > NEXT_WEEK_TTL_MS) {
      const nextWeek = shiftDateKey(today, 7);
      const extra = await client.schedule.list({ date: toFinnishDate(nextWeek) });
      for (const lesson of extra) addLesson(lesson);
      nextWeekCheckedAt = new Date().toISOString();
      logger.debug(
        { event: "wilma_next_week", student: student.studentNumber, date: nextWeek, lessons: extra.length },
        "fetched next week's schedule",
      );
    }
  }

  // Anything already in the past is noise on a display that only ever shows
  // today or later, and dropping it stops the carried-forward set from growing.
  const pruned = lessons.filter((lesson) => lesson.date >= today);
  pruned.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

  const rawMessages = await client.messages.list("inbox");
  const messages = await withDetails(client, rawMessages, student.studentNumber, previous);

  // An empty parse with no HTTP error is the signature a Wilma update leaves
  // behind, and it is easy to miss unless it is called out explicitly.
  if (lessons.length === 0) {
    logger.error(
      {
        event: "wilma_empty_parse",
        provider: "wilma",
        method: "overview.get",
        student: student.studentNumber,
        baseUrl: config.wilma.baseUrl,
        expected: "one or more lessons",
        received: 0,
      },
      "Wilma returned no lessons — the page structure may have changed",
    );
  }

  return {
    data: {
      student: { studentNumber: student.studentNumber, name: student.name },
      lessons: pruned,
      homework: overview.homework,
      upcomingExams: overview.upcomingExams,
      coveredDates: [...covered].sort(),
      nextWeekCheckedAt,
    },
    messages,
  };
}

/**
 * The inbox listing only yields id, subject and timestamp — sender and read
 * state exist solely on the per-message detail. So the detail is fetched once
 * per message, carried forward between cycles, and re-checked only while the
 * message still counts as unread.
 */
async function withDetails(
  client: WilmaClientLike,
  raw: Message[],
  studentNumber: string,
  previous: WilmaData | null,
): Promise<WilmaMessage[]> {
  const known = new Map<number, WilmaMessage>();
  for (const message of previous?.messages ?? []) known.set(message.id, message);

  const messages: WilmaMessage[] = raw.slice(0, 20).map((message) => {
    const cached = known.get(message.wilmaId);
    return {
      id: message.wilmaId,
      subject: message.subject,
      sentAt: message.sentAt instanceof Date ? message.sentAt.toISOString() : String(message.sentAt),
      senderName: cached?.senderName ?? null,
      unread: cached?.unread ?? null,
      content: cached?.content ?? null,
      detailCheckedAt: cached?.detailCheckedAt ?? null,
      studentNumber,
    };
  });

  const now = Date.now();
  let fetched = 0;
  let rechecked = 0;

  for (const message of messages) {
    const neverFetched = message.detailCheckedAt === null;
    const staleUnread =
      !neverFetched &&
      message.unread === true &&
      now - new Date(message.detailCheckedAt ?? 0).getTime() > RECHECK_AFTER_MS;

    if (neverFetched && fetched >= MAX_NEW_DETAILS_PER_CYCLE) continue;
    if (!neverFetched && (!staleUnread || rechecked >= MAX_RECHECKS_PER_CYCLE)) continue;

    try {
      const detail = await client.messages.get(message.id);
      noteStatusValue(detail, message.id);
      message.senderName = detail.senderName ?? message.senderName;
      message.unread = isUnread(detail);
      message.content = stripHtml(detail.content ?? "");
      message.detailCheckedAt = new Date().toISOString();
      if (neverFetched) fetched += 1;
      else rechecked += 1;
    } catch (err) {
      // A single unreadable message must not fail the whole provider.
      logger.debug({ event: "wilma_detail_failed", messageId: message.id, err }, "message detail fetch failed");
    }
  }

  return messages;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchWilma(previous: WilmaData | null): Promise<WilmaData> {
  if (!isWilmaConfigured()) {
    throw new FatalProviderError(
      "NotConfigured",
      "Wilma-tunnuksia ei ole asetettu. Täytä WILMA_* arvot .env-tiedostoon.",
    );
  }

  try {
    const students = await pool.listStudents();
    if (students.length === 0) {
      throw new Error("Wilmasta ei löytynyt yhtään oppilasta");
    }

    const byStudent: Record<string, WilmaStudentData> = {};
    const allMessages: WilmaMessage[] = [];

    // Sequential with a gap: never two concurrent requests to the school.
    for (const [index, student] of students.entries()) {
      if (index > 0) await sleep(STUDENT_STAGGER_MS);
      const client = await pool.clientFor(student.studentNumber);
      const result = await fetchStudent(client, student, previous);
      byStudent[student.studentNumber] = result.data;
      allMessages.push(...result.messages);
    }

    // A guardian often sees the same message under every child.
    const seen = new Set<number>();
    const messages = allMessages
      .filter((message) => (seen.has(message.id) ? false : (seen.add(message.id), true)))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));

    return {
      students: students.map((s) => ({ studentNumber: s.studentNumber, name: s.name })),
      byStudent,
      messages,
      // Counts only what is actually known to be unread; a message whose
      // detail has not been read yet is not guessed at in either direction.
      unreadCount: messages.filter((m) => m.unread === true).length,
    };
  } catch (err) {
    const translated = translateError(err);
    // Only an authentication failure means the session is genuinely dead. A
    // 500, a 429 or a stray 404 leaves it perfectly usable, and dropping the
    // pool there would turn one transient error into a fresh login for the
    // student list plus one per child on the next cycle — a relogin burst at
    // exactly the moment Wilma is already struggling or rate limiting.
    if (translated instanceof FatalProviderError) pool.reset();
    throw translated;
  }
}

/** Wilma is not polled overnight; nothing changes and the traffic is pointless. */
function outsideQuietHours(now: Date): boolean {
  const { hour } = localParts(now);
  return hour >= 5 && hour < 23;
}

export function createWilmaProvider(): Provider<WilmaData> {
  // The provider needs its own previous payload to reuse message bodies, so
  // the snapshot is read back from the instance on each cycle.
  const provider: Provider<WilmaData> = new Provider<WilmaData>({
    id: "wilma",
    intervalMs: 20 * 60 * 1000,
    initialDelayMs: 2_000,
    // Generous, because one cycle walks every child sequentially with a gap
    // between them and may pull a few message bodies along the way.
    timeoutMs: 4 * 60 * 1000,
    shouldRun: outsideQuietHours,
    fetch: () => fetchWilma(provider.snapshot().data),
  });
  return provider;
}
