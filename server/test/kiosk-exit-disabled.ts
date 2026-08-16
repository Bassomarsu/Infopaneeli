/**
 * Kioskista poistumisen (verifyFullPinOnly, server/src/routes/access.ts)
 * käyttäytyminen kun kumpikaan koodi ei ole asetettu. Näkymätön painike ei
 * saa tässä tilassa olla reitti pois kioskitilasta ILMAN todennusta — se
 * olisi selvästi huonompi kuin ominaisuuden puuttuminen kokonaan (ks.
 * tiimin vaatimus). Oma prosessinsa: config.ts lukee ympäristömuuttujat
 * vain kerran moduulin latautuessa.
 *
 * Aja:  npm run test:kiosk-exit-disabled --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-empty-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, verifyFullPinOnly } from "../src/routes/access.ts";

assert.equal(config.editPin, "", "testin oletus: EDIT_PIN on tyhjä tässä ajossa");
assert.equal(config.fullPin, "", "testin oletus: FULL_PIN on tyhjä tässä ajossa");
assert.equal(fullPinEnabled, false, "tyhjä FULL_PIN ei saa olla käytössä");

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

function testEmptyPinValueNeverGrantsExitEvenIfSent(): void {
  const { reply, state } = fakeReply();
  // Joku voisi kokeilla lähettää tyhjän leipätekstiarvon toivoen sen täsmäävän tyhjään FULL_PINiin.
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.1"), reply, "");
  assert.equal(ok, false, "tyhjä annettu arvo ei saa koskaan avata kioskista poistumista, ei edes kun FULL_PIN on itsekin tyhjä");
  assert.equal(state.statusCode, 403, "403, ei 401 — kyse ei ole väärästä koodista vaan siitä ettei ominaisuus ole käytössä");
  console.log("ok  tyhjä leipätekstiarvo ei täsmää tyhjään FULL_PINiin");
}

function testAnyValueIsRejectedWithFeatureUnavailableMessage(): void {
  const { reply, state } = fakeReply();
  const ok = verifyFullPinOnly(fakeRequest("127.0.0.1"), reply, "123456");
  assert.equal(ok, false, "ei mikään koodi saa avata kioskista poistumista kun FULL_PIN ei ole käytössä");
  assert.equal(state.statusCode, 403);
  console.log("ok  kioskista poistuminen on kokonaan pois käytöstä kun FULL_PIN ei ole asetettu — ei vain suojaamaton");
}

testEmptyPinValueNeverGrantsExitEvenIfSent();
testAnyValueIsRejectedWithFeatureUnavailableMessage();

console.log("\nall kiosk-exit-disabled tests passed");
process.exit(0);
