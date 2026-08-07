/**
 * Kaksitasoinen PIN-koodi (server/src/routes/access.ts): EDIT_PIN antaa
 * muistilistan/asetusten/hälytysten muokkauksen, FULL_PIN antaa täydet
 * oikeudet mukaan lukien lasten Wilma-tiedot — sama otsikko (x-edit-pin)
 * kantaa kumpaakin, palvelin päättää tason. Tämä on koko ominaisuuden
 * tärkein testi: se todentaa ettei EDIT_PIN koskaan vuoda Wilma-näkyvyyttä
 * ja että FULL_PIN käyttäytyy täsmälleen kuten TRUSTED_HOSTS-laite.
 *
 * Tämä tiedosto olettaa molemmat koodit asetetuiksi (ks. edit-pin-test-
 * env.ts). Tyhjien koodien käyttäytymistä testaa edit-access-disabled.ts, ja
 * liian lyhyen FULL_PINin käyttäytymistä edit-access-full-too-short.ts —
 * kumpikin omana prosessinaan, koska config.ts lukee ympäristömuuttujat
 * vain kerran moduulin latautuessa.
 *
 * Aja:  npm run test:edit-access --workspace=server
 */
import "./test-env.ts";
import "./edit-pin-test-env.ts";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../src/core/config.ts";
import { fullPinEnabled, isTrustedRequest, PinAttemptLimiter, requireEditAccess, verifyEditPin } from "../src/routes/access.ts";

assert.equal(config.editPin, "4242", "testin oletus: EDIT_PIN on asetettu edit-pin-test-env.ts:ssä");
assert.equal(config.fullPin, "424242", "testin oletus: FULL_PIN on asetettu edit-pin-test-env.ts:ssä");
assert.equal(fullPinEnabled, true, "kuusimerkkinen FULL_PIN pitää olla käytössä");

interface FakeReplyState {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
}

/** Riittävän suuri osajoukko FastifyReplystä requireEditAccessin/verifyEditPinin testaamiseen. */
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

/** Ei-luotettu osoite — TRUSTED_HOSTS on tyhjä testiajossa, joten mikä tahansa muu kuin loopback kelpaa "puhelimeksi". */
function fakeRequest(ip: string, pinHeader?: string): FastifyRequest {
  return {
    ip,
    headers: pinHeader === undefined ? {} : { "x-edit-pin": pinHeader },
  } as unknown as FastifyRequest;
}

function testFullPinGrantsBothTrustedAndEditable(): void {
  const ip = "192.168.20.1";
  assert.equal(isTrustedRequest(fakeRequest(ip, config.fullPin)), true, "FULL_PIN pitää tehdä laitteesta luotetun");

  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest(ip, config.fullPin), reply);
  assert.equal(ok, true, "FULL_PIN pitää läpäistä myös kirjoitusportti");
  assert.equal(state.statusCode, null);
  console.log("ok  FULL_PIN antaa sekä isTrustedRequestin (Wilma näkyy) että requireEditAccessin läpäisyn");
}

function testEditPinGrantsEditableButNeverTrusted(): void {
  const ip = "192.168.20.2";
  // KRIITTISIN yksittäinen väite koko ominaisuudessa: EDIT_PIN ei koskaan
  // saa näyttää lasten Wilma-tietoja.
  assert.equal(isTrustedRequest(fakeRequest(ip, config.editPin)), false, "EDIT_PIN EI SAA tehdä laitteesta luotettua — se paljastaisi Wilma-datan");

  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest(ip, config.editPin), reply);
  assert.equal(ok, true, "EDIT_PIN pitää silti läpäistä kirjoitusportti (muistilista, asetukset, hälytykset)");
  assert.equal(state.statusCode, null);
  console.log("ok  EDIT_PIN antaa muokkauksen mutta ei koskaan luottamusta (ei Wilma-dataa)");
}

function testWrongPinGrantsNeitherLevel(): void {
  const ip = "192.168.20.3";
  assert.equal(isTrustedRequest(fakeRequest(ip, "000000")), false);

  const { reply, state } = fakeReply();
  const ok = requireEditAccess(fakeRequest(ip, "000000"), reply);
  assert.equal(ok, false, "väärä koodi ei saa läpäistä kumpaakaan tasoa");
  assert.equal(state.statusCode, 401);
  const body = JSON.stringify(state.body);
  assert.ok(!body.includes(config.editPin) && !body.includes(config.fullPin), "virhevastaus ei saa sisältää kumpaakaan oikeaa koodia");
  console.log("ok  väärä koodi ei anna kumpaakaan tasoa, eikä vastaus paljasta oikeita koodeja");
}

function testVerifyEndpointReportsWhichLevelWasGranted(): void {
  const full = fakeReply();
  assert.equal(verifyEditPin(fakeRequest("192.168.20.4"), full.reply, config.fullPin), "full");

  const edit = fakeReply();
  assert.equal(verifyEditPin(fakeRequest("192.168.20.5"), edit.reply, config.editPin), "edit");

  const wrong = fakeReply();
  assert.equal(verifyEditPin(fakeRequest("192.168.20.6"), wrong.reply, "999999"), null);
  assert.equal(wrong.state.statusCode, 401);
  console.log("ok  POST /api/edit-access (verifyEditPin) kertoo täsmälleen kumman tason koodi avaa, tai hylkää selvästi");
}

/**
 * Regressiotesti nimenomaan tiimin varoittamalle sudenkuopalle: puhelin
 * jolla on EDIT_PIN tallessa lähettää sen JOKA /api/dashboard-pollauksella
 * (useDashboard.ts lähettää tallennetun koodin aina). Tämä ei koskaan täsmää
 * FULL_PINiin, mutta se ei silti saa laueta rajoittimena — muuten
 * normaalikäyttö lukitsisi laitteen itse itsensä muutamassa minuutissa.
 */
function testRoutineEditPinTrafficNeverTriggersLockout(): void {
  const ip = "192.168.20.7";
  for (let i = 0; i < 50; i++) {
    isTrustedRequest(fakeRequest(ip, config.editPin));
  }
  // Jos rajoitin olisi väärin perustein lauennut, tämäkin (oikea) FULL_PIN-yritys torjuttaisiin.
  assert.equal(isTrustedRequest(fakeRequest(ip, config.fullPin)), true, "50 EDIT_PIN-pollausta ei saa lukita lähdettä");
  console.log("ok  toistuva EDIT_PIN-liikenne isTrustedRequestin kautta (esim. dashboard-pollaus) ei koskaan lukitse lähdettä");
}

/** Sama asia kirjoitusreitin puolella: laite ilman mitään koodia (esim. näyttölaite tai puhelin ilman PIN:iä) ei saa lukittua pelkästä puuttumisesta jos se jotenkin päätyisi requireEditAccessiin toistuvasti. */
function testAbsentPinNeverTriggersLockoutViaIsTrustedRequest(): void {
  const ip = "192.168.20.8";
  for (let i = 0; i < 50; i++) {
    isTrustedRequest(fakeRequest(ip));
  }
  assert.equal(isTrustedRequest(fakeRequest(ip, config.fullPin)), true, "50 otsikotonta lukupyyntöä ei saa lukita lähdettä");
  console.log("ok  puuttuva otsikko isTrustedRequestin kautta ei koskaan lukitse lähdettä");
}

function testLockoutAppliesRegardlessOfWhichTierWasBeingGuessed(): void {
  const ip = "192.168.20.9";
  for (let i = 0; i < 5; i++) {
    const { reply, state } = fakeReply();
    requireEditAccess(fakeRequest(ip, `wrong-${i}`), reply);
    assert.equal(state.statusCode, 401, `yritys ${i + 1}/5: väärä koodi, ei vielä lukittu`);
  }

  const { reply: lockedReply, state: lockedState } = fakeReply();
  requireEditAccess(fakeRequest(ip, "wrong-again"), lockedReply);
  assert.equal(lockedState.statusCode, 429, "kuudennen yrityksen pitää törmätä lukitukseen");
  assert.ok(typeof lockedState.headers["retry-after"] === "string");

  // Lukitus estää MOLEMPIA koodeja, ei vain sitä jota viimeksi yritettiin.
  const { reply: fullDuringLock, state: fullDuringLockState } = fakeReply();
  assert.equal(requireEditAccess(fakeRequest(ip, config.fullPin), fullDuringLock), false, "lukitus estää myös oikean FULL_PINin");
  assert.equal(fullDuringLockState.statusCode, 429);

  const { reply: editDuringLock, state: editDuringLockState } = fakeReply();
  assert.equal(requireEditAccess(fakeRequest(ip, config.editPin), editDuringLock), false, "lukitus estää myös oikean EDIT_PINin");
  assert.equal(editDuringLockState.statusCode, 429);
  console.log("ok  viisi väärää yritystä lukitsee lähteen MOLEMMILTA tasoilta, ei vain siltä jota yritettiin");
}

function testSuccessfulEditPinResetsCounterForFullPinToo(): void {
  const ip = "192.168.20.10";
  const { reply: r1, state: s1 } = fakeReply();
  requireEditAccess(fakeRequest(ip, "wrong-a"), r1);
  assert.equal(s1.statusCode, 401);
  const { reply: r2, state: s2 } = fakeReply();
  requireEditAccess(fakeRequest(ip, "wrong-b"), r2);
  assert.equal(s2.statusCode, 401);

  // Onnistunut EDIT_PIN nollaa laskurin, vaikka se ei olekaan sama koodi kuin lukitusta uhkasi.
  const { reply: r3 } = fakeReply();
  assert.equal(requireEditAccess(fakeRequest(ip, config.editPin), r3), true);

  const { reply: r4, state: s4 } = fakeReply();
  requireEditAccess(fakeRequest(ip, "wrong-c"), r4);
  assert.equal(s4.statusCode, 401, "laskuri nollautui, joten kolmas väärä yritys peräkkäin ei vielä lukitse");
  console.log("ok  onnistunut todennus (kumpi tahansa taso) nollaa jaetun rajoittimen kokonaan");
}

function testLimiterLocksAfterMaxAttemptsAndReleasesAfterLockout(): void {
  let now = 1_000_000;
  const limiter = new PinAttemptLimiter(3, 60_000, () => now);
  const key = "10.0.0.5";

  assert.equal(limiter.lockRemainingMs(key), null, "aluksi ei lukittu");
  limiter.recordFailure(key);
  limiter.recordFailure(key);
  assert.equal(limiter.lockRemainingMs(key), null, "kaksi virhettä ei vielä lukitse kun raja on kolme");

  limiter.recordFailure(key);
  const remaining = limiter.lockRemainingMs(key);
  assert.ok(remaining !== null && remaining > 0, "kolmas virhe (maxAttempts) lukitsee lähteen");

  now += 59_999;
  assert.ok((limiter.lockRemainingMs(key) ?? 0) > 0, "lukitus on yhä voimassa juuri ennen määräaikaa");

  now += 2;
  assert.equal(limiter.lockRemainingMs(key), null, "lukitus vapautuu itsestään määräajan jälkeen");
  console.log("ok  rajoitin lukitsee maxAttempts-virheen jälkeen ja vapautuu lockoutMs:n kuluttua");
}

function testLimiterIsPerSource(): void {
  const limiter = new PinAttemptLimiter(2, 60_000);
  const locked = "10.0.0.7";
  const other = "10.0.0.8";

  limiter.recordFailure(locked);
  limiter.recordFailure(locked);
  assert.ok((limiter.lockRemainingMs(locked) ?? 0) > 0, "toistuvasti väärin yrittänyt lähde lukittuu");
  assert.equal(limiter.lockRemainingMs(other), null, "toinen lähde ei saa lukittua ensimmäisen virheistä");
  console.log("ok  rajoitin on lähdekohtainen — yhden osoitteen lukitus ei vaikuta toiseen");
}

testFullPinGrantsBothTrustedAndEditable();
testEditPinGrantsEditableButNeverTrusted();
testWrongPinGrantsNeitherLevel();
testVerifyEndpointReportsWhichLevelWasGranted();
testRoutineEditPinTrafficNeverTriggersLockout();
testAbsentPinNeverTriggersLockoutViaIsTrustedRequest();
testLockoutAppliesRegardlessOfWhichTierWasBeingGuessed();
testSuccessfulEditPinResetsCounterForFullPinToo();
testLimiterLocksAfterMaxAttemptsAndReleasesAfterLockout();
testLimiterIsPerSource();

console.log("\nall edit-access tests passed");
process.exit(0);
