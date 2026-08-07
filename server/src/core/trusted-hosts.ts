import net from "node:net";
import dns from "node:dns/promises";
import { config } from "./config.ts";
import { logger } from "./logging.ts";

/**
 * 5 minutes: long enough that a home router's DNS is not hit constantly, short
 * enough that a phone getting a new address (DHCP renewal, reconnect) shows up
 * again without anyone restarting the server.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Strips the IPv4-mapped IPv6 prefix Node adds for an IPv4 client on a
 * dual-stack socket, e.g. "::ffff:192.168.10.50" -> "192.168.10.50". Without
 * this, matching a configured "192.168.10.50" against `request.ip` succeeds or
 * fails depending on which stack happened to accept the connection.
 */
export function normalizeAddress(ip: string): string {
  const prefix = "::ffff:";
  const lower = ip.toLowerCase();
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
}

/**
 * Splits a raw TRUSTED_HOSTS value into literal addresses and hostnames.
 * `config.ts`'s `str()` only trims the value as a whole, so each
 * comma-separated entry is trimmed here too — otherwise "a, b" would leave a
 * leading space on "b" and it would never match anything.
 */
export function parseTrustedHostList(raw: string): { literal: string[]; hostnames: string[] } {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const literal: string[] = [];
  const hostnames: string[] = [];
  for (const entry of entries) {
    if (net.isIP(entry) !== 0) literal.push(entry);
    else hostnames.push(entry);
  }
  return { literal, hostnames };
}

/** The subset of node:dns/promises this module needs — narrowed so tests can pass a fake. */
export interface HostnameResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/**
 * Holds the trusted-device list parsed from TRUSTED_HOSTS and, for hostname
 * entries, the addresses they last resolved to. Literal IPs are trusted
 * immediately; hostnames need `refresh()` to run at least once.
 *
 * Resolution is forward (hostname -> addresses), never reverse: reverse DNS is
 * unreliable on a home network and would make trust depend on the router's PTR
 * records, which nobody configures. A hostname can resolve to more than one
 * address (IPv4 and IPv6 both) — all of them are trusted.
 *
 * A hostname that fails to resolve keeps whatever addresses it last resolved
 * to instead of losing trust immediately. A single missed DNS query — the
 * router rebooting, a transient timeout — must not silently kick a trusted
 * phone off the list until the next successful poll five minutes later.
 */
export class TrustedHostRegistry {
  private readonly literalAddresses: Set<string>;
  private readonly hostnames: string[];
  private readonly hostnameAddresses = new Map<string, Set<string>>();
  private readonly resolver: HostnameResolver;
  private resolutionFailing = false;

  constructor(raw: string, resolver: HostnameResolver = dns) {
    const { literal, hostnames } = parseTrustedHostList(raw);
    this.literalAddresses = new Set(literal.map(normalizeAddress));
    this.hostnames = hostnames;
    this.resolver = resolver;
    for (const hostname of hostnames) this.hostnameAddresses.set(hostname, new Set());
  }

  /** How many entries are configured, regardless of whether they've resolved yet. */
  get configuredCount(): number {
    return this.literalAddresses.size + this.hostnames.length;
  }

  isTrusted(ip: string): boolean {
    const normalized = normalizeAddress(ip);
    if (this.literalAddresses.has(normalized)) return true;
    for (const addresses of this.hostnameAddresses.values()) {
      if (addresses.has(normalized)) return true;
    }
    return false;
  }

  /**
   * Resolves every configured hostname and updates the cache. Safe to call on
   * a schedule: never throws, and a hostname that fails this round keeps its
   * previous addresses (see class comment).
   */
  async refresh(): Promise<void> {
    if (this.hostnames.length === 0) return;

    let failedCount = 0;
    await Promise.all(
      this.hostnames.map(async (hostname) => {
        const [v4, v6] = await Promise.allSettled([this.resolver.resolve4(hostname), this.resolver.resolve6(hostname)]);
        const addresses = new Set<string>();
        if (v4.status === "fulfilled") for (const addr of v4.value) addresses.add(normalizeAddress(addr));
        if (v6.status === "fulfilled") for (const addr of v6.value) addresses.add(normalizeAddress(addr));

        if (addresses.size === 0) {
          failedCount += 1;
          return; // keep the previously resolved addresses for this hostname
        }
        this.hostnameAddresses.set(hostname, addresses);
      }),
    );

    // Only the failing <-> recovered edge is logged, matching how provider.ts
    // treats fetch failures: one line per state change, not one per poll. No
    // hostname or address is included — TRUSTED_HOSTS is a .env value.
    const failing = failedCount > 0;
    if (failing !== this.resolutionFailing) {
      if (failing) {
        logger.warn(
          { event: "trusted_host_resolve_failed", failedCount, total: this.hostnames.length },
          "trusted host name resolution failing",
        );
      } else {
        logger.warn({ event: "trusted_host_resolve_recovered" }, "trusted host name resolution recovered");
      }
      this.resolutionFailing = failing;
    }
  }

  /**
   * Starts periodic resolution. Logs a single startup line if anything is
   * configured — this loosens a security boundary, so it must be visible in
   * the log without anyone having to go looking for it — but never logs which
   * hosts, only the count.
   */
  start(intervalMs = REFRESH_INTERVAL_MS): void {
    if (this.configuredCount > 0) {
      logger.warn({ event: "trusted_hosts_configured", count: this.configuredCount }, "trusted hosts configured");
    }
    if (this.hostnames.length === 0) return;

    void this.refresh();
    setInterval(() => void this.refresh(), intervalMs);
  }
}

/** The list the running server actually uses, built from .env at startup. */
export const trustedHosts = new TrustedHostRegistry(config.trustedHosts);
