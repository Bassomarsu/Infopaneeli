import { parseMenuSchoolIds } from './settings.ts';
export interface MenuSchoolOption { id:string; name:string; city:string }
export function parseMenuSchools(body: unknown): MenuSchoolOption[] {
 const nodes=(body as {data?:{allAzureJson?:{nodes?:unknown}}})?.data?.allAzureJson?.nodes;
 if(!Array.isArray(nodes))return [];
 const found=new Map<string,MenuSchoolOption>();
 for(const node of nodes){
  if(!node || !Array.isArray(node.WeekMenu))continue;
  for(const row of node.WeekMenu){
   if(!row || typeof row.RestaurantName!=='string' || typeof row.CityName!=='string')continue;
   try {const [id]=parseMenuSchoolIds([row.RestaurantId]); if(id)found.set(id,{id,name:row.RestaurantName.trim(),city:row.CityName.trim()});}catch{continue;}
  }
 }
 return [...found.values()].sort((a,b)=>(a.city+' '+a.name).localeCompare(b.city+' '+b.name,'fi'));
}
export async function fetchMenuSchools(fetcher:typeof fetch=fetch):Promise<MenuSchoolOption[]> {
 // Sama kokoraja kuin news.ts:llä ja providers/menu.ts:llä, samasta syystä:
 // hakemisto oli 311 kt 16.9.2026, mutta rajaton `r.json()` puskuroisi mitä
 // tahansa mitä osoitteen takaa vastataankin — ja tämä haetaan kymmenelle
 // hash-osoitteelle kerralla, joten katto on per vastaus.
 const LIMIT=4*1024*1024;
 async function json(url:string){const r=await fetcher(url,{signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});if(!r.ok)throw Error('Koululuettelon haku epäonnistui');
  if(Number(r.headers.get('content-length'))>LIMIT){await r.body?.cancel();throw Error('Koululuettelo on odottamattoman suuri');}
  const body=await r.text();if(body.length>LIMIT)throw Error('Koululuettelo on odottamattoman suuri');
  try{return JSON.parse(body) as unknown;}catch{throw Error('Koululuetteloa ei voi lukea');}}
 const index=await json('https://kouluruoka.fi/page-data/index/page-data.json') as {staticQueryHashes?:unknown};
 if(!Array.isArray(index.staticQueryHashes)||index.staticQueryHashes.length>10)throw Error('Koululuettelon rakenne muuttui');
 const results=await Promise.all(index.staticQueryHashes.map(async hash=>{
  if(typeof hash!=='string'||!/^\d{1,20}$/.test(hash))throw Error('Virheellinen koululuettelo');
  return parseMenuSchools(await json('https://kouluruoka.fi/page-data/sq/d/'+hash+'.json'));
 }));
 const schools=[...new Map(results.flat().map(s=>[s.id,s])).values()];
 if(!schools.length)throw Error('Koululuettelo puuttuu');return schools;
}
/**
 * VÄLIMUISTI KOSKEE MYÖS EPÄONNISTUMISTA.
 *
 * Reitti `/api/menu-schools` on tunnistautumaton, ja yksi onnistunut haku on
 * 1 + N pyyntöä ja satoja kilotavuja kouluruoka.fi:ltä (306 kt / 11 pyyntöä
 * 16.9.2026). Ennen tätä VAIN onnistuminen muistettiin: kun lähde oli nurin,
 * viisi peräkkäistä pyyntöä teki viisi täyttä kierrosta ylävirtaan — mitattu.
 * Silmukointi oli siis kutsujalle ilmaista ja lähteelle kallista, ja juuri
 * epäonnistuva lähde on se tilanne jossa sitä vähiten kestää.
 *
 * Kolme suojaa yhdessä:
 *  - onnistuminen muistetaan vuorokauden. Hakemisto muuttuu lukukausien
 *    rajoilla, ei tunneittain (1361 listaa 13.9.2026), joten tuoreempi tieto
 *    ei ole minkään arvoinen suhteessa sen hintaan.
 *  - epäonnistuminen muistetaan viisi minuuttia. Lyhyempi kuin onnistuminen,
 *    koska ohimenevä katko ei saa jäädä päiväksi päälle — mutta riittävä
 *    katkaisemaan tiukan silmukan enintään 12 kierrokseen tunnissa.
 *  - lennossa on korkeintaan yksi haku; rinnakkaiset pyynnöt odottavat sitä.
 *
 * `requireEditAccess`ia EI vaadita, tietoisesti. Hakemisto on julkisen
 * sivuston julkista tietoa (koulun nimi ja kunta) eikä kuulu
 * SENSITIVE_PROVIDERSiin, joten tunnistautuminen ei suojaisi mitään
 * arkaluontoista. Perusteltu haitta on ylävirran kuorma, ja sen leikkaa
 * välimuisti — tunnistautuneenakin silmukoiva laite saisi täsmälleen saman
 * määrän kierroksia läpi. Vaatimus taas rikkoisi koulunvalitsimen jokaiselta
 * laitteelta joka ei ole avannut lukkoa, ja ohjaisi tunnistautumattomat
 * pyynnöt jaettuun PIN-yritysrajoittimeen, joka suojaa FULL_PINiä.
 *
 * `now` ja `fetcher` ovat injektoitavissa vain testejä varten; reitti kutsuu
 * ilman argumentteja.
 */
const OK_TTL = 24 * 60 * 60 * 1000;
const FAIL_TTL = 5 * 60 * 1000;
let cache:MenuSchoolOption[]|undefined; let cacheExpires=0;
let failure:Error|undefined; let failureExpires=0;
let pending:Promise<MenuSchoolOption[]>|undefined;
export function getMenuSchools(fetcher:typeof fetch=fetch, now:()=>number=Date.now):Promise<MenuSchoolOption[]> {
 if(cache&&now()<cacheExpires)return Promise.resolve(cache);
 if(failure&&now()<failureExpires)return Promise.reject(failure);
 return pending??=fetchMenuSchools(fetcher).then(schools=>{
   cache=schools;cacheExpires=now()+OK_TTL;failure=undefined;failureExpires=0;return schools;
  },error=>{
   // Sama virheolio palautetaan koko negatiivisen jakson ajan: pino säilyy
   // siitä hausta joka oikeasti kaatui, eikä jokaiselle torjutulle pyynnölle
   // tarvitse keksiä uutta.
   failure=error instanceof Error?error:new Error(String(error));failureExpires=now()+FAIL_TTL;throw failure;
  }).finally(()=>{pending=undefined;});
}
