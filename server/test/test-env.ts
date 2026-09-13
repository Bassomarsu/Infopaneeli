/**
 * Import this *first* in any test that loads the logger or the database.
 *
 * Without it the tests write into the same log and the same SQLite file as the
 * real display: `data/logs/` fills with rows about `test-flaky-1234`, and
 * `provider_cache` accumulates dozens of `test-recover-*` rows next to the real
 * weather and Wilma payloads. Both directly undermine the two things that make
 * a fault diagnosable — a log short enough to read, and a database whose
 * contents mean what they say.
 *
 * ES modules evaluate their dependencies in source order, so a side-effect
 * import on the first line runs before `config.ts` is evaluated further down.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DIR = "data/logs-test";
const DB_PATH = "data/infonaytto-test.db";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
process.env.LOG_DIR = path.resolve(projectRoot, process.env.LOG_DIR ?? LOG_DIR);
process.env.DB_PATH = path.resolve(projectRoot, process.env.DB_PATH ?? DB_PATH);

/**
 * Wipe the previous run's state before anything opens it.
 *
 * The logging contract test asserts things like "a source that stays broken
 * logs exactly one line", counted by reading the log back. Those counts are
 * only meaningful against an empty log: the fake providers are named after
 * `process.pid`, and Windows recycles PIDs, so a leftover file eventually
 * produces two lines for what looks like the same provider and the assertion
 * fails for a reason that has nothing to do with the code. Starting clean is
 * the fix — unique ids would only paper over it, and a stale file would still
 * grow without bound.
 *
 * Guarded on the path so a future edit cannot point this at `data/logs/` or
 * the real database. Deleting either would destroy exactly the evidence the
 * log exists to preserve.
 */
function resetIfTestPath(target: string, mustContain: string): void {
  if (!target.includes(mustContain)) return;
  try {
    fs.rmSync(path.resolve(target), { recursive: true, force: true });
  } catch {
    // A locked file on Windows is not worth failing the suite over; the test
    // that cares reads the newest log file and will simply see the old one.
  }
}

resetIfTestPath(process.env.LOG_DIR, "logs-test");
resetIfTestPath(process.env.DB_PATH, "infonaytto-test");
