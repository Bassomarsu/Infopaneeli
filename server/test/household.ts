import './household-test-env.ts';
import assert from 'node:assert/strict';
process.env.DB_PATH='data/infonaytto-test-household-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-household-'+process.pid;
process.env.EDIT_PIN='4242';
process.env.TRUSTED_HOSTS='';
const {validDate,nextWasteDate,seasonalOccurrence,helsinkiToday,saveHousehold,readHousehold,clearDoneShopping}=await import('../src/core/household.ts');
const {registerHouseholdRoutes}=await import('../src/routes/household.ts');
const {default:Fastify}=await import('fastify');
assert.equal(validDate('2025-02-29'),false);
assert.equal(validDate('2024-02-29'),true);
assert.equal(validDate('2026-13-01'),false);
assert.equal(helsinkiToday(new Date('2026-09-12T21:30:00Z')),'2026-09-13');
assert.equal(nextWasteDate({id:'w',label:'Bio',date:'2026-03-22',intervalWeeks:1},'2026-03-30'),'2026-04-05');
assert.equal(nextWasteDate({id:'w',label:'Bio',date:'2026-03-22',intervalWeeks:1},'2026-03-29'),'2026-03-29');
const seasonal={id:'s',label:'Renkaat',date:'2026-12-01',annual:true,completedDate:null};
assert.equal(seasonalOccurrence(seasonal,'2027-01-15'),'2026-12-01','unfinished December remains overdue in January');
assert.equal(seasonalOccurrence({...seasonal,completedDate:'2026-12-01'},'2027-01-15'),'2027-12-01');
assert.equal(seasonalOccurrence({...seasonal,date:'2024-02-29',completedDate:'2024-02-29'},'2025-01-01'),'2025-02-28');
const app=Fastify(); registerHouseholdRoutes(app);
for(const kind of ['waste','shopping','seasonal','anniversaries']) {
 const body=kind==='shopping'?{text:'Maito'}:kind==='waste'?{label:'Bio',date:'2026-09-13',intervalWeeks:2}:kind==='seasonal'?{label:'Renkaat',date:'2026-12-01',annual:true}:{label:'Juhla',date:'2024-02-29'};
 for(const method of ['POST','PATCH','DELETE']) {
  const denied=await app.inject({method:method as 'POST'|'PATCH'|'DELETE',url:'/api/household/'+kind+(method==='POST'?'':'/missing'),remoteAddress:'192.0.2.50',...(method==='DELETE'?{}:{payload:body})});
  assert.equal(denied.statusCode,401,kind+' requires edit access');
 }
 const added=await app.inject({method:'POST',url:'/api/household/'+kind,remoteAddress:'192.0.2.50',headers:{'x-edit-pin':'4242'},payload:body});
 assert.equal(added.statusCode,201,added.body); const id=added.json().id;
 const changed=await app.inject({method:'PATCH',url:'/api/household/'+kind+'/'+id,payload:kind==='shopping'?{done:true}:{label:'Uusi'}});assert.equal(changed.statusCode,200,changed.body);
 const invalid=await app.inject({method:'PATCH',url:'/api/household/'+kind+'/'+id,payload:{unexpected:true}});assert.equal(invalid.statusCode,400);
 const read=await app.inject('/api/household');assert.equal(read.json()[kind].length,1);
 const removed=await app.inject({method:'DELETE',url:'/api/household/'+kind+'/'+id});assert.equal(removed.statusCode,204);
 const missing=await app.inject({method:'DELETE',url:'/api/household/'+kind+'/'+id});assert.equal(missing.statusCode,404);
}
assert.throws(()=>saveHousehold('waste',{label:'Bio',date:'2026-02-30',intervalWeeks:1}));
assert.throws(()=>saveHousehold('waste',{label:'Bio',date:'2026-02-20',intervalWeeks:1.5}));
assert.throws(()=>saveHousehold('shopping',{text:' '}));
assert.throws(()=>saveHousehold('anniversaries',{label:'Juhla',date:'2020-01-01',annual:false}));
saveHousehold('anniversaries',{label:'Karkauspäivä',date:'2024-02-29'});
assert.equal(readHousehold(new Date('2025-02-28T10:00:00Z')).anniversaries[0]?.occurrenceDate,'2025-02-28');
assert.equal(readHousehold(new Date('2025-03-01T10:00:00Z')).anniversaries[0]?.occurrenceDate,'2026-02-28');
assert.equal(readHousehold().shopping.length,0);
const task=saveHousehold('seasonal',{label:'Renkaat',date:'2026-12-01',annual:true});
assert.ok(task);
saveHousehold('seasonal',{done:true,occurrenceDate:'2026-12-01'},task.id,new Date('2027-01-15T10:00:00Z'));
assert.equal(readHousehold(new Date('2027-01-15T10:00:00Z')).seasonal[0]?.occurrenceDate,'2027-12-01');
// Duplicate requests from stale dashboards must never complete next year's task.
saveHousehold('seasonal',{done:true,occurrenceDate:'2026-12-01'},task.id);
assert.equal(readHousehold().seasonal[0]?.occurrenceDate,'2027-12-01');
saveHousehold('seasonal',{done:true,occurrenceDate:'2027-12-01'},task.id);
saveHousehold('seasonal',{done:false,occurrenceDate:'2027-12-01'},task.id);
assert.equal(readHousehold().seasonal[0]?.occurrenceDate,'2027-12-01','undo retains earlier completed years');
saveHousehold('seasonal',{done:false,occurrenceDate:'2027-12-01'},task.id);
assert.equal(readHousehold().seasonal[0]?.occurrenceDate,'2027-12-01','duplicate undo is a no-op');
assert.throws(()=>saveHousehold('seasonal',{done:true},task.id));
assert.throws(()=>saveHousehold('seasonal',{done:true,occurrenceDate:'2029-12-01'},task.id));
assert.equal(saveHousehold('shopping',{text:'Missing'},'unknown'),null);
assert.equal(readHousehold().shopping.length,0);

/**
 * KAUSIMUISTUTUSTEN KIINNIOTTO.
 *
 * Mitattu vika: vuosittainen muistutus, kuitattu 2020, näytti vuonna 2026
 * päivämäärää 1.5.2021, ja yksi kuittaus siirsi sitä yhden vuoden — viisi
 * väliin jäänyttä vuotta vaati viisi klikkausta. Seuraava esiintymä lasketaan
 * nyt nykyhetkestä, joten yksi kuittaus riittää aina.
 */
const annual = (date:string, completedDate:string|null) => ({id:'x',label:'Renkaat',date,annual:true,completedDate});
assert.equal(seasonalOccurrence(annual('2020-05-01','2020-05-01'),'2026-09-16'),'2026-05-01','2020 kuitattuna ei jää roikkumaan vuoteen 2021');
assert.equal(seasonalOccurrence(annual('2020-05-01','2026-05-01'),'2026-09-16'),'2027-05-01','yksi kuittaus riittää viiden väliin jääneen vuoden jälkeen');
assert.equal(seasonalOccurrence(annual('2020-05-01',null),'2026-09-16'),'2026-05-01','kuittaamattomanakaan vuodet eivät kasaannu');
assert.equal(seasonalOccurrence(annual('2026-05-01',null),'2026-04-30'),'2026-05-01','tuleva esiintymä näkyy sellaisenaan');
assert.equal(seasonalOccurrence(annual('2028-05-01',null),'2026-09-16'),'2028-05-01','tulevaisuuteen luotu merkintä alkaa omasta vuodestaan');
assert.equal(seasonalOccurrence(annual('2028-05-01','2028-05-01'),'2026-09-16'),'2029-05-01','tulevakin merkintä siirtyy kuitattuna seuraavaan');
assert.equal(seasonalOccurrence({...annual('2020-05-01','2020-05-01'),annual:false},'2026-09-16'),'2020-05-01','kertaluonteinen ei siirry mihinkään');

// 29.2. EI-KARKAUSVUONNA: leikkautuu 28.2:een, ei koskaan valu maaliskuulle.
for (const year of [2025,2026,2027,2028,2029,2030,2031]) {
 const occurrence = seasonalOccurrence(annual('2024-02-29',`${year-1}-02-${year-1===2024||year-1===2028?'29':'28'}`),`${year}-06-01`);
 assert.equal(occurrence.slice(0,7),`${year}-02`,'karkauspäivä pysyy helmikuussa vuonna '+year);
 assert.equal(occurrence.slice(8),year%4===0?'29':'28','29.2. -> 28.2. ei-karkausvuonna, 29.2. karkausvuonna ('+year+')');
}
assert.equal(seasonalOccurrence(annual('2024-02-29','2024-02-29'),'2028-03-01'),'2028-02-29','kiinniotto karkausvuoteen antaa oikean 29.2:n');
assert.equal(seasonalOccurrence(annual('2024-02-29',null),'2025-03-05'),'2025-02-28','kuittaamaton karkauspäivä on myöhässä helmikuulta, ei maaliskuulta');

/**
 * KESÄAIKA. Kaikki päivämäärälaskenta on merkkijono- ja UTC-aritmetiikkaa,
 * joten vaihtopäivä ei ole erikoistapaus — mutta juuri sen oletuksen
 * rikkoutuminen oli hälytysten kesäaikavika, joten se todetaan tässä.
 * Helsingin vaihtohetket: 29.3.2026 klo 03 ja 25.10.2026 klo 04 (paikallista).
 */
assert.equal(helsinkiToday(new Date('2026-03-29T00:30:00Z')),'2026-03-29','kesäaikaan siirtymisen aamu');
assert.equal(helsinkiToday(new Date('2026-10-24T21:30:00Z')),'2026-10-25','talviaikaan siirtymisen yö on jo seuraavaa päivää Helsingissä');
assert.equal(seasonalOccurrence(annual('2020-03-29','2020-03-29'),'2026-06-01'),'2026-03-29','kesäajan vaihtopäivälle osuva muistutus ei siirry');
assert.equal(seasonalOccurrence(annual('2020-10-25',null),'2026-10-25'),'2026-10-25','talviajan vaihtopäivä on ajankohtainen samana päivänä');
assert.equal(seasonalOccurrence(annual('2020-10-25','2026-10-25'),'2026-10-25'),'2027-10-25','kuitattuna vaihtopäivä siirtyy täsmälleen vuodella');

// Sama polku tallennuksen läpi: yksi kuittaus, viisi väliin jäänyttä vuotta.
const missed = saveHousehold('seasonal',{label:'Renkaat',date:'2020-05-01',annual:true});
assert.ok(missed);
saveHousehold('seasonal',{done:true,occurrenceDate:'2020-05-01'},missed.id,new Date('2020-05-01T09:00:00Z'));
const syksy = new Date('2026-09-16T09:00:00Z');
const seasonalRow=(id:string)=>readHousehold(syksy).seasonal.find(item=>item.id===id);
assert.equal(seasonalRow(missed.id)?.occurrenceDate,'2026-05-01','kiinniotto näkyy listalla');
saveHousehold('seasonal',{done:true,occurrenceDate:'2026-05-01'},missed.id,syksy);
assert.equal(seasonalRow(missed.id)?.occurrenceDate,'2027-05-01','yksi klikkaus vie seuraavaan vuoteen, ei vuoteen 2021');
saveHousehold('seasonal',{done:false,occurrenceDate:'2026-05-01'},missed.id,syksy);
assert.equal(seasonalRow(missed.id)?.occurrenceDate,'2026-05-01','kuittauksen peruminen palauttaa saman esiintymän');

/**
 * KAUPPALISTAN KATTO JA TEHTYJEN TYHJENNYS.
 *
 * Tehdyt ostokset eivät enää syö tekemättömien tilaa, ja ne saa pois yhdellä
 * pyynnöllä. Aiemmin 200:n katto laski tehdyt mukaan, joten lista lukkiutui
 * vaikka tekemättömiä olisi ollut kourallinen.
 */
const shoppingIds:string[]=[];
for (let i=0;i<200;i++) shoppingIds.push((saveHousehold('shopping',{text:'Ostos '+i}) as {id:string}).id);
assert.throws(()=>saveHousehold('shopping',{text:'Yli katon'}),/enintään 200 tekemätöntä/);
for (const id of shoppingIds.slice(0,150)) saveHousehold('shopping',{done:true},id);
const lisatty = saveHousehold('shopping',{text:'Mahtuu kun tehdyt eivät laske'});
assert.ok(lisatty,'tehdyt eivät enää täytä kattoa');
assert.equal(readHousehold().shopping.length,201);
assert.equal(clearDoneShopping(),150,'tyhjennys poistaa vain tehdyt');
assert.equal(readHousehold().shopping.length,51);
assert.equal(clearDoneShopping(),0,'tyhjennys ilman tehtyjä on ei-operaatio');
assert.ok(readHousehold().shopping.every(item=>!item.done));

// Tallennetun listan kova katto: tehtyjä ei voi kerätä loputtomiin.
for (const item of readHousehold().shopping) saveHousehold('shopping',{done:true},item.id);
while (readHousehold().shopping.length < 500) {
 const id=(saveHousehold('shopping',{text:'Täyte'}) as {id:string}).id;
 saveHousehold('shopping',{done:true},id);
}
assert.throws(()=>saveHousehold('shopping',{text:'Ei mahdu'}),/Lista on täynnä/);
// Reitti: tyhjennys vaatii muokkausoikeuden, ja kertoo montako poistui.
const clearDenied=await app.inject({method:'DELETE',url:'/api/household/shopping/done',remoteAddress:'192.0.2.50'});
assert.equal(clearDenied.statusCode,401,'tyhjennys vaatii muokkausoikeuden');
assert.equal(readHousehold().shopping.length,500,'torjuttu pyyntö ei poista mitään');
const cleared=await app.inject({method:'DELETE',url:'/api/household/shopping/done'});
assert.equal(cleared.statusCode,200);assert.deepEqual(cleared.json(),{removed:500});
assert.equal(readHousehold().shopping.length,0);
// Staattinen /done ei saa peittää tavallista poistoa.
const kept=saveHousehold('shopping',{text:'Jää jäljelle'}) as {id:string};
const removedOne=await app.inject({method:'DELETE',url:'/api/household/shopping/'+kept.id});
assert.equal(removedOne.statusCode,204);assert.equal(readHousehold().shopping.length,0);
await app.close();
console.log('Household: date boundaries, CRUD, validation, seasonal catch-up, 29 February, shopping limits and all mutation authorization checks passed');
