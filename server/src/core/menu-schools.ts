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
 async function json(url:string){const r=await fetcher(url,{signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});if(!r.ok)throw Error('Koululuettelon haku epäonnistui');return r.json();}
 const index=await json('https://kouluruoka.fi/page-data/index/page-data.json') as {staticQueryHashes?:unknown};
 if(!Array.isArray(index.staticQueryHashes)||index.staticQueryHashes.length>10)throw Error('Koululuettelon rakenne muuttui');
 const results=await Promise.all(index.staticQueryHashes.map(async hash=>{
  if(typeof hash!=='string'||!/^\d{1,20}$/.test(hash))throw Error('Virheellinen koululuettelo');
  return parseMenuSchools(await json('https://kouluruoka.fi/page-data/sq/d/'+hash+'.json'));
 }));
 const schools=[...new Map(results.flat().map(s=>[s.id,s])).values()];
 if(!schools.length)throw Error('Koululuettelo puuttuu');return schools;
}
let cache:MenuSchoolOption[]|undefined;let expires=0;let pending:Promise<MenuSchoolOption[]>|undefined;
export function getMenuSchools():Promise<MenuSchoolOption[]> {
 if(cache&&Date.now()<expires)return Promise.resolve(cache);
 return pending??=fetchMenuSchools().then(s=>{cache=s;expires=Date.now()+6*60*60*1000;return s;}).finally(()=>{pending=undefined;});
}
