/**
 * Manuaalinen "Testaa yhteys" -painike (server/src/core/provider.ts:n
 * manualTest, ks. myös server/src/routes/api.ts:n POST /api/providers/:id/test
 * ja docs/wilma.md:n "Tilin lukituksen esto"). Neljä asiaa täytyy pitää paikkansa:
 *
 *  1. Onnistunut manuaalinen testi nollaa katkaisijan täysin, aivan kuten
 *     automaattinen koeyritys (ks. provider-transitions.ts).
 *  2. Epäonnistunut manuaalinen testi ei kosketa automaattisen katkaisijan
 *     tilaan mitenkään — ei jäähdytystä, ei laskureita. Se on tietoinen
 *     valinta (ks. manualTestin kommentti provider.ts:ssä): käyttäjä ei saa
 *     vahingossa pidentää automaattista aikataulua painamalla nappia.
 *  3. Rajoitin (5 min per yritys, katto vuorokaudessa) on palvelimella, ei
 *     vain käyttöliittymässä — ja kertoo jäljellä olevan ajan.
 *  4. Reitti hyväksyy vain nimetyt providerit, ei mitä tahansa pyynnön
 *     mukana tullutta tunnistetta.
 *
 * Aja:  npm run test:providers-manual --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../src/core/config.ts";
import { FatalProviderError, Provider } from "../src/core/provider.ts";
import { MANUALLY_TESTABLE_PROVIDERS } from "../src/routes/api.ts";

// Sama lokinlukukikka kuin provider-transitions.ts:ssä — katso sen kommentit.
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

function linesFor(provider: string, event?: string): Array<Record<string, unknown>> {
  const file = logFile();
  if (file === null) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["provider"] === provider && (event === undefined || entry["event"] === event));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitLines(
  provider: string,
  event: string,
  expected: number,
  timeoutMs = 5_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && linesFor(provider, event).length < expected) {
    await sleep(50);
  }
  await sleep(250);
  return linesFor(provider, event);
}

async function testManualTestSuccessFullyClosesBreaker(): Promise<void> {
  const id = `test-manual-ok-${process.pid}`;
  let shouldFail = true;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fatalLimit: 3,
    fetch: async () => {
      if (shouldFail) throw new FatalProviderError("AuthenticationError", "wrong password");
      return { value: 1 };
    },
  });

  for (let i = 0; i < 3; i += 1) await provider.runOnce();
  assert.equal(provider.snapshot().status, "failed", "breaker should be open with no cached data yet");

  shouldFail = false;
  const result = await provider.manualTest();
  assert.deepEqual(result, { outcome: "ok" });

  const snapshot = provider.snapshot();
  assert.equal(snapshot.status, "ok", "a successful manual test must clear the failure status");
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.data, { value: 1 });

  const logged = await awaitLines(id, "provider_manual_test", 1);
  assert.equal(logged.length, 1, "the manual test itself must be logged exactly once");
  assert.equal(logged[0]?.["result"], "ok");

  // Katkaisijan pitää olla oikeasti kiinni, ei vain kertaalleen ohitettu:
  // kolme uutta fataalia virhettä pitää pystyä avaamaan se uudelleen.
  shouldFail = true;
  for (let i = 0; i < 3; i += 1) await provider.runOnce();
  // Toinen rivi kokonaisuudessaan — ensimmäinen tuli jo ennen manuaalista
  // testiä. Kaksi riviä todistaa että katkaisija oli TÄYSIN kiinni väliin
  // asti, ei jäänyt puoliksi auki.
  const reopened = await awaitLines(id, "provider_breaker_open", 2);
  assert.equal(reopened.length, 2, "a fully closed breaker must be able to trip again");

  provider.stop();
  console.log("ok  successful manual test fully closes the breaker");
}

async function testManualTestFailureLeavesAutomaticCooldownUntouched(): Promise<void> {
  const id = `test-manual-fail-${process.pid}`;
  let attempts = 0;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fatalLimit: 3,
    probeCooldownMs: 100,
    fetch: async () => {
      attempts += 1;
      throw new FatalProviderError("AuthenticationError", "wrong password");
    },
  });

  for (let i = 0; i < 3; i += 1) await provider.runOnce();
  assert.equal(attempts, 3, "breaker should open after 3 fatal errors");
  const errorBefore = provider.snapshot().error;

  const result = await provider.manualTest();
  assert.equal(attempts, 4, "the manual test must actually attempt a real fetch, not just report a cached error");
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.error.type, "AuthenticationError");
  }

  // Sama virheteksti kuin ennen manuaalista yritystä — manuaalinen
  // epäonnistuminen ei saa kirjoittaa uutta jäähdytysvihjettä automaattisen
  // tilan päälle.
  assert.deepEqual(provider.snapshot().error, errorBefore, "manual failure must not rewrite the automatic error/hint");

  // Alkuperäinen 100 ms:n cooldown (laskettu breakerin avautumishetkestä) ei
  // saa olla tuplaantunut manuaalisen epäonnistumisen takia — jos se olisi
  // tuplaantunut ~200 ms:iin (kuten automaattinen koeyritys tekisi), 150
  // ms:n odotus ei vielä riittäisi seuraavalle automaattiselle koeyritykselle.
  await sleep(150);
  await provider.runOnce();
  assert.equal(attempts, 5, "the ORIGINAL (untouched) automatic cooldown must be the one that governs the next probe");

  const logged = await awaitLines(id, "provider_manual_test", 1);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.["result"], "failed");

  provider.stop();
  console.log("ok  failed manual test leaves the automatic cooldown untouched");
}

async function testManualTestRateLimiter(): Promise<void> {
  const id = `test-manual-rate-${process.pid}`;
  let now = 1_000_000;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    manualTestIntervalMs: 5 * 60_000,
    fetch: async () => ({ value: 1 }),
  });

  const first = await provider.manualTest(() => now);
  assert.deepEqual(first, { outcome: "ok" });

  now += 60_000; // 1 min later — still inside the 5 min window
  const second = await provider.manualTest(() => now);
  assert.equal(second.outcome, "rate_limited");
  if (second.outcome === "rate_limited") {
    assert.equal(second.retryAfterSeconds, 4 * 60, "4 minutes should remain of the 5 minute window");
  }

  now += 4 * 60_000 + 1000; // just past the 5 minute mark
  const third = await provider.manualTest(() => now);
  assert.deepEqual(third, { outcome: "ok" }, "a new attempt must be allowed once the interval has fully elapsed");

  provider.stop();
  console.log("ok  manual test rate limiter blocks a second attempt within 5 minutes and reports the wait");
}

async function testManualTestDailyLimit(): Promise<void> {
  const id = `test-manual-daily-${process.pid}`;
  let now = 2_000_000;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    manualTestIntervalMs: 1_000, // lyhyt, jotta rajoitin ei sekoitu vuorokausikattoon tässä testissä
    manualTestDailyLimit: 3,
    manualTestWindowMs: 10_000, // "vuorokausi" lyhennetty testattavaksi
    fetch: async () => ({ value: 1 }),
  });

  for (let i = 0; i < 3; i += 1) {
    const result = await provider.manualTest(() => now);
    assert.deepEqual(result, { outcome: "ok" }, `attempt ${i + 1} of 3 should be allowed`);
    now += 1_000;
  }

  const fourth = await provider.manualTest(() => now);
  assert.equal(fourth.outcome, "daily_limit", "a fourth attempt within the window must hit the daily cap");
  if (fourth.outcome === "daily_limit") {
    assert.ok(fourth.retryAfterSeconds > 0);
  }

  // Vanhin yritys putoaa ikkunasta pois 10 s:n jälkeen alkuperäisestä
  // ajanhetkestä — sen jälkeen tilaa on taas yhdelle uudelle yritykselle.
  now = 2_000_000 + 10_001;
  const afterWindow = await provider.manualTest(() => now);
  assert.deepEqual(afterWindow, { outcome: "ok" }, "the daily cap must roll off as old attempts age out");

  provider.stop();
  console.log("ok  manual test daily cap blocks a fourth attempt and rolls off with the window");
}

async function testManualTestUnknownProviderRejected(): Promise<void> {
  assert.equal(MANUALLY_TESTABLE_PROVIDERS.has("wilma"), true, "wilma must stay testable");
  assert.equal(MANUALLY_TESTABLE_PROVIDERS.has("weather"), false, "other providers must not be manually testable");
  assert.equal(MANUALLY_TESTABLE_PROVIDERS.has("__proto__"), false, "an arbitrary/malicious id must never pass");
  console.log("ok  only the allowlisted provider id is manually testable");
}

async function testManualTestBusyWhileAlreadyRunning(): Promise<void> {
  const id = `test-manual-busy-${process.pid}`;
  let resolveFetch: (() => void) | null = null;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fetch: () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ value: 1 });
      }),
  });

  const first = provider.manualTest();
  await sleep(20); // anna ensimmäisen ehtiä asettaa this.running = true
  const second = await provider.manualTest();
  assert.deepEqual(second, { outcome: "busy" }, "a concurrent attempt must be refused, not queued or counted");

  assert.ok(resolveFetch, "the fetch should be in flight by now");
  resolveFetch();
  const firstResult = await first;
  assert.deepEqual(firstResult, { outcome: "ok" });

  provider.stop();
  console.log("ok  a manual test refuses to run while one is already in flight, without consuming the limiter");
}

await testManualTestSuccessFullyClosesBreaker();
await testManualTestFailureLeavesAutomaticCooldownUntouched();
await testManualTestRateLimiter();
await testManualTestDailyLimit();
await testManualTestUnknownProviderRejected();
await testManualTestBusyWhileAlreadyRunning();

async function testAutomaticPollingSurvivesOverlappingFailedManualTest(): Promise<void> {
  let rejectManual!: (reason: Error) => void;
  let calls = 0;
  const provider = new Provider({
    id: `test-manual-overlap-${process.pid}`,
    intervalMs: 20,
    initialDelayMs: 0,
    fetch: () => ++calls === 1
      ? new Promise<number>((_resolve, reject) => { rejectManual = reject; })
      : Promise.resolve(42),
  });
  try {
    provider.start();
    const manual = provider.manualTest();
    // The zero-delay automatic timer runs while the manual fetch is held open.
    await sleep(50);
    assert.equal(calls, 1, "scheduled ticks cannot start a concurrent fetch");
    rejectManual(new Error("manual connection test failed"));
    assert.equal((await manual).outcome, "failed");
    const deadline = Date.now() + 1000;
    while (calls < 2 && Date.now() < deadline) await sleep(10);
    assert.ok(calls >= 2, "automatic polling must resume after the failed manual test");
    assert.equal(provider.snapshot().status, "ok");
  } finally { provider.stop(); }
  console.log("ok  automatic polling survives a timer firing during a failed manual test");
}

await testAutomaticPollingSurvivesOverlappingFailedManualTest();

console.log("\nall manual-test provider tests passed");
process.exit(0);
