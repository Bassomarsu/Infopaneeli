/**
 * Kioskista poistumisen (POST /api/kiosk/exit, server/src/routes/api.ts)
 * pääsynvalvonta: access.ts:n verifyFullPinOnly ja isLocalRequest. Reitti
 * itse vaatii MOLEMMAT — tämä testaa kumpaakin erikseen, koska reitin
 * kokoaminen (Fastify-instanssi + oikea HTTP-pyyntö) ei ole tarpeen sen
 * todentamiseksi että itse pääsylogiikka on oikein, ja se altistaisi
 * testin käynnistämään oikean kioskiselaimen sulkevan exitKiosk-kutsun
 * (ks. kiosk.ts:n oma testi, joka injektoi sen pois).
 *
 * Tämä tiedosto olettaa molemmat koodit asetetuiksi (ks.
 * edit-pin-test-env.ts) — tyhjän/liian lyhyen FULL_PIN:n käyttäytymistä
 * testaavat kiosk-exit-disabled.ts ja kiosk-exit-full-too-short.ts omina
 * prosesseinaan.
 *
 * Aja:  npm run test:kiosk-exit --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, isLocalRequest, verifyFullPinOnly } from "../src/routes/access.ts";

assert.equal(config.editPin, "4242", "testin oletus: EDIT_PIN on asetettu edit-pin-test-env.ts:ssä");
assert.equal(config.fullPin, "424242", "testin oletus: FULL_PIN on asetettu edit-pin-test-env.ts:ssä");
assert.equal(fullPinEnabled, true, "kuusimerkkinen FULL_PIN pitää olla käytössä");

interface FakeReplyState {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
}

function fakeReply(): { reply: FastifyReply; state: FakeReplyState } {
  const state: FakeReplyState = { statusCode: null, body: null, headers: {} };
  const reply = {
    code(statusCode: number) {
      state.statusCode = statusCode;
      return reply;
    },
    header(name: string, value: string) {
      state.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function fakeRequest(ip: string): FastifyRequest {
  return { ip } as unknown as FastifyRequest;
}

function testIsLocalRequestAcceptsOnlyLoopback(): void {
  assert.equal(isLocalRequest(fakeRequest("127.0.0.1")), true);
  assert.equal(isLocalRequest(fakeRequest("::1")), true);
  assert.equal(isLocalRequest(fakeRequest("::ffff:127.0.0.1")), true);
  assert.equal(isLocalRequest(fakeRequest("192.168.1.50")), false, "kotiverkon puhelin ei ole paikallinen pyyntö");
  console.log("ok  isLocalRequest hyväksyy vain silmukkaosoitteen — reitti käyttää tätä eikä isTrustedRequestia");
}

// Jokainen testi käyttää omaa väärennettyä IP-osoitettaan, jotta jaettu
// rajoitin (sama mekanismi kuin muillakin PIN-yrityksillä, ks. access.ts:n
// attemptPin) ei kanna tilaa testistä toiseen — sama kikka kuin
// edit-access.ts:ssä. Todellisuudessa tämän reitin kutsuja on aina
// "127.0.0.1" (isLocalRequest-portti reitillä varmistaa sen), mutta
// rajoitin itsessään on yleinen minkä tahansa lähteen suhteen, ja se on
// juuri se mitä testataan.

function testCorrectFullPinGrantsExit(): void {
  const { reply, state } = fakeReply();
  assert.equal(verifyFullPinOnly(fakeRequest("127.0.0.10"), reply, config.fullPin), true);
  assert.equal(state.statusCode, null);
  console.log("ok  oikea FULL_PIN läpäisee verifyFullPinOnlyn");
}

function testEditPinDoesNotGrantExit(): void {
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.11"), reply, config.editPin);
  assert.equal(ok, false, "EDIT_PIN EI SAA riittää kioskista poistumiseen — se on korkeampi valtuus kuin muistilistan muokkaus");
  assert.equal(state.statusCode, 403, "EDIT_PIN saa oman, selittävän 403:n eikä näyttäydy tavallisena vääränä koodina");
  console.log("ok  kelvollinen EDIT_PIN ei riitä kioskista poistumiseen (403, ei 200)");
}

function testWrongCodeIsRejected(): void {
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.12"), reply, "000000");
  assert.equal(ok, false);
  assert.equal(state.statusCode, 401);
  console.log("ok  väärä koodi hylätään 401:llä");
}

function testAbsentCodeIsRejected(): void {
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.13"), reply, undefined);
  assert.equal(ok, false);
  assert.equal(state.statusCode, 401);
  console.log("ok  puuttuva koodi hylätään 401:llä");
}

function testSharedLimiterLocksOutAfterFiveWrongAttempts(): void {
  const ip = "127.0.0.14";
  for (let i = 0; i < 5; i++) {
    const { reply, state } = fakeReply();
    verifyFullPinOnly(fakeRequest(ip), reply, `wrong-${i}`);
    assert.equal(state.statusCode, 401, `yritys ${i + 1}/5 ei vielä lukittu`);
  }
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest(ip), reply, config.fullPin);
  assert.equal(ok, false, "lukitus estää myös oikean FULL_PINin");
  assert.equal(state.statusCode, 429);
  assert.ok(typeof state.headers["retry-after"] === "string");
  console.log("ok  viisi väärää yritystä lukitsee lähteen myös kioskista-poistumisreitiltä (sama jaettu rajoitin)");
}

testIsLocalRequestAcceptsOnlyLoopback();
testCorrectFullPinGrantsExit();
testEditPinDoesNotGrantExit();
testWrongCodeIsRejected();
testAbsentCodeIsRejected();
testSharedLimiterLocksOutAfterFiveWrongAttempts();

console.log("\nall kiosk-exit tests passed");
process.exit(0);
