/**
 * Verifies the pure month-average logic in price-history.ts without hitting
 * Elering, plus one live smoke test that the real endpoint still answers the
 * way this module expects.
 *
 * Run with:  npm run test:prices --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { aggregateMonth, expectedHoursFor, monthKeyOf, shiftMonthKey } from "../src/providers/price-history.ts";

function testShiftMonthKey(): void {
  assert.equal(shiftMonthKey("2026-08", -1), "2026-07");
  assert.equal(shiftMonthKey("2026-01", -1), "2025-12", "must cross a year boundary going back");
  assert.equal(shiftMonthKey("2026-12", 1), "2027-01", "must cross a year boundary going forward");
  assert.equal(shiftMonthKey("2026-08", 0), "2026-08");
  console.log("ok  shiftMonthKey crosses year boundaries correctly");
}

function testMonthKeyOf(): void {
  assert.equal(monthKeyOf(2026, 8), "2026-08");
  assert.equal(monthKeyOf(2026, 1), "2026-01", "single-digit month must be zero-padded");
  console.log("ok  monthKeyOf pads the month");
}

function testExpectedHoursForPastMonth(): void {
  // July 2026 has 31 days.
  assert.equal(expectedHoursFor("2026-07", false), 31 * 24);
  // February 2026 is not a leap year.
  assert.equal(expectedHoursFor("2026-02", false), 28 * 24);
  console.log("ok  expectedHoursFor returns the full month for a past month");
}

function testExpectedHoursForCurrentMonth(): void {
  // 2026-08-07 05:09 local: 6 full days elapsed (1st-6th) plus hour 5 of the 7th, inclusive.
  const now = new Date("2026-08-07T02:09:00.000Z"); // 05:09 Europe/Helsinki in August (UTC+3)
  const expected = (7 - 1) * 24 + 5 + 1;
  assert.equal(expectedHoursFor("2026-08", true, now), expected);
  console.log("ok  expectedHoursFor counts elapsed local hours for the current month");
}

/**
 * Europe/Helsinki DST transitions for 2026, found by scanning the real UTC
 * offset (not assumed): spring-forward at 2026-03-29T01:00:00Z (clocks jump
 * 03:00 -> 04:00 local, so local 03:00-03:59 does not exist that day), and
 * fall-back at 2026-10-25T01:00:00Z (clocks step back 04:00 -> 03:00 local,
 * so local 03:00-03:59 happens twice). A "days * 24" formula is off by one
 * hour in both directions; expectedHoursFor must not be.
 */
function testExpectedHoursForMarchDstSpringForward(): void {
  assert.equal(
    expectedHoursFor("2026-03", false),
    31 * 24 - 1,
    "March 2026 has one fewer real hour due to the spring-forward gap",
  );
  console.log("ok  expectedHoursFor accounts for March 2026's spring-forward missing hour (743 h)");
}

function testExpectedHoursForOctoberDstFallBack(): void {
  assert.equal(
    expectedHoursFor("2026-10", false),
    31 * 24 + 1,
    "October 2026 has one extra real hour due to the fall-back repeat",
  );
  console.log("ok  expectedHoursFor accounts for October 2026's fall-back extra hour (745 h)");
}

/**
 * Builds synthetic Elering-shaped quotes: `hoursPerDay` samples per local day
 * (1 = hourly resolution, 4 = 15-minute resolution), each holding the same
 * EUR/MWh price so the expected snt/kWh average is easy to state by hand.
 */
function fakeQuotes(monthKey: string, days: number, hoursPerDay: number, eurPerMwh: number) {
  const [y, m] = monthKey.split("-").map(Number);
  const quotes: { timestamp: number; price: number }[] = [];
  for (let day = 1; day <= days; day++) {
    for (let hour = 0; hour < 24; hour++) {
      for (let sub = 0; sub < hoursPerDay; sub++) {
        // Helsinki is UTC+2/+3; using UTC noon-ish keeps every sample safely
        // inside the same local day regardless of season for this synthetic test.
        const utcMs = Date.UTC(y ?? 2026, (m ?? 1) - 1, day, hour - 3, sub * (60 / hoursPerDay));
        quotes.push({ timestamp: Math.floor(utcMs / 1000), price: eurPerMwh });
      }
    }
  }
  return quotes;
}

function testAggregateMonthUnitAndVatConversion(): void {
  // 100 EUR/MWh -> 0.1 snt/kWh per EUR/MWh factor -> 10 snt/kWh excl. VAT
  // -> * 1.255 VAT multiplier = 12.55 snt/kWh incl. VAT.
  const quotes = fakeQuotes("2026-07", 31, 1, 100);
  const result = aggregateMonth(quotes, "2026-07", false);
  assert.equal(result.month, "2026-07");
  assert.equal(result.label, "Heinäkuu 2026");
  assert.equal(result.knownHours, 31 * 24, "a full month of hourly quotes must produce 31*24 known hours");
  assert.equal(result.expectedHours, 31 * 24);
  assert.ok(result.average !== null);
  assert.ok(
    Math.abs((result.average ?? 0) - 12.55) < 1e-9,
    `expected 12.55 snt/kWh incl. VAT, got ${result.average}`,
  );
  console.log("ok  aggregateMonth converts EUR/MWh excl. VAT to snt/kWh incl. VAT correctly");
}

function testAggregateMonthAveragesFifteenMinuteResolutionSameAsHourly(): void {
  // Four 15-minute quotes at the same price per hour must average out to the
  // exact same monthly figure as one hourly quote at that price — resolution
  // must not bias the result.
  const hourly = aggregateMonth(fakeQuotes("2026-08", 5, 1, 80), "2026-08", false);
  const quarterHourly = aggregateMonth(fakeQuotes("2026-08", 5, 4, 80), "2026-08", false);
  assert.equal(hourly.knownHours, quarterHourly.knownHours, "hour count must match regardless of source resolution");
  assert.ok(
    Math.abs((hourly.average ?? 0) - (quarterHourly.average ?? 0)) < 1e-9,
    "15-minute and hourly resolution at the same price must average identically",
  );
  console.log("ok  aggregateMonth is resolution-independent");
}

function testAggregateMonthIgnoresOtherMonthsInThePaddedQuery(): void {
  // Simulates the day-of-padding on each side of the query window: quotes
  // that fall outside the target local month must not be counted.
  const julQuotes = fakeQuotes("2026-07", 31, 1, 50);
  const junStray = fakeQuotes("2026-06", 1, 1, 999)[0]!; // one stray hour from June
  const augStray = fakeQuotes("2026-08", 1, 1, 999)[0]!; // one stray hour from August
  const result = aggregateMonth([junStray, ...julQuotes, augStray], "2026-07", false);
  assert.equal(result.knownHours, 31 * 24, "stray hours from neighbouring months must be filtered out");
  console.log("ok  aggregateMonth filters out quotes outside the target local month");
}

/**
 * One quote per real UTC hour across a padded window around monthKey, at a
 * fixed price. Unlike fakeQuotes() above — which assumes a fixed UTC+3 offset
 * per local day/hour and would itself misrepresent a DST-transition month —
 * this walks real elapsed hours directly, the same way expectedHoursFor()
 * does, so it is a faithful stand-in for what Elering actually returns.
 */
function fakeQuotesForRealHours(monthKey: string, eurPerMwh: number): { timestamp: number; price: number }[] {
  const [y, m] = monthKey.split("-").map(Number);
  const scanStart = Date.UTC(y ?? 2026, (m ?? 1) - 1, 1) - 24 * 3_600_000;
  const scanEnd = Date.UTC(y ?? 2026, m ?? 1, 1) + 24 * 3_600_000;
  const quotes: { timestamp: number; price: number }[] = [];
  for (let t = scanStart; t < scanEnd; t += 3_600_000) {
    quotes.push({ timestamp: t / 1000, price: eurPerMwh });
  }
  return quotes;
}

function testAggregateMonthMarchDstSpringForward(): void {
  const quotes = fakeQuotesForRealHours("2026-03", 50);
  const result = aggregateMonth(quotes, "2026-03", false);
  assert.equal(result.knownHours, 31 * 24 - 1, "March 2026 has one fewer real hour (spring-forward gap)");
  assert.equal(result.expectedHours, 31 * 24 - 1);
  console.log("ok  aggregateMonth counts exactly 743 real hours for March 2026 (spring-forward)");
}

function testAggregateMonthOctoberDstFallBack(): void {
  const quotes = fakeQuotesForRealHours("2026-10", 50);
  const result = aggregateMonth(quotes, "2026-10", false);
  assert.equal(result.knownHours, 31 * 24 + 1, "October 2026 has one extra real hour (fall-back repeat)");
  assert.equal(result.expectedHours, 31 * 24 + 1);
  console.log("ok  aggregateMonth counts exactly 745 real hours for October 2026 (fall-back)");
}

/**
 * The regression this whole fix is about: a wall-clock hour key ("2026-10-25T03")
 * would merge the two real hours that both read as local 03:00 on 25 October
 * 2026 into a single bucket, dropping one hour and blending two different
 * prices into one. Bucketing by real UTC hour must keep them apart.
 */
function testAggregateMonthKeepsBothOctoberDstHoursSeparate(): void {
  const eestOccurrence = Date.UTC(2026, 9, 25, 0, 0, 0) / 1000; // first local 03:00 (EEST, UTC+3)
  const eetOccurrence = Date.UTC(2026, 9, 25, 1, 0, 0) / 1000; // second local 03:00 (EET, UTC+2)

  const baseline = fakeQuotesForRealHours("2026-10", 50).filter(
    (q) => q.timestamp !== eestOccurrence && q.timestamp !== eetOccurrence,
  );
  const quotes = [...baseline, { timestamp: eestOccurrence, price: 0 }, { timestamp: eetOccurrence, price: 1000 }];

  const result = aggregateMonth(quotes, "2026-10", false);
  const totalHours = 31 * 24 + 1;
  assert.equal(result.knownHours, totalHours, "both DST-duplicate local hours must count as separate known hours");

  // If the two had been merged into one bucket, that bucket would average to
  // 500 EUR/MWh and contribute only once, dropping the true hour count by one
  // and shifting the month average. Checking the exact average — not just the
  // hour count — catches a merge that happens to preserve the count by luck.
  const expectedEurSum = 50 * (totalHours - 2) + 0 + 1000;
  const expectedAverage = (expectedEurSum / totalHours) * 0.1 * 1.255;
  assert.ok(
    Math.abs((result.average ?? 0) - expectedAverage) < 1e-6,
    `expected average ${expectedAverage}, got ${result.average}`,
  );
  console.log("ok  aggregateMonth keeps both October DST occurrences of local 03:00 as separate hours");
}

function testAggregateMonthHandlesNoData(): void {
  const result = aggregateMonth([], "2026-08", true);
  assert.equal(result.average, null);
  assert.equal(result.knownHours, 0);
  console.log("ok  aggregateMonth returns a null average instead of NaN when there is no data");
}

/**
 * Real network call against Elering — confirms the source this module
 * depends on is still shaped the way the rest of the tests assume: a `fi`
 * price series keyed by EUR/MWh. Deliberately bypasses getMonthlyAverages()
 * so this test does not write into the real project database — it calls
 * Elering directly and feeds the result through the same aggregateMonth()
 * the production code uses. Not a substitute for the unit tests above.
 *
 * Opt-in via `ELERING_LIVE=1`, because `npm test` is meant to run without a
 * network. A check that silently "skips" whenever the network hiccups is worse
 * than no check at all: it makes the suite non-deterministic while still
 * reading as a pass.
 */
async function testLiveEleringShape(): Promise<void> {
  if (process.env["ELERING_LIVE"] !== "1") {
    console.log("skip live Elering check — aja ELERING_LIVE=1 jos haluat todentaa lähteen");
    return;
  }
  try {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    start.setUTCDate(start.getUTCDate() - 1);
    const url = `https://dashboard.elering.ee/api/nps/price?start=${start.toISOString()}&end=${now.toISOString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, `Elering must answer 200, got ${response.status}`);
    const body = (await response.json()) as { success: boolean; data: Record<string, { timestamp: number; price: number }[]> };
    assert.ok(Array.isArray(body.data?.fi), "Elering response must carry a fi price series");
    assert.ok(body.data.fi.length > 0, "fi price series must not be empty for the current month so far");

    const result = aggregateMonth(body.data.fi, monthKey, true);
    assert.ok(result.knownHours > 0, "current month should have at least some known hours");
    assert.ok(
      result.average === null || (result.average > -50 && result.average < 200),
      `current month average out of a sane snt/kWh range: ${result.average}`,
    );
    console.log(
      `ok  live Elering check — ${result.month} avg=${result.average?.toFixed(2)} snt/kWh ` +
        `(${result.knownHours} known hours)`,
    );
  } catch (err) {
    console.log("skip live Elering check —", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Elering answers with tomorrow's already-published prices too. Counting them
 * gave more known hours than the month had elapsed — the card showed a coverage
 * of 169/153, which is impossible and reads as broken. Found against real data,
 * so it is locked down here.
 */
function testCurrentMonthIgnoresHoursThatHaveNotHappenedYet(): void {
  // Paikallinen 7.8.2026 klo 13:30 Helsingissä on 10:30 UTC (kesäaika, +3).
  const now = new Date(Date.UTC(2026, 7, 7, 10, 30));
  const expected = (7 - 1) * 24 + 13 + 1;

  // Tunnit paikallisen elokuun alusta selvästi yli nykyhetken (9.8. asti).
  const quotes = [];
  const firstLocalHourUtc = Date.UTC(2026, 6, 31, 21, 0, 0); // = 1.8. klo 00 paikallista
  for (let i = 0; i < 9 * 24; i += 1) {
    quotes.push({ timestamp: (firstLocalHourUtc + i * 3_600_000) / 1000, price: 20 });
  }

  const result = aggregateMonth(quotes, "2026-08", true, now);

  assert.equal(result.expectedHours, expected);
  assert.equal(
    result.knownHours,
    expected,
    `future hours must be dropped: got ${result.knownHours}, expected ${expected}`,
  );
  assert.ok(
    result.knownHours <= result.expectedHours,
    "a month can never have more known hours than have elapsed",
  );
  console.log("ok  current month ignores hours that have not happened yet");
}

testShiftMonthKey();
testMonthKeyOf();
testExpectedHoursForPastMonth();
testExpectedHoursForCurrentMonth();
testExpectedHoursForMarchDstSpringForward();
testExpectedHoursForOctoberDstFallBack();
testAggregateMonthUnitAndVatConversion();
testAggregateMonthAveragesFifteenMinuteResolutionSameAsHourly();
testAggregateMonthIgnoresOtherMonthsInThePaddedQuery();
testAggregateMonthMarchDstSpringForward();
testAggregateMonthOctoberDstFallBack();
testAggregateMonthKeepsBothOctoberDstHoursSeparate();
testAggregateMonthHandlesNoData();
testCurrentMonthIgnoresHoursThatHaveNotHappenedYet();
await testLiveEleringShape();

console.log("\nall price-history tests passed");
process.exit(0);
