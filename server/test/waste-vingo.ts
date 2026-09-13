import assert from 'node:assert/strict';
import { createVingoClient, WasteAuthError } from '../src/integrations/waste-vingo.ts';
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
for(const response of [new Response('<html>terms</html>',{headers:{'content-type':'text/html'}}),new Response(null,{status:302,headers:{location:'https://other.test/'}})]){
 const test=fixture({'j_acegi_security_check':()=>response});await assert.rejects(()=>test.client.listProperties(),WasteAuthError);assert.equal(test.calls.length,1);
}
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
console.log('Vingo: lazy single login, scoped cookies, verified property, grouped IDs, Helsinki dates, empty/invalid/partial schedules, auth/redirect and response bounds passed');
