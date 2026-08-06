import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { config } from "./config.ts";

fs.mkdirSync(config.logDir, { recursive: true });

/**
 * File transport is rotated daily and size-capped, and only a handful of files
 * are kept. The Surface has a small disk and this process is meant to run for
 * months without anyone looking at it — an unbounded log is a slow outage.
 */
const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino-roll",
    level: config.logLevel,
    options: {
      file: path.join(config.logDir, "infonaytto"),
      extension: ".log",
      frequency: "daily",
      size: "5m",
      limit: { count: 14 },
      mkdir: true,
      dateFormat: "yyyy-MM-dd",
    },
  },
];

// In debug mode the console is where you actually watch things happen.
if (config.debugMode) {
  targets.push({ target: "pino/file", level: "debug", options: { destination: 1 } });
}

export const logger = pino(
  {
    level: config.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Belt and braces: even if a credential is ever put on a log object by
    // mistake, it must not reach the file.
    redact: {
      paths: ["password", "*.password", "cookie", "*.cookie", "authorization", "*.authorization"],
      censor: "[redacted]",
    },
  },
  pino.transport({ targets }),
);

/**
 * Saves a raw upstream response so a parser breakage can be diagnosed after
 * the fact. Only ever called in debug mode — these snapshots can contain a
 * child's personal data, so they stay out of normal operation and out of git.
 */
export function saveDebugSnapshot(name: string, body: string): string | null {
  if (!config.debugMode) return null;
  try {
    fs.mkdirSync(config.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(config.snapshotDir, `${name}-${stamp}.html`);
    fs.writeFileSync(file, body, "utf8");
    return file;
  } catch (err) {
    logger.error({ err, name }, "snapshot_write_failed");
    return null;
  }
}
