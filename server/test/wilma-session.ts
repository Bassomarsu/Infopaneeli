/**
 * Wilman istunnon elinkaari: milloin muistissa oleva istunto pudotetaan ja —
 * yhtä tärkeänä — milloin sitä EI saa pudottaa.
 *
 * Tausta on oikea vika seinänäytöltä: vuorokauden vaihduttua haku lakkasi
 * toimimasta eikä palautunut päivän aikana, ei myöskään asetusten "Testaa
 * yhteys" -painikkeesta. Vasta prosessin uudelleenkäynnistys auttoi. Syy oli
 * poolissa ikuisesti säilytetty istunto, jonka Wilma oli hiljaisten tuntien
 * (23–05) aikana vanhentanut omassa päässään. Vanhentunut istunto ei ilmoita
 * itsestään `AuthenticationError`ina — se tulee takaisin HTTP-virheenä tai
 * kirjautumissivuna, jonka kirjaston jäsentäjät pelkistävät tyhjäksi
 * tulokseksi — joten vanha "nollaa vain fataalista virheestä" -sääntö ei
 * osunut siihen koskaan.
 *
 * Korjauksen vastapaino on tilin lukituksen esto (docs/wilma.md, "Tilin lukituksen
 * esto"): jokainen nollaus tarkoittaa uutta kirjautumista oppilaslistalle ja
 * yhtä per lapsi. Siksi puolet näistä testeistä laskee kirjautumisia eikä
 * dataa.
 *
 * Aja:  npm run test:wilma-session --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { APIError, type Message, type OverviewData, type ScheduleLesson, type StudentInfo } from "@wilm-ai/wilma-client";
import { config } from "../src/core/config.ts";
import { FatalProviderError, Provider } from "../src/core/provider.ts";
import {
  WilmaClientPool,
  runWilmaFetch,
  type WilmaClientLike,
  type WilmaData,
  type WilmaSessionSource,
} from "../src/providers/wilma.ts";
import { localDateKey, shiftDateKey } from "../src/core/time.ts";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const today = localDateKey();
const tomorrow = shiftDateKey(today, 1);

const students: StudentInfo[] = [{ studentNumber: "1234", name: "Testilapsi", href: "/!1234/" }];

function lesson(date: string, subject: string): ScheduleLesson {
  return {
    date,
    dayOfWeek: 1,
    start: "08:15",
    end: "09:45",
    subject,
    subjectCode: subject.slice(0, 2).toUpperCase(),
    teacher: "Opettaja",
    teacherCode: "OP",
    groupId: 1,
  };
}

/**
 * Both today and tomorrow are covered on purpose: without a day after today
 * the provider looks up the following week too, and this file is counting
 * requests rather than testing the schedule logic (that is wilma-fetch.ts).
 */
function overview(): OverviewData {
  return {
    schedule: [lesson(today, "Matematiikka"), lesson(tomorrow, "Kemia")],
    upcomingExams: [],
    grades: [],
    homework: [],
    fetchedAt: new Date(),
  };
}

/**
 * A stand-in Wilma that behaves the way the real one does in the case that
 * caused this bug: it expires sessions silently and answers requests made with
 * an expired one with an HTTP error, never with an authentication error.
 */
class FakeWilma {
  /** Individual logins performed: one for `listStudents`, one per child. */
  logins = 0;
  /** Sessions issued at or before this moment count as expired server-side. */
  expiredThrough = -Infinity;
  /** When set, every request and every login fails with this — Wilma is down. */
  outage: Error | null = null;

  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** Marks every session issued so far dead, as a night of inactivity does. */
  expireIssuedSessions(): void {
    this.expiredThrough = this.clock();
  }

  get source(): WilmaSessionSource {
    return {
      listStudents: async () => {
        if (this.outage) throw this.outage;
        this.logins += 1;
        return students;
      },
      login: async () => {
        if (this.outage) throw this.outage;
        this.logins += 1;
        return this.client(this.clock());
      },
    };
  }

  private client(issuedAt: number): WilmaClientLike {
    const check = (): void => {
      if (this.outage) throw this.outage;
      // Exactly what a dead Wilma session produces: an HTTP error from a
      // request that was made with a cookie the server no longer knows.
      if (issuedAt <= this.expiredThrough) throw new APIError("Wilma HTTP 403 at /overview", 403);
    };

    return {
      overview: {
        get: async () => {
          check();
          return overview();
        },
      },
      schedule: {
        list: async () => {
          check();
          return [];
        },
      },
      messages: {
        list: async () => {
          check();
          return [] as Message[];
        },
        get: async () => {
          check();
          throw new Error("no message details in this fixture");
        },
      },
    };
  }
}

/* -------------------------------------------------------------------- */
/*  Log reading — same trick as provider-transitions.ts, see its comments */
/* -------------------------------------------------------------------- */

const logFile = (): string | null => {
  let files: string[];
  try {
    files = fs.readdirSync(config.logDir);
  } catch {
    return null;
  }
  return (
    files
      .filter((f) => f.endsWith(".log"))
      .map((f) => `${config.logDir}/${f}`)
      .sort()
      .at(-1) ?? null
  );
};

function resetLines(): Array<Record<string, unknown>> {
  const file = logFile();
  if (file === null) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === "wilma_session_reset");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * All four tests share one log file, so every assertion is made against the
 * lines written *since that test started*. Counting from zero would make each
 * test's result depend on the ones before it.
 */
async function resetLinesSince(
  from: number,
  expected: number,
  timeoutMs = 5_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && resetLines().length - from < expected) await sleep(50);
  await sleep(250);
  return resetLines().slice(from);
}

/* -------------------------------------------------------------------- */
/*  Tests                                                                */
/* -------------------------------------------------------------------- */

/**
 * The reported fault, end to end. A session that worked last night is dead in
 * the morning, and the error it produces is an HTTP one — the case the old
 * code explicitly refused to reset on. Without the age check every fetch from
 * here to the next restart fails with the same dead session.
 */
async function testOvernightSessionRecoversWithoutRestart(): Promise<void> {
  const logFrom = resetLines().length;
  const clock = { now: Date.parse("2026-09-09T22:50:00+03:00") };
  const wilma = new FakeWilma(() => clock.now);
  const pool = new WilmaClientPool(wilma.source);
  const now = (): number => clock.now;

  const evening = await runWilmaFetch(pool, null, now);
  assert.equal(evening.students.length, 1, "the evening fetch must work normally");
  assert.equal(wilma.logins, 2, "one login for the student list and one for the child");

  // The night: no cycles run (quiet hours), and Wilma drops the session.
  wilma.expireIssuedSessions();
  clock.now += 6 * HOUR_MS + 15 * MINUTE_MS;

  const morning = await runWilmaFetch(pool, evening, now);
  assert.equal(
    morning.students.length,
    1,
    "the first fetch of the morning must succeed on its own, without a restart",
  );
  assert.equal(wilma.logins, 4, "recovery costs exactly one extra login round, not more");

  // And the recovered session is then reused like any other — the fix must not
  // turn into a login every cycle.
  clock.now += 20 * MINUTE_MS;
  await runWilmaFetch(pool, morning, now);
  assert.equal(wilma.logins, 4, `the fresh session must be reused, got ${wilma.logins} logins`);

  const logged = await resetLinesSince(logFrom, 1);
  assert.equal(logged.length, 1, "the drop must leave exactly one line in the log");
  assert.equal(logged[0]?.["reason"], "idle", "and it must say why the session was dropped");
  assert.ok(
    Number(logged[0]?.["idleMinutes"]) >= 360,
    "the log must carry the idle time that justified the drop",
  );

  console.log("ok  a session expired overnight recovers on the first morning fetch");
}

/**
 * The counterweight. A single HTTP error is not evidence that the session is
 * dead, and re-logging in on one would produce a relogin burst at exactly the
 * moment Wilma is already struggling — the thing the original code was written
 * to avoid, and which must survive this fix.
 */
async function testOneTransientErrorDoesNotRelogin(): Promise<void> {
  const logFrom = resetLines().length;
  const clock = { now: Date.parse("2026-09-10T09:00:00+03:00") };
  const wilma = new FakeWilma(() => clock.now);
  const pool = new WilmaClientPool(wilma.source);
  const now = (): number => clock.now;

  const first = await runWilmaFetch(pool, null, now);
  assert.equal(wilma.logins, 2, "the first cycle logs in");

  // One 500 from a perfectly healthy session.
  clock.now += 20 * MINUTE_MS;
  wilma.outage = new APIError("Wilma HTTP 500 at /overview", 500);
  await assert.rejects(runWilmaFetch(pool, first, now));
  assert.equal(wilma.logins, 2, `one failure must not cost a login, got ${wilma.logins}`);

  // Back to normal on the very same session.
  clock.now += 20 * MINUTE_MS;
  wilma.outage = null;
  const recovered = await runWilmaFetch(pool, first, now);
  assert.equal(recovered.students.length, 1);
  assert.equal(wilma.logins, 2, `the session must survive a transient error, got ${wilma.logins}`);

  assert.equal(
    resetLines().length - logFrom,
    0,
    "nothing was dropped, so nothing may be logged",
  );

  console.log("ok  a single transient error costs no login and drops no session");
}

/**
 * A long outage is where the login count could run away: the pool is empty, so
 * every cycle would log in again. It must not. Repeated failures buy exactly
 * one new session, after which the failures are understood to be Wilma's and
 * not the session's.
 */
async function testSustainedOutageBuysOneLoginRoundNotOnePerCycle(): Promise<void> {
  const logFrom = resetLines().length;
  const clock = { now: Date.parse("2026-09-10T09:00:00+03:00") };
  const wilma = new FakeWilma(() => clock.now);
  const pool = new WilmaClientPool(wilma.source);
  const now = (): number => clock.now;

  const first = await runWilmaFetch(pool, null, now);
  const beforeOutage = wilma.logins;

  // Wilma answers, but only with errors — the session is fine, the server is
  // not. Requests fail; logins would succeed if anything asked for one.
  wilma.expiredThrough = Infinity; // every request errors, whatever session
  for (let cycle = 0; cycle < 8; cycle += 1) {
    clock.now += 20 * MINUTE_MS;
    await assert.rejects(runWilmaFetch(pool, first, now));
  }

  const extra = wilma.logins - beforeOutage;
  assert.equal(
    extra,
    2,
    `eight failing cycles may buy one login round (student list + one child), got ${extra} logins`,
  );

  const drops = await resetLinesSince(logFrom, 1);
  assert.equal(drops.length, 1, "one drop for the whole failure run, not one per cycle");
  assert.equal(drops[0]?.["reason"], "failures");
  assert.equal(drops[0]?.["errorType"], "APIError", "the error that broke the fetch must be named");

  console.log("ok  a sustained outage costs one login round in total, not one per cycle");
}

/**
 * "Testaa yhteys" is the recovery button. Before this fix it went through the
 * same pool as the automatic fetch, so it reused the very session that was
 * broken and failed identically — leaving a restart as the only way out, which
 * is what the display's owner actually had to do.
 *
 * The automatic path would eventually get there by itself now (see the outage
 * test above), but "eventually" is another cycle at best and a circuit-breaker
 * cooldown of up to four hours at worst. Skipping that wait is the whole point
 * of the button.
 */
async function testManualTestRecoversFromAStuckSession(): Promise<void> {
  const logFrom = resetLines().length;
  const clock = { now: Date.parse("2026-09-10T09:00:00+03:00") };
  const wilma = new FakeWilma(() => clock.now);
  const pool = new WilmaClientPool(wilma.source);
  const now = (): number => clock.now;

  // Same wiring as createWilmaProvider, minus the credential check.
  const provider: Provider<WilmaData> = new Provider<WilmaData>({
    id: `test-wilma-manual-${process.pid}`,
    intervalMs: 20 * MINUTE_MS,
    fetch: () => runWilmaFetch(pool, provider.snapshot().data, now),
    beforeManualTest: () => {
      pool.reset("manual");
    },
  });

  await provider.runOnce();
  assert.equal(provider.snapshot().status, "ok", "the provider starts out healthy");

  // Wilma expires the session. The clock barely moves, so the age check does
  // not save us here — this is the automatic path genuinely stuck.
  wilma.expireIssuedSessions();
  clock.now += 20 * MINUTE_MS;

  await provider.runOnce();
  assert.equal(provider.snapshot().status, "stale", "the automatic fetch fails on the dead session");
  const loginsWhileStuck = wilma.logins;

  const result = await provider.manualTest();
  assert.deepEqual(
    result,
    { outcome: "ok" },
    "the button must be able to recover; on the pooled session it cannot",
  );
  assert.equal(provider.snapshot().status, "ok", "and the card must go back to showing fresh data");
  assert.equal(
    wilma.logins - loginsWhileStuck,
    2,
    "one login round per press — the rate limiter is what keeps that safe",
  );

  const dropped = await resetLinesSince(logFrom, 1);
  assert.equal(dropped.length, 1, "the button's clean slate must be visible in the log");
  assert.equal(dropped[0]?.["reason"], "manual");

  provider.stop();
  console.log("ok  \"Testaa yhteys\" starts from a clean session and recovers a stuck fetch");
}

await testOvernightSessionRecoversWithoutRestart();
await testOneTransientErrorDoesNotRelogin();
await testSustainedOutageBuysOneLoginRoundNotOnePerCycle();
await testManualTestRecoversFromAStuckSession();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A timed-out operation can finish after its replacement. Exercise the real
// fetch path, including both async cache writes, with and without a manual reset.
async function testLateLoginCannotReplaceCurrentSession(stage: "students" | "client", manual: boolean) {
  const fake = new FakeWilma(Date.now);
  const oldClient = await fake.source.login("1234");
  oldClient.overview.get = async () => { throw new Error("obsolete session used"); };
  const delayed = deferred<StudentInfo[] | WilmaClientLike>();
  const entered = deferred<void>();
  let lists = 0;
  let logins = 0;
  const pool = new WilmaClientPool({
    listStudents: async () => {
      lists += 1;
      if (stage === "students" && lists === 1) {
        entered.resolve();
        return await delayed.promise as StudentInfo[];
      }
      return students;
    },
    login: async (id) => {
      logins += 1;
      if (stage === "client" && logins === 1) {
        entered.resolve();
        return await delayed.promise as WilmaClientLike;
      }
      return fake.source.login(id);
    },
  });
  const old = assert.rejects(runWilmaFetch(pool, null), /korvattu uudemmalla/);
  await entered.promise;
  if (manual) pool.reset("manual");
  const fresh = await runWilmaFetch(pool, null);
  const loginCount = logins;
  delayed.resolve(stage === "students" ? [{ ...students[0]!, studentNumber: "obsolete" }] : oldClient);
  await old;
  const next = await runWilmaFetch(pool, fresh);
  assert.deepEqual(next.students, fresh.students, "a late student list cannot overwrite the current list");
  assert.equal(logins, loginCount, "an obsolete cycle cannot start another login or replace the cached client");
  console.log(`ok  late ${stage} result is discarded after ${manual ? "manual reset" : "replacement fetch"}`);
}

async function testLateFetchCannotDropFreshSession() {
  const fake = new FakeWilma(Date.now);
  const pending = deferred<OverviewData>();
  const entered = deferred<void>();
  let calls = 0;
  const client = await fake.source.login("1234");
  client.overview.get = async () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    return overview();
  };
  let logins = 0;
  const pool = new WilmaClientPool({
    listStudents: async () => students,
    login: async () => { logins += 1; return client; },
  });
  const old = assert.rejects(runWilmaFetch(pool, null));
  await entered.promise;
  const fresh = await runWilmaFetch(pool, null);
  pending.reject(new FatalProviderError("Expired", "late session failure"));
  await old;
  await runWilmaFetch(pool, fresh);
  assert.equal(logins, 1, "a late fatal failure cannot clear the session used successfully by a newer cycle");
  console.log("ok  a superseded fetch failure cannot drop the current session");
}

async function testLoginFailureOpensBreaker(stage: "students" | "client") {
  let attempts = 0;
  const fail = async (): Promise<never> => {
    attempts += 1;
    throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") });
  };
  const pool = new WilmaClientPool({
    listStudents: stage === "students" ? fail : async () => students,
    login: fail,
  });
  const provider = new Provider({
    id: `test-wilma-login-${stage}-${process.pid}`,
    intervalMs: 20 * MINUTE_MS,
    fetch: () => runWilmaFetch(pool, null),
  });
  try {
    for (let i = 0; i < 10; i += 1) await provider.runOnce();
    assert.equal(attempts, 3, "failed logins must stop at the circuit breaker, including non-authentication errors");
    assert.equal(provider.snapshot().error?.type, "LoginFailed");
    assert.match(provider.snapshot().error!.message, /fetch failed: redirect count exceeded/);
  } finally { provider.stop(); }
  console.log(`ok  failed ${stage} login opens the breaker and reports the underlying error`);
}

async function testUnsuccessfulEveningSessionExpiresOvernight() {
  const clock = { now: Date.parse("2026-09-09T21:40:00+03:00") };
  const wilma = new FakeWilma(() => clock.now);
  const pool = new WilmaClientPool(wilma.source);
  const now = () => clock.now;
  const first = await runWilmaFetch(pool, null, now);
  // Two failed cycles trigger the one permitted reset; its new login succeeds
  // but the first data request still fails. No success timestamp exists for it.
  wilma.expiredThrough = Infinity;
  for (let i = 0; i < 3; i += 1) {
    clock.now += 20 * MINUTE_MS;
    await assert.rejects(runWilmaFetch(pool, first, now));
  }
  assert.equal(wilma.logins, 4);
  wilma.expireIssuedSessions();
  clock.now += 6 * HOUR_MS + 20 * MINUTE_MS;
  const morning = await runWilmaFetch(pool, first, now);
  assert.equal(morning.students.length, 1);
  assert.equal(wilma.logins, 6, "the unsuccessful evening session also needs a fresh morning login");
  console.log("ok  a session whose first fetch failed also expires across the night");
}

for (const stage of ["students", "client"] as const) {
  await testLateLoginCannotReplaceCurrentSession(stage, false);
  await testLateLoginCannotReplaceCurrentSession(stage, true);
  await testLoginFailureOpensBreaker(stage);
}
await testLateFetchCannotDropFreshSession();
await testUnsuccessfulEveningSessionExpiresOvernight();

console.log("\nall wilma session tests passed");
process.exit(0);
