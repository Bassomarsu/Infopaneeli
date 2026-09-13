import './waste-test-env.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Fastify from 'fastify';
import {config} from '../src/core/config.ts';
import {getSetting} from '../src/core/store.ts';
import {getSettings} from '../src/core/settings.ts';
import {getWasteCompanies,wasteCompaniesForMunicipality} from '../src/core/waste-companies.ts';
import {saveWasteConfig,wasteConfig,wasteProperties,fetchWaste,projectWasteData,projectWasteSnapshot,createWasteProvider} from '../src/core/waste-service.ts';
import {saveHousehold,readHousehold} from '../src/core/household.ts';
import {registry} from '../src/core/provider.ts';
import {registerApiRoutes} from '../src/routes/api.ts';
assert.equal(wasteCompaniesForMunicipality('Karstula')[0]?.id,'sammakkokangas');assert.equal(wasteCompaniesForMunicipality('Sastamala').length,2);
assert.equal(getWasteCompanies().filter(c=>c.adapter==='vingo').length,3);
saveHousehold('waste',{label:'Oma manuaali',date:'2030-01-01',intervalWeeks:2});
assert.equal((await fetchWaste()).enabled,false);
assert.throws(()=>saveWasteConfig({companyId:'https://evil'}));
assert.throws(()=>saveWasteConfig({companyId:'sammakkokangas',username:'u'}));
saveWasteConfig({companyId:'sammakkokangas',municipality:'Karstula',address:'Testitie 1',username:'fixture-user',password:'fixture-secret'});
assert.equal(wasteConfig().configured,true);
const stored=JSON.stringify(getSetting('waste.connection'));
assert.ok(!stored.includes('fixture-user')&&!stored.includes('fixture-secret'));
assert.ok(!JSON.stringify(wasteConfig()).includes('secret'));
assert.ok(!JSON.stringify(getSettings()).includes('Testitie'));
assert.equal(fs.readFileSync(config.dbPath+'.waste-key').length,32);
const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;const advance=()=>{offset+=61_000;};
const originalFetch=globalThis.fetch;let logins=0, failLogin=false,failSchedule=false;
let hold:Promise<void>|null=null, began:(()=>void)|undefined;
globalThis.fetch=(async(url,init)=>{
 const u=new URL(String(url)),endpoint=u.pathname.split('/').at(-1);
 if(endpoint==='j_acegi_security_check'){logins++;return Response.json({response:failLogin?'FAILED':'OK'});}
 if(endpoint==='get_customer_datas.do')return Response.json({a:[{asiakasnro:41,katu:'Testitie 1',posti:'43500 Karstula'}],b:[{asiakasnro:42,katu:'Testitie 2',posti:'43500 Karstula'}]});
 if(endpoint==='get_services_by_customer_numbers.do')return Response.json([{id:{ASTAsnro:u.searchParams.get('customerNumbers[]'),ASTPos:1},tariff:{name:'Sekajäte'}}]);
 if(endpoint==='get_collection_schedule.do'){if(hold){began?.();await hold;}return failSchedule?new Response(null,{status:503}):Response.json(['2030-01-01']);}
 throw Error('Unexpected URL');
}) as typeof fetch;
try{
 const props=await wasteProperties();assert.equal(props.length,2);
 await assert.rejects(()=>wasteProperties(),/minuutti/);
 saveWasteConfig({propertyId:props[0]!.id,enabled:true});
 const good=await fetchWaste();assert.equal(good.events.length,1);
 const loginsBefore=logins;await assert.rejects(()=>fetchWaste(),/minuutti/);assert.equal(logins,loginsBefore);
 saveWasteConfig({propertyId:'vingo:42',enabled:true});const pending=projectWasteSnapshot({id:'waste',status:'ok',fetchedAt:'2026-09-13T10:00:00Z',error:null,data:good});assert.equal(pending.status,'idle');assert.equal(pending.fetchedAt,null);assert.deepEqual(pending.data?.events,[]);saveWasteConfig({propertyId:'vingo:41',enabled:true});
 const provider=createWasteProvider();registry.register(provider);advance();await provider.runOnce();
 failSchedule=true;advance();await provider.runOnce();assert.equal(provider.snapshot().status,'stale');assert.equal(provider.snapshot().data?.events.length,1);failSchedule=false;
 const app=Fastify();await registerApiRoutes(app);
 for(const method of ['GET','PUT'] as const){const response=await app.inject({method,url:'/api/waste/config',remoteAddress:'203.0.113.1',...(method==='PUT'?{payload:{enabled:false}}:{})});assert.equal(response.statusCode,403);}
 const basic=await app.inject({method:'GET',url:'/api/waste/config',remoteAddress:'203.0.113.2',headers:{'x-edit-pin':'4242'}});assert.equal(basic.statusCode,403);
 const dashboard=await app.inject({method:'GET',url:'/api/dashboard',remoteAddress:'203.0.113.3'});assert.equal(dashboard.json().providers.waste.status,'hidden');assert.equal(dashboard.json().providers.waste.data,null);
 assert.ok(!dashboard.body.includes('fixture-secret')&&!dashboard.body.includes('Testitie'));
 const authorized=await app.inject({method:'GET',url:'/api/waste/config',remoteAddress:'127.0.0.1'});assert.equal(authorized.statusCode,200);assert.ok(!authorized.body.includes('fixture-secret'));
 await app.close();
 let release!:()=>void;hold=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>began=r);
 advance();const active=fetchWaste();await started;saveWasteConfig({enabled:false});release();await active;assert.deepEqual(projectWasteData(good).events,[]);hold=null;
 saveWasteConfig({username:'fixture-user',password:'new-fixture-secret'});saveWasteConfig({propertyId:'vingo:41',enabled:true});failLogin=true;advance();
 await assert.rejects(()=>fetchWaste());assert.equal(wasteConfig().blocked,true);const count=logins;await assert.rejects(()=>fetchWaste());assert.equal(logins,count,'blocked account must not retry login');
 saveWasteConfig({companyId:'other',enabled:false});assert.equal(wasteConfig().configured,false);assert.equal(wasteConfig().propertyId,'');
 assert.equal(readHousehold().waste[0]?.label,'Oma manuaali');
}finally{globalThis.fetch=originalFetch;Date.now=realNow;registry.stopAll();}
console.log('Waste service: municipality mapping, encrypted secrets, full-access only, property cache isolation, in-flight changes, no auth retry, stale cache and manual fallback passed');
