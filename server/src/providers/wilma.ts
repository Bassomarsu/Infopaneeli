import {
  APIError,
  AuthenticationError,
  MfaRequiredError,
  WilmaClient,
  type HomeworkItem,
  type Message,
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
  senderName: string | null;
  unread: boolean;
  /** Plain-text body, fetched once per message and then reused from cache. */
  content: string | null;
  studentNumber: string;
}

export interface WilmaStudentData {
  student: WilmaStudent;
  lessons: ScheduleLesson[];
  homework: HomeworkItem[];
  upcomingExams: UpcomingExam[];
  /** Dates (YYYY-MM-DD) the lesson data is known to cover. */
  coveredDates: string[];
}

export interface WilmaData {
  students: WilmaStudent[];
  byStudent: Record<string, WilmaStudentData>;
  messages: WilmaMessage[];
  unreadCount: number;
}

/** How many message bodies to pull per cycle for messages we have not seen. */
const MAX_NEW_BODIES_PER_CYCLE = 5;

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
 * Wilma's `status` field is not documented. Everything observed so far uses a
 * non-zero value for messages that have been opened, so an absent or zero
 * status is treated as unread — erring towards showing the badge rather than
 * hiding a message nobody has read.
 */
function isUnread(message: Message): boolean {
  const status = message.status;
  return status === null || status === undefined || status === 0;
}

async function fetchStudent(
  student: StudentInfo,
  previous: WilmaData | null,
): Promise<{ data: WilmaStudentData; messages: WilmaMessage[] }> {
  const client = await pool.clientFor(student.studentNumber);

  // One request covers schedule, homework and exams for the current week.
  const overview = await client.overview.get();
  const lessons = [...overview.schedule];
  const covered = new Set(lessons.map((lesson) => lesson.date));

  const today = localDateKey();
  covered.add(today);

  // Both today and the next school day have to be cached before the midday
  // rollover, or the switch itself would trigger a Wilma request. If nothing
  // in the current week falls after today — a Friday — the next school day is
  // in the following week. One extra request, once a week.
  const needsNextWeek = !lessons.some((lesson) => lesson.date > today);
  if (needsNextWeek) {
    const nextWeek = shiftDateKey(today, 7);
    const extra = await client.schedule.list({ date: toFinnishDate(nextWeek) });
    for (const lesson of extra) {
      if (!lessons.some((l) => l.date === lesson.date && l.start === lesson.start && l.subject === lesson.subject)) {
        lessons.push(lesson);
      }
      covered.add(lesson.date);
    }
    logger.debug(
      { event: "wilma_next_week", student: student.studentNumber, date: nextWeek, lessons: extra.length },
      "fetched next week's schedule",
    );
  }

  lessons.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

  const rawMessages = await client.messages.list("inbox");
  const messages = await withBodies(client, rawMessages, student.studentNumber, previous);

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
      lessons,
      homework: overview.homework,
      upcomingExams: overview.upcomingExams,
      coveredDates: [...covered].sort(),
    },
    messages,
  };
}

/**
 * Message bodies are a separate request each, so they are fetched once and
 * then carried forward from the previous payload. Without this the provider
 * would re-download every visible message every cycle.
 */
async function withBodies(
  client: WilmaClient,
  raw: Message[],
  studentNumber: string,
  previous: WilmaData | null,
): Promise<WilmaMessage[]> {
  const knownBodies = new Map<number, string | null>();
  for (const message of previous?.messages ?? []) {
    if (message.content !== null) knownBodies.set(message.id, message.content);
  }

  const messages: WilmaMessage[] = raw.slice(0, 20).map((message) => ({
    id: message.wilmaId,
    subject: message.subject,
    sentAt: message.sentAt instanceof Date ? message.sentAt.toISOString() : String(message.sentAt),
    senderName: message.senderName ?? null,
    unread: isUnread(message),
    content: knownBodies.get(message.wilmaId) ?? null,
    studentNumber,
  }));

  let fetched = 0;
  for (const message of messages) {
    if (message.content !== null || fetched >= MAX_NEW_BODIES_PER_CYCLE) continue;
    try {
      const full = await client.messages.get(message.id);
      message.content = stripHtml(full.content ?? "");
      fetched += 1;
    } catch (err) {
      // A single unreadable message must not fail the whole provider.
      logger.debug({ event: "wilma_body_failed", messageId: message.id, err }, "message body fetch failed");
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
      const result = await fetchStudent(student, previous);
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
      unreadCount: messages.filter((m) => m.unread).length,
    };
  } catch (err) {
    const translated = translateError(err);
    // A dead session cannot be repaired by retrying with the same client.
    if (translated instanceof FatalProviderError || err instanceof APIError) pool.reset();
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
