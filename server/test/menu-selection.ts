import './test-env.ts';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parseMenuSchoolIds, getSettings, updateSettings } from '../src/core/settings.ts';
import { fetchSelectedMenus, selectedMenuData } from '../src/providers/menu.ts';
import { parseMenuSchools, fetchMenuSchools, getMenuSchools } from '../src/core/menu-schools.ts';
import { registerApiRoutes } from '../src/routes/api.ts';
const now=new Date('2026-12-29T12:00:00Z');
const page=(id:string)=>({result:{pageContext:{menu:{RestaurantId:id,RestaurantName:'Koulu '+id,Start:'2026-12-28',Days:[{Date:'maanantai 28.12.',Meals:[{MealType:'Lounas',Name:'Keitto '+id}]}]}}}});
/** Sivu sellaisena kuin kouluruoka.fi sen nyt palauttaa: JSON upotettuna HTML:ään. */
const html=(data:unknown)=>new Response(`<script id="gatsby-inlined-page-data">(function(){var d=${JSON.stringify(data)};window.pageData=d;})()</script>`,{headers:{'content-type':'text/html'}});
assert.deepEqual(parseMenuSchoolIds(['a','a','b']),['a','b']);assert.deepEqual(parseMenuSchoolIds([]),[]);
for(const bad of [null,'a',['../foo'],['https://example.com'],Array(9).fill('a'),['a/b']])assert.throws(()=>parseMenuSchoolIds(bad));
updateSettings({menuSchoolIds:['a','b']});assert.deepEqual(getSettings().menuSchoolIds,['a','b']);
assert.throws(()=>updateSettings({menuSchoolIds:['../bad']}));assert.deepEqual(getSettings().menuSchoolIds,['a','b']);
let ids=['a'];let release!:()=>void;let started!:()=>void;
const start=new Promise<void>(r=>started=r), gate=new Promise<void>(r=>release=r);const calls:string[]=[];
const result=fetchSelectedMenus((async url=>{const id=String(url).split('/menu/')[1]!.split('/')[0]!;calls.push(id);if(id==='a'){started();await gate;}return html(page(id));}) as typeof fetch,()=>ids,null,now);
await start;ids=['b'];release();
assert.deepEqual((await result).schools.map(s=>s.locationId),['b']);assert.ok(calls.includes('b'));
const old={locationId:'a',locationName:'Vanha koulu',sourceUrl:'https://kouluruoka.fi/menu/a/',days:[]};
assert.equal(selectedMenuData(old,['a'],'2026-12-28T10:00:00Z').schools[0]?.locationName,'Vanha koulu');
assert.equal(selectedMenuData(old,['b']).schools[0]?.status,'loading');
assert.deepEqual(selectedMenuData(old,[]).schools,[]);
const multi=await fetchSelectedMenus((async url=>String(url).includes('/a/')?html(page('a')):new Response(null,{status:503})) as typeof fetch,()=>['a','b'],{schools:[{...old,locationId:'b',locationName:'Koulu b',status:'ok',error:null,fetchedAt:'2026-12-28T10:00:00Z'}]},now);
assert.equal(multi.schools[0]?.status,'ok');assert.equal(multi.schools[1]?.status,'stale');assert.match(multi.schools[1]!.error!,/503/);
const empty=await fetchSelectedMenus((async()=>{throw Error('must not fetch');}) as typeof fetch,()=>[],null,now);assert.deepEqual(empty.schools,[]);

/**
 * VIRHERAJA MOLEMPIIN SUUNTIIN.
 *
 * Yksi lähde kaatuu -> muut näkyvät eikä provideri epäonnistu (yllä `multi`).
 * Jokainen lähde kaatuu -> virhe nousee providerille asti, jotta
 * perääntyminen, katkaisija ja lokitus laukeavat. Aiemmin tämä palautti
 * `status:'ok'` eikä lokiin tullut riviäkään.
 */
const down=(async()=>new Response(null,{status:503})) as typeof fetch;
// Kaikki kaatuvat, ei välimuistia: kortilla ei ole mitään näytettävää.
await assert.rejects(()=>fetchSelectedMenus(down,()=>['a','b'],null,now),/kaikille 2 koululle.*503/s);
// Kaikki kaatuvat, välimuisti lämmin: vanha lista jää näkyviin PROVIDERIN
// omana `stale`-tilana, mutta kierros on silti epäonnistunut.
await assert.rejects(()=>fetchSelectedMenus(down,()=>['a','b'],{schools:[{...old,status:'ok',error:null,fetchedAt:'2026-12-28T10:00:00Z'},{...old,locationId:'b',status:'ok',error:null,fetchedAt:'2026-12-28T10:00:00Z'}]},now),/kaikille 2 koululle/);
// Ainoa valittu koulu kaatuu -> providerin virheeksi lähteen oma viesti,
// ilman "kaikille N koululle" -kiertoilmausta.
await assert.rejects(()=>fetchSelectedMenus(down,()=>['a'],null,now),/^Error: Ruokalistan haku epäonnistui \(HTTP 503\)$/);
// Yksi kahdesta onnistuu -> EI virhettä, ja kaatuneen koulun oma virhe säilyy.
const partial=await fetchSelectedMenus((async url=>String(url).includes('/a/')?html(page('a')):new Response(null,{status:503})) as typeof fetch,()=>['a','b'],null,now);
assert.equal(partial.schools[0]?.status,'ok');assert.equal(partial.schools[1]?.status,'failed');assert.match(partial.schools[1]!.error!,/503/);
// Valinnan muuttuminen kesken kaiken ei saa näkyä virheenä: poistetun koulun
// epäonnistuminen uusii kierroksen sen sijaan että kaataisi providerin.
let live=['a'];
const swapped=await fetchSelectedMenus((async url=>{const id=String(url).split('/menu/')[1]!.split('/')[0]!;if(id==='a'){live=['b'];return new Response(null,{status:503});}return html(page(id));}) as typeof fetch,()=>live,null,now);
assert.deepEqual(swapped.schools.map(s=>s.locationId),['b']);assert.equal(swapped.schools[0]?.status,'ok');
const catalog={data:{allAzureJson:{nodes:[{WeekMenu:[{RestaurantId:'a',RestaurantName:'Koulu A',CityName:'Kunta'}]},{WeekMenu:[{RestaurantId:'a',RestaurantName:'Koulu A',CityName:'Kunta'},{RestaurantId:'../bad',RestaurantName:'Bad',CityName:'Bad'}]}]}}};
assert.deepEqual(parseMenuSchools(catalog),[{id:'a',name:'Koulu A',city:'Kunta'}]);
assert.equal((await fetchMenuSchools((async url=>Response.json(String(url).includes('/index/')?{staticQueryHashes:['12','34']}:String(url).includes('/12.')?catalog:{})) as typeof fetch)).length,1);
await assert.rejects(()=>fetchMenuSchools((async()=>Response.json({staticQueryHashes:['https://evil']})) as typeof fetch));

/**
 * YLÄVIRRAN PYYNTÖJEN MÄÄRÄ.
 *
 * `/api/menu-schools` on tunnistautumaton, ja yksi kierros on 1 + N pyyntöä
 * kouluruoka.fi:lle. Mitattu lähtötaso ennen korjausta: viisi peräkkäistä
 * pyyntöä nurin olevaa lähdettä vasten teki VIISI kierrosta, koska vain
 * onnistuminen välimuistitettiin. Nämä testit laskevat kierrokset; jos
 * välimuisti puretaan kummasta päästä tahansa, luvut kasvavat ja testi kaatuu.
 */
let upstream=0; let upstreamDown=true;
const schoolCatalogue={data:{allAzureJson:{nodes:[{WeekMenu:[{RestaurantId:'a',RestaurantName:'Koulu A',CityName:'Kunta'}]}]}}};
const counting=(async(url:string|URL|Request)=>{upstream++;return upstreamDown?new Response(null,{status:503}):Response.json(String(url).includes('/index/')?{staticQueryHashes:['11','22','33']}:schoolCatalogue);}) as typeof fetch;
let clock=0; const fakeNow=()=>clock;
const MIN=60_000;

// Viisi peräkkäistä pyyntöä nurin olevaa lähdettä vasten -> yksi kierros.
for(let i=0;i<5;i++) await assert.rejects(()=>getMenuSchools(counting,fakeNow));
assert.equal(upstream,1,'epäonnistuminen välimuistitetaan: 5 pyyntöä, 1 kierros (ennen: 5)');
clock+=4*MIN; await assert.rejects(()=>getMenuSchools(counting,fakeNow));
assert.equal(upstream,1,'negatiivinen välimuisti on yhä voimassa neljän minuutin kohdalla');
clock+=2*MIN; await assert.rejects(()=>getMenuSchools(counting,fakeNow));
assert.equal(upstream,2,'negatiivinen välimuisti vanhenee viidessä minuutissa — katko ei jää päiväksi päälle');

// Viisi RINNAKKAISTA pyyntöä -> yksi kierros, ei viittä.
clock+=6*MIN; upstreamDown=false;
const parallel=await Promise.all(Array.from({length:5},()=>getMenuSchools(counting,fakeNow)));
assert.equal(upstream,6,'rinnakkaiset pyynnöt odottavat samaa hakua: 1 indeksi + 3 hashia');
assert.deepEqual(parallel.map(list=>list.length),[1,1,1,1,1]);

// Onnistuminen välimuistitetaan vuorokaudeksi.
for(let i=0;i<5;i++) assert.equal((await getMenuSchools(counting,fakeNow)).length,1);
assert.equal(upstream,6,'onnistunut koululista tarjoillaan välimuistista');
clock+=23*60*MIN; await getMenuSchools(counting,fakeNow);
assert.equal(upstream,6,'23 tunnin päästä yhä välimuistista');
clock+=2*60*MIN; await getMenuSchools(counting,fakeNow);
assert.equal(upstream,10,'vuorokauden jälkeen haetaan uudelleen');

const app=Fastify();await registerApiRoutes(app);

/**
 * Sama mittaus REITIN läpi: varmistaa ettei reitti ohita välimuistia.
 * Ajetaan injektoidun kellon jälkeen, jolloin moduulin välimuisti on
 * todellisessa ajassa vanhentunut ja mittaus alkaa kylmältä.
 */
const realFetch=globalThis.fetch;
upstream=0; upstreamDown=true; globalThis.fetch=counting;
try {
 for(let i=0;i<5;i++) assert.equal((await app.inject('/api/menu-schools')).statusCode,502);
 assert.equal(upstream,1,'reitti: 5 pyyntöä nurin olevaan lähteeseen -> 1 kierros ylävirtaan (ennen: 5)');
} finally { globalThis.fetch=realFetch; }

const denied=await app.inject({method:'PUT',url:'/api/settings',remoteAddress:'203.0.113.25',payload:{menuSchoolIds:['c']}});assert.equal(denied.statusCode,403);assert.deepEqual(getSettings().menuSchoolIds,['a','b']);
const saved=await app.inject({method:'PUT',url:'/api/settings',remoteAddress:'127.0.0.1',payload:{menuSchoolIds:[]}});assert.equal(saved.statusCode,200);assert.deepEqual(saved.json().menuSchoolIds,[]);
await app.close();
console.log('Menu selection: validation, settings/auth, multiple schools, partial failures, legacy cache, in-flight change, empty selection, all-sources-down error boundary, dynamic catalogue and upstream request budget passed');
