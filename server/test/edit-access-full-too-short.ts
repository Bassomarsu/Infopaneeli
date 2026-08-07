/**
 * FULL_PIN paljastaa lasten koulutiedot, joten liian lyhyt arvo (alle kuusi
 * merkkiä) EI OTA tasoa käyttöön lainkaan — ei riitä että se vain
 * varoittaisi lokissa. Käyttäjän kannalta tämä on juuri se tapaus jossa
 * hiljainen epäonnistuminen olisi pahin: hän luulisi suojanneensa Wilma-
 * tiedot koodilla joka ei tosiasiassa ole käytössä. Tämä testi todentaa
 * ettei liian lyhyt FULL_PIN ikinä avaa täyttä luottamusta, VAIKKA se
 * täsmäisi tismalleen konfiguroituun (liian lyhyeen) arvoon — ja että
 * EDIT_PIN toimii silti normaalisti samassa asetuksessa.
 *
 * Oma prosessinsa (ks. edit-pin-full-too-short-test-env.ts): config.ts
 * lukee ympäristömuuttujat vain kerran moduulin latautuessa.
 *
 * Aja:  npm run test:edit-access-full-too-short --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-full-too-short-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, isTrustedRequest, requireEditAccess, verifyEditPin } from "../src/routes/access.ts";

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

function fakeRequest(ip: string, pinHeader?: string): FastifyRequest {
  return {
    ip,
    headers: pinHeader === undefined ? {} : { "x-edit-pin": pinHeader },
  } as unknown as FastifyRequest;
}

function testExactMatchOnTooShortFullPinStillGrantsNothing(): void {
  const ip = "192.168.30.1";
  // Annetaan TÄSMÄLLEEN se merkkijono joka on .env:ssä FULL_PIN:inä —
  // tämän PITÄÄ silti epäonnistua, koska taso on kokonaan pois käytöstä.
  assert.equal(isTrustedRequest(fakeRequest(ip, config.fullPin)), false, "liian lyhyt FULL_PIN ei saa avata Wilma-näkyvyyttä vaikka arvo täsmäisi");

  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest(ip, config.fullPin), reply);
  assert.equal(ok, false, "liian lyhyt FULL_PIN ei saa läpäistä kirjoitusporttiakaan sillä perusteella että se olisi 'oikea'");
  assert.equal(state.statusCode, 401, "kohdellaan vääränä koodina, ei erikoistapauksena");
  console.log("ok  liian lyhyt FULL_PIN ei avaa mitään, vaikka annettu koodi täsmäisi tarkalleen konfiguroituun arvoon");
}

function testVerifyEndpointNeverReportsFullForTooShortConfiguredValue(): void {
  const { reply, state } = fakeReply();
  const level = verifyEditPin(fakeRequest("192.168.30.2"), reply, config.fullPin);
  assert.equal(level, null, "verifyEditPin ei saa koskaan raportoida 'full'-tasoa kun FULL_PIN on liian lyhyt");
  assert.equal(state.statusCode, 401, "käyttäjä saa ymmärrettävän 'väärä koodi' -vastauksen, ei hiljaista epäonnistumista");
  console.log("ok  POST /api/edit-access ei koskaan myönnä 'full'-tasoa liian lyhyelle FULL_PINille — käyttäjä näkee selvän virheen");
}

function testEditPinStillWorksNormallyWhenFullPinIsDisabled(): void {
  const ip = "192.168.30.3";
  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest(ip, config.editPin), reply);
  assert.equal(ok, true, "EDIT_PIN ei saa kärsiä siitä että FULL_PIN on liian lyhyt ja siksi pois käytöstä");
  assert.equal(state.statusCode, null);
  assert.equal(isTrustedRequest(fakeRequest(ip, config.editPin)), false, "EDIT_PIN ei silti koskaan avaa Wilma-näkyvyyttä");
  console.log("ok  EDIT_PIN toimii normaalisti vaikka FULL_PIN on asetettu mutta liian lyhyt ja siksi pois käytöstä");
}

testExactMatchOnTooShortFullPinStillGrantsNothing();
testVerifyEndpointNeverReportsFullForTooShortConfiguredValue();
testEditPinStillWorksNormallyWhenFullPinIsDisabled();

console.log("\nall edit-access-full-too-short tests passed");
process.exit(0);
