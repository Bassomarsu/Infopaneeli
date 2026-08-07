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
process.env.LOG_DIR ??= "data/logs-test";
process.env.DB_PATH ??= "data/infonaytto-test.db";
