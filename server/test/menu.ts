import './test-env.ts';
import assert from 'node:assert/strict';
import { parseMenuPage, fetchMenu, extractInlinedPageData } from '../src/providers/menu.ts';
function page(start='2026-12-28', dates=['maanantai 28.12.','perjantai 1.1.']) { return {result:{pageContext:{menu:{RestaurantId:'karstula_koulut',RestaurantName:'Karstula - Koulut',Start:start,Days:dates.map(Date=>({Date,Meals:[{MealType:'Lounas',Name:'Keitto'}]}))}}}}; }
/** Sivu sellaisena kuin kouluruoka.fi sen nykyään palauttaa: JSON upotettuna HTML:ään. */
function markup(data:unknown):string { return `<html><body><div id="___gatsby">…</div><script id="gatsby-inlined-page-data">/*<![CDATA[*/(function(){var d=${JSON.stringify(data)};if(typeof window!=="undefined"){d.path="/";}window.pageData=d;})();/*]]>*/</script><script id="gatsby-script-loader">/*<![CDATA[*/…/*]]>*/</script></body></html>`; }
function html(data:unknown):Response { return new Response(markup(data),{headers:{'content-type':'text/html'}}); }

const menu=parseMenuPage(page());
assert.deepEqual(menu.days.map(d=>d.date),['2026-12-28','2027-01-01']);
assert.deepEqual(menu.days[1]?.meals,[{type:'Lounas',name:'Keitto'}]);
assert.throws(()=>parseMenuPage(page('2026-02-30')),/viikko/);
assert.throws(()=>parseMenuPage(page('2026-12-28',['maanantai 28.12.','maanantai 28.12.'])),/päivämäärä/);
assert.throws(()=>parseMenuPage(page('2026-12-28',['maanantai 21.12.'])),/päivämäärä/);
const wrong=page(); wrong.result.pageContext.menu.RestaurantId='other';
assert.throws(()=>parseMenuPage(wrong),/eri koululle/);
assert.throws(()=>parseMenuPage({}),/rakenne/);

// --- Upotetun aineiston kaivaminen HTML-sivusta (lähde vaihtoi muotoa 2026) ---
assert.deepEqual(extractInlinedPageData(markup(page())),page());
// Kääre saa muuttua: ankkurina on `{"`, ei `var d=`.
assert.deepEqual(extractInlinedPageData(`<script id="gatsby-inlined-page-data">(()=>{let q=${JSON.stringify(page())};window.pageData=q})()</script>`),page());
// Merkkijonon sisällä olevat aaltosulkeet ja lainausmerkit eivät päätä oliota.
const tricky={result:{pageContext:{menu:{RestaurantId:'karstula_koulut',RestaurantName:'Koulu } "{" \\ loppu',Start:'2026-12-28',Days:[]}}}};
assert.deepEqual(extractInlinedPageData(markup(tricky)),tricky);
assert.equal(parseMenuPage(extractInlinedPageData(markup(tricky))).locationName,'Koulu } "{" \\ loppu');
// Skandit säilyvät (sivu ei ilmoita merkistöä content-typessä).
assert.equal(parseMenuPage(extractInlinedPageData(markup(page('2026-12-28',[])))).locationName,'Karstula - Koulut');
assert.throws(()=>extractInlinedPageData('<html><body>ei mitään</body></html>'),/puuttuu upotettu data/);
assert.throws(()=>extractInlinedPageData('<script id="gatsby-inlined-page-data">(function(){var d=null;})()</script>'),/ei tunnistettu/);
assert.throws(()=>extractInlinedPageData('<script id="gatsby-inlined-page-data">(function(){var d={"a":1'),/katkesi kesken/);
assert.throws(()=>extractInlinedPageData(markup(page()).slice(0,-260)),/katkesi kesken/);
assert.throws(()=>extractInlinedPageData('<script id="gatsby-inlined-page-data">var d={"a":1,,}</script>'),/ei voi lukea/);
// 404-sivu vastaa 200:lla vain jos lähde rikkoutuu; silloin `menu` puuttuu kokonaan.
assert.throws(()=>parseMenuPage(extractInlinedPageData(markup({result:{pageContext:{}}}))),/rakenne/);

/**
 * PERÄÄNTYMISEN ESTO ON TESTATTU AJASTA, ei koodin ulkonäöstä. Syöte on sama
 * ansa joka kaatoi uutisten säännöllisillä lausekkeilla tehdyn jäsentimen:
 * suuri määrä avaavia tageja ilman sulkevaa. Mitattuna tällä syötteellä
 * (1,72 Mt): perääntyvä lauseke 3828 ms, nykyinen indexOf-toteutus 5,2 ms.
 * Raja on 500 ms — kaukana kummastakin, joten testi ei heilu koneen kuorman
 * mukaan mutta kaatuu heti jos joku vaihtaa tähän lausekkeen takaisin.
 */
for (const [label,bait] of [
  ['40 000 avaavaa script-tagia ilman sulkevaa','<script id="gatsby-inlined-page-data">{"a":1,'.repeat(40_000)],
  ['2 Mt sisäkkäisiä aaltosulkeita','<script id="gatsby-inlined-page-data">{"'+'{'.repeat(2*1024*1024)],
  ['2 Mt sulkematonta merkkijonoa','<script id="gatsby-inlined-page-data">{"'+'a'.repeat(2*1024*1024)],
  ['2 Mt kenoviivoja merkkijonossa','<script id="gatsby-inlined-page-data">{"'+'\\'.repeat(2*1024*1024)],
  ['2 Mt roskaa ilman merkkiä','x'.repeat(2*1024*1024)],
] as const) {
  const started=performance.now();
  assert.throws(()=>extractInlinedPageData(bait));
  const elapsed=performance.now()-started;
  assert.ok(elapsed<500,`${label} kesti ${elapsed.toFixed(0)} ms — jäsennin perääntyy`);
}

let calls:string[]=[];
const fetched=await fetchMenu((async url=>{calls.push(String(url));return html(String(url).includes('/2/')?page('2027-01-04',['maanantai 4.1.']):page());}) as typeof fetch,new Date('2026-12-29T12:00:00Z'));
assert.equal(calls.length,2);assert.deepEqual(fetched.days.map(d=>d.date),['2026-12-28','2027-01-01','2027-01-04']);
// Haetaan sivu, ei kadonnutta page-data-aineistoa.
assert.deepEqual(calls,['https://kouluruoka.fi/menu/karstula_koulut/','https://kouluruoka.fi/menu/karstula_koulut/2/']);
const missing=await fetchMenu((async url=>String(url).includes('/2/')?new Response(null,{status:404}):html(page())) as typeof fetch,new Date('2026-12-29T12:00:00Z'));
assert.equal(missing.days.length,2);
await assert.rejects(()=>fetchMenu((async()=>html(page())) as typeof fetch,new Date('2027-02-01T12:00:00Z')),/vanhentunut/);
await assert.rejects(()=>fetchMenu((async()=>new Response(null,{status:503})) as typeof fetch),/HTTP 503/);
await assert.rejects(()=>fetchMenu((async url=>String(url).includes('/2/')?new Response(null,{status:500}):html(page())) as typeof fetch),/HTTP 500/);
// Kadonnut page-data-polku vastaa 404:llä HTML-virhesivulla — ensimmäinen viikko ei saa niellä sitä.
await assert.rejects(()=>fetchMenu((async()=>new Response('<html>404</html>',{status:404})) as typeof fetch),/HTTP 404/);
const empty=await fetchMenu((async()=>html(page('2026-12-28',[]))) as typeof fetch,new Date('2026-12-29T12:00:00Z'));
assert.deepEqual(empty.days,[]);

// --- Kokoraja (ks. MAX_PAGE_BYTES) ---
// Rehellinen content-length torjutaan ennen rungon lukemista.
await assert.rejects(()=>fetchMenu((async()=>new Response('<html/>',{headers:{'content-length':String(80*1024*1024)}})) as typeof fetch),/odottamattoman suuri/);
// Valehteleva tai puuttuva content-length ei auta: runko katkaistaan rajalla.
const huge='<html>'+'x'.repeat(3*1024*1024);
await assert.rejects(()=>fetchMenu((async()=>new Response(huge,{headers:{'content-length':'7'}})) as typeof fetch),/odottamattoman suuri/);
// Rajan alle jäävä sivu luetaan normaalisti.
assert.equal((await fetchMenu((async()=>new Response(markup(page())+'<!--'+'x'.repeat(200_000)+'-->')) as typeof fetch,new Date('2026-12-29T12:00:00Z'))).days.length,2);

console.log('Menu: parser, inlined page data, backtracking guard, size cap, year rollover, missing days, duplicate/date/location validation, fetch errors and stale source checks passed');
