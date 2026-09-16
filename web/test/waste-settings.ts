/**
 * Jätehuoltoasetusten tekstit. Mitattuna neljästä tekstikerroksesta kolme sanoi
 * "tarkista tunnukset" silloinkin kun kyse oli yhtiön huoltokatkosta, ja juuri se
 * kehotus ajaa käyttäjän kokeilemaan salasanoja kunnes tili lukkiutuu. Tämä testi
 * pitää selainpään kerroksen rehellisenä.
 *
 * Aja:  npm run test:waste-settings --workspace=web
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wasteBlockedNotice, wasteRequestError } from '../src/waste.ts';

// 1. Palvelimen oma selitys menee läpi sellaisenaan, oli tilakoodi mikä tahansa.
for (const [status, error] of [[400, 'Jätehuoltopalvelu ei juuri nyt vastaa odotetusti (huolto tai häiriö).'], [429, 'Uusi yritys on mahdollinen 12 min kuluttua.'], [502, 'Jätehuoltopalveluun ei saada yhteyttä.'], [403, 'Jätehuoltopalvelu palautti virheen (HTTP 403).']] as const) {
  assert.equal(wasteRequestError(status, { error }), error, 'HTTP ' + status + ': palvelimen viesti on hukattu');
}

// 2. Ilman palvelimen viestiä näytetään varateksti — eikä se puhu tunnuksista,
// koska mikään tässä ei kerro tunnuksista mitään.
for (const body of [null, undefined, {}, { error: '' }, { error: '   ' }, { error: 42 }, 'ei json']) {
  for (const status of [400, 429, 500, 502, 503]) {
    const text = wasteRequestError(status, body);
    assert.ok(text.length > 0);
    assert.ok(!/tunnu|salasan/i.test(text), 'HTTP ' + status + ' -varateksti puhuu tunnuksista: ' + text);
  }
}
// 403 on ainoa varateksti joka saa puhua oikeuksista: se on infonäytön oma PIN,
// ei jätehuollon tunnus.
assert.match(wasteRequestError(403, null), /käyttöoikeu/i);
assert.doesNotMatch(wasteRequestError(403, null), /jätehuollon tunnu/i);

// 3. Ylipitkä palvelimen viesti katkaistaan, jotta asetusnäkymä ei hajoa.
assert.equal(wasteRequestError(400, { error: 'x'.repeat(500) }).length, 300);

// 4. Lukitustilan teksti kertoo ENSIN itsestään purkautuvasta odotuksesta ja vasta
// sitten tunnuksista: odottaminen ei kuluta kirjautumisyrityksiä, arvailu kuluttaa.
const waiting = wasteBlockedNotice(12 * 60);
assert.match(waiting, /12 min/);
assert.ok(waiting.indexOf('12 min') < waiting.indexOf('tunnukset ovat muuttuneet'), 'odotusaika on kerrottava ennen kehotusta syöttää tunnukset');
assert.match(wasteBlockedNotice(1), /1 min/);
assert.match(wasteBlockedNotice(0), /nyt/, 'jäähdytyksen loputtua on kerrottava että haku toimii taas');
assert.doesNotMatch(wasteBlockedNotice(0), /min kuluttua/);

// 5. Asetusnäkymä käyttää näitä tekstejä eikä omaa yleistekstiään, ja "Hae
// kiinteistöt" avautuu itsestään jäähdytyksen jälkeen. Ilman jälkimmäistä
// `blocked` sulkisi oven molempiin suuntiin: ulos pääsisi vain syöttämällä
// tunnukset uudelleen, mikä on tasan se toiminta joka lukitsee tilin.
const source = fs.readFileSync(new URL('../src/components/WasteSettings.vue', import.meta.url), 'utf8');
assert.match(source, /wasteRequestError\(response\.status/, 'virheviestit on haettava palvelimen vastauksesta');
assert.match(source, /wasteBlockedNotice\(blockedFor\)/, 'lukitustilan teksti on näytettävä jäljellä olevan ajan kanssa');
const button = source.split('\n').find(line => line.includes('@click="loadProperties"'))!;
assert.match(button, /blockedFor > 0/, '"Hae kiinteistöt" on estettävä jäähdytyksen ajaksi');
assert.ok(!/config\?\.blocked\s*\|\|/.test(button), '"Hae kiinteistöt" ei saa jäädä estetyksi jäähdytyksen jälkeen');

console.log('PASS: waste settings show the server\'s own explanation, never blame credentials for an outage, and reopen the property search when the cooldown ends');
