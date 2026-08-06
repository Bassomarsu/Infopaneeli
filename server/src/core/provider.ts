import { logger } from "./logging.ts";
import { readCache, writeCache } from "./store.ts";

export type ProviderStatus = "ok" | "stale" | "failed" | "idle";

export interface ProviderSnapshot<T = unknown> {
  id: string;
  status: ProviderStatus;
  data: T | null;
  /** When the data currently held was actually fetched. */
  fetchedAt: string | null;
  error: { type: string; message: string } | null;
}

/**
 * Thrown by a provider when retrying is not just useless but harmful — a wrong
 * password being the case that matters. These count towards the circuit
 * breaker; ordinary network errors do not.
 */
export class FatalProviderError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.name = "FatalProviderError";
    this.type = type;
  }
}

export interface ProviderOptions<T> {
  id: string;
  /** Normal polling interval in milliseconds. */
  intervalMs: number;
  fetch: () => Promise<T>;
  /** Delay before the very first run, used to stagger providers on startup. */
  initialDelayMs?: number;
  /** Return false to skip this cycle entirely (e.g. quiet hours). */
  shouldRun?: (now: Date) => boolean;
  maxBackoffMs?: number;
  /** Consecutive fatal errors after which the provider stops trying. */
  fatalLimit?: number;
  /** Hard ceiling for one fetch attempt. */
  timeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A fetch that never settles would silently stop the provider forever, since
 * the next run is only scheduled after the current one finishes. Individual
 * HTTP calls have their own timeouts, but a provider that makes several calls
 * in sequence needs an outer bound too.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${id}: fetch timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Spreads scheduled runs by ±10 %. Without it every provider would fire on an
 * exact repeating boundary, which both bunches up the requests and looks more
 * like a bot than a browser to whatever is on the other end.
 */
function withJitter(delayMs: number): number {
  if (delayMs <= 0) return 0;
  return Math.round(delayMs * (0.9 + Math.random() * 0.2));
}

/**
 * Wraps one data source. Everything that keeps the log small and the upstream
 * unbothered lives here rather than in the individual providers: state
 * transition logging, exponential backoff, the circuit breaker, and the
 * last-good cache.
 */
export class Provider<T = unknown> {
  readonly id: string;

  private readonly options: ProviderOptions<T>;
  private readonly maxBackoffMs: number;
  private readonly fatalLimit: number;
  private readonly timeoutMs: number;
  private running = false;

  private data: T | null = null;
  private fetchedAt: string | null = null;
  private status: ProviderStatus = "idle";
  private error: { type: string; message: string } | null = null;

  private consecutiveFailures = 0;
  private consecutiveFatal = 0;
  private breakerOpen = false;
  private failingSince: number | null = null;
  private lastFailureLogAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: ProviderOptions<T>) {
    this.options = options;
    this.id = options.id;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60 * 1000;
    this.fatalLimit = options.fatalLimit ?? 3;
    this.timeoutMs = options.timeoutMs ?? 90_000;

    // Warm up from the last-good cache so the screen has something to show
    // immediately after a restart, before the first fetch completes.
    const cached = readCache<T>(this.id);
    if (cached) {
      this.data = cached.data;
      this.fetchedAt = cached.fetchedAt;
      this.status = "stale";
    }
  }

  snapshot(): ProviderSnapshot<T> {
    return {
      id: this.id,
      status: this.status,
      data: this.data,
      fetchedAt: this.fetchedAt,
      error: this.error,
    };
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.options.initialDelayMs ?? 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    // Always replace rather than add, so a manual runOnce() interleaved with
    // the scheduled one cannot leave two timers racing.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnce();
    }, withJitter(delayMs));
    this.timer.unref?.();
  }

  /** Runs a fetch cycle and schedules the next one. */
  async runOnce(): Promise<void> {
    if (this.stopped || this.running) return;

    const now = new Date();

    if (this.breakerOpen) {
      this.noteStillFailing();
      this.schedule(this.options.intervalMs);
      return;
    }

    if (this.options.shouldRun && !this.options.shouldRun(now)) {
      this.schedule(this.options.intervalMs);
      return;
    }

    this.running = true;
    try {
      const data = await withTimeout(this.options.fetch(), this.timeoutMs, this.id);
      this.onSuccess(data);
      this.schedule(this.options.intervalMs);
    } catch (err) {
      this.onFailure(err);
      this.schedule(this.breakerOpen ? this.options.intervalMs : this.backoffMs());
    } finally {
      this.running = false;
    }
  }

  private backoffMs(): number {
    const factor = 2 ** Math.min(this.consecutiveFailures, 8);
    return Math.min(this.options.intervalMs * factor, this.maxBackoffMs);
  }

  private onSuccess(data: T): void {
    // `failingSince` is the only honest signal that this process actually saw a
    // failure. Testing the status instead would report a recovery on every
    // restart, because a provider warmed from the cache starts out `stale`.
    const hadFailed = this.failingSince !== null;
    const downForMs = hadFailed ? Date.now() - (this.failingSince ?? 0) : 0;

    this.data = data;
    this.fetchedAt = new Date().toISOString();
    this.status = "ok";
    this.error = null;
    this.consecutiveFailures = 0;
    this.consecutiveFatal = 0;
    this.failingSince = null;
    this.lastFailureLogAt = 0;

    writeCache(this.id, data, this.fetchedAt);

    // Only the FAILED -> OK edge is logged, never the steady state.
    if (hadFailed) {
      logger.warn(
        { event: "provider_recovered", provider: this.id, downForMinutes: Math.round(downForMs / 60000) },
        "provider recovered",
      );
    }
    logger.debug({ event: "provider_ok", provider: this.id }, "provider fetch ok");
  }

  private onFailure(err: unknown): void {
    const fatal = err instanceof FatalProviderError;
    const type = fatal ? err.type : err instanceof Error ? err.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);

    const wasHealthy = this.status === "ok" || this.status === "idle";
    this.consecutiveFailures += 1;
    if (fatal) this.consecutiveFatal += 1;
    if (this.failingSince === null) this.failingSince = Date.now();

    this.error = { type, message };
    // Keep serving the last good data if there is any — a stale schedule beats
    // an empty card.
    this.status = this.data === null ? "failed" : "stale";

    if (fatal && this.consecutiveFatal >= this.fatalLimit && !this.breakerOpen) {
      this.breakerOpen = true;
      logger.error(
        {
          event: "provider_breaker_open",
          provider: this.id,
          errorType: type,
          attempts: this.consecutiveFatal,
          err,
        },
        "provider circuit breaker opened — no further attempts until restart",
      );
      this.lastFailureLogAt = Date.now();
      return;
    }

    // Only the OK -> FAILED edge is logged in full. A source that stays broken
    // for a week must not write a line every polling cycle.
    if (wasHealthy) {
      logger.error(
        { event: "provider_failed", provider: this.id, errorType: type, err },
        "provider fetch failed",
      );
      this.lastFailureLogAt = Date.now();
    } else {
      this.noteStillFailing();
    }
  }

  /** At most one line per day while a source stays broken. */
  private noteStillFailing(): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < DAY_MS) return;
    this.lastFailureLogAt = now;
    logger.error(
      {
        event: "provider_still_failing",
        provider: this.id,
        errorType: this.error?.type ?? "unknown",
        breakerOpen: this.breakerOpen,
        failingForHours: this.failingSince ? Math.round((now - this.failingSince) / 3600000) : 0,
        consecutiveFailures: this.consecutiveFailures,
      },
      "provider still failing",
    );
  }
}

/** Keeps every registered provider in one place so routes can read them all. */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider<unknown>>();

  register<T>(provider: Provider<T>): Provider<T> {
    this.providers.set(provider.id, provider as Provider<unknown>);
    return provider;
  }

  get(id: string): Provider<unknown> | undefined {
    return this.providers.get(id);
  }

  snapshots(): Record<string, ProviderSnapshot> {
    const out: Record<string, ProviderSnapshot> = {};
    for (const [id, provider] of this.providers) out[id] = provider.snapshot();
    return out;
  }

  startAll(): void {
    for (const provider of this.providers.values()) provider.start();
  }

  stopAll(): void {
    for (const provider of this.providers.values()) provider.stop();
  }
}

export const registry = new ProviderRegistry();
