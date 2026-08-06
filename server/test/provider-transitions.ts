/**
 * Verifies the logging contract that keeps the log small: a source that stays
 * broken must produce exactly one log line, not one per polling cycle.
 *
 * Run with:  npm run test:providers --workspace=server
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../src/core/config.ts";
import { FatalProviderError, Provider } from "../src/core/provider.ts";

const logFile = (): string => {
  const files = fs
    .readdirSync(config.logDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => `${config.logDir}/${f}`)
    .sort();
  const latest = files.at(-1);
  assert.ok(latest, "no log file was created");
  return latest;
};

function linesFor(provider: string, event?: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["provider"] === provider && (event === undefined || entry["event"] === event));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pino writes through an async transport, so a line that has been logged is
 * not necessarily on disk yet. Poll until the expected count appears, then
 * settle briefly so that a bug producing *extra* lines still fails the
 * assertion rather than racing past it.
 */
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

async function testRepeatedFailureLogsOnce(): Promise<void> {
  const id = `test-flaky-${process.pid}`;
  let attempts = 0;
  const provider = new Provider({
    id,
    intervalMs: 60_000,
    fetch: async () => {
      attempts += 1;
      throw new Error("upstream is down");
    },
  });

  for (let i = 0; i < 5; i += 1) {
    await provider.runOnce();
  }
  provider.stop();

  assert.equal(attempts, 5, "every cycle should have attempted a fetch");

  const failed = await awaitLines(id, "provider_failed", 1);
  assert.equal(
    failed.length,
    1,
    `five failed cycles must log once, got ${failed.length} lines`,
  );

  const snapshot = provider.snapshot();
  assert.equal(snapshot.status, "failed", "no cached data means the card reports failure");
  assert.equal(snapshot.error?.message, "upstream is down");

  console.log("ok  repeated failures log exactly once");
}

async function testBreakerStopsAfterThreeFatalErrors(): Promise<void> {
  const id = `test-auth-${process.pid}`;
  let attempts = 0;
  const provider = new Provider({
    id,
    intervalMs: 60_000,
    fatalLimit: 3,
    fetch: async () => {
      attempts += 1;
      throw new FatalProviderError("AuthenticationError", "wrong password");
    },
  });

  // Ten cycles, but the breaker must stop the attempts at three. This is the
  // guard that keeps a wrong Wilma password from locking the account.
  for (let i = 0; i < 10; i += 1) {
    await provider.runOnce();
  }
  provider.stop();

  assert.equal(attempts, 3, `breaker must stop after 3 attempts, got ${attempts}`);

  const opened = await awaitLines(id, "provider_breaker_open", 1);
  assert.equal(opened.length, 1, "breaker opening must be logged exactly once");

  console.log("ok  circuit breaker stops after three fatal errors");
}

async function testRecoveryIsLogged(): Promise<void> {
  const id = `test-recover-${process.pid}`;
  let shouldFail = true;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fetch: async () => {
      if (shouldFail) throw new Error("temporary outage");
      return { value: 42 };
    },
  });

  await provider.runOnce();
  shouldFail = false;
  await provider.runOnce();
  provider.stop();

  const recovered = await awaitLines(id, "provider_recovered", 1);
  assert.equal(recovered.length, 1, "recovery must be logged exactly once");
  assert.equal(provider.snapshot().status, "ok");
  assert.deepEqual(provider.snapshot().data, { value: 42 });

  console.log("ok  recovery is logged exactly once");
}

async function testStaleDataSurvivesFailure(): Promise<void> {
  const id = `test-stale-${process.pid}`;
  let shouldFail = false;
  const provider = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fetch: async () => {
      if (shouldFail) throw new Error("gone away");
      return { value: 7 };
    },
  });

  await provider.runOnce();
  shouldFail = true;
  await provider.runOnce();
  provider.stop();

  const snapshot = provider.snapshot();
  assert.equal(snapshot.status, "stale", "last good data must keep being served");
  assert.deepEqual(snapshot.data, { value: 7 });
  assert.ok(snapshot.fetchedAt, "stale data must carry the time it was fetched");

  console.log("ok  last good data survives a failure");
}

/**
 * A restart warms every provider from the on-disk cache, which leaves it in
 * the `stale` state before it has failed at anything. That must not be
 * reported as a recovery, or every reboot would write a line per provider.
 */
async function testWarmStartIsNotARecovery(): Promise<void> {
  const id = `test-warm-${process.pid}`;

  const first = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fetch: async () => ({ value: 1 }),
  });
  await first.runOnce();
  first.stop();

  // A second instance with the same id is what a process restart looks like.
  const restarted = new Provider<{ value: number }>({
    id,
    intervalMs: 60_000,
    fetch: async () => ({ value: 2 }),
  });
  assert.equal(restarted.snapshot().status, "stale", "a warm start begins as stale");
  await restarted.runOnce();
  restarted.stop();

  await sleep(400);
  const recovered = linesFor(id, "provider_recovered");
  assert.equal(recovered.length, 0, "a warm start must not be logged as a recovery");

  console.log("ok  warm start is not reported as a recovery");
}

await testRepeatedFailureLogsOnce();
await testBreakerStopsAfterThreeFatalErrors();
await testRecoveryIsLogged();
await testStaleDataSurvivesFailure();
await testWarmStartIsNotARecovery();

console.log("\nall provider tests passed");
process.exit(0);
