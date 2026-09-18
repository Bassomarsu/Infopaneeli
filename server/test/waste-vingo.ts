import assert from 'node:assert/strict';
import { createVingoClient, WasteAuthError, WasteServiceError } from '../src/integrations/waste-vingo.ts';
const base='https://example.test/portal';
const groups={first:[{asiakasnro:42,katu:'Testikatu 1',posti:'00100 Testi'},{asiakasnro:41,katu:'Testikatu 1',posti:'00100 Testi'}]};
const services=[{id:{ASTAsnro:41,ASTPos:1},tariff:{name:'Sekajäte'}}];
type Call={url:URL;options:RequestInit};
function fixture(overrides: Record<string,(call:Call)=>Response>={}){
  const calls:Call[]=[];
  const fetcher=(async(url,options={})=>{
    const call={url:new URL(String(url)),options};calls.push(call);
    const endpoint=call.url.pathname.split('/').at(-1)!;
    if(overrides[endpoint])return overrides[endpoint](call);
    if(endpoint==='j_acegi_security_check')return Response.json({response:'OK'},{headers:{'set-cookie':'JSESSIONID=fixture; Path=/portal; Secure; HttpOnly'}});
    assert.equal(new Headers(options.headers).get('cookie'),'JSESSIONID=fixture');
    if(endpoint==='get_customer_datas.do')return Response.json(groups);
    if(endpoint==='get_services_by_customer_numbers.do')return Response.json(services);
    if(endpoint==='get_collection_schedule.do')return Response.json(['2026-10-25T22:30:00Z','2026-10-26','2026-09-14T00:00:00',Date.parse('2026-09-13T21:00:00Z')]);
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
  return {client:createVingoClient(base,'fixture-user','fixture-password',fetcher),calls};
}
const good=fixture();
assert.equal(good.calls.length,0);
const properties=await good.client.listProperties();
assert.deepEqual(properties,[{id:'vingo:41,42',address:'Testikatu 1, 00100 Testi'}]);
const result=await good.client.schedule(properties[0]!.id);
assert.deepEqual(result.map(r=>r.date),['2026-09-14','2026-10-26']);
assert.ok(result.every(r=>r.label==='Sekajäte'));
assert.equal(good.calls.filter(c=>c.options.method==='POST').length,1);
assert.equal(good.calls[0]!.url.searchParams.get('target'),'2');
assert.deepEqual(Object.fromEntries(new URLSearchParams(String(good.calls[0]!.options.body))),{j_username:'fixture-user',j_password:'fixture-password','remember-me':'false'});
assert.deepEqual(good.calls.find(c=>c.url.pathname.endsWith('get_services_by_customer_numbers.do'))!.url.searchParams.getAll('customerNumbers[]'),['41','42']);
assert.equal(good.calls.find(c=>c.url.pathname.endsWith('get_collection_schedule.do'))!.url.pathname,'/portal/get_collection_schedule.do');
await good.client.listProperties();assert.equal(good.calls.filter(c=>c.options.method==='POST').length,1);
const denied=fixture({'j_acegi_security_check':()=>Response.json({response:'FAILED'})});
await assert.rejects(()=>denied.client.listProperties(),WasteAuthError);
await assert.rejects(()=>denied.client.listProperties(),WasteAuthError);
assert.equal(denied.calls.length,1);
// Vain hylätty kirjautuminen on tunnusvirhe. Yhtiön huoltosivu (HTTP 200 + text/html)
// ja suojamuurin 403 eivät kerro tunnuksista mitään, joten ne eivät saa näyttää
// väärältä salasanalta: juuri se ero ratkaisee lukkiutuuko perheen jätehuoltotili.
// POSTin uudelleenohjauksen KOHDE ratkaisee. Uudelleenohjausta ei seurata eikä
// tunnuksia toisteta, mutta `Location` luetaan: se on ainoa asia joka kertoo
// menikö kirjautuminen läpi. Mitattu oikeaa portaalia vasten 18.9.2026:
// onnistunut kirjautuminen on `303` + `secure/welcome.do` tyhjällä rungolla.
// Aiemmin kaikki POSTin uudelleenohjaukset olivat tunnusvirhe, joten yhteys ei
// voinut toimia lainkaan sellaista portaalia vastaan.
// Onnistunut kirjautuminen uudelleenohjauksella: koko ketjun on toimittava, ei
// vain kirjautumisen. Tämä väite kaatuu jos POSTin uudelleenohjaus palautetaan
// ehdottomaksi tunnusvirheeksi.
const redirectLogin=fixture({'j_acegi_security_check':()=>new Response(null,{status:303,headers:{location:'/portal/secure/welcome.do','set-cookie':'JSESSIONID=fixture; Path=/portal'}})});
const redirectProps=await redirectLogin.client.listProperties();
assert.deepEqual(redirectProps,[{id:'vingo:41,42',address:'Testikatu 1, 00100 Testi'}],'303 suojatulle polulle on onnistunut kirjautuminen');
assert.deepEqual((await redirectLogin.client.schedule(redirectProps[0]!.id)).map(r=>r.date),['2026-09-14','2026-10-26'],'uudelleenohjauksella kirjautunut istunto hakee aikataulun');
assert.equal(redirectLogin.calls.filter(c=>c.options.method==='POST').length,1,'kirjautuminen tehdään tasan kerran');

// Ehtojen hyväksyntä ja pakotettu salasanan vaihto ovat `secure/`-puussa, joten
// ne läpäisevät polkutarkistuksen. Ne EIVÄT ole onnistunut kirjautuminen, mutta
// eivät myöskään väärä salasana: käyttäjän on tehtävä jotain selaimessa, ja
// tekstin on sanottava se. Ilman tätä haaraa seuraava pyyntö kaatuisi ja
// käyttäjä saisi "huolto tai häiriö" pysyvästä tilasta joka ei korjaudu
// odottamalla.
for(const pakko of ['terms.do','pw.do']){
 const test=fixture({'j_acegi_security_check':()=>new Response(null,{status:303,headers:{location:'/portal/secure/'+pakko}})});
 const error=await test.client.listProperties().then(()=>null,(e:Error)=>e);
 assert.ok(error instanceof WasteAuthError,pakko+' ei ole onnistunut kirjautuminen');
 assert.match(error.message,/selaimessa/,pakko+': viestin on ohjattava selaimeen');
 assert.doesNotMatch(error.message,/huolto|häiriö/,pakko+': tämä ei ole huoltokatko');
 assert.equal(test.calls.length,1,pakko+': kirjautumisen jälkeen ei saa jatkaa');
}

// ASTNextDate tayttää tyhjän ajosuunnitelman, mutta EI syrjäytä sitä.
//
// Mitattu oikeaa portaalia vasten: ajosuunnitelma on tyhjä kaikille neljalle
// palvelulle, ja ainoa tyhjennettava astia kertoo paivansa vain ASTNextDatessa.
// Ilman tata haaraa kortti oli tyhja vaikka portaalissa lukee paiva.
{
 const services2=[{id:{ASTAsnro:41,ASTPos:1},tariff:{name:'Sekajäte'},ASTNextDate:'2026-09-29'}];
 const tyhja=fixture({
  'get_services_by_customer_numbers.do':()=>Response.json(services2),
  'get_collection_schedule.do':()=>Response.json([]),
 });
 const props=await tyhja.client.listProperties();
 const rows=await tyhja.client.schedule(props[0]!.id);
 assert.equal(rows.length,1,'ASTNextDate tuottaa yhden tapahtuman');
 assert.equal(rows[0]!.date,'2026-09-29','päivä ei siirry vuorokaudella');
 assert.equal(rows[0]!.approximate,true,'ASTNextDate on arvio ja se on merkittävä');

 // Tyhjennysväli TEKSTINÄ, samoin sanoin kuin portaali. Ei laskettuja päiviä:
 // astialla voi olla toinen väli eri vuodenajalle, ja virhe kumuloituisi.
 const valit:[unknown,unknown,string|undefined][]=[
  [4,0,'4 viikon välein'],['4','0','4 viikon välein'],
  [1,0,'Kerran viikossa'],[2,0,'Joka toinen viikko'],
  [0,0,undefined],[0,null,undefined],[null,null,undefined],
  [0,2,'Joka toinen viikko'],
  ['roska',0,undefined],[-1,0,undefined],[99999,0,undefined],
 ];
 for(const [vali,vali2,odotus] of valit){
  const t=fixture({
   'get_services_by_customer_numbers.do':()=>Response.json([{id:{ASTAsnro:41,ASTPos:1},tariff:{name:'Sekajäte'},ASTNextDate:'2026-09-29',ASTVali:vali,ASTVali2:vali2}]),
   'get_collection_schedule.do':()=>Response.json([]),
  });
  const pr=await t.client.listProperties();
  const r=await t.client.schedule(pr[0]!.id);
  assert.equal(r[0]!.intervalText,odotus,'ASTVali '+JSON.stringify(vali)+'/'+JSON.stringify(vali2));
 }

 // Ajosuunnitelma voittaa: sama astia ei saa esiintya kahdesti perakkaisina
 // paivina siksi etta arvio ja suunnitelma ovat eri mielta.
 const molemmat=fixture({'get_services_by_customer_numbers.do':()=>Response.json(services2)});
 const props2=await molemmat.client.listProperties();
 const rows2=await molemmat.client.schedule(props2[0]!.id);
 assert.deepEqual(rows2.map(r=>r.date),['2026-09-14','2026-10-26'],'ajosuunnitelma voittaa kun siinä on dataa');
 assert.ok(rows2.every(r=>!r.approximate),'ajosuunnitelman päivät eivät ole arvioita');
 assert.ok(!rows2.some(r=>r.date==='2026-09-29'),'ASTNextDate ei saa tulla ajosuunnitelman rinnalle');

 // Tilauksesta tyhjennettava astia: ei paivaa, eika sita saa keksia.
 const tilauksesta=fixture({
  'get_services_by_customer_numbers.do':()=>Response.json([{id:{ASTAsnro:41,ASTPos:1},tariff:{name:'Kompostori'},ASTNextDate:null}]),
  'get_collection_schedule.do':()=>Response.json([]),
 });
 const props3=await tilauksesta.client.listProperties();
 assert.deepEqual(await tilauksesta.client.schedule(props3[0]!.id),[],'tyhjä ASTNextDate on oikea tieto, ei puuttuva');
}

const authCases:Record<string,()=>Response>={
 'kirjautuminen hylättiin':()=>Response.json({response:'FAILED'}),
 'HTTP 401':()=>new Response(null,{status:401}),
 'POST ohjattiin muualle':()=>new Response(null,{status:302,headers:{location:'https://other.test/'}}),
 'POST ohjattiin kirjautumissivulle':()=>new Response(null,{status:303,headers:{location:'/portal/login.do?login_error=1'}}),
 'POST ohjattiin portaalin ulkopuolelle':()=>new Response(null,{status:303,headers:{location:'/toinen/secure/welcome.do'}}),
 'POST ohjattiin ilman kohdetta':()=>new Response(null,{status:303}),
};
for(const [name,response] of Object.entries(authCases)){
 const test=fixture({'j_acegi_security_check':response});
 await assert.rejects(()=>test.client.listProperties(),WasteAuthError,name+' on tunnusvirhe');
 assert.equal(test.calls.length,1,name+': kirjautumisen jälkeen ei saa jatkaa');
}
const serviceCases:Record<string,()=>Response>={
 'huoltosivu':()=>new Response('<html>Huoltokatko</html>',{headers:{'content-type':'text/html'}}),
 'suojamuuri 403':()=>new Response(null,{status:403}),
};
const serviceErrors:Error[]=[];
for(const [name,response] of Object.entries(serviceCases)){
 const test=fixture({'j_acegi_security_check':response});
 const error=await test.client.listProperties().then(()=>null,(e:Error)=>e);
 assert.ok(error instanceof WasteServiceError,name+' on palveluhäiriö, ei tunnusvirhe');
 assert.ok(!(error instanceof WasteAuthError),name+' ei saa olla WasteAuthError');
 serviceErrors.push(error);assert.equal(test.calls.length,1);
}
const broken=fixture({'j_acegi_security_check':()=>new Response(null,{status:500})});
serviceErrors.push(await broken.client.listProperties().then(()=>null,(e:Error)=>e)!);
const offline=fixture({'j_acegi_security_check':()=>{throw new TypeError('fetch failed');}});
serviceErrors.push(await offline.client.listProperties().then(()=>null,(e:Error)=>e)!);
assert.match(serviceErrors.at(-2)!.message,/HTTP 500/);
assert.match(serviceErrors.at(-1)!.message,/ei saada yhteyttä/);
// Yksikään palveluhäiriön viesti ei saa puhua tunnuksista. Kehotus tarkistaa ne
// silloin kun vika on yhtiön päässä on se mikä ajaa salasanojen kokeiluun.
for(const error of serviceErrors){
 assert.ok(!(error instanceof WasteAuthError),'palveluhäiriö ei saa olla tunnusvirhe: '+error.message);
 assert.ok(!/tunnu|salasan/i.test(error.message),'palveluhäiriön viesti puhuu tunnuksista: '+error.message);
}
assert.match(new WasteAuthError().message,/tunnu/i);
const wrong=fixture();await assert.rejects(()=>wrong.client.schedule('vingo:99'),/ei kuulu/);assert.equal(wrong.calls.length,2);
const empty=fixture({'get_collection_schedule.do':()=>Response.json([])});assert.deepEqual(await empty.client.schedule('vingo:41,42'),[]);
for(const value of [null,{},['2026-02-30'],['2026-02-30T00:00:00Z'],['2026-01-01T99:00:00'],['tomorrow'],[null]]){
 const test=fixture({'get_collection_schedule.do':()=>Response.json(value)});await assert.rejects(()=>test.client.schedule('vingo:41,42'));
}
const partial=fixture({'get_services_by_customer_numbers.do':()=>Response.json([...services,{id:{ASTAsnro:41,ASTPos:2},tariff:{name:'Biojäte'}}]),'get_collection_schedule.do':c=>c.url.searchParams.get('pos')==='1'?Response.json(['2026-09-14']):new Response(null,{status:503})});
await assert.rejects(()=>partial.client.schedule('vingo:41,42'),/HTTP 503/);
const expired=fixture({'get_collection_schedule.do':()=>new Response(null,{status:401})});await assert.rejects(()=>expired.client.schedule('vingo:41,42'),WasteAuthError);assert.equal(expired.calls.filter(c=>c.options.method==='POST').length,1);
const other=fixture({'get_customer_datas.do':()=>new Response(null,{status:302,headers:{location:'https://other.test/steal'}})});await assert.rejects(()=>other.client.listProperties(),WasteAuthError);assert.equal(other.calls.length,2);
const large=fixture({'get_customer_datas.do':()=>new Response('{}',{headers:{'content-length':'2000001'}})});await assert.rejects(()=>large.client.listProperties(),/liian suuri/);
const largeStream=fixture({'get_customer_datas.do':()=>new Response(' '.repeat(2000001))});await assert.rejects(()=>largeStream.client.listProperties(),/liian suuri/);
const redirectCalls:string[]=[];
const redirectClient=createVingoClient(base,'u','p',(async(url,init)=>{
 const path=new URL(String(url)).pathname;redirectCalls.push(path);
 if(path.endsWith('j_acegi_security_check'))return Response.json({response:'OK'},{headers:{'set-cookie':'sid=one; Path=/portal'}});
 if(path.endsWith('get_customer_datas.do'))return new Response(null,{status:302,headers:{location:'/portal/secure/actual','set-cookie':'sid=two; Path=/portal'}});
 assert.equal(new Headers(init?.headers).get('cookie'),'sid=two');return Response.json(groups);
}) as typeof fetch);
assert.equal((await redirectClient.listProperties()).length,1);assert.equal(redirectCalls.length,3);
assert.throws(()=>createVingoClient('http://example.test','u','p'),/palveluosoite/);
console.log('Vingo: lazy single login, scoped cookies, verified property, grouped IDs, Helsinki dates, empty/invalid/partial schedules, auth vs. service-outage split (401/redirect vs. html/403/500/offline), login redirect target and response bounds passed');
