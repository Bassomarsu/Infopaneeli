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
  MAX_LAYOUT_ROWS,
  MIN_PANEL_SPAN,
  PANEL_IDS,
  defaultPanelLayout,
  defaultHiddenPanels,
  type PanelId,
  type PanelLayout,
} from "../src/types.ts";

/**
 * Täydentää osittaisen asettelun täydeksi. Testit kuvaavat vain ne paneelit
 * joilla on merkitystä kyseiselle tapaukselle; loput otetaan oletuksista.
 *
 * Ilman tätä jokainen testiasettelu pitäisi kirjoittaa uusiksi joka kerta kun
 * uusi paneeli lisätään — ja silloin testi kertoisi paneelien määrästä eikä
 * siitä asiasta jota se on kirjoitettu vartioimaan.
 */
function taydenna(osittainen: Partial<PanelLayout>): PanelLayout {
  return { ...defaultPanelLayout, ...osittainen } as PanelLayout;
}

/** `noUncheckedIndexedAccess` merkitsee kaiken indeksoinnin mahdollisesti undefinediksi — tämä kaventaa sen pois, koska i/j pysyvät aina PANEL_IDS:n rajoissa. */
function panelIdAt(index: number): PanelId {
  const id = PANEL_IDS[index];
  assert.ok(id, `indeksi ${index} on PANEL_IDS:n ulkopuolella`);
  return id;
}

function assertNoOverlaps(layout: PanelLayout, label: string, hidden: readonly PanelId[] = defaultHiddenPanels): void {
  for (let i = 0; i < PANEL_IDS.length; i++) {
    for (let j = i + 1; j < PANEL_IDS.length; j++) {
      const idA = panelIdAt(i);
      const idB = panelIdAt(j);
      if (hidden.includes(idA) || hidden.includes(idB)) continue;
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
  const outcome = resolveMove(defaultPanelLayout, "weather", 6, 6, 6, 6, defaultHiddenPanels);
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
  const outcome = resolveMove(defaultPanelLayout, "schedule", 1, 7, 2, 7, defaultHiddenPanels);
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
const sparse: PanelLayout = taydenna({
  schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
  messages: { col: 1, row: 3, colSpan: 2, rowSpan: 2 },
  weather: { col: 1, row: 5, colSpan: 2, rowSpan: 2 },
  electricity: { col: 1, row: 7, colSpan: 2, rowSpan: 2 },
  calendar: { col: 3, row: 1, colSpan: 2, rowSpan: 2 },
  notes: { col: 3, row: 3, colSpan: 2, rowSpan: 2 },
  news: { col: 3, row: 5, colSpan: 2, rowSpan: 2 },
});
assertNoOverlaps(sparse, "sparse-fixture on itsessään virheellinen");
assertInBounds(sparse, "sparse-fixture on itsessään virheellinen");

// Aidosti vapaaseen tilaan siirto onnistuu, kun pudotuspiste on vapaa solu.
{
  // notes (col3,row3) vapaaseen kohtaan (col5,row1) — kukaan ei omista sitä.
  const outcome = resolveMove(sparse, "notes", 5, 1, 5, 1, defaultHiddenPanels);
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
  const outcome = resolveMove(sparse, "electricity", 2, 1, 5, 5, defaultHiddenPanels);
  assert.equal(outcome.rejected, "occupied");
  assert.equal(outcome.layout, sparse, "hylätty siirto ei saa muuttaa asettelua");
  console.log("ok  vapaa pudotuspiste ei riitä jos raahatun paneelin oma jalanjälki osuu toiseen");
}

// Kohteen ulkopuolelle raahaaminen typistetään ruudukon sisään, ei koskaan
// yli reunan — riippumatta siitä mihin haaraan (vaihto/vapaa tila/hylkäys)
// päädytään.
{
  const outcome = resolveMove(defaultPanelLayout, "schedule", 999, 999, 999, 999, defaultHiddenPanels);
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
    const id = PANEL_IDS.filter((id) => !defaultHiddenPanels.includes(id))[rand(PANEL_IDS.length - defaultHiddenPanels.length)]!;
    const outcome = resolveMove(
      layout,
      id,
      rand(GRID_COLUMNS) + 1,
      rand(GRID_ROWS) + 1,
      rand(GRID_COLUMNS) + 1,
      rand(GRID_ROWS) + 1,
      defaultHiddenPanels,
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
  const shrunk = resolveResize(defaultPanelLayout, "schedule", 1, 1, defaultHiddenPanels);
  assert.equal(shrunk.schedule.colSpan, MIN_PANEL_SPAN, "colSpan ei saa mennä minimin alle");
  assert.equal(shrunk.schedule.rowSpan, MIN_PANEL_SPAN, "rowSpan ei saa mennä minimin alle");
  assertInBounds(shrunk, "minimiin kutistuksen jälkeen");
  console.log("ok  koon kutistus pysähtyy MIN_PANEL_SPANiin");
}

// notes on jo ruudukon oikeassa alakulmassa (col 5, row 7) — molemmat
// suunnat ovat jo reunassa, joten kumpikaan span ei voi kasvaa yhtään,
// pelkkä ruudukon reunan typistys (ei ylitys) riittää estämään sen.
{
  const grown = resolveResize(defaultPanelLayout, "notes", 6, 6, defaultHiddenPanels);
  assertInBounds(grown, "reunassa olevan paneelin resizen jälkeen");
  assert.deepEqual(grown, defaultPanelLayout, "reunassa oleva paneeli ei voi kasvaa kumpaankaan suuntaan");
  console.log("ok  ruudukon reunassa oleva paneeli ei kasva yli reunan");
}

// electricity yrittää kasvaa alaspäin (rowSpan 3 -> 5) niin että se osuisi
// noteseen — vain rowSpan kasvoi, joten vain sitä kutistetaan takaisin,
// colSpan ei saa muuttua vaikka se olisikin kokeiltu ensin.
{
  const grown = resolveResize(defaultPanelLayout, "electricity", 2, 5, defaultHiddenPanels);
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
  const grown = resolveResize(defaultPanelLayout, "electricity", 10, 10, defaultHiddenPanels);
  assertNoOverlaps(grown, "isoimman kasvun jälkeen");
  assertInBounds(grown, "isoimman kasvun jälkeen");
  assertAllPanelsPresent(grown, "isoimman kasvun jälkeen");
  console.log("ok  suurikin ylikasvupyyntö päätyy turvalliseen kokoon");
}

// Koon muutos ei koskaan voi työntää paneelia ruudukon ulkopuolelle.
{
  const grown = resolveResize(defaultPanelLayout, "schedule", GRID_COLUMNS + 10, GRID_ROWS + 10, defaultHiddenPanels);
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
    const id = PANEL_IDS.filter((id) => !defaultHiddenPanels.includes(id))[rand(PANEL_IDS.length - defaultHiddenPanels.length)]!;
    layout = resolveResize(layout, id, rand(GRID_COLUMNS) + 1, rand(GRID_ROWS) + 1, defaultHiddenPanels);
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
  const next = resolveResize(defaultPanelLayout, "weather", 2, 6, [...defaultHiddenPanels, "electricity"]);
  assert.equal(next.weather.rowSpan, 6, "piilotetun paneelin ruudut ovat vapaita kasvulle");

  const blocked = resolveResize(defaultPanelLayout, "weather", 2, 6, defaultHiddenPanels);
  assert.equal(blocked.weather.rowSpan, 3, "näkyvä naapuri estää kasvun yhä");
  console.log("ok  piilotettu paneeli ei estä naapurin kasvattamista, näkyvä estää");
}

{
  // Sama siirrolle: pudotus piilotetun paneelin ruutuihin onnistuu, eikä sitä
  // tulkita paikanvaihdoksi piilotetun kanssa.
  const outcome = resolveMove(defaultPanelLayout, "notes", 1, 7, 1, 7, [...defaultHiddenPanels, "calendar"]);
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

// Kaikki paneelit näkyvissä: piilotuslista on tarkoituksella tyhjä.
// Jokainen kortti käy siirron lähteenä ja kohteena, myös kaikki viisi uutta.
{
  const compact = {} as PanelLayout;
  const perRow = Math.floor(GRID_COLUMNS / MIN_PANEL_SPAN);
  PANEL_IDS.forEach((id, index) => {
    compact[id] = {
      col: 1 + (index % perRow) * MIN_PANEL_SPAN,
      row: 1 + Math.floor(index / perRow) * MIN_PANEL_SPAN,
      colSpan: MIN_PANEL_SPAN, rowSpan: MIN_PANEL_SPAN,
    };
  });
  assert.equal(PANEL_IDS.length, 12, "kaikki kaksitoista paneelia mukana");
  assertNoOverlaps(compact, "kaikki näkyvissä", []);
  assertInBounds(compact, "kaikki näkyvissä");
  for (const source of PANEL_IDS) {
    for (const target of PANEL_IDS) {
      if (source === target) continue;
      const to = compact[target];
      const moved = resolveMove(compact, source, to.col, to.row, to.col, to.row, []);
      assert.equal(moved.rejected, null);
      assert.deepEqual(moved.layout[source], compact[target]);
      assert.deepEqual(moved.layout[target], compact[source]);
      for (const other of PANEL_IDS) {
        if (other !== source && other !== target) assert.deepEqual(moved.layout[other], compact[other]);
      }
      assertNoOverlaps(moved.layout, source + " → " + target, []);
      assertInBounds(moved.layout, "kaikkien paneelien vaihto");
      assertAllPanelsPresent(moved.layout, "kaikkien paneelien vaihto");
    }
    const grown = resolveResize(compact, source, GRID_COLUMNS, GRID_ROWS, []);
    assert.deepEqual(grown, compact, "täyden ruudukon korttia ei voi kasvattaa muiden päälle");
  }
  console.log("ok  kaikkien 12 paneelin 132 paikanvaihtoa ja kasvun esto ilman piilotuksia");
}

// Scroll adds space without resizing or moving existing panels.
{
  const { enablePanel } = await import('../src/composables/usePanelLayout.ts');
  let layout = structuredClone(defaultPanelLayout);
  let hidden = [...defaultHiddenPanels];
  for (const id of defaultHiddenPanels) {
    const before = structuredClone(layout);
    const outcome = enablePanel(layout, hidden, id, true);
    assert.equal(outcome.rejected, null);
    assert.equal(outcome.layout[id].rowSpan, before[id].rowSpan);
    assert.equal(outcome.layout[id].colSpan, before[id].colSpan);
    for (const other of PANEL_IDS.filter(p => p !== id)) assert.deepEqual(outcome.layout[other], before[other]);
    layout = outcome.layout; hidden = outcome.hiddenPanels;
  }
  assert.equal(hidden.length, 0);
  assert.ok(Object.values(layout).some(p => p.row > GRID_ROWS));
  assertNoOverlaps(layout, 'scroll all panels', []);
  assert.deepEqual(mergeWithDefaults(layout), layout, 'reload preserves extended rows');
  // Siirto ruudukon ulkopuolelle RAJAUTUU, ei hyväksytä sellaisenaan.
  // Aiemmin tässä odotettiin riviä 100, koska MAX_LAYOUT_ROWS oli 10 000:
  // yksi paneeli riville 300 tuotti 37 769 px korkean sivun. Odotus on nyt
  // johdettu katosta eikä kiinteä luku, jotta se seuraa mukana jos
  // paneelien määrä muuttuu.
  const moved = resolveMove(layout, 'waste', 1, 100, 1, 100, [], true);
  const ylin = MAX_LAYOUT_ROWS - moved.layout.waste.rowSpan + 1;
  assert.equal(moved.layout.waste.row, ylin);
  assert.ok(moved.layout.waste.row + moved.layout.waste.rowSpan - 1 <= MAX_LAYOUT_ROWS);
  const grown = resolveResize(moved.layout, 'waste', 2, 6, [], true);
  assert.ok(grown.waste.row + grown.waste.rowSpan - 1 <= MAX_LAYOUT_ROWS, 'kasvu ei saa ylittää kattoa');
  assert.deepEqual(grown.weather, layout.weather);
  console.log('ok  scroll enables every panel unchanged, persists extra rows and moves/resizes below row eight');
}

{
  const { findFreeSpot } = await import('../src/composables/usePanelLayout.ts');
  const layout = structuredClone(defaultPanelLayout);
  // Paneeli joka täyttää ruudukon katon asti: vapaa paikka on sen alapuolella
  // vain jos kattoa on jäljellä. Luvut on johdettu MAX_LAYOUT_ROWSista, koska
  // katto on nyt paneelimäärästä laskettu eikä kiinteä 10 000.
  const korkea = MAX_LAYOUT_ROWS - 2;
  layout.schedule = {col:1,row:1,colSpan:6,rowSpan:korkea};
  const hidden = PANEL_IDS.filter(id => id !== 'schedule');
  const spot = findFreeSpot(layout, hidden, 'waste', 2, 2, true);
  assert.deepEqual(spot, {col:1,row:korkea + 1,colSpan:2,rowSpan:2});
  console.log('ok  sparse tall layouts locate the next free boundary directly');
}

{
 const layout = structuredClone(defaultPanelLayout);
 // Ylin sallittu rivi 2x2-paneelille, ja sen ylitys. Johdettu katosta.
 const ylin = MAX_LAYOUT_ROWS - 1;
 layout.waste = {col:1,row:ylin,colSpan:2,rowSpan:2};
 const hidden = PANEL_IDS.filter(id => id !== 'waste');
 const moved=resolveMove(layout,'waste',1,100000,1,100000,hidden,true);
 assert.equal(moved.layout.waste.row,ylin);
 // Katon yli menevä tallennettu sijoitus hylätään ja korvataan oletuksella,
 // eikä kortti katoa hiljaa.
 layout.waste.row=MAX_LAYOUT_ROWS + 1;
 assert.deepEqual(mergeWithDefaults(layout).waste,defaultPanelLayout.waste);
 console.log('ok  browser grid track safety limit rejects overflow without clipping stored cards');
}
