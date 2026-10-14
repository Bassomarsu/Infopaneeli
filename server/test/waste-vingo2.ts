import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WasteAuthError, WasteServiceError } from '../src/integrations/waste-vingo.ts';
import { createVingo2Client } from '../src/integrations/waste-vingo2.ts';
// Kiinteä "nyt": fixturen Planned-päivät ovat vuosilta 2023-2027, joten testi ei saa riippua kellosta.
const NOW = Date.parse('2026-10-14T10:00:00Z');
const api = 'https://example.test/api/customers';
const tenant = '5429b74b-d22b-48b2-8c77-8d10bfd91c94';
const TOKEN = 'header.payload.signature-0123456789';
const load = (name: string) => JSON.parse(fs.readFileSync(new URL('./fixtures/vingo2/' + name + '.json', import.meta.url), 'utf8'));
const infos = load('emptying-infos'), contracts = load('contracts'), details = load('contract-details-pos2');
type Call = { url: URL; method: string; headers: Headers; body: string | undefined; redirect: string | undefined; signal: AbortSignal | null | undefined };
type Handler = (call: Call) => Response;
const loginOk = () => Response.json({ token: TOKEN, expiresAt: '2026-10-14T14:21:26Z' });
function fixture(overrides: Record<string, Handler> = {}, clock: () => number = () => NOW) {
  const calls: Call[] = [];
  const fetcher = (async (url, init = {}) => {
    const call: Call = { url: new URL(String(url)), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body as string | undefined, redirect: init.redirect, signal: init.signal };
    calls.push(call);
    const path = call.url.pathname.slice('/api/customers/'.length);
    const key = Object.keys(overrides).find(k => path === k || (k.endsWith('*') && path.startsWith(k.slice(0, -1))));
    if (key) return overrides[key]!(call);
    if (path === 'Users/login') return loginOk();
    if (path === 'Customers/emptying-infos') return Response.json(infos);
    if (path === 'Customers/emptying-infos/06-0001234-00/contracts') return Response.json(contracts);
    if (path === 'Customers/contracts/06-0001234-00/2') return Response.json(details);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { client: createVingo2Client(api, tenant, 'fixture-user', 'fixture-password', fetcher, clock), calls };
}
const ID = 'vingo2:06-0001234-00';
const dates = (events: { date: string }[]) => events.map(e => e.date);

// --- Kirjautuminen, otsakkeet ja kiinteistöt
const good = fixture();
assert.equal(good.calls.length, 0, 'ei pyyntöjä ennen ensimmäistä kutsua');
const properties = await good.client.listProperties();
assert.deepEqual(properties, [{ id: ID, address: 'TESTITIE 1, 43500 KARSTULA' }]);
const login = good.calls[0]!;
assert.equal(login.method, 'POST');
assert.equal(login.url.href, api + '/Users/login');
assert.equal(login.headers.get('content-type'), 'application/json;charset=utf-8');
assert.equal(login.headers.get('accept-language'), 'fi-FI, fi');
assert.equal(login.headers.get('tenant-id'), tenant);
assert.equal(login.headers.get('authorization'), null, 'kirjautuminen ei kanna tokenia');
assert.deepEqual(JSON.parse(login.body!), { userName: 'fixture-user', password: 'fixture-password' });
const read = good.calls[1]!;
assert.equal(read.method, 'GET');
assert.equal(read.headers.get('authorization'), 'Vingo-e-services ' + TOKEN);
assert.equal(read.headers.get('accept-language'), 'fi-FI, fi');
assert.equal(read.headers.get('tenant-id'), null, 'tunnistautuneet pyynnöt eivät lähetä Tenant-Id:tä');
assert.equal(read.body, undefined);

// --- Aikataulu fixturesta: maksurivit ohitetaan, menneet suodatetaan, UTC -> Helsingin päivä
const events = await good.client.schedule(ID);
assert.deepEqual(dates(events), ['2026-10-27', '2026-11-24', '2026-12-22'], '2026-10-26T22:00Z on 27.10. ja horisontti on 92 vrk');
assert.ok(events.every(e => e.label === 'SEKAJÄTE ENERGIAKSI 240 L' && e.intervalText === '4 viikon välein' && !('approximate' in e)));
assert.equal(events[0]!.id, '06-0001234-00:2:2026-10-27');
const detailCalls = good.calls.filter(c => c.url.pathname.includes('/Customers/contracts/'));
assert.deepEqual(detailCalls.map(c => c.url.pathname), ['/api/customers/Customers/contracts/06-0001234-00/2'], 'maksurivit (nextEmptying null) eivät saa tietopyyntöä');
assert.equal(good.calls.filter(c => c.method === 'POST').length, 1, 'yksi kirjautuminen per asiakasolio');
await good.client.schedule(ID);
assert.equal(good.calls.filter(c => c.method === 'POST').length, 1, 'token käytetään uudelleen');
assert.equal(good.calls.filter(c => c.url.pathname.endsWith('/Customers/emptying-infos')).length, 1, 'kiinteistöluettelo haetaan kerran');

// --- Vain GET ja kirjautumisen POST, ei koskaan uudelleenohjauksen seurantaa
assert.ok(good.calls.every(c => c.method === 'GET' || (c.method === 'POST' && c.url.pathname === '/api/customers/Users/login')));
assert.ok(good.calls.every(c => c.redirect === 'manual' && c.url.protocol === 'https:' && c.url.origin === 'https://example.test'));

// --- Kesäaika: 2027-08-02T21:00Z on Helsingissä 3.8. (UTC+3), talviaika 2026-10-26T22:00Z on 27.10. (UTC+2)
const CONTRACTS = 'Customers/emptying-infos/06-0001234-00/contracts', DETAILS = 'Customers/contracts/06-0001234-00/2';
const planned = (...values: string[]) => ({ ...details, allEmptyings: { Successful: [], Missed: [], Planned: values.map(emptyingDate => ({ emptyingDate, eventType: 'Planned', description: null })) } });
const summerNow = () => Date.parse('2027-07-20T10:00:00Z');
const summer = fixture({
  [CONTRACTS]: () => Response.json([{ ...contracts[1], nextEmptying: '2027-08-03T00:00:00' }]),
  [DETAILS]: () => Response.json(planned('2027-08-02T21:00:00Z', '2027-08-30T21:00:00Z', '2027-07-05T21:00:00Z')),
}, summerNow);
assert.deepEqual(dates(await summer.client.schedule(ID)), ['2027-08-03', '2027-08-31'], 'kesäajan UTC+3; mennyt 2027-07-06 suodatetaan, nextEmptying ja Planned samalle päivälle -> yksi tapahtuma');

// --- Tänään (Helsingin aikaa) vielä mukana, eilinen ei. 14.10. klo 21:30Z on jo Helsingissä 15.10.
const dayEdge = fixture({ [DETAILS]: () => Response.json(planned('2026-10-13T21:00:00Z', '2026-10-14T21:00:00Z', '2026-10-15T21:00:00Z')) }, () => Date.parse('2026-10-14T21:30:00Z'));
assert.deepEqual(dates(await dayEdge.client.schedule(ID)), ['2026-10-15', '2026-10-16', '2026-10-27'], 'päivä vaihtuu Helsingin keskiyönä, ei UTC:ssä');

// --- Horisontti ja astiakohtainen yläraja: viikoittainen tyhjennys ei täytä korttia
const weekly = Array.from({ length: 30 }, (_, i) => new Date(Date.parse('2026-10-18T21:00:00Z') + i * 7 * 86_400_000).toISOString().replace('.000', ''));
const capped = fixture({ [DETAILS]: () => Response.json(planned(...weekly, ...weekly)) });
const cappedEvents = await capped.client.schedule(ID);
assert.equal(cappedEvents.filter(e => e.date !== '2026-10-27').length, 6, 'enintään 6 Planned-päivää astiaa kohden, kaksoiskappaleet yhdistetään');
assert.ok(cappedEvents.every(e => e.date >= '2026-10-14' && e.date <= '2027-01-14' || e.date === '2026-10-27'));

// --- Yhden astian tietovirhe ei kaada muita: varapäiväksi riittää nextEmptying
const second = { ...contracts[1], position: 4, name: 'BIOJÄTE 140 L', nextEmptying: '2026-10-20T00:00:00', emptyingIntervals: [{ startWeek: 1, endWeek: 53, interval: 2, amountPerWeek: 1, sequence: 1 }] };
const third = { ...contracts[1], position: 5, name: 'PAPERI', nextEmptying: '2026-10-21T00:00:00', emptyingIntervals: [{ startWeek: 1, endWeek: 53, interval: 0, amountPerWeek: 1, sequence: 1 }] };
for (const [label, broken] of [['503', () => new Response(null, { status: 503 })], ['html', () => new Response('<html>huolto</html>', { headers: { 'content-type': 'text/html' } })], ['roskaa', () => new Response('ei json')], ['rakenne', () => Response.json([1, 2])], ['401', () => new Response(null, { status: 401 })], ['yhteys', () => { throw new Error('katkesi'); }]] as const) {
  const partial = fixture({ [CONTRACTS]: () => Response.json([contracts[1], second, third]), 'Customers/contracts/06-0001234-00/4': broken });
  const result = await partial.client.schedule(ID);
  assert.deepEqual(result.filter(e => e.label === 'BIOJÄTE 140 L').map(e => e.date), ['2026-10-20'], 'varapäivä astialle jonka tiedot epäonnistuivat (' + label + ')');
  assert.deepEqual(dates(result.filter(e => e.label === 'SEKAJÄTE ENERGIAKSI 240 L')).slice(0, 2), ['2026-10-27', '2026-11-24'], 'muut astiat säilyvät (' + label + ')');
  assert.equal(result.find(e => e.label === 'BIOJÄTE 140 L')!.intervalText, 'Joka toinen viikko');
  assert.equal(result.find(e => e.label === 'PAPERI')!.intervalText, undefined, 'interval 0 = tilauksesta, ei väliä');
}

// --- Kelvoton päivä, päättynyt sopimus ja nimetön rivi pilaavat vain oman solunsa eivätkä saa tietopyyntöä
const messy = fixture({ [CONTRACTS]: () => Response.json([
  contracts[1],
  { ...second, nextEmptying: '1899-11-30T00:00:00' },
  { ...second, position: 6, nextEmptying: 'huomenna' },
  { ...second, position: 7, endDate: '2026-09-01T00:00:00' },
  { ...second, position: 8, name: '' },
  { ...second, position: 9, customerId: null },
  'rikki',
  { ...second, position: 10, nextEmptying: '2026-09-01T00:00:00' },
]) });
const messyEvents = await messy.client.schedule(ID);
assert.deepEqual(dates(messyEvents), ['2026-10-27', '2026-11-24', '2026-12-22']);
assert.deepEqual(messy.calls.filter(c => c.url.pathname.includes('/Customers/contracts/')).map(c => c.url.pathname.split('/').at(-1)), ['2', '10'], 'vain kelvollisen nextEmptyingin astiat saavat tietopyynnön');

// --- Kelvoton Planned-alkio pilaa vain oman solunsa
const cell = fixture({ [DETAILS]: () => Response.json({ allEmptyings: { Planned: [null, { emptyingDate: 'x' }, { emptyingDate: '2026-11-24T22:00:00Z' }, { emptyingDate: '2026-02-30T00:00:00Z' }] } }) });
assert.deepEqual(dates(await cell.client.schedule(ID)), ['2026-10-27', '2026-11-25']);
const noPlanned = fixture({ [DETAILS]: () => Response.json({ allEmptyings: {} }) });
assert.deepEqual(dates(await noPlanned.client.schedule(ID)), ['2026-10-27'], 'puuttuva Planned -> nextEmptying');

// --- Päättyneet kiinteistöt suodatetaan pois
const ended = fixture({ 'Customers/emptying-infos': () => Response.json([{ ...infos[0], id: 'A', contractEndDate: '2026-09-30T00:00:00' }, { ...infos[0], id: 'B', contractEndDate: '2026-12-31T00:00:00' }, { ...infos[0], id: 'C', contractEndDate: 'rikki', address: null }]) });
assert.deepEqual((await ended.client.listProperties()).map(p => p.id), ['vingo2:B', 'vingo2:C']);
assert.equal((await ended.client.listProperties())[1]!.address, 'C', 'osoitteeton kohde näytetään tunnisteella');
await assert.rejects(() => ended.client.schedule('vingo2:A'), /ei kuulu/);

// --- Tunnisteet koodataan polussa
const odd = fixture({ 'Customers/emptying-infos': () => Response.json([{ ...infos[0], id: '06/1 ?x#' }]), 'Customers/emptying-infos/*': () => Response.json([{ ...contracts[1], customerId: '06/1 ?x#', position: 'a/b' }]), 'Customers/contracts/*': () => Response.json(planned()) });
assert.deepEqual((await odd.client.listProperties()).map(p => p.id), ['vingo2:06%2F1%20%3Fx%23']);
const oddEvents = await odd.client.schedule('vingo2:06%2F1%20%3Fx%23');
assert.deepEqual(oddEvents.map(e => e.id), ['06%2F1%20%3Fx%23:a%2Fb:2026-10-27']);
assert.ok(odd.calls.some(c => c.url.href === api + '/Customers/emptying-infos/06%2F1%20%3Fx%23/contracts'));
assert.ok(odd.calls.some(c => c.url.href === api + '/Customers/contracts/06%2F1%20%3Fx%23/a%2Fb'));

// --- Vanhan sovittimen tunniste ja tuntematon kohde: selkeä "valitse uudelleen", ei verkkoliikennettä vanhalle
const stale = fixture();
await assert.rejects(() => stale.client.schedule('vingo:41,42'), (error: unknown) => !(error instanceof WasteAuthError) && /Valitse kohde uudelleen/.test((error as Error).message));
assert.equal(stale.calls.length, 0, 'vanha tunniste hylätään ennen kirjautumista');
await assert.rejects(() => stale.client.schedule('vingo2:99'), /ei kuulu.*Valitse kohde uudelleen/);

// --- Tunnusvirhe: login 401 ja 400 ovat WasteAuthError, eikä kirjautumista toisteta
for (const status of [401, 400]) {
  const denied = fixture({ 'Users/login': () => Response.json({ status, title: 'Unauthorized' }, { status }) });
  await assert.rejects(() => denied.client.listProperties(), WasteAuthError);
  await assert.rejects(() => denied.client.schedule(ID), WasteAuthError);
  await assert.rejects(() => denied.client.listProperties(), WasteAuthError);
  assert.equal(denied.calls.length, 1, 'hylättyä kirjautumista ei toisteta samalla asiakasoliolla (' + status + ')');
}

// --- Palveluhäiriö EI ole tunnusvirhe: HTML, 403, 429, 5xx, uudelleenohjaus, katkennut yhteys
const outages: [string, Handler][] = [
  ['html 200 (vanhan osoitteen SPA)', () => new Response('<!doctype html><title>Vingo</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } })],
  ['html 401', () => new Response('<html>', { status: 401, headers: { 'content-type': 'text/html' } })],
  ['html 400', () => new Response('<html>', { status: 400, headers: { 'content-type': 'text/html' } })],
  ['403', () => new Response(null, { status: 403 })],
  ['429', () => new Response(null, { status: 429 })],
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://other.test/steal' } })],
];
for (const [label, handler] of outages) {
  const down = fixture({ 'Users/login': handler });
  await assert.rejects(() => down.client.listProperties(), (error: unknown) => error instanceof WasteServiceError && !(error instanceof WasteAuthError), label);
  assert.equal(down.calls.length, 1);
  assert.ok(down.calls.every(c => c.redirect === 'manual'));
}
for (const [label, handler] of [['503', () => new Response(null, { status: 503 })], ['500 problem+json', () => Response.json({ status: 500, title: 'Server error' }, { status: 500 })], ['katkennut', () => { throw new Error('ECONNRESET'); }], ['ei JSONia', () => new Response('ok')], ['ei tokenia', () => Response.json({ expiresAt: '2026-10-14T14:21:26Z' })], ['token rivinvaihdolla', () => Response.json({ token: 'abc\r\nX-Evil: 1abcdefghijkl', expiresAt: '2026-10-14T14:21:26Z' })], ['taulukko', () => Response.json([])]] as [string, Handler][]) {
  const down = fixture({ 'Users/login': handler });
  await assert.rejects(() => down.client.listProperties(), (error: unknown) => error instanceof Error && !(error instanceof WasteAuthError), label);
}
// Palveluhäiriö muistetaan asiakasolion eliniän (waste-service luo uuden 30 min välein), jotta huoltokatko ei tuota kirjautumisia joka haulla
let attempts = 0;
const flaky = fixture({ 'Users/login': () => ++attempts === 1 ? new Response(null, { status: 503 }) : loginOk() });
await assert.rejects(() => flaky.client.listProperties());
await assert.rejects(() => flaky.client.schedule(ID));
assert.equal(attempts, 1, 'sama asiakasolio ei kirjaudu uudelleen häiriön jälkeen');

// --- Tietopyyntöjen virheet: HTML, 403 ja uudelleenohjaus listauksessa ovat palveluhäiriö; 401 ei ole tunnusvirhe
for (const [label, handler] of [['html', () => new Response('<html>', { headers: { 'content-type': 'text/html' } })], ['403', () => new Response(null, { status: 403 })], ['redirect', () => new Response(null, { status: 307, headers: { location: 'https://other.test/' } })], ['401', () => new Response(null, { status: 401 })]] as [string, Handler][]) {
  const broken = fixture({ 'Customers/emptying-infos': handler });
  await assert.rejects(() => broken.client.listProperties(), (error: unknown) => error instanceof WasteServiceError && !(error instanceof WasteAuthError), label);
}
// Vanhentunut token (yli 5 min vanha) hylätään tietopyynnössä: seuraava haku kirjautuu uudelleen (onnistunut kirjautuminen ei lukitse tiliä), tunnuksia ei merkitä vääriksi
let rotation = NOW, rejects = 0;
const rotated = fixture({ [CONTRACTS]: () => ++rejects === 1 ? new Response(null, { status: 401 }) : Response.json(contracts) }, () => rotation);
await rotated.client.listProperties();
rotation += 6 * 60_000;
await assert.rejects(() => rotated.client.schedule(ID), (error: unknown) => error instanceof WasteServiceError && !(error instanceof WasteAuthError));
assert.ok((await rotated.client.schedule(ID)).length > 0);
assert.equal(rotated.calls.filter(c => c.method === 'POST').length, 2);
// Tuore token (alle 5 min) jonka tietopyyntö hylätään on pysyvä vika: sticky WasteServiceError, ei uutta kirjautumista
const looping = fixture({ 'Customers/emptying-infos': () => new Response(null, { status: 401 }) });
for (let i = 0; i < 5; i++) await assert.rejects(() => looping.client.listProperties(), (error: unknown) => error instanceof WasteServiceError && !(error instanceof WasteAuthError));
assert.equal(looping.calls.filter(c => c.method === 'POST').length, 1, 'tuoreen tokenin 401 ei tuota uusia kirjautumisia');
let loopClock = NOW;
const loopingOld = fixture({ [CONTRACTS]: () => new Response(null, { status: 401 }) }, () => loopClock);
await loopingOld.client.listProperties(); loopClock += 6 * 60_000;
for (let i = 0; i < 6; i++) await assert.rejects(() => loopingOld.client.schedule(ID), WasteServiceError);
assert.ok(loopingOld.calls.filter(c => c.method === 'POST').length <= 2, 'vanhan tokenin toistuva 401: enintään kaksi kirjautumista asiakasoliota kohden');

// --- Token uusitaan vasta kun vanheneminen on lähellä (2 min)
let clock = NOW;
const aging = fixture({ 'Users/login': () => Response.json({ token: TOKEN, expiresAt: new Date(clock + 10 * 60_000).toISOString() }) }, () => clock);
await aging.client.listProperties();
clock += 7 * 60_000;
await aging.client.schedule(ID);
assert.equal(aging.calls.filter(c => c.method === 'POST').length, 1, 'token riittää vielä 3 minuuttia');
clock += 2 * 60_000;
await aging.client.schedule(ID);
assert.equal(aging.calls.filter(c => c.method === 'POST').length, 2, 'alle 2 minuuttia jäljellä -> uusi kirjautuminen');
// expiresAt puuttuu: oletetaan lyhyt elinikä eikä rikota
const noExpiry = fixture({ 'Users/login': () => Response.json({ token: TOKEN }) });
assert.equal((await noExpiry.client.listProperties()).length, 1);

// --- Rinnakkaiset kutsut jakavat yhden kirjautumisen
const parallel = fixture();
await Promise.all([parallel.client.listProperties(), parallel.client.listProperties(), parallel.client.schedule(ID)]);
assert.equal(parallel.calls.filter(c => c.method === 'POST').length, 1);

// --- Vastauskoon rajat ja rakenteen validointi
const big = fixture({ 'Customers/emptying-infos': () => new Response('[]', { headers: { 'content-length': '2000001' } }) });
await assert.rejects(() => big.client.listProperties(), /liian suuri/);
const bigStream = fixture({ 'Customers/emptying-infos': () => new Response(' '.repeat(2_000_001)) });
await assert.rejects(() => bigStream.client.listProperties(), /liian suuri/);
for (const value of [{}, null, 'x', [{ id: '' }], [{ id: 'A' }, { id: 'A' }], Array.from({ length: 201 }, (_, i) => ({ id: 'K' + i }))]) {
  const bad = fixture({ 'Customers/emptying-infos': () => Response.json(value) });
  await assert.rejects(() => bad.client.listProperties(), (error: unknown) => !(error instanceof WasteAuthError));
}
const badContracts = fixture({ [CONTRACTS]: () => Response.json({ a: 1 }) });
await assert.rejects(() => badContracts.client.schedule(ID), (error: unknown) => !(error instanceof WasteAuthError));
const empty = fixture({ [CONTRACTS]: () => Response.json([]) });
assert.deepEqual(await empty.client.schedule(ID), []);

// --- expiresAt: vyöhykkeetön aika tulkitaan UTC:ksi, ja heti vanhentuneelta näyttävä token ei tuota kirjautumissilmukkaa
for (const [label, expiresAt] of [['vyöhykkeetön', '2026-10-14T14:21:26'], ['vyöhykkeetön millisekunneilla', '2026-10-14T14:21:26.123'], ['menneisyydessä', '2026-10-14T09:00:00Z'], ['roskaa', 'huomenna'], ['puuttuu', undefined]] as const) {
  const zoneless = fixture({ 'Users/login': () => Response.json({ token: TOKEN, ...(expiresAt ? { expiresAt } : {}) }) });
  await zoneless.client.schedule(ID);
  await zoneless.client.schedule(ID);
  assert.equal(zoneless.calls.filter(c => c.method === 'POST').length, 1, 'yksi schedule() = yksi kirjautuminen (' + label + ')');
}

// --- Kirjautumisen 4xx: JSONilla kaikki paitsi 408/429 ovat tunnusvirhe; HTML-vahti ja 408/429 ennallaan
for (const status of [400, 401, 403, 404, 409, 422, 423]) {
  const rejected = fixture({ 'Users/login': () => Response.json({ status, title: 'Rejected' }, { status }) });
  await assert.rejects(() => rejected.client.schedule(ID), WasteAuthError, 'JSON ' + status);
  await assert.rejects(() => rejected.client.listProperties(), WasteAuthError);
  assert.equal(rejected.calls.length, 1, 'hylkäystä ei toisteta (' + status + ')');
}
for (const status of [408, 429]) {
  const timing = fixture({ 'Users/login': () => Response.json({ status, title: 'Slow down' }, { status }) });
  await assert.rejects(() => timing.client.listProperties(), (error: unknown) => error instanceof Error && !(error instanceof WasteAuthError), String(status));
}
for (const status of [403, 404, 422]) {
  const wall = fixture({ 'Users/login': () => new Response('<html>blocked</html>', { status, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(() => wall.client.listProperties(), (error: unknown) => error instanceof WasteServiceError && !(error instanceof WasteAuthError), 'HTML ' + status);
  const plain = fixture({ 'Users/login': () => new Response(null, { status }) });
  await assert.rejects(() => plain.client.listProperties(), (error: unknown) => !(error instanceof WasteAuthError), 'tyhjä ' + status);
}

// --- Tunnusvirheen viesti: status ja lyhyt title, ei muuta rungosta eikä koskaan salasanaa tai tokenia
const verbose = fixture({ 'Users/login': () => Response.json({ status: 400, title: 'Bad Request', detail: 'salainen runko fixture-password ' + TOKEN, errors: { userName: ['x'] } }, { status: 400 }) });
const err400 = await verbose.client.listProperties().then(() => assert.fail('pitäisi hylätä'), (e: unknown) => e as Error);
assert.ok(err400 instanceof WasteAuthError);
assert.match(err400.message, /HTTP 400: Bad Request/);
assert.match(err400.message, /rajapinta on voinut muuttua/);
for (const secret of ['fixture-password', 'fixture-user', TOKEN, 'salainen runko']) assert.ok(!err400.message.includes(secret), 'viestissä ei saa olla: ' + secret);
const err401 = await fixture({ 'Users/login': () => Response.json({ title: 'x'.repeat(500) }, { status: 401 }) }).client.listProperties().then(() => assert.fail('x'), (e: unknown) => e as Error);
assert.match(err401.message, /HTTP 401\)/, 'liian pitkä title jätetään pois');
assert.doesNotMatch(err401.message, /rajapinta on voinut muuttua/, 'lisälause vain 400:lle');
const err401b = await fixture({ 'Users/login': () => new Response('ei json', { status: 401 }) }).client.listProperties().then(() => assert.fail('x'), (e: unknown) => e as Error);
assert.ok(err401b instanceof WasteAuthError && /HTTP 401\)/.test(err401b.message));
const evilTitle = await fixture({ 'Users/login': () => Response.json({ title: 'fixture-password\n<script>' }, { status: 400 }) }).client.listProperties().then(() => assert.fail('x'), (e: unknown) => e as Error);
assert.doesNotMatch(evilTitle.message, /fixture-password|script/);

// --- Planned vs nextEmptying: arkipyhäsiirrossa nextEmptying voittaa, ±3 vrk Plannedit poistetaan
const shifted = fixture({
  [CONTRACTS]: () => Response.json([{ ...contracts[1], nextEmptying: '2026-10-28T00:00:00' }]),
  [DETAILS]: () => Response.json(planned('2026-10-26T22:00:00Z', '2026-10-24T22:00:00Z', '2026-10-31T22:00:00Z', '2026-11-24T22:00:00Z')),
});
assert.deepEqual(dates(await shifted.client.schedule(ID)), ['2026-10-28', '2026-11-01', '2026-11-25'], '27.10. (1 vrk) ja 25.10. (3 vrk) poistuvat, 1.11. (4 vrk) ja 25.11. jäävät');
const unshifted = fixture({ [CONTRACTS]: () => Response.json([{ ...contracts[1], nextEmptying: '2026-10-12T00:00:00' }]), [DETAILS]: () => Response.json(planned('2026-10-26T22:00:00Z')) });
assert.deepEqual(dates(await unshifted.client.schedule(ID)), ['2026-10-27'], 'mennyt nextEmptying ei poista tulevia Planned-päiviä');

// --- Planned-aika ilman vyöhykettä hylätään (ei arvata paikalliseksi), vyöhykkeellinen offset kelpaa
const zoneless = fixture({ [DETAILS]: () => Response.json({ allEmptyings: { Planned: [{ emptyingDate: '2026-11-24T22:00:00' }, { emptyingDate: '2026-12-01' }, { emptyingDate: Date.parse('2026-12-02T00:00:00Z') }, { emptyingDate: '2026-12-05T01:00:00+02:00' }, { emptyingDate: '2026-12-15T22:00:00.000Z' }] } }) });
assert.deepEqual(dates(await zoneless.client.schedule(ID)), ['2026-10-27', '2026-12-05', '2026-12-16']);

// --- Kelvoton contract.endDate ei pudota astiaa, mennyt pudottaa
const badEnd = fixture({ [CONTRACTS]: () => Response.json([{ ...contracts[1], endDate: 'ei päivä' }, { ...second, endDate: '2026-09-01T00:00:00' }]) });
assert.deepEqual(dates(await badEnd.client.schedule(ID)).slice(0, 1), ['2026-10-27']);
assert.ok((await badEnd.client.schedule(ID)).every(e => e.label === 'SEKAJÄTE ENERGIAKSI 240 L'));

// --- Tunniste ei saa olla pelkkiä pisteitä (polkuun koodattuna '..' pääsisi ylös)
for (const bad of ['.', '..', '...', ' .. ']) {
  const dots = fixture({ 'Customers/emptying-infos': () => Response.json([{ ...infos[0], id: bad }]) });
  await assert.rejects(() => dots.client.listProperties(), /tunniste/, JSON.stringify(bad));
  const dotsContract = fixture({ [CONTRACTS]: () => Response.json([{ ...contracts[1], customerId: bad }]) });
  assert.deepEqual(await dotsContract.client.schedule(ID), [], 'astia pisteillä pelkillä tunnisteella ohitetaan');
  assert.equal(dotsContract.calls.filter(c => c.url.pathname.includes('/Customers/contracts/')).length, 0);
}

// --- Astioiden tietovirheistä yksi warn-rivi per haku
const warnings: { info: Record<string, unknown>; message: string }[] = [];
const loud = createVingo2Client(api, tenant, 'u', 'p', (async (url: URL) => {
  const path = new URL(String(url)).pathname.slice('/api/customers/'.length);
  if (path === 'Users/login') return loginOk();
  if (path === 'Customers/emptying-infos') return Response.json(infos);
  if (path === CONTRACTS) return Response.json([contracts[1], second, third]);
  if (path === DETAILS) return Response.json(details);
  return new Response(null, { status: 503 });
}) as unknown as typeof fetch, () => NOW, (info, message) => warnings.push({ info, message }));
await loud.schedule(ID);
assert.equal(warnings.length, 1, 'yksi rivi per haku, ei per astia');
assert.equal(warnings[0]!.info.event, 'waste_vingo2_details_failed');
assert.equal(warnings[0]!.info.failed, 2);
assert.equal(warnings[0]!.info.containers, 3);
assert.deepEqual(warnings[0]!.info.reasons, ['Jätehuoltopalvelu palautti virheen (HTTP 503).']);
assert.ok(!JSON.stringify(warnings).includes(TOKEN) && !JSON.stringify(warnings).includes('Authorization'));
warnings.length = 0;
await good.client.schedule(ID);
assert.equal(warnings.length, 0);

// --- Aikakatkaisu ja määräaika: jokaisella pyynnöllä on keskeytyssignaali, ja määräajan ylitys pysäyttää haun
assert.ok(good.calls.every(c => c.signal instanceof AbortSignal));
let tick = NOW;
const late = fixture({ 'Users/login': () => { tick += 100_000; return loginOk(); } }, () => tick);
await assert.rejects(() => late.client.listProperties(), /kesti liian kauan/);

// --- Osoitteen ja asiakastunnisteen validointi
assert.throws(() => createVingo2Client('http://example.test/api', tenant, 'u', 'p'), /palveluosoite/);
assert.throws(() => createVingo2Client('https://u:p@example.test/api', tenant, 'u', 'p'), /palveluosoite/);
assert.throws(() => createVingo2Client('https://example.test/api?x=1', tenant, 'u', 'p'), /palveluosoite/);
assert.throws(() => createVingo2Client(api, 'x\r\ny', 'u', 'p'), /asiakastunniste/);

// --- Mikään testi ei saa lähettää muuta kuin GETiä ja kirjautumisen POSTia
for (const f of [good, summer, shifted, zoneless, badEnd, rotated, looping, dayEdge, capped, messy, cell, noPlanned, ended, odd, stale, aging, parallel, rotated, flaky]) {
  assert.ok(f.calls.every(c => c.method === 'GET' || (c.method === 'POST' && c.url.pathname === '/api/customers/Users/login')));
}
console.log('Vingo 2.0: login headers, single login/token reuse, Planned UTC->Helsinki incl. DST, past/horizon/cap filtering, payment rows skipped, per-container fallback, auth (401/400) vs. service split (html/403/429/302/5xx), id encoding, stale vingo: id, response bounds, GET-only passed');
