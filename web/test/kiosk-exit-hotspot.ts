/**
 * useLongPress.ts:n eleen tunnistus, jota KioskExitHotspot.vue käyttää
 * kioskista poistumisen näkymättömälle painikkeelle. Testataan pieniä
 * millisekunti-arvoja käyttäen (ei tuotannon 3000 ms), jotta testi pysyy
 * nopeana — logiikka on riippumaton siitä mikä holdMs on.
 *
 * Aja:  npm run test:kiosk-exit-hotspot --workspace=web
 */
import assert from "node:assert/strict";
import { createLongPressTracker, type PointerLike } from "../src/composables/useLongPress.ts";

const HOLD_MS = 20;
const MOVE_TOLERANCE_PX = 10;

function pointer(pointerId: number, clientX: number, clientY: number): PointerLike {
  return { pointerId, clientX, clientY };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testHoldingStillTriggersAfterHoldMs(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 1, "paikallaan pysyvä painallus pitää laueta HOLD_MS:n jälkeen");
  console.log("ok  paikallaan pysyvä painallus laukeaa kerran HOLD_MS:n jälkeen");
}

async function testLiftingBeforeHoldMsNeverTriggers(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  await wait(HOLD_MS / 2);
  tracker.onPointerUp(pointer(1, 10, 10));
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 0, "nosto ennen HOLD_MS:ää ei saa koskaan laueta myöhemmin");
  console.log("ok  liian lyhyt painallus (nostettu kesken) ei laukea");
}

async function testMovingBeyondToleranceCancelsEvenIfHeldLongEnough(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  tracker.onPointerMove(pointer(1, 10 + MOVE_TOLERANCE_PX + 5, 10)); // pyyhkäisy — ylittää toleranssin heti
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 0, "pyyhkäisy tai rätin liike ei saa laueta vaikka kosketus kestäisi HOLD_MS:n verran");
  console.log("ok  liike toleranssin yli peruuttaa eleen (pyyhkäisy ei laukea)");
}

async function testSmallJitterWithinToleranceStillTriggers(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  tracker.onPointerMove(pointer(1, 12, 11)); // pieni tärähdys, alle toleranssin
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 1, "pieni, toleranssin sisään jäävä liike ei saa peruuttaa aitoa painallusta");
  console.log("ok  pieni tärähdys toleranssin sisällä ei peruuta laukeamista");
}

async function testPointerCancelStopsTheHold(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  tracker.onPointerCancel(pointer(1, 10, 10));
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 0, "pointercancel (esim. selain ottaa kosketuksen käsittelyyn) pitää perua ajastimen");
  console.log("ok  pointercancel perii kesken olevan painalluksen");
}

async function testSecondPointerDuringHoldIsIgnored(): Promise<void> {
  let triggered = 0;
  const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => triggered++);
  tracker.onPointerDown(pointer(1, 10, 10));
  tracker.onPointerDown(pointer(2, 50, 50)); // toinen sormi samaan aikaan — ei saa käynnistää omaa ajastintaan eikä häiritä ensimmäistä
  tracker.onPointerUp(pointer(2, 50, 50));
  await wait(HOLD_MS + 15);
  assert.equal(triggered, 1, "ensimmäisen sormen painallus ei saa häiriintyä toisesta sormesta, eikä toinen sormi saa laukaista mitään itse");
  console.log("ok  toinen sormi kesken painalluksen ei käynnistä uutta ajastinta eikä keskeytä ensimmäistä");
}

await testHoldingStillTriggersAfterHoldMs();
await testLiftingBeforeHoldMsNeverTriggers();
await testMovingBeyondToleranceCancelsEvenIfHeldLongEnough();
await testSmallJitterWithinToleranceStillTriggers();
await testPointerCancelStopsTheHold();
await testSecondPointerDuringHoldIsIgnored();

console.log("\nall kiosk-exit-hotspot tests passed");
process.exit(0);
