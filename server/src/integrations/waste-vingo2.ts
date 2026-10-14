/** Vain lukeva sovitin Vingo 2.0 -asiointiportaalin (React-sovellus + REST-rajapinta) protokollaan.
 * Ainoa kirjoittava pyyntö on kirjautumisen POST; tilauksia, keskeytyksiä, ehtojen
 * hyväksyntää tai muita muutoksia ei koskaan lähetetä.
 *
 * Sammakkokangas vaihtoi vanhasta Vingo-asioinnista (`waste-vingo.ts`) tähän
 * 12.9.2026. Rajapinta mitattiin 14.10.2026 oikeilla tunnuksilla (yksi
 * kirjautuminen ja GET-pyynnöt), ks. docs/waste-sources.md.
 */
import { WasteAuthError, WasteServiceError, boundedArray, calendarDate, identifier, intervalText, record, type WasteClient, type WasteCollection, type WasteProperty } from './waste-vingo.ts';

const LIMIT = 2_000_000;
/** Tunnisteen etuliite. Vanhan sovittimen `vingo:` ei kelpaa tälle, ks. schedule(). */
const PREFIX = 'vingo2:';
/** Kuinka pitkälle eteenpäin Planned-päiviä näytetään, ja kuinka monta astiaa kohden. */
const HORIZON_DAYS = 92;
const PER_CONTAINER = 6;
/** Token uusitaan kun vanhenemiseen on tätä vähemmän. Portaalin token on voimassa ~1 h. */
const TOKEN_MARGIN_MS = 120_000;
/** Jos vastaus ei kerro kelvollista vanhenemista, oletetaan lyhyt elinikä. */
const TOKEN_FALLBACK_MS = 15 * 60_000;
/** Tätä tuoreemman tokenin hylkäys tietopyynnössä ei ole vanhenemista vaan pysyvä vika. */
const FRESH_TOKEN_MS = 5 * 60_000;
/** Planned-päivä näin lähellä nextEmptyingia on saman tyhjennyksen vanha ajoitus (arkipyhäsiirto). */
const SHIFT_DAYS = 3;

const helsinkiDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
function addDays(day: string, days: number): string {
  return new Date(new Date(day + 'T12:00:00Z').getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
/** ISO-viikon numero kalenteripäivälle, jolla valitaan `emptyingIntervals`in kausi. */
function isoWeek(day: string): number {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));   // viikon torstai
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}
/**
 * `emptyingIntervals` tekstiksi samoin sanoin kuin vanha sovitin. Väli on
 * kausikohtainen (`startWeek`..`endWeek`), joten valitaan se joka kattaa kuluvan
 * viikon; jos mikään ei kata, ensimmäinen jolla on väli. `interval` 0 = "Tilauksesta"
 * eli ei säännöllisiä tyhjennyksiä, eikä siitä synny tekstiä.
 */
function intervalFrom(value: unknown, week: number): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.slice(0, 20).flatMap(raw => {
    try {
      const row = record(raw);
      const text = intervalText(row.interval, undefined);
      const start = Number(row.startWeek), end = Number(row.endWeek);
      return text ? [{ text, covers: Number.isFinite(start) && Number.isFinite(end) && (start <= end ? start <= week && week <= end : week >= start || week <= end) }] : [];
    } catch { return []; }
  });
  return (rows.find(row => row.covers) ?? rows[0])?.text;
}

/** Hylätyn kirjautumisen viesti: status ja lyhyt `title`, ei mitään muuta rungosta. */
function rejectedMessage(status: number, title: string | undefined): string {
  const base = 'Jätehuolto hylkäsi kirjautumisen (HTTP ' + status + (title ? ': ' + title : '') + '). Tarkista tunnukset tai avaa asiointipalvelu selaimessa.';
  return status === 400 ? base + ' Jos tunnukset ovat varmasti oikein, asiointipalvelun rajapinta on voinut muuttua.' : base;
}
/** Problem-JSONin `title` jos se on lyhyt, siisti merkkijono. Muu runko jätetään lukematta. */
async function problemTitle(response: Response): Promise<string | undefined> {
  try {
    const reader = response.body?.getReader(); if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let length = 0;
    try { while (length < 4096) { const part = await reader.read(); if (part.done) break; length += part.value.length; chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
    const title = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { title?: unknown }).title;
    return typeof title === 'string' && /^[\p{L}\p{N} .,:;'()/_-]{1,100}$/u.test(title.trim()) ? title.trim() : undefined;
  } catch { return undefined; }
}
const hasZone = (value: unknown): value is string => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
/** `expiresAt` UTC-hetkenä; vyöhykkeetön aika tulkitaan UTC:ksi. */
function parseExpiry(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value + 'Z' : value);
}

type Container = { customer: string; pos: string; name: string; next: string; interval?: string };

export function createVingo2Client(apiUrl: string, tenantId: string, username: string, password: string, fetcher: typeof fetch = fetch, now: () => number = () => Date.now(), report: (info: Record<string, unknown>, message: string) => void = () => {}) {
  const base = new URL(apiUrl.endsWith('/') ? apiUrl : apiUrl + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Jätehuollon palveluosoite ei kelpaa.');
  if (!/^[\w-]{8,100}$/.test(tenantId)) throw new Error('Jätehuollon asiakastunniste ei kelpaa.');
  let token: string | undefined;
  let expiresAt = 0;
  let issuedAt = 0;
  let login: Promise<void> | undefined;
  let failure: unknown;
  let logins = 0;
  let properties: Promise<(WasteProperty & { customer: string })[]> | undefined;
  const today = () => helsinkiDay.format(new Date(now()));

  /** `path` on aina kiinteä polkumalli, jonka tunnisteet on URL-koodattu kutsuvassa päässä. */
  async function send(method: 'GET' | 'POST', path: string, deadline: number, body?: object): Promise<unknown> {
    const url = new URL(path, base);
    // Polku ei saa karata rajapinnan juuresta (esim. koodaamaton `..`).
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Jätehuollon osoite ei kelpaa.');
    const remaining = Math.min(20_000, deadline - now());
    if (remaining <= 0) throw new Error('Jätehuollon haku kesti liian kauan.');
    const signal = AbortSignal.timeout(remaining);
    const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Language': 'fi-FI, fi' };
    const sent = token;
    if (body) { headers['Content-Type'] = 'application/json;charset=utf-8'; headers['Tenant-Id'] = tenantId; }
    else {
      if (!sent) throw new WasteServiceError('Jätehuollon istunto ei ole voimassa. Yritä myöhemmin uudelleen.');
      headers.Authorization = 'Vingo-e-services ' + sent;
    }
    let response: Response;
    // `redirect:'manual'`: uudelleenohjausta ei seurata, joten token tai tunnukset eivät
    // voi päätyä toiseen osoitteeseen.
    try { response = await fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal }); }
    catch { throw new Error('Jätehuoltopalveluun ei saada yhteyttä.'); }
    const discard = () => response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) { await discard(); throw new WasteServiceError('Jätehuoltopalvelu ohjasi toiseen osoitteeseen. Avaa asiointipalvelu selaimessa.'); }
    // HTML ennen statuskoodeja: huoltosivu tai suojamuurin sivu EI kerro tunnuksista
    // mitään, vaikka se tulisi koodilla 400/401. Vanhan osoitteen SPA vastaa myös
    // 200 + text/html.
    if (response.headers.get('content-type')?.includes('text/html')) { await discard(); throw new WasteServiceError(); }
    // Kirjautumisen hylkäys. Hylätyn kirjautumisen statusta ei ole mitattu (väärillä
    // tunnuksilla ei kokeilla, tili voisi lukkiutua), joten luetaan hylkäykseksi 400 ja
    // 401 aina sekä muu 4xx kun vastaus on JSONia (portaalin oma virhemuoto). Poikkeus
    // ovat 408 ja 429, jotka ovat ajoitusta eivätkä tunnuksia. Valinta on tilin kannalta
    // turvallisempi suunta: väärä "tunnukset hylätty" pysäyttää haun ja pyytää käyttäjää
    // tarkistamaan tunnukset, kun taas väärä "palveluhäiriö" jatkaisi kirjautumista samoilla
    // väärillä tunnuksilla. HTML on jo torjuttu yllä, joten suojamuurin sivu ei päädy tänne.
    if (method === 'POST' && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      && (response.status === 400 || response.status === 401 || response.headers.get('content-type')?.includes('json'))) {
      const title = await problemTitle(response);
      throw new WasteAuthError(rejectedMessage(response.status, title));
    }
    // Tunnistautuneen pyynnön 401 ei ole tunnusvirhe: kirjautuminen onnistui hetkeä
    // aiemmin, joten kyse on vanhentuneesta tai hylätystä tokenista. Token unohdetaan ja
    // seuraava haku kirjautuu uudelleen (tunnuksia ei merkitä vääriksi). Jos token on
    // aivan tuore, vika on pysyvä (esim. otsakemuoto muuttunut) ja sticky: uusi
    // kirjautuminen ei auttaisi vaan tuottaisi niitä kahden kirjautumisen kierroksia ikuisesti.
    if (response.status === 401) {
      await discard();
      if (token === sent) {
        token = undefined;
        if (now() - issuedAt < FRESH_TOKEN_MS) failure = new WasteServiceError('Jätehuoltopalvelu hylkää istunnon heti kirjautumisen jälkeen. Yritä myöhemmin uudelleen.');
      }
      throw new WasteServiceError('Jätehuollon istunto ei ollut voimassa. Yritä myöhemmin uudelleen.');
    }
    if (response.status === 403 || response.status === 429) { await discard(); throw new WasteServiceError(); }
    if (!response.ok) { await discard(); throw new Error('Jätehuoltopalvelu palautti virheen (HTTP ' + response.status + ').'); }
    if (Number(response.headers.get('content-length')) > LIMIT) { await discard(); throw new Error('Jätehuollon vastaus on liian suuri.'); }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    if (reader) { try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > LIMIT) { await reader.cancel(); throw new Error('Jätehuollon vastaus on liian suuri.'); } chunks.push(part.value); } } finally { reader.releaseLock(); } }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new Error('Jätehuollon vastaus ei ole luettavissa.'); }
  }

  /**
   * Yksi kirjautuminen per asiakasolio: token käytetään uudelleen kunnes siihen jää
   * alle TOKEN_MARGIN_MS. `waste-service` luo asiakkaan uudelleen 30 min välein ja
   * token on voimassa ~1 h, joten uusi kirjautuminen tämän olion sisällä on käytännössä
   * vain varalla (esim. lyhyt `expiresAt`). Hylätty kirjautuminen muistetaan eikä sitä
   * toisteta. Sama koskee palveluhäiriötä: se ei kerro tunnuksista mitään, mutta
   * `waste-service` luo asiakkaan uudelleen 30 min välein, ja juuri se rytmi pitää
   * kirjautumiset alle kahdessa tunnissa myös yhtiön huoltokatkon aikana
   * (server/test/waste-lockout.ts). Käsin haettaessa asiakas luodaan joka kerta uusiksi.
   * Uusia kirjautumisia sallitaan kaksi: ensimmäinen ja yksi uusinta (token vanhenee
   * tai hylätään), jottei jatkuvasti hylätty token toista kirjautumista silmukassa.
   */
  function session(deadline: number): Promise<void> {
    if (failure) return Promise.reject(failure);
    if (token && now() < expiresAt - TOKEN_MARGIN_MS) return Promise.resolve();
    if (!login && logins >= 2) return Promise.reject(failure = new WasteServiceError('Jätehuollon istunto ei pysy voimassa. Yritä myöhemmin uudelleen.'));
    return login ??= (async () => {
      logins++;
      try {
        const result = record(await send('POST', 'Users/login', deadline, { userName: username, password }));
        const value = result.token;
        // Token menee otsakkeeseen sellaisenaan; rivinvaihto tai tyhjä merkki sallisi otsakeinjektion.
        if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(value)) throw new Error('Jätehuollon kirjautumisvastauksen rakenne ei kelpaa.');
        // Tuore token ei saa näyttää heti vanhentuneelta (väärä vyöhyke tai kellot eri
        // tahtiin), koska silloin jokainen haku kirjautuisi uudelleen. Käytetään silloin oletuseliniää.
        const until = parseExpiry(result.expiresAt);
        token = value;
        issuedAt = now();
        expiresAt = Number.isFinite(until) && until > now() + TOKEN_MARGIN_MS ? until : now() + TOKEN_FALLBACK_MS;
      } catch (error) {
        failure = error;
        throw error;
      } finally { login = undefined; }
    })();
  }

  function loadProperties(deadline: number) {
    return properties ??= (async () => {
      await session(deadline);
      const infos = boundedArray(await send('GET', 'Customers/emptying-infos', deadline), 200);
      const day = today(), seen = new Set<string>(), result: (WasteProperty & { customer: string })[] = [];
      for (const raw of infos) {
        const info = record(raw);
        const customer = identifier(info.id);
        // Päättynyt kohde ei tyhjene enää. Kelvoton päivä ei sulje kohdetta pois.
        if (info.contractEndDate != null) { try { if (calendarDate(info.contractEndDate) < day) continue; } catch { /* käsitellään voimassa olevana */ } }
        const id = PREFIX + encodeURIComponent(customer);
        if (seen.has(id)) throw new Error('Jätehuollon kohde toistuu vastauksessa.');
        seen.add(id);
        const where = info.address && typeof info.address === 'object' && !Array.isArray(info.address) ? info.address as Record<string, unknown> : {};
        const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
        const address = [text(where.street), [text(where.postalCode), text(where.postOffice)].filter(Boolean).join(' ')].filter(Boolean).join(', ').slice(0, 500);
        result.push({ id, address: address || customer, customer });
      }
      return result;
    })().catch(error => { if (!(error instanceof WasteAuthError)) properties = undefined; throw error; });
  }

  return {
    async listProperties(): Promise<WasteProperty[]> {
      return (await loadProperties(now() + 60_000)).map(({ id, address }) => ({ id, address }));
    },
    async schedule(propertyId: string): Promise<WasteCollection[]> {
      const deadline = now() + 90_000;
      // Vanhan sovittimen tunniste on tallennettu ennen Sammakkokankaan siirtymää.
      // Sitä ei voi muuntaa (asiakasnumero ei ole sama kuin Vingo 2.0:n kohdetunniste),
      // joten käyttäjää pyydetään valitsemaan kohde uudelleen.
      if (propertyId.startsWith('vingo:')) throw new Error('Tallennettu kiinteistö on vanhan asiointipalvelun tunniste. Valitse kohde uudelleen.');
      await session(deadline);
      const property = (await loadProperties(deadline)).find(item => item.id === propertyId);
      if (!property) throw new Error('Valittu kiinteistö ei kuulu jätehuoltotunnukselle. Valitse kohde uudelleen.');
      const day = today(), horizon = addDays(day, HORIZON_DAYS), week = isoWeek(day);
      const contracts = boundedArray(await send('GET', 'Customers/emptying-infos/' + encodeURIComponent(property.customer) + '/contracts', deadline), 200);
      // Vain astiat joilla on seuraava tyhjennyspäivä. Maksurivit (perusmaksu jne.)
      // ovat sopimuksia ilman sitä, eikä niille haeta tietoja. Kelvoton rivi pilaa vain itsensä.
      const containers: Container[] = [];
      for (const raw of contracts) {
        try {
          const contract = record(raw);
          if (contract.nextEmptying == null) continue;
          const next = calendarDate(contract.nextEmptying);
          // Tuntematon päivä ei ole päättynyt sopimus: vain selvästi mennyt endDate pudottaa astian.
          if (contract.endDate != null) { try { if (calendarDate(contract.endDate) < day) continue; } catch { /* käsitellään voimassa olevana */ } }
          const name = contract.name;
          if (typeof name !== 'string' || !name.trim() || name.length > 500) continue;
          const customer = identifier(contract.customerId), pos = identifier(contract.position);
          if (containers.some(item => item.customer === customer && item.pos === pos)) continue;
          const interval = intervalFrom(contract.emptyingIntervals, week);
          containers.push({ customer, pos, name: name.trim(), next, ...(interval ? { interval } : {}) });
        } catch { /* ei päivää tälle sopimukselle; muut jatkavat */ }
      }
      const collections = new Map<string, WasteCollection>();
      const failures: string[] = [];
      for (const container of containers) {
        const dates = new Set<string>();
        try {
          const details = record(await send('GET', 'Customers/contracts/' + encodeURIComponent(container.customer) + '/' + encodeURIComponent(container.pos), deadline));
          const planned = details.allEmptyings && typeof details.allEmptyings === 'object' ? (details.allEmptyings as Record<string, unknown>).Planned : undefined;
          const upcoming: string[] = [];
          // Planned-ajat ovat UTC-hetkiä Helsingin keskiyöstä, ja menneet päivät
          // ovat mukana. Kelvoton alkio pilaa vain oman solunsa.
          if (planned != null) for (const item of boundedArray(planned, 5000)) {
            // Vyöhykkeetön Planned-aika hylätään: se olisi arvaus paikalliseksi, kun portaali antaa UTC-hetkiä.
          try { const raw = record(item).emptyingDate; if (!hasZone(raw)) continue; const date = calendarDate(raw); if (date >= day && date <= horizon) upcoming.push(date); } catch { /* ohitetaan */ }
          }
          // Mitatussa datassa nextEmptying on ensimmäinen tuleva Planned. Jos ne eroavat
          // (esim. arkipyhäsiirto), nextEmptying on ajantasaisempi, eikä samalle astialle
          // saa tulla kahta lähekkäistä päivää.
          const near = (date: string) => container.next >= day && date !== container.next && Math.abs(Date.parse(date + 'T12:00:00Z') - Date.parse(container.next + 'T12:00:00Z')) <= SHIFT_DAYS * 86_400_000;
          for (const date of [...new Set(upcoming)].filter(date => !near(date)).sort().slice(0, PER_CONTAINER)) dates.add(date);
        } catch (error) {
          // Tietopyyntö epäonnistui: `nextEmptying` riittää tämän astian varapäiväksi,
          // eikä yksi astia saa kaataa muita. Syy kirjataan yhdellä rivillä haun lopussa.
          failures.push(error instanceof Error ? error.message : 'tuntematon virhe');
        }
        if (container.next >= day) dates.add(container.next);
        for (const date of dates) {
          const id = [container.customer, container.pos, date].map(encodeURIComponent).join(':');
          collections.set(id, { id, label: container.name, date, ...(container.interval ? { intervalText: container.interval } : {}) });
        }
      }
      if (failures.length) report({ event: 'waste_vingo2_details_failed', failed: failures.length, containers: containers.length, reasons: [...new Set(failures)].slice(0, 3) }, 'Jätehuollon astioiden tietopyyntö epäonnistui, käytetään nextEmptyingia: ' + failures.length + '/' + containers.length);
      return [...collections.values()].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    }
  } satisfies WasteClient;
}
