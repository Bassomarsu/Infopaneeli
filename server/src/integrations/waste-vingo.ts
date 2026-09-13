/** Read-only adapter for the public Vingo customer portal protocol.
 * Only the explicit login submits data; terms, orders and service changes are never accepted.
 */
export class WasteAuthError extends Error {
  constructor(message = 'Kirjautuminen jätehuoltoon epäonnistui. Tarkista tunnukset tai avaa asiointipalvelu selaimessa.') {
    super(message); this.name = 'WasteAuthError';
  }
}
export interface WasteProperty { id: string; address: string }
export interface WasteCollection { id: string; label: string; date: string }
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
export function createVingoClient(baseUrl: string, username: string, password: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Jätehuollon palveluosoite ei kelpaa.');
  const cookies = new Map<string, {name:string; value:string; path:string}>();
  let login: Promise<void> | undefined;
  let groups: Promise<Group[]> | undefined;
  async function request(path: string, body?: URLSearchParams, deadline = Date.now() + 20_000): Promise<unknown> {
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
        // A login redirect may request terms/password changes. Never follow/replay credentials.
        if (method === 'POST') throw new WasteAuthError();
        const target = response.headers.get('location');
        if (!target || redirects === 3) throw new WasteAuthError();
        await response.body?.cancel(); url = new URL(target,url); continue;
      }
      if (response.status === 401 || response.status === 403 || response.headers.get('content-type')?.includes('text/html')) throw new WasteAuthError();
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
      const result = record(await request('j_acegi_security_check?target=2',new URLSearchParams({j_username:username,j_password:password,'remember-me':'false'})));
      if (result.response !== 'OK') throw new WasteAuthError();
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
      }
      return [...collections.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
    }
  };
}
