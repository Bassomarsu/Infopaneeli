/**
 * Import this *first* in any test that loads the logger.
 *
 * Without it the tests write their fake providers into the same file as the
 * real display, and `data/logs/` fills up with rows about `test-flaky-1234`.
 * That directly undermines the one job the log has: when Wilma breaks after a
 * school-side update, the log should be short enough to read.
 *
 * ES modules evaluate their dependencies in source order, so a side-effect
 * import on the first line runs before `config.ts` is evaluated further down.
 */
process.env.LOG_DIR ??= "data/logs-test";
