/**
 * TRUSTED_HOSTS lets a device other than the wall display get the same access
 * as localhost (see routes/access.ts and core/trusted-hosts.ts). Wrong here
 * means either a stranger's phone seeing the children's Wilma data, or a
 * trusted phone silently losing access it should have — both are worth
 * pinning down without needing a real network or a real DNS server.
 *
 * Run with:  npm run test:trusted-hosts --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { normalizeAddress, parseTrustedHostList, TrustedHostRegistry, type HostnameResolver } from "../src/core/trusted-hosts.ts";

function fakeResolver(v4: () => Promise<string[]>, v6: () => Promise<string[]>): HostnameResolver {
  return { resolve4: v4, resolve6: v6 };
}

function rejects(): Promise<string[]> {
  return Promise.reject(new Error("ENOTFOUND"));
}

function testEmptyListIsTodaysBehaviour(): void {
  const registry = new TrustedHostRegistry("");
  assert.equal(registry.configuredCount, 0, "empty TRUSTED_HOSTS must configure nothing");
  assert.equal(registry.isTrusted("192.168.10.50"), false, "no address is trusted with an empty list");
  assert.equal(registry.isTrusted("127.0.0.1"), false, "localhost is not this class's concern — isLocalRequest handles that separately");
  console.log("ok  an empty TRUSTED_HOSTS trusts nothing, matching today's behaviour");
}

function testLiteralIpMatchesExactly(): void {
  const registry = new TrustedHostRegistry("192.168.10.50");
  assert.equal(registry.isTrusted("192.168.10.50"), true, "the configured address must be trusted");
  assert.equal(registry.isTrusted("192.168.10.51"), false, "a neighbouring address must not be trusted");
  console.log("ok  a literal IP in TRUSTED_HOSTS matches exactly and nothing else");
}

function testIpv6MappedAddressIsNormalized(): void {
  const registry = new TrustedHostRegistry("192.168.10.50");
  assert.equal(
    registry.isTrusted("::ffff:192.168.10.50"),
    true,
    "the IPv4-mapped IPv6 form Node hands out on a dual-stack socket must match the plain IPv4 entry",
  );

  const mappedEntry = new TrustedHostRegistry("::ffff:192.168.10.60");
  assert.equal(mappedEntry.isTrusted("192.168.10.60"), true, "normalization must also apply to how the .env entry itself was written");
  console.log("ok  ::ffff:-mapped addresses are normalized both when configured and when matched");
}

function testUntrustedAddressIsRejected(): void {
  const registry = new TrustedHostRegistry("192.168.10.50,192.168.10.51");
  assert.equal(registry.isTrusted("10.0.0.5"), false, "an address never listed must not be trusted");
  console.log("ok  an address outside the configured list is rejected");
}

function testParsingTrimsEntriesAndSplitsHostnamesFromIps(): void {
  const { literal, hostnames } = parseTrustedHostList(" 192.168.10.50 , puhelin.local ,, ::1 ");
  assert.deepEqual(literal, ["192.168.10.50", "::1"], "literal IPv4 and IPv6 entries must be recognised and trimmed");
  assert.deepEqual(hostnames, ["puhelin.local"], "a non-IP entry must be treated as a hostname, and trimmed, and empty entries dropped");
  console.log("ok  parseTrustedHostList trims each comma-separated entry and separates literal IPs from hostnames");
}

async function testHostnameResolutionGrantsTrust(): Promise<void> {
  const resolver = fakeResolver(() => Promise.resolve(["192.168.10.77"]), rejects);
  const registry = new TrustedHostRegistry("puhelin.local", resolver);

  assert.equal(registry.isTrusted("192.168.10.77"), false, "a hostname must not be trusted before it has ever resolved");
  await registry.refresh();
  assert.equal(registry.isTrusted("192.168.10.77"), true, "the address a hostname resolved to must become trusted");
  assert.equal(registry.isTrusted("192.168.10.78"), false, "an unrelated address must stay untrusted");
  console.log("ok  a hostname becomes trusted once it resolves");
}

async function testHostnameWithBothAddressFamiliesTrustsBoth(): Promise<void> {
  const resolver = fakeResolver(() => Promise.resolve(["192.168.10.10"]), () => Promise.resolve(["fe80::1234"]));
  const registry = new TrustedHostRegistry("dual.local", resolver);
  await registry.refresh();
  assert.equal(registry.isTrusted("192.168.10.10"), true, "the IPv4 address must be trusted");
  assert.equal(registry.isTrusted("fe80::1234"), true, "the IPv6 address must also be trusted");
  console.log("ok  a hostname resolving to both an IPv4 and an IPv6 address trusts both");
}

async function testFailedResolutionKeepsThePreviousAddress(): Promise<void> {
  let shouldFail = false;
  const resolver = fakeResolver(() => (shouldFail ? rejects() : Promise.resolve(["192.168.10.90"])), rejects);
  const registry = new TrustedHostRegistry("flaky.local", resolver);

  await registry.refresh();
  assert.equal(registry.isTrusted("192.168.10.90"), true, "must be trusted after the first successful resolution");

  shouldFail = true;
  await registry.refresh();
  assert.equal(
    registry.isTrusted("192.168.10.90"),
    true,
    "a single failed resolution round must not drop a previously resolved address — a transient DNS blip must not silently untrust a device",
  );
  console.log("ok  a failed resolution round keeps the address from the last successful one");
}

function testNormalizeAddressStripsOnlyTheIpv4MappedPrefix(): void {
  assert.equal(normalizeAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeAddress("192.168.10.50"), "192.168.10.50", "a plain address must pass through unchanged");
  assert.equal(normalizeAddress("::1"), "::1", "a native IPv6 address without the mapped prefix must pass through unchanged");
  console.log("ok  normalizeAddress only strips the ::ffff: prefix, nothing else");
}

testEmptyListIsTodaysBehaviour();
testLiteralIpMatchesExactly();
testIpv6MappedAddressIsNormalized();
testUntrustedAddressIsRejected();
testParsingTrimsEntriesAndSplitsHostnamesFromIps();
testNormalizeAddressStripsOnlyTheIpv4MappedPrefix();
await testHostnameResolutionGrantsTrust();
await testHostnameWithBothAddressFamiliesTrustsBoth();
await testFailedResolutionKeepsThePreviousAddress();

console.log("\nall trusted-hosts tests passed");
process.exit(0);
