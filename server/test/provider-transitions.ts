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

function linesFor(provider: string): Array<Record<string, unknown>> {
  // pino's file transport is async; give it a moment to flush.
  return fs
    .readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["provider"] === provider);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  await sleep(300);

  assert.equal(attempts, 5, "every cycle should have attempted a fetch");

  const failed = linesFor(id).filter((l) => l["event"] === "provider_failed");
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
  await sleep(300);

  assert.equal(attempts, 3, `breaker must stop after 3 attempts, got ${attempts}`);

  const opened = linesFor(id).filter((l) => l["event"] === "provider_breaker_open");
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
  await sleep(300);

  const recovered = linesFor(id).filter((l) => l["event"] === "provider_recovered");
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
  await sleep(200);

  const snapshot = provider.snapshot();
  assert.equal(snapshot.status, "stale", "last good data must keep being served");
  assert.deepEqual(snapshot.data, { value: 7 });
  assert.ok(snapshot.fetchedAt, "stale data must carry the time it was fetched");

  console.log("ok  last good data survives a failure");
}

await testRepeatedFailureLogsOnce();
await testBreakerStopsAfterThreeFatalErrors();
await testRecoveryIsLogged();
await testStaleDataSurvivesFailure();

console.log("\nall provider tests passed");
process.exit(0);
