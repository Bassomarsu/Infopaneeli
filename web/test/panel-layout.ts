/**
 * Paneelien asettelun kollisiosäännöt (resolveMove/resolveResize) ovat se
 * osa, joka päättää säilyykö jokainen paneeli ruudukossa raahauksen ja koon
 * muutoksen jälkeen. Tämä testi lukitsee molemmat ehdottomat vaatimukset:
 * paneeli ei saa koskaan kadota eikä jäädä ruudukon ulkopuolelle.
 *
 * Aja (web-hakemistosta):  node test/panel-layout.ts
 * (Ei vielä kytketty package.json:n test-skripteihin, koska tiedosto ei ole
 * asettelueditorin omistamien tiedostojen listalla.)
 */
import assert from "node:assert/strict";
import { mergeWithDefaults, overlaps, resolveMove, resolveResize } from "../src/composables/usePanelLayout.ts";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  MIN_PANEL_SPAN,
  PANEL_IDS,
  defaultPanelLayout,
  type PanelId,
  type PanelLayout,
} from "../src/types.ts";

/** `noUncheckedIndexedAccess` merkitsee kaiken indeksoinnin mahdollisesti undefinediksi — tämä kaventaa sen pois, koska i/j pysyvät aina PANEL_IDS:n rajoissa. */
function panelIdAt(index: number): PanelId {
  const id = PANEL_IDS[index];
  assert.ok(id, `indeksi ${index} on PANEL_IDS:n ulkopuolella`);
  return id;
}

function assertNoOverlaps(layout: PanelLayout, label: string): void {
  for (let i = 0; i < PANEL_IDS.length; i++) {
    for (let j = i + 1; j < PANEL_IDS.length; j++) {
      const idA = panelIdAt(i);
      const idB = panelIdAt(j);
      assert.ok(!overlaps(layout[idA], layout[idB]), `${label}: ${idA} ja ${idB} menevät päällekkäin`);
    }
  }
}

function assertInBounds(layout: PanelLayout, label: string): void {
  for (const id of PANEL_IDS) {
    const p = layout[id];
    assert.ok(p.col >= 1 && p.row >= 1, `${label}: ${id} alkaa ruudukon ulkopuolelta`);
    assert.ok(p.col + p.colSpan - 1 <= GRID_COLUMNS, `${label}: ${id} ylittää sarakkeet`);
    assert.ok(p.row + p.rowSpan - 1 <= GRID_ROWS, `${label}: ${id} ylittää rivit`);
  }
}

function assertAllPanelsPresent(layout: PanelLayout, label: string): void {
  for (const id of PANEL_IDS) {
    assert.ok(layout[id], `${label}: ${id} puuttuu asettelusta`);
  }
}

// --- resolveMove ---
//
// resolveMove tunnistaa kohteen pudotuspisteen (pointerCol/pointerRow) eli
// sen solun perusteella joka on sormen/kursorin alla — EI raahatun paneelin
// omasta, deltasta lasketusta kulmasta (targetCol/targetRow). Käyttäjän
// riittää siis osua kohdepaneelin päälle jostain kohtaa.

// Osuma kohdepaneelin päälle KESKELTÄ (ei sen vasempaan yläkulmaan) riittää
// vaihtamaan samankokoiset paneelit paikoiltaan.
{
  // weather (col5,row1,2x3) raahataan electricityn (col5,row4,2x3) päälle,
  // mutta pudotuspiste (6,6) on electricityn oikeassa alakulmassa, ei sen
  // origossa (5,4) — silti pitää vaihtaa.
  const outcome = resolveMove(defaultPanelLayout, "weather", 6, 6, 6, 6);
  assert.equal(outcome.rejected, null, "osuma kohdepaneelin sisään jostain kohtaa ei saa hylätä");
  assert.equal(outcome.layout.weather.col, defaultPanelLayout.electricity.col);
  assert.equal(outcome.layout.weather.row, defaultPanelLayout.electricity.row);
  assert.equal(outcome.layout.electricity.col, defaultPanelLayout.weather.col);
  assert.equal(outcome.layout.electricity.row, defaultPanelLayout.weather.row);
  assertNoOverlaps(outcome.layout, "keskikohtaan osuneen vaihdon jälkeen");
  assertInBounds(outcome.layout, "keskikohtaan osuneen vaihdon jälkeen");
  assertAllPanelsPresent(outcome.layout, "keskikohtaan osuneen vaihdon jälkeen");
  console.log("ok  osuma kohdepaneelin sisään jostain kohtaa vaihtaa samankokoiset paneelit");
}

// Pudotuspiste eri kokoisen paneelin päällä hylkää siirron syyllä "size-mismatch".
{
  // schedule (4x3) pudotetaan calendarin (4x2) päälle, pudotuspiste (2,7).
  const outcome = resolveMove(defaultPanelLayout, "schedule", 1, 7, 2, 7);
  assert.equal(outcome.rejected, "size-mismatch");
  assert.equal(outcome.layout, defaultPanelLayout, "hylätty siirto ei saa muuttaa asettelua");
  console.log("ok  eri kokoisen paneelin päälle pudottaminen hylätään syyllä size-mismatch");
}

// Oletusasettelu täyttää koko ruudukon (48 solua, ei vapaata tilaa) eikä
// mikään paneeli voi enää kutistua MIN_PANEL_SPANin (2) alle vapauttaakseen
// tilaa, joten "vapaaseen tilaan siirto" -tapauksia varten käytetään omaa,
// käsin rakennettua asettelua, jossa kaikki paneelit ovat 2x2 ja vasemman
// puoliskon (sarakkeet 1-4) täyttäviä — sarakkeet 5-6 jäävät kokonaan
// vapaiksi.
const sparse: PanelLayout = {
  schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
  messages: { col: 1, row: 3, colSpan: 2, rowSpan: 2 },
  weather: { col: 1, row: 5, colSpan: 2, rowSpan: 2 },
  electricity: { col: 1, row: 7, colSpan: 2, rowSpan: 2 },
  calendar: { col: 3, row: 1, colSpan: 2, rowSpan: 2 },
  notes: { col: 3, row: 3, colSpan: 2, rowSpan: 2 },
  news: { col: 3, row: 5, colSpan: 2, rowSpan: 2 },
};
assertNoOverlaps(sparse, "sparse-fixture on itsessään virheellinen");
assertInBounds(sparse, "sparse-fixture on itsessään virheellinen");

// Aidosti vapaaseen tilaan siirto onnistuu, kun pudotuspiste on vapaa solu.
{
  // notes (col3,row3) vapaaseen kohtaan (col5,row1) — kukaan ei omista sitä.
  const outcome = resolveMove(sparse, "notes", 5, 1, 5, 1);
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.layout.notes.col, 5);
  assert.equal(outcome.layout.notes.row, 1);
  assertNoOverlaps(outcome.layout, "vapaaseen tilaan siirron jälkeen");
  console.log("ok  vapaaseen tilaan siirto onnistuu kun pudotuspiste on vapaa");
}

// Pudotuspiste on tyhjässä solussa, mutta raahatun paneelin oma,
// deltasta laskettu jalanjälki ulottuisi silti toisen paneelin päälle —
// hylätään syyllä "occupied" siitä huolimatta että pudotuskohta oli vapaa.
{
  // electricity (col1,row7) kohti kulmaa (2,1): jalanjälki col2-3,row1-2
  // osuu sekä scheduleen (col1-2,row1-2) että calendariin (col3-4,row1-2).
  // Pudotuspiste (5,5) on itsessään täysin vapaa.
  const outcome = resolveMove(sparse, "electricity", 2, 1, 5, 5);
  assert.equal(outcome.rejected, "occupied");
  assert.equal(outcome.layout, sparse, "hylätty siirto ei saa muuttaa asettelua");
  console.log("ok  vapaa pudotuspiste ei riitä jos raahatun paneelin oma jalanjälki osuu toiseen");
}

// Kohteen ulkopuolelle raahaaminen typistetään ruudukon sisään, ei koskaan
// yli reunan — riippumatta siitä mihin haaraan (vaihto/vapaa tila/hylkäys)
// päädytään.
{
  const outcome = resolveMove(defaultPanelLayout, "schedule", 999, 999, 999, 999);
  assertInBounds(outcome.layout, "reunan yli raahauksen jälkeen");
  assertAllPanelsPresent(outcome.layout, "reunan yli raahauksen jälkeen");
  console.log("ok  siirto typistetään ruudukon sisään myös äärimmäisillä arvoilla");
}

// Jokainen mahdollinen siirto satojen satunnaisten kohteiden ja
// pudotuspisteiden yli säilyttää molemmat ehdottomat vaatimukset.
{
  let layout = defaultPanelLayout;
  let seed = 1;
  function rand(max: number): number {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  }
  for (let i = 0; i < 500; i++) {
    const id = panelIdAt(rand(PANEL_IDS.length));
    const outcome = resolveMove(
      layout,
      id,
      rand(GRID_COLUMNS) + 1,
      rand(GRID_ROWS) + 1,
      rand(GRID_COLUMNS) + 1,
      rand(GRID_ROWS) + 1,
    );
    layout = outcome.layout;
    assertAllPanelsPresent(layout, `satunnaissiirto ${i}`);
    assertInBounds(layout, `satunnaissiirto ${i}`);
    assertNoOverlaps(layout, `satunnaissiirto ${i}`);
  }
  console.log("ok  500 satunnaista siirtoa säilyttävät kaikki paneelit ja rajat");
}

// --- resolveResize ---

// Kutistus ei saa koskaan mennä MIN_PANEL_SPANin (2) alle — kortti leikkaisi
// otsikkonsa piiloon sitä pienempänä (ks. types.ts).
{
  const shrunk = resolveResize(defaultPanelLayout, "schedule", 1, 1);
  assert.equal(shrunk.schedule.colSpan, MIN_PANEL_SPAN, "colSpan ei saa mennä minimin alle");
  assert.equal(shrunk.schedule.rowSpan, MIN_PANEL_SPAN, "rowSpan ei saa mennä minimin alle");
  assertInBounds(shrunk, "minimiin kutistuksen jälkeen");
  console.log("ok  koon kutistus pysähtyy MIN_PANEL_SPANiin");
}

// notes on jo ruudukon oikeassa alakulmassa (col 5, row 7) — molemmat
// suunnat ovat jo reunassa, joten kumpikaan span ei voi kasvaa yhtään,
// pelkkä ruudukon reunan typistys (ei ylitys) riittää estämään sen.
{
  const grown = resolveResize(defaultPanelLayout, "notes", 6, 6);
  assertInBounds(grown, "reunassa olevan paneelin resizen jälkeen");
  assert.deepEqual(grown, defaultPanelLayout, "reunassa oleva paneeli ei voi kasvaa kumpaankaan suuntaan");
  console.log("ok  ruudukon reunassa oleva paneeli ei kasva yli reunan");
}

// electricity yrittää kasvaa alaspäin (rowSpan 3 -> 5) niin että se osuisi
// noteseen — vain rowSpan kasvoi, joten vain sitä kutistetaan takaisin,
// colSpan ei saa muuttua vaikka se olisikin kokeiltu ensin.
{
  const grown = resolveResize(defaultPanelLayout, "electricity", 2, 5);
  assertNoOverlaps(grown, "resize-kasvun jälkeen");
  assertInBounds(grown, "resize-kasvun jälkeen");
  assertAllPanelsPresent(grown, "resize-kasvun jälkeen");
  assert.equal(grown.electricity.colSpan, defaultPanelLayout.electricity.colSpan, "muuttumaton ulottuvuus ei saa kutistua");
  assert.equal(grown.electricity.rowSpan, defaultPanelLayout.electricity.rowSpan, "kasvu piti perua kokonaan koska notes tukkii koko rivikasvun");
  console.log("ok  vain kasvanut ulottuvuus kutistuu, ei muuttumaton");
}

// Jos molemmat ulottuvuudet kasvavat mutta vain toinen aiheuttaa
// päällekkäisyyden, kutistus kohdistuu ensisijaisesti siihen joka kasvoi
// enemmän suhteessa nykyiseen kokoon.
{
  // electricity (col5,row4,2x3): kasvatetaan sarake yhdellä (3) ja rivi
  // kahdella (5). Sarake mahtuisi sellaisenaan (col5-7 ylittäisi ruudukon,
  // joten se typistyy jo rajan takia), mutta rivikasvu osuu noteseen.
  const grown = resolveResize(defaultPanelLayout, "electricity", 10, 10);
  assertNoOverlaps(grown, "isoimman kasvun jälkeen");
  assertInBounds(grown, "isoimman kasvun jälkeen");
  assertAllPanelsPresent(grown, "isoimman kasvun jälkeen");
  console.log("ok  suurikin ylikasvupyyntö päätyy turvalliseen kokoon");
}

// Koon muutos ei koskaan voi työntää paneelia ruudukon ulkopuolelle.
{
  const grown = resolveResize(defaultPanelLayout, "schedule", GRID_COLUMNS + 10, GRID_ROWS + 10);
  assertInBounds(grown, "äärimmäisen resizen jälkeen");
  console.log("ok  koon kasvu typistetään ruudukon sisään");
}

// Satoja satunnaisia koon muutoksia, aina kasvuun ja kutistukseen sekaisin,
// säilyttävät molemmat ehdottomat vaatimukset.
{
  let layout = defaultPanelLayout;
  let seed = 7;
  function rand(max: number): number {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  }
  for (let i = 0; i < 500; i++) {
    const id = panelIdAt(rand(PANEL_IDS.length));
    layout = resolveResize(layout, id, rand(GRID_COLUMNS) + 1, rand(GRID_ROWS) + 1);
    assertAllPanelsPresent(layout, `satunnaisresize ${i}`);
    assertInBounds(layout, `satunnaisresize ${i}`);
    assertNoOverlaps(layout, `satunnaisresize ${i}`);
  }
  console.log("ok  500 satunnaista koon muutosta säilyttävät kaikki paneelit ja rajat");
}

// --- mergeWithDefaults ---

// Puuttuva paneeli (esim. skeeman muuttuessa) täydentyy oletuksesta, muut
// paneelit säilyvät ennallaan.
{
  const partial = { ...defaultPanelLayout } as Partial<PanelLayout>;
  delete partial.notes;
  const merged = mergeWithDefaults(partial as PanelLayout);
  assert.deepEqual(merged.notes, defaultPanelLayout.notes, "puuttuva paneeli ei täydentynyt oletuksesta");
  assert.deepEqual(merged.schedule, defaultPanelLayout.schedule, "ennallaan pysyvä paneeli muuttui");
  console.log("ok  puuttuva paneeli täydentyy oletusasettelusta");
}

// Ruudukon ulkopuolelle menevä paneeli hylätään ja korvataan oletuksella.
{
  const invalid: PanelLayout = {
    ...defaultPanelLayout,
    weather: { col: GRID_COLUMNS, row: 1, colSpan: 3, rowSpan: 2 },
  };
  const merged = mergeWithDefaults(invalid);
  assert.deepEqual(merged.weather, defaultPanelLayout.weather, "ruudukon ulkopuolelle menevä paneeli ei palautunut");
  console.log("ok  ruudukon ulkopuolelle menevä paneeli korvataan oletuksella");
}

// MIN_PANEL_SPANin alle jäävä (mutta muuten rajojen sisällä pysyvä) paneeli
// hylätään ja korvataan oletuksella — esim. vanha, ennen minimin lisäämistä
// tallennettu asettelu.
{
  const invalid: PanelLayout = {
    ...defaultPanelLayout,
    notes: { col: 5, row: 7, colSpan: 1, rowSpan: 2 },
  };
  const merged = mergeWithDefaults(invalid);
  assert.deepEqual(merged.notes, defaultPanelLayout.notes, "MIN_PANEL_SPANin alittava paneeli ei palautunut oletukseen");
  console.log("ok  MIN_PANEL_SPANin alittava paneeli korvataan oletuksella");
}

// null tarkoittaa "ei koskaan muokattu" — koko oletusasettelu.
{
  const merged = mergeWithDefaults(null);
  assert.deepEqual(merged, defaultPanelLayout);
  // --- Piilotettu paneeli ei ole tiellä ---
//
// Piilotetun paneelin sijoitus on PARKKIPAIKKA eikä piirtopaikka: sitä ei
// renderöidä, joten se ei saa varata ruutuja muilta. Ilman tätä eroa pois
// kytkeminen ei vapauttaisi tilaa lainkaan — oletusasettelu täyttää ruudukon
// tasan, joten naapuria ei voisi koskaan kasvattaa.
{
  // Sähkö piilossa: sää (5,1 2x3) voi kasvaa sen päälle riveille 4-6.
  const next = resolveResize(defaultPanelLayout, "weather", 2, 6, ["electricity"]);
  assert.equal(next.weather.rowSpan, 6, "piilotetun paneelin ruudut ovat vapaita kasvulle");

  const blocked = resolveResize(defaultPanelLayout, "weather", 2, 6, []);
  assert.equal(blocked.weather.rowSpan, 3, "näkyvä naapuri estää kasvun yhä");
  console.log("ok  piilotettu paneeli ei estä naapurin kasvattamista, näkyvä estää");
}

{
  // Sama siirrolle: pudotus piilotetun paneelin ruutuihin onnistuu, eikä sitä
  // tulkita paikanvaihdoksi piilotetun kanssa.
  const outcome = resolveMove(defaultPanelLayout, "notes", 1, 7, 1, 7, ["calendar"]);
  assert.equal(outcome.rejected, null, "piilotetun paneelin ruutuun pudottaminen onnistuu");
  assert.deepEqual(outcome.layout.notes, { col: 1, row: 7, colSpan: 2, rowSpan: 2 });
  assert.deepEqual(
    outcome.layout.calendar,
    defaultPanelLayout.calendar,
    "piilotettu paneeli ei vaihda paikkaa — se ei ole ruudulla",
  );
  console.log("ok  piilotetun paneelin ruutuun voi siirtää, eikä se johda paikanvaihtoon");
}

console.log("ok  null palauttaa koko oletusasettelun");
}
