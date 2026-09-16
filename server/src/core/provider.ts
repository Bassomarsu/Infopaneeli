import { logger } from "./logging.ts";
import { readCache, writeCache } from "./store.ts";

/**
 * `hidden` is never set by a provider. The API layer stamps it when a payload
 * is withheld from a non-local client, so the phone can say why the card is
 * empty instead of showing a spinner that will never finish.
 */
export type ProviderStatus = "ok" | "stale" | "failed" | "idle" | "hidden";

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
  /** Cooldown before the circuit breaker's first probe attempt. */
  probeCooldownMs?: number;
  /** Ceiling the cooldown grows to after repeated failed probes. */
  maxProbeCooldownMs?: number;
  /** Minimum time between manual "test connection" attempts (see manualTest). */
  manualTestIntervalMs?: number;
  /** Max manual test attempts allowed within manualTestWindowMs. */
  manualTestDailyLimit?: number;
  /** Rolling window the manual test daily cap is measured over. Overridable only for tests. */
  manualTestWindowMs?: number;
  /**
   * Ajetaan juuri ennen manuaalista koeyritystä, ei koskaan automaattisella
   * kierroksella. Providerikohtainen paikka heittää pois se muistissa oleva
   * tila, jonka takia automaattinen haku on jumissa — Wilmalla vanhentunut
   * istunto, jota yksikään uusi yritys samalla istunnolla ei elvytä. Ilman
   * tätä "Testaa yhteys" epäonnistuisi täsmälleen samalla tavalla kuin
   * automaattinen haku, eli se ei olisi palautumiskeino lainkaan.
   */
  beforeManualTest?: () => void | Promise<void>;
}

export type ManualTestOutcome =
  | { outcome: "ok" }
  | { outcome: "failed"; error: { type: string; message: string } }
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "daily_limit"; retryAfterSeconds: number }
  | { outcome: "busy" };

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
  private readonly probeCooldownBaseMs: number;
  private readonly probeCooldownMaxMs: number;
  private readonly manualTestIntervalMs: number;
  private readonly manualTestDailyLimit: number;
  private readonly manualTestWindowMs: number;
  private running = false;

  private data: T | null = null;
  private fetchedAt: string | null = null;
  private status: ProviderStatus = "idle";
  private error: { type: string; message: string } | null = null;

  private consecutiveFailures = 0;
  private consecutiveFatal = 0;
  private breakerOpen = false;
  /** Current length of the breaker's cooldown; grows on each failed probe. */
  private probeCooldownMs = 0;
  /** Epoch ms of the earliest moment the next probe attempt may run. */
  private nextProbeAt: number | null = null;
  private failingSince: number | null = null;
  private lastFailureLogAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** Epoch ms of the most recent manual test attempt (not attempts blocked by the limiter). */
  private lastManualTestAt: number | null = null;
  /** Epoch ms of every manual test attempt within the rolling window, oldest first. */
  private readonly manualTestAttempts: number[] = [];

  constructor(options: ProviderOptions<T>) {
    this.options = options;
    this.id = options.id;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60 * 1000;
    this.fatalLimit = options.fatalLimit ?? 3;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    // 30 min, doubling to a 4 h ceiling. These pace fetch cycles; a provider
    // can make several login requests inside one cycle (e.g. one per child).
    this.probeCooldownBaseMs = options.probeCooldownMs ?? 30 * 60 * 1000;
    this.probeCooldownMaxMs = options.maxProbeCooldownMs ?? 4 * 60 * 60 * 1000;

    // Viiden minuutin väli ja erillinen vuorokausikatto estävät jatkuvan
    // manuaalisen uudelleenyrittämisen. Kumpikin raja koskee hakukierroksia.
    this.manualTestIntervalMs = options.manualTestIntervalMs ?? 5 * 60 * 1000;
    this.manualTestDailyLimit = options.manualTestDailyLimit ?? 12;
    this.manualTestWindowMs = options.manualTestWindowMs ?? DAY_MS;

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

  /**
   * Avaa katkaisijan heti, ilman koeyritystä. Tarkoitettu yhteen tilanteeseen:
   * käyttäjä on vaihtanut ne tunnukset joiden takia katkaisija meni kiinni.
   * Ilman tätä seuraava `runOnce()` palaisi jäähdytyksen takia saman tien
   * yrittämättä mitään, ja vasta korjatut tunnukset näyttäisivät yhä rikkinäisiltä
   * tuntikausia. Ei kosketa `data`an, `error`iin eikä `status`een — tämä ei väitä
   * että haku onnistuisi, vaan että se saa taas yrittää.
   *
   * `manualTest()` tekee saman ohituksen omalla kutsukerrallaan, mutta sillä on
   * oma tiheysrajansa ja vuorokausikattonsa; tunnusten vaihto ei saa kuluttaa
   * niitä eikä jäädä niiden taakse.
   */
  resetBreaker(): void {
    this.breakerOpen = false;
    this.consecutiveFatal = 0;
    this.probeCooldownMs = 0;
    this.nextProbeAt = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    // Always replace rather than add, so a manual runOnce() interleaved with
    // the scheduled one cannot leave two timers racing.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A manual test may still be running when this timer fires. Its failure
      // leaves the automatic schedule alone, so retain a timer here instead
      // of losing the only scheduled callback to runOnce's busy guard.
      if (this.running) {
        this.schedule(this.options.intervalMs);
        return;
      }
      void this.runOnce();
    }, withJitter(delayMs));
    this.timer.unref?.();
  }

  /** Runs a fetch cycle and schedules the next one. */
  async runOnce(): Promise<void> {
    if (this.stopped || this.running) return;

    const now = new Date();

    if (this.breakerOpen) {
      // Cooldown not elapsed yet — stay closed, no attempt this cycle.
      if (this.nextProbeAt === null || now.getTime() < this.nextProbeAt) {
        this.noteStillFailing();
        this.schedule(this.options.intervalMs);
        return;
      }
      // Cooldown elapsed: fall through to the one probe attempt below, still
      // subject to the same quiet-hours gate as a normal run so the two
      // delays don't stack — a probe due overnight simply waits for the next
      // active cycle instead of both waiting out the cooldown *and* the night.
    }

    // Quiet hours only apply once there is something to show. Otherwise
    // setting the display up late in the evening would leave every card empty
    // until morning, with no way to tell a misconfiguration from a quiet night.
    if (this.data !== null && this.options.shouldRun && !this.options.shouldRun(now)) {
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

  /**
   * "Testaa yhteys" -painikkeen palvelinpää. Ohittaa katkaisijan jäähdytys-
   * portin kokonaan (nextProbeAt-tarkistuksen) — se on koko pointti, kun
   * automaattinen jäähdytys on venynyt tunteja eikä kukaan halua käynnistää
   * palvelinta uudelleen vain nollatakseen sen. Rate-limit on TÄÄLLÄ, ei
   * selaimessa: pelkkä selainpuolen esto katoaisi sivun päivityksellä.
   *
   * Onnistunut yritys nollaa katkaisijan täysin (onSuccess, sama koodipolku
   * kuin automaattisella onnistuneella koeyrityksellä) ja aikatauluttaa
   * normaalin kierron uudelleen. Epäonnistunut yritys EI koske automaattisen
   * katkaisijan tilaan mitenkään — ei consecutiveFatal, ei probeCooldownMs,
   * ei nextProbeAt. Tämä on tietoinen valinta: manuaalinen yritys on erillinen
   * kanava, jonka epäonnistuminen ei saa pidentää tai muuten sotkea
   * automaattista aikataulua, jota käyttäjä ei enää edes katso jos hän
   * nojaa tähän nappiin. Automaattinen jäähdytys jatkuu täsmälleen samana
   * kuin jos nappia ei olisi koskaan painettu.
   *
   * Yritys lähtee providerin omalta puhtaalta pöydältä (`beforeManualTest`).
   * Jäähdytyksen ohittaminen ei yksin riitä, jos providerin jumi on sen
   * omassa muistissa olevassa tilassa eikä aikataulussa.
   */
  async manualTest(now: () => number = Date.now): Promise<ManualTestOutcome> {
    if (this.stopped || this.running) return { outcome: "busy" };

    const t = now();
    if (this.lastManualTestAt !== null) {
      const sinceLastMs = t - this.lastManualTestAt;
      if (sinceLastMs < this.manualTestIntervalMs) {
        return { outcome: "rate_limited", retryAfterSeconds: Math.ceil((this.manualTestIntervalMs - sinceLastMs) / 1000) };
      }
    }

    // Siivotaan ikkunan ulkopuolelle jääneet yritykset pois ennen kuin
    // vuorokausikattoa tarkistetaan, jotta vanha yritys ei jää ikuisesti
    // varaamaan paikkaa listalta.
    const windowStart = t - this.manualTestWindowMs;
    let oldest = this.manualTestAttempts.at(0);
    while (oldest !== undefined && oldest < windowStart) {
      this.manualTestAttempts.shift();
      oldest = this.manualTestAttempts.at(0);
    }
    if (oldest !== undefined && this.manualTestAttempts.length >= this.manualTestDailyLimit) {
      const retryAfterMs = oldest + this.manualTestWindowMs - t;
      return { outcome: "daily_limit", retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    this.lastManualTestAt = t;
    this.manualTestAttempts.push(t);

    this.running = true;
    try {
      // Providerikohtainen puhdistus ennen yritystä (ks. beforeManualTest).
      // Jos se heittää, lopputulos on "failed" kuten mikä tahansa muukin
      // epäonnistunut koeyritys — automaattista aikataulua se ei koske.
      await this.options.beforeManualTest?.();
      const data = await withTimeout(this.options.fetch(), this.timeoutMs, this.id);
      this.onSuccess(data);
      logger.warn(
        { event: "provider_manual_test", provider: this.id, result: "ok" },
        "manuaalinen yhteystesti onnistui — katkaisija nollattu",
      );
      // Vanha ajastin (esim. katkaisijan jäähdytyksen odotus) ei enää päde
      // sen jälkeen kun yhteys on juuri todettu toimivaksi — korvataan
      // normaalilla kierrolla heti.
      this.schedule(this.options.intervalMs);
      return { outcome: "ok" };
    } catch (err) {
      const fatal = err instanceof FatalProviderError;
      const type = fatal ? err.type : err instanceof Error ? err.name : "UnknownError";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { event: "provider_manual_test", provider: this.id, result: "failed", errorType: type, err },
        "manuaalinen yhteystesti epäonnistui — automaattinen jäähdytys pysyy ennallaan",
      );
      return { outcome: "failed", error: { type, message } };
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
    const hadBreakerOpen = this.breakerOpen;

    this.data = data;
    this.fetchedAt = new Date().toISOString();
    this.status = "ok";
    this.error = null;
    this.consecutiveFailures = 0;
    this.consecutiveFatal = 0;
    this.failingSince = null;
    this.lastFailureLogAt = 0;
    // A successful probe closes the breaker completely — counters, cooldown
    // and all — rather than merely postponing the next attempt.
    this.breakerOpen = false;
    this.probeCooldownMs = 0;
    this.nextProbeAt = null;

    writeCache(this.id, data, this.fetchedAt);

    // Only the FAILED -> OK edge is logged, never the steady state.
    if (hadFailed) {
      logger.warn(
        {
          event: "provider_recovered",
          provider: this.id,
          downForMinutes: Math.round(downForMs / 60000),
          hadBreakerOpen,
        },
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
    // A failure while the breaker was already open is the cooldown's probe
    // attempt coming back negative, not a fresh run towards `fatalLimit`.
    const wasProbing = this.breakerOpen;

    this.consecutiveFailures += 1;
    if (fatal) this.consecutiveFatal += 1;
    if (this.failingSince === null) this.failingSince = Date.now();

    // Keep serving the last good data if there is any — a stale schedule beats
    // an empty card.
    this.status = this.data === null ? "failed" : "stale";

    if (wasProbing) {
      // Back off further instead of probing again at a fixed cadence, which
      // would otherwise turn a permanently wrong password into one login
      // attempt every cooldown period forever at the same rate.
      this.probeCooldownMs = Math.min(this.probeCooldownMs * 2, this.probeCooldownMaxMs);
      this.nextProbeAt = Date.now() + this.probeCooldownMs;
      this.error = { type, message: this.withRetryHint(message) };
      // Logged through the same once-a-day cap as any other ongoing failure —
      // a probe that keeps failing must not write a line every cooldown.
      this.noteStillFailing();
      return;
    }

    this.error = { type, message };

    if (fatal && this.consecutiveFatal >= this.fatalLimit) {
      this.breakerOpen = true;
      this.probeCooldownMs = this.probeCooldownBaseMs;
      this.nextProbeAt = Date.now() + this.probeCooldownMs;
      this.error = { type, message: this.withRetryHint(message) };
      logger.error(
        {
          event: "provider_breaker_open",
          provider: this.id,
          errorType: type,
          attempts: this.consecutiveFatal,
          probeCooldownMinutes: Math.round(this.probeCooldownMs / 60000),
          err,
        },
        "provider circuit breaker opened — cooling down before next attempt",
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

  /**
   * Appends a short, human-readable retry estimate to a fatal error message
   * so a card left showing the same text for hours can tell "will heal
   * itself soon" apart from "needs a person to fix it". Approximate: while
   * the breaker is cooling down no fetch runs, so the countdown shown is the
   * one computed at the last attempt and can run past zero before the next
   * one actually fires (e.g. because quiet hours delay it further).
   */
  private withRetryHint(message: string): string {
    if (this.nextProbeAt === null) return message;
    const minutes = Math.max(1, Math.round((this.nextProbeAt - Date.now()) / 60000));
    const hint =
      minutes < 60
        ? `Yritetään uudelleen noin ${minutes} min kuluttua.`
        : `Yritetään uudelleen noin ${Math.round(minutes / 60)} h kuluttua.`;
    return `${message} ${hint}`;
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
        nextProbeInMinutes:
          this.breakerOpen && this.nextProbeAt !== null
            ? Math.max(0, Math.round((this.nextProbeAt - now) / 60000))
            : null,
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
