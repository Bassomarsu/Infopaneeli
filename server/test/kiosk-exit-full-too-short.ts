/**
 * Kioskista poistumisen (verifyFullPinOnly, server/src/routes/access.ts)
 * käyttäytyminen kun FULL_PIN on asetettu mutta alle kuusi merkkiä
 * (access.ts:n FULL_PIN_MIN_LENGTH). Sama periaate kuin
 * edit-access-full-too-short.ts:ssä: liian lyhyt FULL_PIN EI OTA tasoa
 * käyttöön lainkaan, joten kioskista poistuminen pitää olla kokonaan pois
 * käytöstä — VAIKKA annettu koodi täsmäisi tarkalleen siihen liian lyhyeen
 * arvoon. Oma prosessinsa: config.ts lukee ympäristömuuttujat vain kerran
 * moduulin latautuessa.
 *
 * Aja:  npm run test:kiosk-exit-full-too-short --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-full-too-short-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, verifyFullPinOnly } from "../src/routes/access.ts";

assert.equal(config.editPin, "1357", "testin oletus: EDIT_PIN on asetettu tässä ajossa");
assert.equal(config.fullPin, "123", "testin oletus: FULL_PIN on asetettu mutta alle 6 merkkiä tässä ajossa");
assert.equal(fullPinEnabled, false, "alle 6 merkin FULL_PIN ei saa olla käytössä");

interface FakeReplyState {
  statusCode: number | null;
  body: unknown;
}

function fakeReply(): { reply: FastifyReply; state: FakeReplyState } {
  const state: FakeReplyState = { statusCode: null, body: null };
  const reply = {
    code(statusCode: number) {
      state.statusCode = statusCode;
      return reply;
    },
    header() {
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

function testExactMatchOnTooShortFullPinStillDoesNotGrantExit(): void {
  const { reply, state } = fakeReply();
  // Annetaan TÄSMÄLLEEN se merkkijono joka on .env:ssä FULL_PIN:inä — tämän PITÄÄ silti epäonnistua.
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.1"), reply, config.fullPin);
  assert.equal(ok, false, "liian lyhyt FULL_PIN ei saa avata kioskista poistumista vaikka annettu arvo täsmäisi tarkalleen");
  assert.equal(state.statusCode, 403, "kohdellaan 'ominaisuus pois käytöstä' -tilanteena, ei väärän koodin 401:nä");
  console.log("ok  liian lyhyt FULL_PIN ei avaa kioskista poistumista, vaikka annettu koodi täsmäisi tarkalleen konfiguroituun arvoon");
}

function testValidEditPinStillDoesNotGrantExitEither(): void {
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.2"), reply, config.editPin);
  assert.equal(ok, false, "kelvollinen EDIT_PIN ei koskaan riitä, ei tässäkään asetuksessa");
  assert.equal(state.statusCode, 403);
  console.log("ok  kelvollinen EDIT_PIN ei riitä kioskista poistumiseen kun FULL_PIN on liian lyhyt ja siksi pois käytöstä");
}

testExactMatchOnTooShortFullPinStillDoesNotGrantExit();
testValidEditPinStillDoesNotGrantExitEither();

console.log("\nall kiosk-exit-full-too-short tests passed");
process.exit(0);
