import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { config } from './config.ts';
import { getSetting, setSetting } from './store.ts';
import { Provider, type ProviderSnapshot } from './provider.ts';
import { getWasteCompanies } from './waste-companies.ts';
import { createVingoClient, WasteAuthError } from '../integrations/waste-vingo.ts';
interface Connection {revision:string;companyId:string;municipality:string;address:string;propertyId:string;enabled:boolean;blocked:boolean;secret:string|null}
export interface WasteData {revision:string;companyName:string;events:{id:string;label:string;date:string}[];sourceUrl:string;configured:boolean;enabled:boolean}
const KEY='waste.connection';
const initial:Connection={revision:'unset',companyId:'',municipality:'',address:'',propertyId:'',enabled:false,blocked:false,secret:null};
const connection=():Connection=>({...initial,...getSetting<Connection>(KEY)});
function key(create=true):Buffer {
 const filename=config.dbPath+'.waste-key';
 try {const data=fs.readFileSync(filename);if(data.length!==32)throw Error();return data;}
 catch(error){if(!create || (error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Jätehuollon tunnusten avainta ei voitu lukea.');fs.mkdirSync(path.dirname(filename),{recursive:true});const data=randomBytes(32);try{fs.writeFileSync(filename,data,{flag:'wx',mode:0o600});return data;}catch{const existing=fs.readFileSync(filename);if(existing.length!==32)throw Error('Virheellinen tunnusavain.');return existing;}}
}
function seal(value:unknown):string {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
function credentials(secret:string):{username:string;password:string} {try{const data=Buffer.from(secret,'base64'),cipher=createDecipheriv('aes-256-gcm',key(false),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8'));}catch{throw Error('Tallennetut jätehuollon tunnukset on syötettävä uudelleen.');}}
export function wasteConfig(){const c=connection();return {companyId:c.companyId,municipality:c.municipality,address:c.address,propertyId:c.propertyId,enabled:c.enabled,blocked:c.blocked,configured:!!c.secret};}
function string(value:unknown,max=200):string {if(typeof value!=='string'||value.length>max)throw Error('Virheellinen jätehuollon asetus.');return value.trim();}
export function saveWasteConfig(body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Virheellinen sisältö.');
 const p=body as Record<string,unknown>;
 if(Object.keys(p).some(k=>!['companyId','municipality','address','propertyId','username','password','enabled'].includes(k)))throw Error('Tuntematon jätehuollon asetus.');
 const before=connection(),next={...before,revision:randomUUID()};
 for(const field of ['companyId','municipality','address','propertyId'] as const)if(field in p)next[field]=string(p[field]);
 const company=getWasteCompanies().find(c=>c.id===next.companyId);
 if(next.companyId&&!company)throw Error('Valitse jätehuoltoyhtiö luettelosta.');
 const accountChanged=next.companyId!==before.companyId || 'username' in p || 'password' in p;
 if(accountChanged){next.secret=null;next.propertyId='';next.blocked=false;next.enabled=false;}
 if('username' in p || 'password' in p){
  const username=string(p.username),password=typeof p.password==='string'&&p.password.length<=1000?p.password:'';
  if(!username||!password)throw Error('Anna käyttäjätunnus ja salasana.');
  if(company?.adapter!=='vingo')throw Error('Tälle yhtiölle ei ole vielä automaattista kirjautumisliitäntää.');
  next.secret=seal({username,password});
 }
 if('enabled' in p){if(typeof p.enabled!=='boolean')throw Error('Virheellinen automaattisen haun valinta.');next.enabled=p.enabled;}
 if(next.enabled&&(!next.secret||!next.propertyId||company?.adapter!=='vingo'))throw Error('Yhdistä jätehuollon tunnus ja valitse kiinteistö ensin.');
 setSetting(KEY,next);if(accountChanged)clientCache=null;return wasteConfig();
}
let lastLoginAttempt=0;
let lastScheduleAttempt=0;
function limited(){return Object.assign(Error("Odota minuutti ennen uutta yhteysyritystä."),{statusCode:429});}
let clientCache:{accountKey:string;createdAt:number;client:ReturnType<typeof createVingoClient>}|null=null;
function client(c:Connection){
 const company=getWasteCompanies().find(x=>x.id===c.companyId);
 if(!c.secret||company?.adapter!=='vingo'||!company.baseUrl)throw Error('Automaattista jätehuoltoyhteyttä ei ole määritetty.');
 const accountKey=c.companyId+':'+c.secret;
 if(clientCache?.accountKey!==accountKey || Date.now()-clientCache.createdAt>30*60_000){
  if(Date.now()-lastLoginAttempt<60_000)throw limited();
  const auth=credentials(c.secret);lastLoginAttempt=Date.now();clientCache={accountKey,createdAt:Date.now(),client:createVingoClient(company.baseUrl,auth.username,auth.password)};
 }
 return clientCache!.client;
}
function markBlocked(c:Connection){if(connection().revision===c.revision)setSetting(KEY,{...c,blocked:true});}
let lastManualAttempt=0;
export async function wasteProperties(){
 if(Date.now()-lastManualAttempt<60_000)throw Object.assign(Error('Odota minuutti ennen uutta yhteysyritystä.'),{statusCode:429});
 lastManualAttempt=Date.now();const c=connection();clientCache=null;
 try{const properties=await client(c).listProperties();if(connection().revision!==c.revision)throw Error('Asetukset muuttuivat. Yhdistä uudelleen.');setSetting(KEY,{...c,blocked:false});return properties;}
 catch(error){if(error instanceof WasteAuthError)markBlocked(c);throw error;}
}
export function projectWasteData(data:unknown):WasteData {
 const c=connection(),company=getWasteCompanies().find(x=>x.id===c.companyId);
 const empty:WasteData={revision:c.revision,companyName:company?.name??'',events:[],sourceUrl:company?.website??'',configured:!!c.secret&&!!c.propertyId,enabled:c.enabled};
 const old=data as WasteData|null;
 return old?.revision===c.revision&&c.enabled?old:empty;
}
let lastFailureRevision:string|null=null;
export function projectWasteSnapshot(snapshot:ProviderSnapshot):ProviderSnapshot<WasteData> {
 const data=projectWasteData(snapshot.data);
 const old=snapshot.data as WasteData|null;
 if(old?.revision!==data.revision)return {...snapshot,data,status:!data.enabled?'ok':lastFailureRevision===data.revision?'failed':'idle',fetchedAt:null,error:lastFailureRevision===data.revision?snapshot.error:null};
 return {...snapshot,data};
}
export async function fetchWaste():Promise<WasteData>{
 for(let i=0;i<4;i++){
  const c=connection(),empty=projectWasteData(null);
  if(!c.enabled)return empty;
  if(c.blocked)throw Error('Jätehuollon kirjautuminen on pysäytetty. Tarkista tunnukset asetuksista ja yhdistä uudelleen.');
  if(Date.now()-lastScheduleAttempt<60_000)throw limited();
  lastScheduleAttempt=Date.now();
  try{const events=await client(c).schedule(c.propertyId);if(connection().revision===c.revision)return {...empty,events};}
  catch(error){if(connection().revision!==c.revision)continue;lastFailureRevision=c.revision;if(error instanceof WasteAuthError)markBlocked(c);throw error;}
 }
 throw Error('Jätehuollon asetukset muuttuivat haun aikana.');
}
export function createWasteProvider(){return new Provider<WasteData>({id:'waste',intervalMs:6*60*60*1000,initialDelayMs:9000,timeoutMs:100_000,fetch:fetchWaste});}
