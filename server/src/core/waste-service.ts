import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { config } from './config.ts';
import { getSetting, setSetting } from './store.ts';
import { FatalProviderError, Provider, registry, type ProviderSnapshot } from './provider.ts';
import { getWasteCompanies } from './waste-companies.ts';
import { createVingoClient, WasteAuthError } from '../integrations/waste-vingo.ts';
interface Connection {revision:string;companyId:string;municipality:string;address:string;propertyId:string;enabled:boolean;blocked:boolean;blockedAt:number;secret:string|null}
export interface WasteData {revision:string;companyName:string;events:{id:string;label:string;date:string}[];sourceUrl:string;configured:boolean;enabled:boolean}
const KEY='waste.connection';
const initial:Connection={revision:'unset',companyId:'',municipality:'',address:'',propertyId:'',enabled:false,blocked:false,blockedAt:0,secret:null};
const connection=():Connection=>({...initial,...getSetting<Connection>(KEY)});
/**
 * Salausavain omassa tiedostossaan tietokannan vierellä. Suojaa sen tapauksen
 * jossa pelkkä `infonaytto.db` kopioidaan muualle (varmuuskopio, kehittäjä joka
 * testaa oikealla kannalla) — silloin tunnukset eivät lähde mukana. Se ei suojaa
 * jos koko `data/` kopioidaan, koska avain on siellä sisällä; ks. docs/waste-sources.md.
 *
 * `flag:'wx'` ja sitä seuraava catch ovat kilpailutilanteen esto, eivät
 * varovaisuutta: jos kaksi rinnakkaista tallennusta kirjoittaisi avaimen päälle,
 * ensimmäisellä avaimella salatut tunnukset muuttuisivat PYSYVÄSTI lukukelvottomiksi.
 * `wx` epäonnistuu jos tiedosto jo on, ja silloin luetaan se joka ehti ensin.
 */
function key(create=true):Buffer {
 const filename=config.dbPath+'.waste-key';
 try {const data=fs.readFileSync(filename);if(data.length!==32)throw Error();return data;}
 catch(error){if(!create || (error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Jätehuollon tunnusten avainta ei voitu lukea.');fs.mkdirSync(path.dirname(filename),{recursive:true});const data=randomBytes(32);try{fs.writeFileSync(filename,data,{flag:'wx',mode:0o600});return data;}catch{const existing=fs.readFileSync(filename);if(existing.length!==32)throw Error('Virheellinen tunnusavain.');return existing;}}
}
function seal(value:unknown):string {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
/** `key(false)`: purku ei saa KOSKAAN luoda avainta. Jos kadonnut avain korvautuisi
 * uudella, vanha salateksti muuttuisi palauttamattomaksi juuri siinä hetkessä kun
 * alkuperäinen avain olisi vielä voitu palauttaa varmuuskopiosta. */
function credentials(secret:string):{username:string;password:string} {try{const data=Buffer.from(secret,'base64'),cipher=createDecipheriv('aes-256-gcm',key(false),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8'));}catch{throw Error('Tallennetut jätehuollon tunnukset on syötettävä uudelleen.');}}
/** Tunnukset ovat tallessa JA luettavissa. Pelkkä secretin olemassaolo ei riitä:
 * jos avaintiedosto on kadonnut mutta salattu data jäänyt, asetusnäkymä sanoi
 * "Tunnukset on tallennettu. Jätä kentät tyhjiksi säilyttääksesi ne." — ja ohjeen
 * noudattaminen jäi silmukkaan, koska ulos pääsi vain syöttämällä ne uudelleen. */
function readable(secret:string|null):boolean {if(!secret)return false;try{credentials(secret);return true;}catch{return false;}}
/** Jäljellä oleva jäähdytys millisekunteina, 0 kun yritys on taas sallittu. Ks. BLOCK_RETRY_MS. */
function blockedFor(c:Connection):number {return c.blocked?Math.max(0,BLOCK_RETRY_MS-(Date.now()-c.blockedAt)):0;}
/**
 * `blockedForSeconds` ja `keyMissing` ovat käyttöliittymää varten eivätkä koristeita.
 * Ilman ensimmäistä asetusnäkymä ei voi kertoa milloin lukitustilasta pääsee ulos
 * ILMAN tunnusten syöttämistä, jolloin ainoaksi näkyväksi ulospääsyksi jää salasanan
 * kokeileminen uudelleen. Ilman toista näkymä väittää tunnusten olevan tallessa
 * silloinkin kun avain on kadonnut eikä niitä voi enää purkaa (ks. readable).
 */
export function wasteConfig(){const c=connection(),ok=readable(c.secret);return {companyId:c.companyId,municipality:c.municipality,address:c.address,propertyId:c.propertyId,enabled:c.enabled,blocked:c.blocked,blockedForSeconds:Math.ceil(blockedFor(c)/1000),configured:ok,keyMissing:!!c.secret&&!ok};}
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
 if(accountChanged){next.secret=null;next.propertyId='';next.blocked=false;next.blockedAt=0;next.enabled=false;}
 if('username' in p || 'password' in p){
  // Salasanaa EI viedä `string()`:n läpi, koska se trimmaisi: välilyönti alussa
  // tai lopussa on osa salasanaa, ja sen hiljainen poistaminen tuottaisi
  // epäonnistuvia kirjautumisia oikeilla tunnuksilla. Raja on myös 1000, ei
  // `string()`:n 200 — pitkä satunnaissalasana on tavallinen.
  const username=string(p.username),password=typeof p.password==='string'&&p.password.length<=1000?p.password:'';
  if(!username||!password)throw Error('Anna käyttäjätunnus ja salasana.');
  if(company?.adapter!=='vingo')throw Error('Tälle yhtiölle ei ole vielä automaattista kirjautumisliitäntää.');
  next.secret=seal({username,password});
 }
 if('enabled' in p){if(typeof p.enabled!=='boolean')throw Error('Virheellinen automaattisen haun valinta.');next.enabled=p.enabled;}
 if(next.enabled&&(!next.secret||!next.propertyId||company?.adapter!=='vingo'))throw Error('Yhdistä jätehuollon tunnus ja valitse kiinteistö ensin.');
 setSetting(KEY,next);
 // Tunnusten vaihto on ainoa asia joka voi korjata katkaisijan kiinni panneen
 // tunnusvirheen, joten se myös avaa katkaisijan. Muuten juuri korjatut tunnukset
 // jäisivät jäähdytyksen taakse tunneiksi eikä käyttäjä näkisi mitään tapahtuvan.
 if(accountChanged){clientCache=null;registry.get('waste')?.resetBreaker();}
 return wasteConfig();
}
/**
 * Kirjautumisyritysten väli luetaan ja kirjoitetaan KANTAAN, ei moduulimuuttujaan.
 * Moduulitila nollautuu jokaisessa käynnistyksessä, ja mitattuna kuusi peräkkäistä
 * käynnistystä tuotti kuusi kirjautumista 1,4 sekunnissa. Palvelin käynnistyy
 * uudelleen itsestään (systemd Restart=always), joten ilman kantaan tallennusta
 * käynnistyssilmukka on nopein tapa lukita perheen jätehuoltotili — ja tili on
 * sama joka on huoltajan omassa puhelimessa.
 */
const ATTEMPT_KEY='waste.login-attempt';
const LOGIN_INTERVAL_MS=60_000;
const lastLoginAttempt=()=>getSetting<{at:number}>(ATTEMPT_KEY)?.at??0;
let lastScheduleAttempt=0;
function limited(){return Object.assign(Error("Odota minuutti ennen uutta yhteysyritystä."),{statusCode:429});}
let clientCache:{accountKey:string;createdAt:number;client:ReturnType<typeof createVingoClient>}|null=null;
function client(c:Connection){
 const company=getWasteCompanies().find(x=>x.id===c.companyId);
 if(!c.secret||company?.adapter!=='vingo'||!company.baseUrl)throw Error('Automaattista jätehuoltoyhteyttä ei ole määritetty.');
 // Salateksti itse on välimuistin avain. Tämä nojaa siihen että `seal()` arpoo uuden
 // IV:n joka tallennuksella: samojen tunnusten tallentaminen uudelleen tuottaa eri
 // salatekstin ja pakottaa siksi uuden kirjautumisen. Se on tarkoitus — "tallenna
 // yhteys" on käyttäjän tapa hylätä vanha istunto.
 const accountKey=c.companyId+':'+c.secret;
 if(clientCache?.accountKey!==accountKey || Date.now()-clientCache.createdAt>30*60_000){
  if(Date.now()-lastLoginAttempt()<LOGIN_INTERVAL_MS)throw limited();
  // `credentials()` ennen kirjausta: puuttuva avain ei saa kuluttaa yritysväliä,
  // koska siinä ei lähtenyt yhtään pyyntöä jätehuoltoyhtiöön.
  const auth=credentials(c.secret);setSetting(ATTEMPT_KEY,{at:Date.now()});clientCache={accountKey,createdAt:Date.now(),client:createVingoClient(company.baseUrl,auth.username,auth.password)};
 }
 return clientCache!.client;
}
function markBlocked(c:Connection){if(connection().revision===c.revision)setSetting(KEY,{...c,blocked:true,blockedAt:Date.now()});}
/**
 * Jäähdytys `blocked`-tilassa, ja samalla vastaus siihen että kiinteistöhaulla on
 * KAKSI roolia: se on sekä ainoa kirjautuva polku jota käyttäjä voi painaa niin
 * usein kuin jaksaa (mitattuna 60 kirjautumista tunnissa) että ainoa tapa nollata
 * `blocked` ILMAN tunnusten syöttämistä uudelleen. Siksi `blocked` ei sulje hakua
 * kokonaan vaan harventaa sen yhteen yritykseen puolessa tunnissa: väärillä
 * tunnuksilla se on 2 kirjautumista tunnissa, oikeilla tunnuksilla ensimmäinen
 * yritys jäähdytyksen jälkeen palauttaa yhteyden itsestään.
 *
 * Portti on tahallaan ENNEN `lastManualAttempt`-rajaa: jäähdytys on lukitussuoja,
 * ei näpyttelysuoja, eikä sitä saa voida ohittaa odottamalla minuuttia.
 *
 * Hetki luetaan kannasta, joten uudelleenkäynnistys ei anna uutta yritystä.
 */
const BLOCK_RETRY_MS=30*60_000;
let lastManualAttempt=0;
export async function wasteProperties(){
 const c=connection();
 const blockedForMs=blockedFor(c);
 if(blockedForMs>0)throw Object.assign(Error('Jätehuolto hylkäsi tunnukset viimeksi, joten kirjautumista ei toisteta heti. Uusi yritys on mahdollinen '+Math.ceil(blockedForMs/60_000)+' min kuluttua. Jos tunnukset ovat muuttuneet, syötä ne uudelleen ja tallenna yhteys.'),{statusCode:429,retryAfterSeconds:Math.ceil(blockedForMs/1000)});
 if(Date.now()-lastManualAttempt<60_000)throw limited();
 // Vanha istunto pois ennen uutta hakua: "Hae kiinteistöt" on nimenomaan se
 // painike jolla käyttäjä yrittää toipua rikkinäisestä yhteydestä, eikä se saa
 // palauttaa saman rikkinäisen istunnon tulosta uudelleen.
 lastManualAttempt=Date.now();clientCache=null;
 // Onnistunut kirjautuminen todistaa tunnukset toimiviksi, joten se avaa myös
 // katkaisijan. Muuten ulospääsy jäisi puolitiehen: `blocked` nollautuisi mutta
 // automaattinen haku odottaisi yhä jäähdytystä, jonka sama tunnusvirhe avasi.
 try{const properties=await client(c).listProperties();if(connection().revision!==c.revision)throw Error('Asetukset muuttuivat. Yhdistä uudelleen.');setSetting(KEY,{...c,blocked:false,blockedAt:0});registry.get('waste')?.resetBreaker();return properties;}
 catch(error){if(error instanceof WasteAuthError)markBlocked(c);throw error;}
}
export function projectWasteData(data:unknown):WasteData {
 const c=connection(),company=getWasteCompanies().find(x=>x.id===c.companyId);
 const empty:WasteData={revision:c.revision,companyName:company?.name??'',events:[],sourceUrl:company?.website??'',configured:readable(c.secret)&&!!c.propertyId,enabled:c.enabled};
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
  // Tahallaan tavallinen Error eikä FatalProviderError: tässä ei lähde yhtään
  // pyyntöä yhtiöön, joten katkaisijalla ei ole mitään suojattavaa — ja jos tämä
  // avaisi katkaisijan, `PUT /api/waste/config`in laukaisema välitön uusi haku
  // jäisi jäähdytyksen taakse juuri kun käyttäjä on korjaamassa tunnuksia.
  if(c.blocked)throw Error('Jätehuolto hylkäsi tunnukset, joten automaattista kirjautumista ei toisteta. Päivitä tunnukset asetuksista.');
  if(Date.now()-lastScheduleAttempt<60_000)throw limited();
  lastScheduleAttempt=Date.now();
  try{const events=await client(c).schedule(c.propertyId);if(connection().revision===c.revision)return {...empty,events};}
  catch(error){if(connection().revision!==c.revision)continue;lastFailureRevision=c.revision;throw asFatal(error,c);}
 }
 throw Error('Jätehuollon asetukset muuttuivat haun aikana.');
}
/**
 * Tunnusvirhe on providerille FATAALI — sama mekanismi jolla Wilma ja Päikky
 * estävät tilin lukittumisen (docs/wilma.md, docs/paikky-toteutus.md). Ilman tätä
 * jätteen katkaisija ei avautunut koskaan, koska `onFailure` laskee vain
 * FatalProviderError-virheitä, ja ainoa suoja oli `blocked`-lippu.
 *
 * `blocked` pysäyttää haun jo ensimmäisen hylkäyksen jälkeen, joten katkaisija on
 * käytännössä varajärjestelmä: se laukeaa silloin kun `markBlocked` ei ehtinyt
 * tallentua (asetukset vaihtuivat kesken haun, jolloin revision-vahti ohittaa
 * kirjoituksen). Juuri siksi `fatalLimit` on 2 eikä 3 kuten Wilmassa — yksi
 * jätehaku on yksi kirjautuminen, ja tili lukkiutuu.
 */
function asFatal(error:unknown,c:Connection):unknown {
 if(!(error instanceof WasteAuthError))return error;
 markBlocked(c);
 return new FatalProviderError('waste_auth',error.message);
}
export function createWasteProvider(){return new Provider<WasteData>({id:'waste',intervalMs:6*60*60*1000,initialDelayMs:9000,timeoutMs:100_000,fatalLimit:2,fetch:fetchWaste});}
