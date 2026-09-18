/** Read-only adapter for the public Vingo customer portal protocol.
 * Only the explicit login submits data; terms, orders and service changes are never accepted.
 */
export class WasteAuthError extends Error {
  constructor(message = 'Kirjautuminen jätehuoltoon epäonnistui. Tarkista tunnukset tai avaa asiointipalvelu selaimessa.') {
    super(message); this.name = 'WasteAuthError';
  }
}
/**
 * Palveluhäiriö, EI tunnusvirhe. Ero on se joka ratkaisee lukkiutuuko perheen
 * jätehuoltotili: vain WasteAuthError pysäyttää kirjautumisen ja kehottaa
 * tarkistamaan tunnukset, ja juuri se kehotus ajaa käyttäjän kokeilemaan
 * salasanoja. Huoltosivu ja suojamuurin torjunta eivät kerro tunnuksista
 * mitään, joten ne eivät saa näyttää väärältä salasanalta.
 */
export class WasteServiceError extends Error {
  constructor(message = 'Jätehuoltopalvelu ei juuri nyt vastaa odotetusti (huolto tai häiriö). Yritä myöhemmin uudelleen.') {
    super(message); this.name = 'WasteServiceError';
  }
}
export interface WasteProperty { id: string; address: string }
export interface WasteCollection {
  id: string;
  label: string;
  date: string;
  /**
   * Päivä on arvio, ei ajosuunnitelma — kortin on merkittävä se.
   *
   * Portaalilla on kaksi eri tarkkuuden lähdettä samalle astialle, eivätkä ne
   * ole sama tieto eri kattavuudella:
   *
   *   get_collection_schedule.do   ajosuunnitelma, portaali näyttää sen
   *                                sellaisenaan viikkoruudukossa
   *   ASTNextDate                  arvio, jonka portaali näyttää AINA
   *                                merkinnällä "(± 1-2 päivää)"
   *
   * Merkintä ei ole reunatapaus vaan kentän ominaisuus: portaalin sapluunassa
   * teksti on kiinteä, ja sen korvaava sääntömoottori (`_nextEmptyingRules`)
   * on tyhjä eikä sen asettajaa kutsuta mistään. Jokainen `ASTNextDate`
   * esitetään siis epävarmana.
   */
  approximate?: boolean;
  /**
   * Tyhjennysväli tekstinä, esim. "4 viikon välein", tai puuttuu jos astialla
   * ei ole väliä.
   *
   * TEKSTINÄ eikä laskettuina päivinä. Välistä voisi ekstrapoloida tulevia
   * tyhjennyksiä, mutta se olisi fiktiota: astialla voi olla kaksi eri väliä
   * eri vuodenajoille (`ASTVali2`), `ASTKrtvk` voi olla yli yksi jolloin väli
   * ei yksin määrää päivää, ja ±1-2 päivän virhe kumuloituu joka kerralla.
   * Portaali itse ei ekstrapoloi vaikka sillä on molemmat kentät samassa
   * oliossa — kun järjestelmän tekijä kieltäytyy laskemasta seuraavaa, me
   * emme tiedä enempää.
   */
  intervalText?: string;
}
type Group = WasteProperty & { customers: string[] };
const LIMIT = 2_000_000;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Jätehuollon vastauksen rakenne ei kelpaa.');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 100) throw new Error('Jätehuollon tunniste puuttuu.');
  return String(value);
}
function boundedArray(value: unknown, max = 500): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Jätehuollon luettelon rakenne ei kelpaa.');
  return value;
}
function calendarDate(value: unknown): string {
  // Unzoned portal date-times are local calendar dates, never host-machine UTC guesses.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)?$/.test(value)) {
    const day = value.slice(0, 10);
    const date = new Date(day + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day || Number(day.slice(0,4)) < 1900) throw new Error('Jätehuollon päivämäärä ei kelpaa.');
    if (value.length > 10 && (Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59)) throw new Error('Jätehuollon päivämäärä ei kelpaa.');
    return day;
  }
  if (!(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) throw new Error('Jätehuollon päivämäärä ei kelpaa.');
  if (typeof value === 'string') calendarDate(value.slice(0,19));
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9998) throw new Error('Jätehuollon päivämäärä ei kelpaa.');
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
/**
 * `request`in paluuarvo kun kirjautumis-POST onnistui uudelleenohjauksella.
 *
 * Oma symboli eikä esim. `true`, jotta sitä ei voi sekoittaa palvelimelta
 * tulleeseen JSON-arvoon: portaalin vastaus ei voi koskaan olla tämä.
 */
/**
 * `ASTVali` tekstiksi samoin sanoin kuin portaali (`ASTValiToText`,
 * tabs/service-list.js:374). Astialla voi olla kaksi väliä eri vuodenajoille;
 * jos ensimmäinen on "Tilauksesta" mutta toinen ei, portaali näyttää toisen —
 * sama valinta tehdään tässä.
 */
function intervalText(vali: unknown, vali2: unknown): string | undefined {
  const luku = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value) : null;
    return n !== null && Number.isInteger(n) && n >= 0 && n <= 520 ? n : null;
  };
  const a = luku(vali), b = luku(vali2);
  const valittu = a !== null && a > 0 ? a : b !== null && b > 0 ? b : null;
  if (valittu === null) return undefined;   // 0 = "Tilauksesta", ei väliä
  if (valittu === 1) return 'Kerran viikossa';
  if (valittu === 2) return 'Joka toinen viikko';
  return valittu + ' viikon välein';
}

const LOGIN_OK = Symbol('vingo-login-ok');

export function createVingoClient(baseUrl: string, username: string, password: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Jätehuollon palveluosoite ei kelpaa.');
  const cookies = new Map<string, {name:string; value:string; path:string}>();
  let login: Promise<void> | undefined;
  let groups: Promise<Group[]> | undefined;
  async function request(path: string, body?: URLSearchParams, deadline = Date.now() + 20_000, salliKirjautumisohjaus = false): Promise<unknown> {
    let url = new URL(path, base);
    let method = body ? 'POST' : 'GET';
    const remaining = Math.min(20_000, deadline - Date.now());
    if (remaining <= 0) throw new Error('Jätehuollon haku kesti liian kauan.');
    const timeout = AbortSignal.timeout(remaining);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new WasteAuthError('Jätehuoltopalvelu ohjasi toiseen osoitteeseen. Avaa asiointipalvelu selaimessa.');
      const headers: Record<string,string> = {Accept:'application/json', 'X-Requested-With':'XMLHttpRequest'};
      const cookie = [...cookies.values()].filter(c => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')).map(c => c.name + '=' + c.value).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      let response: Response;
      try { response = await fetcher(url, {method,headers,body:body?.toString(),redirect:'manual',signal:timeout}); }
      catch { throw new Error('Jätehuoltopalveluun ei saada yhteyttä.'); }
      for (const raw of response.headers.getSetCookie()) {
        const parts = raw.split(';').map(v => v.trim());
        const pair = parts.shift()!; const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0,eq), value = pair.slice(eq+1);
        if (!/^[!#$%&'*+.^_\x60|~\w-]+$/.test(name) || /[\r\n;]/.test(value)) continue;
        const attrs = new Map(parts.map(part=>{const i=part.indexOf('=');return [part.slice(0,i<0?undefined:i).toLowerCase(), i<0?'':part.slice(i+1)] as const;}));
        const domain = attrs.get('domain')?.replace(/^\./,'').toLowerCase();
        if (domain && domain !== base.hostname) continue;
        const cookiePath = attrs.get('path')?.startsWith('/') ? attrs.get('path')! : url.pathname.slice(0,url.pathname.lastIndexOf('/')+1);
        const key = name + ':' + cookiePath;
        if (attrs.get('max-age') === '0' || (attrs.has('expires') && Date.parse(attrs.get('expires')!) <= Date.now())) cookies.delete(key);
        else if (cookies.size < 100 || cookies.has(key)) cookies.set(key,{name,value,path:cookiePath});
      }
      if (response.status >= 300 && response.status < 400) {
        const target = response.headers.get('location');
        // POSTin uudelleenohjausta EI seurata: tunnuksia ei toisteta toiseen
        // osoitteeseen, eikä ehtoja tai salasananvaihtoa hyvaksyta puolesta.
        // Kohde kuitenkin LUETAAN, koska se on ainoa asia joka kertoo menikö
        // kirjautuminen läpi.
        //
        // Mitattu Sammakkokankaan portaalia vasten 18.9.2026: onnistunut
        // kirjautuminen vastaa `303 See Other` + `Location: secure/welcome.do`
        // ja tyhjällä rungolla. Aiemmin tämä haara heitti POSTilla aina
        // `WasteAuthError`in, joten ONNISTUNUT kirjautuminen luettiin vääriksi
        // tunnuksiksi eikä yhteys voinut toimia lainkaan. Epäonnistunut
        // kirjautuminen ohjaa `login.do`hon, joten kohde erottaa nämä.
        if (method === 'POST') {
          // Vain kirjautuminen saa tulkita uudelleenohjauksen onnistumiseksi.
          // Ilman tätä lippua mikä tahansa myöhemmin lisätty POST palauttaisi
          // `LOGIN_OK`in, ja kutsuja saisi siitä harhaanjohtavan
          // rakennevirheen.
          if (!salliKirjautumisohjaus || !target) throw new WasteAuthError();
          const to = new URL(target, url);
          const secure = new URL('secure/', base);
          if (to.origin !== base.origin || !to.pathname.startsWith(secure.pathname)) throw new WasteAuthError();
          // Ehtojen hyväksyntä ja pakotettu salasanan vaihto asuvat `secure/`-
          // puussa, joten ne läpäisisivät tarkistuksen ja näyttäisivät
          // onnistuneelta kirjautumiselta. Seuraava pyyntö kaatuisi, ja
          // käyttäjä saisi tekstin "huolto tai häiriö" pysyvästä tilasta joka
          // ei korjaudu odottamalla. Mitattu 18.9.2026: molemmat polut ovat
          // olemassa (`secure/terms.do`, `secure/pw.do`).
          if (['terms.do', 'pw.do'].includes(to.pathname.slice(to.pathname.lastIndexOf('/') + 1))) {
            await response.body?.cancel();
            throw new WasteAuthError('Jätehuollon asiointipalvelu vaatii ehtojen hyväksynnän tai salasanan vaihdon. Avaa asiointipalvelu selaimessa ja tee se siellä.');
          }
          await response.body?.cancel();
          return LOGIN_OK;
        }
        if (!target || redirects === 3) throw new WasteAuthError();
        await response.body?.cancel(); url = new URL(target,url); continue;
      }
      // Vain 401 on aito tunnusvirhe. Huoltosivu palautuu koodilla 200 ja
      // `text/html`:llä, ja suojamuuri vastaa 403:lla — kumpikaan ei kerro
      // tunnuksista mitään. Aiemmin kaikki kolme olivat WasteAuthError, jolloin
      // yhtiön huoltokatko pysäytti kirjautumisen ja käyttöliittymä käski
      // tarkistaa tunnukset. Tunnusten hylkääminen tunnistetaan oikeasti
      // kirjautumisvastauksen `response !== 'OK'` -kentästä (ks. authenticate).
      if (response.status === 401) throw new WasteAuthError();
      if (response.status === 403 || response.headers.get('content-type')?.includes('text/html')) throw new WasteServiceError();
      if (!response.ok) throw new Error('Jätehuoltopalvelu palautti virheen (HTTP ' + response.status + ').');
      if (Number(response.headers.get('content-length')) > LIMIT) {await response.body?.cancel(); throw new Error('Jätehuollon vastaus on liian suuri.');}
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      if (reader) { try { while (true) {const part=await reader.read(); if(part.done)break; length+=part.value.length; if(length>LIMIT) {await reader.cancel();throw new Error('Jätehuollon vastaus on liian suuri.');} chunks.push(part.value);} } finally {reader.releaseLock();} }
      try {return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;} catch {throw new Error('Jätehuollon vastaus ei ole luettavissa.');}
    }
    throw new WasteAuthError();
  }
  function authenticate() {
    // Keep a rejected promise: invalid credentials are never retried by this client.
    return login ??= (async()=>{
      const result = await request('j_acegi_security_check?target=2',new URLSearchParams({j_username:username,j_password:password,'remember-me':'false'}),undefined,true);
      // Kaksi hyväksyttyä vastausta, koska Vingo-asennukset eroavat toisistaan
      // ja vain yhtä niistä on päästy mittaamaan:
      //
      //   LOGIN_OK          3xx suojatulle polulle (mitattu Sammakkokangas)
      //   {response:'OK'}   JSON-vastaus. EI TODENNETTU MISSÄÄN asennuksessa:
      //                     Etapin ja Puhaksen oma `login.js` on rivi riviltä
      //                     sama kuin Sammakkokankaan, joten nekin ohjaavat.
      //                     Säilytetään halpana varana tuntemattomalle
      //                     asennukselle, ei koska sitä tiedettäisiin
      //                     tarvittavan.
      //
      // Kaikki muu on tunnusvirhe.
      if (result === LOGIN_OK) return;
      if (record(result).response !== 'OK') throw new WasteAuthError();
    })();
  }
  function loadGroups() {
    return groups ??= (async()=>{
      await authenticate();
      const response = await request('secure/get_customer_datas.do');
      const values=Array.isArray(response) ? boundedArray(response) : Object.values(record(response)); if(values.length>500)throw new Error('Liian monta jätehuollon kohdetta.');
      const seen=new Set<string>();
      return values.map(value=>{
        const customers = boundedArray(value).map(record);
        if (!customers.length) throw new Error('Jätehuollon kohteen tiedot puuttuvat.');
        const ids = [...new Set(customers.map(c=>identifier(c.asiakasnro)))].sort();
        const id='vingo:'+ids.map(encodeURIComponent).join(',');
        if(seen.has(id))throw new Error('Jätehuollon kohde toistuu vastauksessa.');seen.add(id);
        const first=customers.find(c=>String(c.asiakasnro)===ids[0])!;
        const address=[first.katu,first.posti].filter(v=>typeof v==='string'&&v.trim()).join(', ').slice(0,500);
        if(!address)throw new Error('Jätehuollon kohteen osoite puuttuu.');
        return {id,address,customers:ids};
      });
    })();
  }
  return {
    async listProperties(): Promise<WasteProperty[]> {return (await loadGroups()).map(({id,address})=>({id,address}));},
    async schedule(propertyId: string): Promise<WasteCollection[]> {
      const deadline = Date.now() + 90_000;
      const group=(await loadGroups()).find(g=>g.id===propertyId);
      if(!group)throw new Error('Valittu kiinteistö ei kuulu jätehuoltotunnukselle. Valitse kohde uudelleen.');
      const params=new URLSearchParams();group.customers.forEach(id=>params.append('customerNumbers[]',id));
      const services=boundedArray(await request('secure/get_services_by_customer_numbers.do?'+params, undefined, deadline));
      const collections=new Map<string,WasteCollection>();
      for(const raw of services){
        const service=record(raw), id=record(service.id), tariff=record(service.tariff);
        const customer=identifier(id.ASTAsnro),pos=identifier(id.ASTPos);
        // Shared containers can be owned by another customer, but only services returned by
        // the authenticated property's service list are queried; no IDs come from user input.
        if(typeof tariff.name!=='string'||!tariff.name.trim()||tariff.name.length>500)throw new Error('Jäteastian nimi puuttuu.');
        const dates=boundedArray(await request('get_collection_schedule.do?'+new URLSearchParams({customerNumber:customer,pos}), undefined, deadline),1000);
        for(const value of dates){const date=calendarDate(value), key=[customer,pos,date].map(encodeURIComponent).join(':');collections.set(key,{id:key,label:tariff.name.trim(),date});}
        // Valinta tehdään ASTIAKOHTAISESTI eikä päivämääräkohtaisesti.
        //
        // Lähteet ovat eri tarkkuutta: ajosuunnitelma voittaa aina kun siinä on
        // dataa, koska `ASTNextDate` on ±1-2 päivän arvio. Jos molemmat
        // kirjoitettaisiin, ne olisivat päivän eri mieltä juuri niin usein kuin
        // arvion epävarmuus edellyttää, ja kortille tulisi SAMA ASTIA KAHDESTI
        // peräkkäisinä päivinä — huonompi kuin kumpikaan lähde yksin.
        //
        // Mitattu 18.9.2026: tällä kiinteistöllä ajosuunnitelma on tyhjä
        // kaikille neljälle palvelulle, ja ainoa tyhjennettävä astia
        // (`ASTVali` = 4 viikkoa) kertoo päivänsä vain `ASTNextDate`ssa.
        // Muiden `ASTVali` on 0 = "Tilauksesta", eikä niitä tyhjennetä
        // lainkaan — niiden tyhjä `ASTNextDate` on oikea tieto, ei puuttuva.
        //
        // Tulevia kertoja EI johdeta välistä: portaali itse näyttää yhden
        // päivän, ja neljän viikon päähän ekstrapoloitu arvio kasaisi
        // epävarmuutta jota mikään ei enää erottaisi tiedosta.
        if(!dates.length && service.ASTNextDate!=null){
          const date=calendarDate(service.ASTNextDate), key=[customer,pos,date].map(encodeURIComponent).join(':');
          const vali=intervalText(service.ASTVali,service.ASTVali2);
          collections.set(key,{id:key,label:tariff.name.trim(),date,approximate:true,...(vali?{intervalText:vali}:{})});
        }
      }
      return [...collections.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
    }
  };
}
