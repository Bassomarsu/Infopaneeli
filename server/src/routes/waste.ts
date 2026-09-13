import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isTrustedRequest } from './access.ts';
import { getWasteCompanies } from '../core/waste-companies.ts';
import { wasteConfig,saveWasteConfig,wasteProperties } from '../core/waste-service.ts';
import { registry } from '../core/provider.ts';
function allowed(req:FastifyRequest,reply:FastifyReply){if(isTrustedRequest(req))return true;reply.code(403).send({error:'Jätehuollon tunnusten hallinta vaatii täydet oikeudet (FULL_PIN) tai näyttölaitteen.'});return false;}
export function registerWasteRoutes(app:FastifyInstance){
 app.get('/api/waste/companies',async()=>({companies:getWasteCompanies().map(({baseUrl,...c})=>c)}));
 app.get('/api/waste/config',async(req,reply)=>{if(!allowed(req,reply))return reply;return wasteConfig();});
 app.put('/api/waste/config',async(req,reply)=>{if(!allowed(req,reply))return reply;try{const config=saveWasteConfig(req.body);void registry.get('waste')?.runOnce();return config;}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Tallennus epäonnistui.'});}});
 app.post('/api/waste/properties',async(req,reply)=>{if(!allowed(req,reply))return reply;try{return {properties:await wasteProperties()};}catch(error){return reply.code((error as {statusCode?:number}).statusCode===429?429:400).send({error:error instanceof Error?error.message:'Yhdistäminen epäonnistui.'});}});
 app.post('/api/waste/refresh',async(req,reply)=>{if(!allowed(req,reply))return reply;const provider=registry.get('waste');if(!provider)return reply.code(503).send({error:'Aikataulupalvelu ei ole käynnissä.'});
 const result=await provider.manualTest();
 if(result.outcome==='rate_limited'||result.outcome==='daily_limit')return reply.code(429).header('retry-after',String(result.retryAfterSeconds)).send({error:'Odota ennen seuraavaa päivitystä.',retryAfterSeconds:result.retryAfterSeconds});
 if(result.outcome==='failed')return reply.code(502).send({error:'Aikataulun haku epäonnistui. Tarkista yhteys asetuksista.'});
 return reply.code(result.outcome==='busy'?202:200).send({ok:true});});
}
