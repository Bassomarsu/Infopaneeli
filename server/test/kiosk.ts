/**
 * core/kiosk.ts on ainoa keino poistua kioskitilasta — selain ei voi tehdä
 * sitä itselleen, joten palvelin sulkee kioskiselaimen prosessin
 * (server/src/routes/api.ts:n POST /api/kiosk/exit, PIN-todennuksen
 * jälkeen). Tämä testaa VAIN exitKiosk-funktion alustakohtaisen valinnan ja
 * poistumiskoodien tulkinnan — platform ja runner ovat injektoitavissa juuri
 * siksi ettei yksikään testi koskaan käynnistä oikeaa taskkill/pkill-
 * komentoa eikä sulje oikeaa kehityskoneen selainta.
 *
 * Aja:  npm run test:kiosk --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { exitKiosk, type CommandRunner } from "../src/core/kiosk.ts";

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeRunner(behavior: (call: RecordedCall) => void): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    behavior(call);
  };
  return { runner, calls };
}

function exitError(code: number): Error & { code: number } {
  const err = new Error(`komento palautti koodin ${code}`) as Error & { code: number };
  err.code = code;
  return err;
}

async function testWindowsKillsMsedgeByImageName(): Promise<void> {
  const { runner, calls } = fakeRunner(() => {});
  const result = await exitKiosk("win32", runner);
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.command, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/IM", "msedge.exe", "/F"], "Windowsilla suljetaan msedge.exe kovakoodatulla nimellä, ei pyynnöstä otetulla");
  console.log("ok  win32-alustalla exitKiosk kutsuu taskkill /IM msedge.exe /F");
}

async function testLinuxKillsChromiumByFixedProfileString(): Promise<void> {
  const { runner, calls } = fakeRunner(() => {});
  const result = await exitKiosk("linux", runner);
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.command, "pkill");
  assert.deepEqual(calls[0]?.args, ["-f", "infonaytto-chromium"], "Linuxilla suljetaan pkill -f kiinteällä profiilikansion nimellä");
  console.log("ok  linux-alustalla exitKiosk kutsuu pkill -f infonaytto-chromium");
}

async function testWindowsAlreadyClosedIsNotAnError(): Promise<void> {
  const { runner } = fakeRunner(() => {
    throw exitError(128); // taskkillin "prosessia ei löytynyt" -koodi
  });
  const result = await exitKiosk("win32", runner);
  assert.equal(result.ok, true, "kioski joka on jo kiinni ei saa näyttäytyä virheenä");
  console.log("ok  taskkillin koodi 128 (prosessia ei löytynyt) tulkitaan onnistumiseksi");
}

async function testLinuxAlreadyClosedIsNotAnError(): Promise<void> {
  const { runner } = fakeRunner(() => {
    throw exitError(1); // pkillin "yhtään täsmäävää prosessia ei löytynyt" -koodi
  });
  const result = await exitKiosk("linux", runner);
  assert.equal(result.ok, true, "kioski joka on jo kiinni ei saa näyttäytyä virheenä");
  console.log("ok  pkillin koodi 1 (ei täsmääviä prosesseja) tulkitaan onnistumiseksi");
}

async function testRealFailureIsReportedAsError(): Promise<void> {
  const { runner } = fakeRunner(() => {
    throw exitError(2); // jokin muu virhe kuin "ei löytynyt"
  });
  const result = await exitKiosk("win32", runner);
  assert.equal(result.ok, false, "muu poistumiskoodi kuin 'ei löytynyt' on oikea virhe");
  assert.ok(result.error, "virheestä pitää jäädä selite jatkokäsittelyä varten");
  console.log("ok  todellinen virhe (muu koodi kuin 'ei löytynyt') raportoidaan epäonnistumisena");
}

async function testUnsupportedPlatformFailsCleanly(): Promise<void> {
  const { runner, calls } = fakeRunner(() => {});
  const result = await exitKiosk("darwin", runner);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "tuntemattomalla alustalla ei pidä yrittää suorittaa mitään komentoa");
  console.log("ok  tukematon alusta epäonnistuu selkeästi eikä yritä suorittaa mitään");
}

await testWindowsKillsMsedgeByImageName();
await testLinuxKillsChromiumByFixedProfileString();
await testWindowsAlreadyClosedIsNotAnError();
await testLinuxAlreadyClosedIsNotAnError();
await testRealFailureIsReportedAsError();
await testUnsupportedPlatformFailsCleanly();

console.log("\nall kiosk tests passed");
process.exit(0);
