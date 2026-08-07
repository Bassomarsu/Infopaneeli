/**
 * hourFromPointerX kartoittaa kosketus-/hiiripisteen lähimpään tuntiin
 * pörssisähkökaavion 24 palkin alueella. Kosketusnäytöllä yksittäinen palkki
 * on liian kapea osuttavaksi tarkasti, joten kartoitus tehdään koko
 * piirtoalueen leveydeltä, ei palkki kerrallaan.
 *
 * Aja (web-hakemistosta): node test/electricity-hour-from-x.ts
 */
import assert from "node:assert/strict";
import { hourFromPointerX } from "../src/components/electricityChart.ts";

// Vasen reuna ja piste juuri ennen oikeaa reunaa osuvat ensimmäiseen/viimeiseen tuntiin.
assert.equal(hourFromPointerX(0, 240), 0);
assert.equal(hourFromPointerX(239, 240), 23);
console.log("ok  reunat osuvat ensimmäiseen ja viimeiseen tuntiin");

// Piste tasan leveyden puolivälissä osuu tuntiin 12 (floor 24*0.5 = 12).
assert.equal(hourFromPointerX(120, 240), 12);
console.log("ok  puoliväli osuu keskimmäiseen tuntiin");

// Alueen ulkopuolelle (negatiivinen tai leveyttä suurempi) menevä piste
// typistetään rajoihin — esim. pyyhkäisyssä sormi voi livahtaa hieman
// kaavion reunan yli pointerCapturen aikana, eikä se saa aiheuttaa virhettä.
assert.equal(hourFromPointerX(-50, 240), 0);
assert.equal(hourFromPointerX(9999, 240), 23);
console.log("ok  alueen ulkopuolelle menevä piste typistetään reunaan");

// Nollaleveä tai puuttuva mittaus (esim. elementti ei vielä layoutissa) ei saa jakaa nollalla.
assert.equal(hourFromPointerX(10, 0), 0);
assert.equal(hourFromPointerX(10, -5), 0);
console.log("ok  nollaleveys tai negatiivinen leveys ei kaadu jakoon nollalla");

// Jokainen 24 tunnista löytyy tasaisesti jaetusta 240px:n alueesta (10px per tunti).
for (let h = 0; h < 24; h++) {
  assert.equal(hourFromPointerX(h * 10 + 5, 240), h, `tunti ${h} ei osunut omaan lohkoonsa`);
}
console.log("ok  kaikki 24 tuntia löytyvät tasaisesti jaetulta alueelta");
