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
/**
 * undici raportoi uudelleenohjaussilmukan pelkkänä `TypeError: fetch failed`
 * ja panee varsinaisen syyn — `redirect count exceeded` — `cause`-kenttään.
 * Kortti renderöi `error.message`n, joten ilman tätä seinällä luki vain
 * "fetch failed": juuri se teki tämän vian paikantamisesta työlästä. Ketju
 * kävellään läpi, koska syyllä voi olla oma syynsä.
 */
function describeError(err: Error): string {
  const parts = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    if (!parts.includes(cause.message)) parts.push(cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(": ");
}

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
    // The status stays in the message, but the *name* is what the provider
    // logs as `errorType`. Left as a plain Error it read "Error", which told
    // nobody afterwards whether the fetch died on an HTTP response or on
    // something else entirely.
    const wrapped = new Error(`Wilma vastasi virheellä HTTP ${err.status}`);
    wrapped.name = "APIError";
    return wrapped;
  }
  if (!(err instanceof Error)) return new Error(String(err));

  // Alkuperäinen pino säilytetään: se on se mitä loki tulostaa, ja siitä näkyy
  // missä kirjaston kutsussa vika oli.
  const described = describeError(err);
  if (described === err.message) return err;
  const wrapped = new Error(described, { cause: err });
  wrapped.name = err.name;
  wrapped.stack = err.stack;
  return wrapped;
}

/**
 * A session that has sat unused for longer than this is assumed dead.
 *
 * Wilma expires an idle session at its own end, and it does not say so in a
 * way this code can recognise. `AuthenticationError` comes from a *login* that
 * fails, never from a request made with a session that has already gone: that
 * comes back as an HTTP error, or — worse — as the login page, which every
 * parser in the library reduces to an empty result without raising anything at
 * all. The age of the session is the only signal that is actually reliable.
 *
 * Quiet hours (23–05) leave the session untouched for over six hours, which is
 * why the first fetch of the morning failed and, with the dead session kept in
 * the pool, so did every fetch after it for the rest of the day.
 *
 * 90 min is four and a half normal cycles: long enough that a couple of failed
 * cycles in a row do not throw away a session that is still good, short enough
 * to catch the night with room to spare. The cost is one extra login round per
 * night — exactly what restarting the process already does every morning.
 */
const MAX_SESSION_IDLE_MS = 90 * 60 * 1000;

/**
 * Consecutive failed cycles after which the session is suspected rather than
 * the school's server. One failure is deliberately not enough — see
 * `noteFailure` for why that number is the whole safety argument.
 */
const RESET_AFTER_FAILURES = 2;

/** Why a session was dropped. Logged, so a repeat of this fault is readable. */
type SessionResetReason = "idle" | "failures" | "fatal" | "manual";

/**
 * Where sessions come from. The live implementation is the library; the tests
 * supply their own, which is what makes the reset rules testable without a
 * school server — and lets a test count logins, the number that decides
 * whether this code can lock the family's account.
 */
export interface WilmaSessionSource {
  listStudents: () => Promise<StudentInfo[]>;
  login: (studentNumber: string) => Promise<WilmaClientLike>;
}

const liveSessions: WilmaSessionSource = {
  listStudents: () => WilmaClient.listStudents(profileFor()),
  login: (studentNumber) => WilmaClient.login(profileFor(studentNumber)),
};

/**
 * The library's cookie jar lives in memory only, so clients are created once
 * and kept rather than rebuilt per fetch, which would mean a login request
 * every cycle.
 *
 * Keeping them *forever* was the other half of the fault: an expired session
 * is indistinguishable from a good one until it is used, and using it produces
 * an error the old code read as transient. So the pool now tracks when its
 * session was last used and drops it after an idle gap (`dropIfStale`) or on
 * repeated failures (`noteFailure`), instead of waiting for an error type that
 * never arrives.
 */
export class WilmaClientPool {
  private readonly source: WilmaSessionSource;
  private students: StudentInfo[] | null = null;
  private readonly clients = new Map<string, WilmaClientLike>();
  /** Last fetch attempt, including a session whose first data request failed. */
  private lastAttemptAt: number | null = null;
  private consecutiveFailures = 0;
  /** Stops a long outage from dropping a session once per cycle. */
  private droppedForThisFailureRun = false;
  /**
   * Kasvaa joka kierroksella ja pudotuksessa. `withTimeout` vapauttaa
   * kierroksen aikakatkaisussa muttei keskeytä sitä, joten hylätty kierros voi
   * palata vasta kun seuraava on jo kirjautunut sisään. Ilman tätä sen
   * myöhästynyt `noteFailure` pudottaisi tuoreen istunnon ja maksaisi
   * ylimääräisen kirjautumiskierroksen.
   */
  private generation = 0;

  constructor(source: WilmaSessionSource = liveSessions) {
    this.source = source;
  }

  async listStudents(generation: number): Promise<StudentInfo[]> {
    this.assertCurrent(generation);
    if (this.students) return this.students;
    const students = await this.loggingIn(() => this.source.listStudents());
    this.assertCurrent(generation);
    this.students = students;
    logger.debug(
      { event: "wilma_students", count: this.students.length },
      "resolved Wilma students",
    );
    return this.students;
  }

  async clientFor(studentNumber: string, generation: number): Promise<WilmaClientLike> {
    this.assertCurrent(generation);
    const existing = this.clients.get(studentNumber);
    if (existing) return existing;
    const client = await this.loggingIn(() => this.source.login(studentNumber));
    this.assertCurrent(generation);
    this.clients.set(studentNumber, client);
    return client;
  }

  /**
   * Epäonnistunut KIRJAUTUMINEN on ainoa virhe, jota ei saa yrittää uudelleen
   * normaalitahtiin, ja se on istuntojen pudottamisen hinta.
   *
   * Jokainen kierros, joka alkaa tyhjällä poolilla, alkaa kirjautumisella. Jos
   * kirjautuminen epäonnistuu, pooli ei täyty, joten seuraava kierros
   * kirjautuu taas — yksi yritys oppilaslistalle plus yksi per lapsi, 20
   * minuutin välein koko valveillaoloajan. Se on juuri se liikenne, joka
   * lukitsee perheen Wilma-tilin. Huomaa mikä tässä on nurinkurista: ENNEN
   * tätä korjausta kuollut istunto käytettiin uudelleen sellaisenaan, mikä
   * maksoi nolla kirjautumista — ja juuri siksi tili selvisi päiväkausista
   * tätä vikaa.
   *
   * Fataaliksi merkitseminen siirtää tahdituksen katkaisijalle
   * (core/provider.ts): kolme avaa sen, ja jäähdytys kasvaa 30 minuutista
   * neljään tuntiin. Tämä rajoittaa kierroksia, ei niiden sisäisiä pyyntöjä.
   *
   * Haun epäonnistumista ONNISTUNEEN kirjautumisen jälkeen ei eskaloida.
   * Asiakkaat ovat silloin välimuistissa, joten seuraavat kierrokset käyttävät
   * niitä eivätkä maksa yhtään kirjautumista.
   */
  private async loggingIn<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      const translated = translateError(err);
      if (translated instanceof FatalProviderError) throw translated;
      const fatal = new FatalProviderError(
        "LoginFailed",
        `Wilma-kirjautuminen ei onnistunut: ${translated.message}`,
      );
      fatal.stack = translated.stack;
      throw fatal;
    }
  }

  /**
   * Drops cached sessions so the next fetch logs in again. Silent no-op when
   * there is nothing cached — otherwise a source that stays broken would write
   * this line on every single cycle, which is the opposite of what a log with
   * one line per state change is for.
   */
  reset(reason: SessionResetReason, detail: Record<string, unknown> = {}): boolean {
    const had = this.students !== null || this.clients.size > 0;
    this.students = null;
    this.clients.clear();
    this.lastAttemptAt = null;
    this.generation += 1;
    if (!had) return false;
    logger.warn(
      { event: "wilma_session_reset", provider: "wilma", reason, ...detail },
      "Wilma-istunto pudotettu — seuraava haku kirjautuu uudelleen",
    );
    return true;
  }

  /** Runs before every fetch; see MAX_SESSION_IDLE_MS for why age is the test. */
  dropIfStale(now: number): void {
    if (this.lastAttemptAt === null) return;
    const idleMs = now - this.lastAttemptAt;
    if (idleMs <= MAX_SESSION_IDLE_MS) return;
    this.reset("idle", { idleMinutes: Math.round(idleMs / 60000) });
  }

  /** Uusi kierros syrjäyttää mahdollisen aikakatkaistun kierroksen. */
  beginFetch(now: number): number {
    this.dropIfStale(now);
    // Myös onnistuneen kirjautumisen jälkeinen epäonnistunut haku jättää
    // istunnon pooliin. Senkin on vanhennuttava yön yli, vaikka yksikään
    // haku ei olisi vielä onnistunut. Jatkuva häiriö normaalilla kysely-
    // välillä ei sen sijaan saa aiheuttaa uutta kirjautumista 90 min välein.
    this.lastAttemptAt = now;
    return ++this.generation;
  }

  /** Tarkistus myös awaitin jälkeen: vanha kirjautuminen ei saa täyttää poolia. */
  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new Error("Wilma-hakukierros on korvattu uudemmalla");
  }

  /** Onko kierros yhä se, jonka istunnolla pooli nyt on. */
  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  noteSuccess(generation: number): void {
    // Hylätyn kierroksen myöhästynyt onnistuminen ei saa merkitä nykyistä
    // istuntoa toimivaksi: se todistaa vain, että JOKIN istunto toimi joskus.
    if (!this.isCurrent(generation)) return;
    this.consecutiveFailures = 0;
    this.droppedForThisFailureRun = false;
  }

  noteFailure(error: Error, generation: number): void {
    // Hylätty kierros ei saa pudottaa istuntoa, jonka sitä seurannut kierros
    // on jo ehtinyt luoda.
    if (!this.isCurrent(generation)) return;
    this.consecutiveFailures += 1;

    // A failed login is the one case where the session is *known* to be
    // unusable, and hammering a wrong password in a loop is what locks the
    // whole family out — so it is dropped at once and the provider's circuit
    // breaker takes over the pacing from there.
    if (error instanceof FatalProviderError) {
      this.reset("fatal", { errorType: error.type });
      return;
    }

    // Everything else gets one more go on the same session. A single 500, a
    // 429 or a stray 404 leaves it perfectly usable, and dropping it there
    // would turn one transient error into a fresh login for the student list
    // plus one per child on the next cycle — a relogin burst at exactly the
    // moment Wilma is already struggling or rate limiting.
    //
    // A second consecutive failure is a different claim: whatever is wrong has
    // now outlived a full cycle, and a dead session explains that better than
    // an outage that happens to span two of them. The drop then happens once
    // per failure run and not once per cycle — afterwards the pool is empty,
    // so there is nothing left to drop until a fetch succeeds again.
    if (this.consecutiveFailures < RESET_AFTER_FAILURES || this.droppedForThisFailureRun) return;
    this.droppedForThisFailureRun = true;
    this.reset("failures", {
      consecutiveFailures: this.consecutiveFailures,
      errorType: error.name,
    });
  }
}

const pool = new WilmaClientPool();

/**
 * Read state, or `null` when Wilma did not tell us.
 *
 * Measured against a real message on 7.8.2026: `status` came back `null`, and
 * grepping the library confirms why — `parsers/messages.js` never assigns the
 * field at all, on either the list or the detail response. So the read state is
 * simply not available through this library today.
 *
 * The earlier rule ("absent means unread") therefore marked *every* message
 * unread forever: the badge could never return to zero, and the hourly
 * re-check for unread messages would re-fetch every message for the rest of
 * time — the exact pointless load this provider is built to avoid. Reporting
 * "not known" is both honest and cheap, and the card already renders it as
 * neither read nor unread.
 *
 * A number, if the library ever starts producing one, is interpreted the way
 * Wilma's own markup implies: zero means not opened.
 */
function isUnread(detail: Message): boolean | null {
  const status = detail.status;
  if (status === null || status === undefined) return null;
  return status === 0;
}

/**
 * Every distinct status value is recorded once, which is how the `null` above
 * was discovered in the first place. Keep it: a library update that starts
 * populating the field will announce itself here instead of silently changing
 * what the badge means. Bounded by the set — a handful of lines per process
 * lifetime, never one per cycle.
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

/**
 * One fetch cycle against a given pool. Split out from `fetchWilma` so the
 * session rules can be driven by a test with its own pool and its own clock;
 * the process only ever uses the module-level `pool` below.
 */
export async function runWilmaFetch(
  pool: WilmaClientPool,
  previous: WilmaData | null,
  now: () => number = Date.now,
): Promise<WilmaData> {
  // Before the request rather than after it fails. A session left over from
  // last night is already dead at Wilma's end and no amount of retrying
  // revives it, so the first fetch of the morning has to start from a new
  // login instead of discovering the problem several failed cycles later —
  // by which point the circuit breaker has stretched the next attempt to
  // hours away and the day is lost.
  const generation = pool.beginFetch(now());

  try {
    const students = await pool.listStudents(generation);
    if (students.length === 0) {
      throw new Error("Wilmasta ei löytynyt yhtään oppilasta");
    }

    const byStudent: Record<string, WilmaStudentData> = {};
    const allMessages: WilmaMessage[] = [];

    // Sequential with a gap: never two concurrent requests to the school.
    for (const [index, student] of students.entries()) {
      if (index > 0) await sleep(STUDENT_STAGGER_MS);
      const client = await pool.clientFor(student.studentNumber, generation);
      pool.assertCurrent(generation);
      const result = await fetchStudent(client, student, previous);
      pool.assertCurrent(generation);
      byStudent[student.studentNumber] = result.data;
      allMessages.push(...result.messages);
    }

    // A guardian often sees the same message under every child.
    const seen = new Set<number>();
    const messages = allMessages
      .filter((message) => (seen.has(message.id) ? false : (seen.add(message.id), true)))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));

    pool.noteSuccess(generation);

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
    // The pool decides whether this failure is worth a new login — see
    // `noteFailure`. Doing it there rather than here is what keeps the "one
    // transient error must not cause a relogin burst" rule in the same place
    // as the counter that enforces it.
    pool.noteFailure(translated, generation);
    throw translated;
  }
}

async function fetchWilma(previous: WilmaData | null): Promise<WilmaData> {
  if (!isWilmaConfigured()) {
    throw new FatalProviderError(
      "NotConfigured",
      "Wilma-tunnuksia ei ole asetettu. Täytä WILMA_* arvot .env-tiedostoon.",
    );
  }
  return runWilmaFetch(pool, previous);
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
    // "Testaa yhteys" on juuri tämän vian palautumispainike, joten sen on
    // pakko aloittaa puhtaalta pöydältä. Samalla kuolleella istunnolla se
    // epäonnistuisi täsmälleen samalla tavalla kuin automaattinen haku eikä
    // voisi määritelmällisesti auttaa siinä tilanteessa, jota varten se on
    // olemassa. Yksi kirjautumiskierros per painallus mahtuu rajoittimen
    // sisään (5 min väli, 12/vrk, ks. provider.ts:n manualTest).
    beforeManualTest: () => {
      pool.reset("manual");
    },
  });
  return provider;
}
