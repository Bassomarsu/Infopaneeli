/**
 * LASKEE KIRJAUTUMISYRITYKSET. Tämä testi on olemassa yhtä lukua varten: montako
 * kertaa infonäyttö koputtaa jätehuoltoyhtiön kirjautumissivulle tunnissa silloin
 * kun jokin on rikki. Tili on sama jolla huoltaja itse asioi, ja liian monta
 * hylättyä kirjautumista lukitsee sen.
 *
 * Mitattu lähtötaso ennen korjausta: 60 kirjautumista tunnissa ("Hae kiinteistöt"
 * kerran minuutissa, mikään ei estänyt sitä), ja käynnistyssilmukassa ~360, koska
 * yritysten väliä pidettiin moduulimuuttujassa joka nollautui joka käynnistyksessä.
 *
 * Jokainen POST `j_acegi_security_check`iin on yksi kirjautumisyritys. Testi ei
 * koskaan ota yhteyttä oikeaan palveluun: `globalThis.fetch` on korvattu.
 *
 * Aja:  node server/test/waste-lockout.ts
 */
import './waste-lockout-env.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { FatalProviderError, registry } from '../src/core/provider.ts';
import { createWasteProvider, fetchWaste, saveWasteConfig, wasteConfig, wasteProperties } from '../src/core/waste-service.ts';
import { registerApiRoutes } from '../src/routes/api.ts';

const COMPANY = { companyId: 'sammakkokangas', municipality: 'Karstula', address: 'Testitie 1' };
const HOUR_MINUTES = 60;

/** Virtuaalikello: tunti kuluu testissä millisekunneissa, mutta rajat ovat oikeat. */
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const advance = (ms: number) => { clock += ms; };
const minute = () => advance(61_000);

type Mode = 'ok' | 'wrong-credentials' | 'maintenance' | 'forbidden' | 'server-error' | 'offline';
let mode: Mode = 'ok';
let logins = 0;
const realFetch = globalThis.fetch;

/** Yhtiön vastaus kun vika on yhtiön päässä — ei koskaan tunnusvirhe. */
function outage(): Response {
  if (mode === 'maintenance') return new Response('<html>Huoltokatko, palaamme pian</html>', { headers: { 'content-type': 'text/html' } });
  if (mode === 'forbidden') return new Response(null, { status: 403 });
  return new Response(null, { status: 500 });
}
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const endpoint = new URL(String(url)).pathname.split('/').at(-1);
  if (endpoint === 'j_acegi_security_check') logins++;
  if (mode === 'offline') throw new TypeError('fetch failed');
  if (mode !== 'ok' && mode !== 'wrong-credentials') return outage();
  if (endpoint === 'j_acegi_security_check') return Response.json({ response: mode === 'wrong-credentials' ? 'FAILED' : 'OK' });
  if (endpoint === 'get_customer_datas.do') return Response.json({ a: [{ asiakasnro: 41, katu: 'Testitie 1', posti: '43500 Karstula' }] });
  if (endpoint === 'get_services_by_customer_numbers.do') return Response.json([{ id: { ASTAsnro: 41, ASTPos: 1 }, tariff: { name: 'Sekajäte' } }]);
  if (endpoint === 'get_collection_schedule.do') return Response.json(['2030-01-01']);
  throw new Error('Odottamaton osoite ' + String(url));
}) as typeof fetch;

/** Käyttäjän täysi palautusrutiini: tunnukset, kiinteistö ja automaattinen haku. */
async function reconnect(): Promise<void> {
  mode = 'ok'; minute();
  saveWasteConfig({ ...COMPANY, username: 'fixture-user', password: 'fixture-secret' });
  minute();
  const properties = await wasteProperties();
  saveWasteConfig({ propertyId: properties[0]!.id, enabled: true });
  minute();
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Palveluhäiriön viesti ei saa kehottaa tarkistamaan tunnuksia — se kehotus ajaa salasanojen kokeiluun. */
function assertNoCredentialAdvice(error: unknown, when: string): void {
  assert.ok(!/tunnu|salasan/i.test(message(error)), when + ': viesti puhuu tunnuksista vaikka vika ei ole niissä — ' + message(error));
}

const measured: string[] = [];
try {
  // ── 1. "Hae kiinteistöt" kerran minuutissa tunnin ajan, väärillä tunnuksilla ──
  // Tämä on se mitattu 60 kirjautumista tunnissa. Nappi ei enää ohita lukitustilaa.
  await reconnect();
  saveWasteConfig({ ...COMPANY, username: 'fixture-user', password: 'wrong-secret' });
  mode = 'wrong-credentials'; minute();
  logins = 0;
  let presses = 0, refusedWithoutLogin = 0, countdownSeen = 0;
  for (let i = 0; i < HOUR_MINUTES; i++) {
    presses++;
    await wasteProperties().then(() => assert.fail('väärillä tunnuksilla ei saa onnistua'), (error: unknown) => { if (/ei toisteta heti/.test(message(error))) refusedWithoutLogin++; });
    countdownSeen = Math.max(countdownSeen, wasteConfig().blockedForSeconds);
    minute();
  }
  assert.equal(presses, HOUR_MINUTES);
  assert.equal(logins, 2, 'väärillä tunnuksilla 60 napinpainallusta saa tuottaa täsmälleen 2 kirjautumista (ennen: 60)');
  assert.equal(refusedWithoutLogin, HOUR_MINUTES - 2, 'muut painallukset on torjuttava ilman yhtään yhteydenottoa');
  assert.equal(wasteConfig().blocked, true);
  // Jäähdytyksen on oltava näkyvissä käyttöliittymälle, mutta myös loputtava:
  // ilman kumpaakin nappi jää harmaaksi eikä ulos pääse muuten kuin syöttämällä
  // tunnukset uudelleen — juuri se umpikuja jota tämä korjaus purkaa.
  assert.ok(countdownSeen > 0 && countdownSeen <= 30 * 60, 'jäähdytyksen jäljellä olevan ajan on näyttävä käyttöliittymälle: ' + countdownSeen);
  assert.equal(wasteConfig().blockedForSeconds, 0, 'tunnin kuluttua uusi yritys on jälleen sallittu ilman käyttäjän toimia');
  measured.push('väärät tunnukset, 60 x "Hae kiinteistöt": ' + logins + ' kirjautumista/h (ennen 60)');

  // ── 2. Lukitustilasta ulos ILMAN tunnusten syöttämistä ──
  // Jäähdytyksen jälkeen yksi yritys sallitaan. Jos se onnistuu (tunnukset olivatkin
  // oikein, tai yhtiö oli sekaisin), lukitustila purkautuu itsestään.
  mode = 'ok'; advance(30 * 60_000);
  logins = 0;
  const properties = await wasteProperties();
  assert.equal(properties.length, 1);
  assert.equal(logins, 1, 'jäähdytyksen jälkeen saa yrittää tasan kerran');
  assert.equal(wasteConfig().blocked, false, 'onnistunut kiinteistöhaku purkaa lukitustilan ilman tunnusten syöttämistä');
  assert.equal(wasteConfig().blockedForSeconds, 0);

  // ── 3. Yhtiön palveluhäiriö ei ole tunnusvirhe eikä saa pysäyttää mitään ──
  for (const failing of ['maintenance', 'forbidden', 'server-error', 'offline'] as const) {
    await reconnect();
    const provider = createWasteProvider();
    registry.register(provider);
    mode = failing;
    logins = 0;
    let errors = 0;
    for (let i = 0; i < HOUR_MINUTES; i++) {
      minute();
      await provider.runOnce();
      const failure = provider.snapshot().error;
      if (failure) { errors++; assertNoCredentialAdvice(new Error(failure.message), failing); }
    }
    assert.ok(errors > 0, failing + ': haun pitäisi epäonnistua');
    assert.equal(wasteConfig().blocked, false, failing + ' ei saa merkitä tunnuksia hylätyiksi');
    assert.notEqual(provider.snapshot().error?.type, 'waste_auth', failing + ' ei saa näkyä tunnusvirheenä');
    assert.ok(logins <= 2, failing + ': tunnin häiriö tuotti ' + logins + ' kirjautumista, enintään 2 sallitaan');
    measured.push(failing + ', 60 hakukierrosta: ' + logins + ' kirjautumista/h');

    // Katkaisija ei saa avautua palveluhäiriöstä. Tämä on syy siihen että
    // fatalLimit: 2 on turvallinen: se laskee vain tunnusvirheitä, joten epävakaa
    // yhtiö ei jäädytä näyttöä neljäksi tunniksi. Auki oleva katkaisija näkyisi
    // viestiin liimattuna arviona (Provider.withRetryHint) — sitä ei saa olla.
    assert.doesNotMatch(provider.snapshot().error!.message, /Yritetään uudelleen/, failing + ': katkaisija avautui palveluhäiriöstä');
    // Kun yhtiö palaa, haku palaa ilman käyttäjän toimia. Viive on korkeintaan
    // istuntovälimuistin ikä (30 min), EI katkaisijan jäähdytys (30 min → 4 h).
    mode = 'ok'; advance(31 * 60_000);
    await provider.runOnce();
    assert.equal(provider.snapshot().status, 'ok', failing + ': palvelun palattua haun pitää onnistua itsestään');
    provider.stop();
  }

  // ── 3b. Sama häiriö, mutta käyttäjä painaa nappia. Tätä EI ole rajoitettu
  // jäähdytyksellä, ja luku on siksi iso: 60 painallusta = 60 kirjautumista.
  // Se on tietoinen valinta. Yhtiö ei ole hylännyt tunnuksia, joten tili ei ole
  // lukkiutumassa, ja jokainen yritys on ihmisen erikseen painama — palvelin
  // rajoittaa silti yhteen minuutissa. Häiriön jäähdyttäminen sulkisi juuri sen
  // oven jolla käyttäjä toipuu, kun taas hylättyjen tunnusten jäähdytys (kohta 1)
  // sulkee vain sen oven joka lukitsee tilin. Jos tämä luku halutaan alas, se on
  // oma päätöksensä — eikä sitä saa tehdä vahingossa, siksi tarkka vertailu.
  await reconnect();
  mode = 'maintenance';
  logins = 0;
  for (let i = 0; i < HOUR_MINUTES; i++) {
    await wasteProperties().then(() => assert.fail('huoltokatkossa ei saa onnistua'), (error: unknown) => assertNoCredentialAdvice(error, 'huoltokatko, käsin haettu'));
    minute();
  }
  assert.equal(logins, HOUR_MINUTES, 'huoltokatkossa käsin haettaessa yksi yritys minuutissa, ei enempää');
  assert.equal(wasteConfig().blocked, false, 'huoltokatko ei saa lukita kiinteistöhakua');
  measured.push('huoltokatko, 60 x "Hae kiinteistöt": ' + logins + ' kirjautumista/h (ihmisen painamia, tili ei lukkiudu)');

  // ── 4. Aito tunnusvirhe: ainoa joka pysäyttää haun ──
  await reconnect();
  const provider = createWasteProvider();
  registry.register(provider);
  // Tallennettu salasana on muuttunut yhtiön päässä: istunto on yhä auki, mutta
  // seuraava kirjautuminen hylätään. Kiinteistö annetaan suoraan, koska tunnusten
  // vaihto tyhjentää valinnan eikä sitä voi hakea tunnuksilla jotka eivät kelpaa.
  saveWasteConfig({ ...COMPANY, username: 'fixture-user', password: 'wrong-secret' });
  saveWasteConfig({ propertyId: 'vingo:41', enabled: true });
  mode = 'wrong-credentials';
  logins = 0;
  minute();
  await provider.runOnce();
  assert.equal(provider.snapshot().error?.type, 'waste_auth', 'tunnusvirheen on oltava katkaisijalle fataali');
  assert.match(provider.snapshot().error!.message, /tunnu/i, 'tunnusvirhe on ainoa joka saa kehottaa tarkistamaan tunnukset');
  assert.equal(wasteConfig().blocked, true, 'yksi hylkäys riittää pysäyttämään haun');
  for (let i = 1; i < HOUR_MINUTES; i++) { minute(); await provider.runOnce(); }
  assert.equal(logins, 1, 'hylätyt tunnukset: tunnin automaattihaku saa tuottaa täsmälleen 1 kirjautumisen');
  await assert.rejects(() => fetchWaste(), (error: unknown) => error instanceof Error && !(error instanceof FatalProviderError));
  measured.push('hylätyt tunnukset, 60 hakukierrosta: ' + logins + ' kirjautumista/h (ennen 60)');

  // Oikeat tunnukset tallentamalla palvelu palaa HETI: lukitustila purkautuu ja
  // katkaisija nollataan, joten korjatut tunnukset eivät jää jäähdytyksen taakse.
  mode = 'ok'; minute();
  saveWasteConfig({ ...COMPANY, username: 'fixture-user', password: 'fixture-secret' });
  assert.equal(wasteConfig().blocked, false);
  minute();
  const again = await wasteProperties();
  saveWasteConfig({ propertyId: again[0]!.id, enabled: true });
  minute();
  await provider.runOnce();
  assert.equal(provider.snapshot().status, 'ok', 'korjatut tunnukset palauttavat haun saman tien');
  provider.stop();

  // ── 5. Käynnistyssilmukka: kuusi käynnistystä 1,4 sekunnissa ──
  // Jokainen `import(...?restart=N)` on tuore moduulikopio, eli täsmälleen se mikä
  // moduulimuuttujista katoaa kun systemd käynnistää palvelimen uudelleen. Kanta ja
  // provider.ts ovat samat, kuten oikeassakin käynnistyksessä.
  const moduleUrl = new URL('../src/core/waste-service.ts', import.meta.url).href;
  for (const failing of ['maintenance', 'wrong-credentials'] as const) {
    await reconnect();
    mode = failing;
    logins = 0;
    for (let restart = 0; restart < 6; restart++) {
      const fresh = await import(moduleUrl + '?restart=' + failing + restart) as { fetchWaste: typeof fetchWaste };
      advance(230);
      await fresh.fetchWaste().then(() => assert.fail(failing + ': haun ei pitäisi onnistua'), () => {});
    }
    assert.equal(logins, 1, failing + ': kuusi käynnistystä 1,4 sekunnissa saa tuottaa yhden kirjautumisen (ennen: 6, eli ~360/h)');
    measured.push(failing + ', 6 käynnistystä 1,4 s:ssa: ' + logins + ' kirjautuminen (ennen 6)');
  }

  // ── 6. Kadonnut avain ei kuluta yhtään kirjautumista eikä valehtele käyttäjälle ──
  // Avain vaihdetaan toiseksi eikä poisteta: lopputulos on sama koodipolku (purku
  // epäonnistuu), mutta myös se mitä oikeasti tapahtuu kun kanta palautetaan
  // varmuuskopiosta ilman avainta ja seuraava tallennus luo uuden.
  await reconnect();
  fs.writeFileSync(process.env.DB_PATH + '.waste-key', randomBytes(32));
  assert.equal(wasteConfig().configured, false, 'tunnuksia ei voi purkaa, joten niitä ei saa esittää tallennettuina');
  assert.equal(wasteConfig().keyMissing, true, 'käyttöliittymän on voitava kertoa MIKSI tunnukset katosivat');
  // Auki oleva istunto jatkaa toimintaansa; vika paljastuu vasta kun pitäisi
  // kirjautua uudelleen (välimuistin ikä 30 min tai palvelimen käynnistys).
  advance(31 * 60_000);
  logins = 0;
  await assert.rejects(() => fetchWaste(), /syötettävä uudelleen/);
  assert.equal(logins, 0, 'purkamaton salaisuus ei saa lähettää yhtään kirjautumista');
  assert.equal(wasteConfig().blocked, false, 'oma vika ei saa näyttää yhtiön hylkäämiltä tunnuksilta');

  // ── 7. Rajapinta kertoo MIKÄ meni pieleen ──
  // Selain näyttää palvelimen `error`-kentän sellaisenaan, joten yleisteksti täällä
  // on sama asia kuin väärä neuvo ruudulla. Aiemmin molemmat päätepisteet korvasivat
  // oikean syyn kehotuksella tarkistaa tunnukset.
  const app = Fastify();
  await registerApiRoutes(app);
  await reconnect();
  registry.register(createWasteProvider());
  mode = 'maintenance'; minute();
  const outageReply = await app.inject({ method: 'POST', url: '/api/waste/properties', remoteAddress: '127.0.0.1' });
  assert.equal(outageReply.statusCode, 400);
  assert.match(outageReply.json().error, /huolto|häiriö/i, 'huoltokatko on kerrottava huoltokatkona');
  assertNoCredentialAdvice(new Error(outageReply.json().error), 'POST /api/waste/properties');
  const refreshReply = await app.inject({ method: 'POST', url: '/api/waste/refresh', remoteAddress: '127.0.0.1' });
  assert.equal(refreshReply.statusCode, 502);
  assertNoCredentialAdvice(new Error(refreshReply.json().error), 'POST /api/waste/refresh');

  // Lukitustilassa selain tarvitsee myös ajan: ilman sitä se ei voi kertoa milloin
  // nappi aukeaa itsestään, ja jäljelle jää taas kehotus syöttää tunnukset.
  mode = 'wrong-credentials'; minute();
  await wasteProperties().then(() => assert.fail('väärillä tunnuksilla ei saa onnistua'), () => {});
  minute();
  const blockedReply = await app.inject({ method: 'POST', url: '/api/waste/properties', remoteAddress: '127.0.0.1' });
  assert.equal(blockedReply.statusCode, 429);
  assert.ok(Number(blockedReply.headers['retry-after']) > 0, 'retry-after puuttuu lukitustilan vastauksesta');
  assert.ok(blockedReply.json().retryAfterSeconds > 0, 'selain ei saa jäljellä olevaa aikaa');
  await app.close();
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  registry.stopAll();
  fs.rmSync(process.env.DB_PATH!, { force: true });
  fs.rmSync(process.env.DB_PATH + '.waste-key', { force: true });
  fs.rmSync(process.env.LOG_DIR!, { recursive: true, force: true });
}
console.log('Waste lockout: ' + measured.join(' | '));
