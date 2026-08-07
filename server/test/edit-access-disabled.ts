/**
 * Molempien koodien (EDIT_PIN ja FULL_PIN) tyhjän arvon käyttäytyminen:
 * muokkaus on tällöin sallittu vain näyttölaitteelta/luotetuilta
 * laitteilta, eikä käyttöliittymän pidä tarjota PIN-syöttöä lainkaan. Oma
 * prosessinsa (ei sama tiedosto kuin edit-access.ts): config.ts lukee
 * ympäristömuuttujat process.env:stä vain kerran moduulin latautuessa,
 * joten eri arvoja ei voi testata samassa ajossa.
 *
 * Aja:  npm run test:edit-access-disabled --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-empty-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, isTrustedRequest, requireEditAccess, verifyEditPin } from "../src/routes/access.ts";

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

function fakeRequest(ip: string, pinHeader?: string): FastifyRequest {
  return {
    ip,
    headers: pinHeader === undefined ? {} : { "x-edit-pin": pinHeader },
  } as unknown as FastifyRequest;
}

function testRequireEditAccessRejectsWithNoPinConfiguredMessage(): void {
  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest("192.168.10.20"), reply);
  assert.equal(ok, false, "ei-luotettu laite ei saa muokkausoikeutta kun kumpikaan koodi ei ole asetettu");
  assert.equal(state.statusCode, 403, "403, ei 401 — kyse ei ole väärästä koodista vaan siitä ettei koodia ole");
  console.log("ok  molempien koodien puuttuminen antaa 403:n eri viestillä kuin väärä koodi (401)");
}

function testEmptyPinValueNeverMatchesEvenIfSent(): void {
  const { reply, state } = fakeReply();
  // Joku voisi kokeilla lähettää tyhjän otsikon toivoen sen täsmäävän tyhjään EDIT_PINiin/FULL_PINiin.
  const ok = requireEditAccess(fakeRequest("192.168.10.21", ""), reply);
  assert.equal(ok, false, "tyhjä otsikkoarvo ei saa koskaan läpäistä, ei edes kun koodit ovat itsekin tyhjiä");
  assert.equal(state.statusCode, 403);
  console.log("ok  tyhjä x-edit-pin-otsikko ei täsmää tyhjiin koodeihin");
}

function testIsTrustedRequestNeverGrantsFullAccessEither(): void {
  const trusted = isTrustedRequest(fakeRequest("192.168.10.23", "anything"));
  assert.equal(trusted, false, "ilman FULL_PINiä mikään koodi ei saa avata Wilma-näkyvyyttä");
  console.log("ok  isTrustedRequest ei myönnä täyttä luottamusta kun FULL_PIN on tyhjä");
}

function testVerifyEndpointAlsoRejectsWhenNoPinConfigured(): void {
  const { reply, state } = fakeReply();
  const level = verifyEditPin(fakeRequest("192.168.10.22"), reply, "1234");
  assert.equal(level, null);
  assert.equal(state.statusCode, 403, "POST /api/edit-access ei voi todentaa mitään kun palvelimella ei ole kumpaakaan koodia");
  console.log("ok  verifyEditPin (POST /api/edit-access) antaa saman 403:n kun kumpikaan koodi ei ole asetettu");
}

testRequireEditAccessRejectsWithNoPinConfiguredMessage();
testEmptyPinValueNeverMatchesEvenIfSent();
testIsTrustedRequestNeverGrantsFullAccessEither();
testVerifyEndpointAlsoRejectsWhenNoPinConfigured();

console.log("\nall edit-access-disabled tests passed");
process.exit(0);
