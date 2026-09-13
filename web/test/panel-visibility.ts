/**
 * Paneelien näkyvyys: mitkä paneelit renderöidään kun käyttäjä on kytkenyt
 * jotain pois, mitä tapahtuu tuntemattomalle tunnisteelle, ja ennen kaikkea
 * se ettei käyttäjän oma piilotus ja palvelimen arkaluontoisuussuodatus
 * sekoitu toisiinsa.
 *
 * Kaksi eri syytä piiloon on tämän tiedoston pääasia. Ne EIVÄT saa sekoittua:
 *   - Palvelin piilottaa lukujärjestyksen ja Wilma-viestit laitteelta jolla ei
 *     ole täyttä luottamusta (ProviderStatus "hidden"). Paneeli renderöityy
 *     silti ja kertoo itse miksi se on tyhjä.
 *   - Käyttäjä kytkee paneelin pois (hiddenPanels). Paneelia ei renderöidä.
 * Jos nämä valuisivat yhteen, puhelimella piilotettu lukujärjestys
 * tallentuisi käyttäjän omaksi valinnaksi ja katoaisi myös seinänäytöltä.
 *
 * Aja (web-hakemistosta):  node test/panel-visibility.ts
 */
import assert from "node:assert/strict";
import { enablePanel, findFreeSpot, overlappingVisiblePanels } from "../src/composables/usePanelLayout.ts";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  MIN_PANEL_SPAN,
  PANEL_IDS,
  PANEL_TITLES,
  defaultPanelLayout,
  defaultHiddenPanels,
  isPanelHidden,
  isPanelId,
  panelVisibilityRows,
  sanitizeHiddenPanels,
  shouldRenderPanel,
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

/** Ne paneelit jotka näkyvät annetulla piilotuslistalla, muokkaustilan ulkopuolella. */
function rendered(hidden: readonly unknown[] | null | undefined): PanelId[] {
  return PANEL_IDS.filter((id) => shouldRenderPanel(id, hidden));
}

// --- Perustapaus: piilotus poistaa juuri sen paneelin eikä mitään muuta ---
{
  assert.deepEqual(rendered([]), [...PANEL_IDS], "tyhjä lista = kaikki näkyy");
  assert.deepEqual(rendered(null), [...PANEL_IDS], "null = kaikki näkyy");
  assert.deepEqual(rendered(undefined), [...PANEL_IDS], "puuttuva avain = kaikki näkyy");
  console.log("ok  tyhjä, null ja puuttuva lista tarkoittavat kaikki samaa: kaikki näkyy");
}

{
  const visible = rendered(["news"]);
  assert.ok(!visible.includes("news"), "pois kytketty paneeli ei saa renderöityä");
  assert.deepEqual(
    visible,
    PANEL_IDS.filter((id) => id !== "news"),
    "vain pois kytketty paneeli saa kadota",
  );
  console.log("ok  hiddenPanels piilottaa täsmälleen luettelemansa paneelit");
}

{
  const visible = rendered(["news", "notes", "weather"]);
  assert.deepEqual(visible, PANEL_IDS.filter((id) => !["news", "notes", "weather"].includes(id)));
  console.log("ok  useampi kerralla pois");
}

{
  assert.deepEqual(rendered([...PANEL_IDS]), [], "kaikki saa kytkeä pois");
  console.log("ok  kaikkien paneelien pois kytkeminen on sallittua (tyhjä ruutu, ei virhe)");
}

// --- Tuntematon tunniste listassa ---
{
  const visible = rendered(["ei-ole-paneeli", "", null, 42, { id: "news" }, "News"]);
  assert.deepEqual(visible, [...PANEL_IDS], "tuntematon tunniste ei saa piilottaa mitään");
  console.log("ok  tuntematon tunniste jätetään huomiotta eikä se piilota mitään");
}

{
  // Tuntematon tunniste ei myöskään saa kaataa mitään eikä estää tunnettujen
  // toimintaa samassa listassa.
  const visible = rendered(["poistettu-paneeli", "notes"]);
  assert.deepEqual(
    visible,
    PANEL_IDS.filter((id) => id !== "notes"),
    "tunnettu tunniste toimii vaikka listassa on tuntematon",
  );
  console.log("ok  tuntematon tunniste ei estä samassa listassa olevaa tunnettua");
}

{
  assert.equal(isPanelId("news"), true);
  assert.equal(isPanelId("uutiset"), false);
  assert.equal(isPanelId(undefined), false);
  assert.equal(isPanelId(7), false);
  console.log("ok  isPanelId tunnistaa vain oikeat tunnisteet");
}

// --- Muokkaustila ei muuta renderöintiä ---
{
  // Pois kytketty paneeli EI ole ruudukossa myöskään muokkaustilassa — se on
  // yläpalkin parkkirivissä. Ruudukkoon jätettynä se olisi väistämättä
  // toisen kortin päällä aina kun asettelu on täynnä.
  for (const id of PANEL_IDS) {
    assert.equal(shouldRenderPanel(id, [...PANEL_IDS]), false, `${id}: pois kytkettyä ei renderöidä ruudukkoon`);
    assert.equal(shouldRenderPanel(id, []), true, `${id}: näkyvä renderöidään`);
  }
  console.log("ok  pois kytketty paneeli ei ole ruudukossa myöskään muokkaustilassa");
}

// --- Peruutettavuus: lista sisältää aina jokaisen paneelin ---
{
  const rows = panelVisibilityRows(["messages", "news"]);
  assert.equal(rows.length, PANEL_IDS.length, "valintalistasta ei saa karsia piilotettuja");
  assert.deepEqual(
    rows.map((row) => row.id),
    [...PANEL_IDS],
    "järjestys on PANEL_IDS",
  );
  assert.deepEqual(
    rows.filter((row) => row.hidden).map((row) => row.id),
    ["messages", "news"],
  );
  for (const row of rows) {
    assert.equal(row.title, PANEL_TITLES[row.id], `${row.id}: rivillä on oltava paneelin oma otsikko`);
  }
  console.log("ok  valintalista sisältää jokaisen paneelin — piilotus on peruutettavissa");
}

{
  const rows = panelVisibilityRows(["ei-ole-paneeli"]);
  assert.equal(rows.length, PANEL_IDS.length, "tuntematon ei saa lisätä haamuriviä");
  assert.equal(rows.some((row) => row.hidden), false, "tuntematon ei saa merkitä mitään piilotetuksi");
  console.log("ok  tuntematon tunniste ei tuota valintariviä olemattomalle paneelille");
}

// --- Tallennetun listan siivous ---
{
  assert.deepEqual(sanitizeHiddenPanels(["news", "news", "news"]), ["news"], "kaksoiskappaleet pois");
  assert.deepEqual(sanitizeHiddenPanels(["news", "ei-ole", 5, null]), ["news"], "vain tunnetut jäävät");
  assert.deepEqual(sanitizeHiddenPanels(null), []);
  assert.deepEqual(sanitizeHiddenPanels(undefined), []);
  // Järjestys ei saa riippua siitä missä järjestyksessä käyttäjä napsutteli.
  assert.deepEqual(sanitizeHiddenPanels(["news", "schedule"]), sanitizeHiddenPanels(["schedule", "news"]));
  assert.deepEqual(sanitizeHiddenPanels(["news", "schedule"]), ["schedule", "news"], "järjestys on PANEL_IDS");
  console.log("ok  sanitizeHiddenPanels siivoaa tuntemattomat ja kaksoiskappaleet, järjestys vakio");
}

// --- Käyttäjän piilotus ja arkaluontoisuussuodatus eivät sekoitu ---
{
  // 1. Selain ei koskaan piilota arkaluontoisia paneeleja omasta aloitteestaan.
  //    Jos joku joskus "auttaisi" lisäämällä ne hiddenPanelsiin puhelimella,
  //    valinta tallentuisi käyttäjän omaksi ja paneelit katoaisivat myös
  //    seinänäytöltä — pysyvästi, ilman että kukaan kytki niitä pois.
  const sensitive: PanelId[] = ["schedule", "messages"];
  for (const id of sensitive) {
    assert.equal(
      shouldRenderPanel(id, []),
      true,
      `${id}: arkaluontoinen paneeli renderöityy aina kun käyttäjä ei ole kytkenyt sitä pois`,
    );
  }
  console.log("ok  arkaluontoinen paneeli renderöityy — palvelimen suodatus näkyy kortin sisällä, ei paneelin katoamisena");
}

{
  // 2. Päätös ei saa riippua providerin tilasta millään tavalla. Funktio ei
  //    ota sitä parametrikseen, ja tämä testi lukitsee sen: käyttäjän
  //    piilotus vaikuttaa täsmälleen samalla tavalla arkaluontoiseen ja
  //    tavalliseen paneeliin.
  const sensitiveHidden = rendered(["messages"]);
  const ordinaryHidden = rendered(["notes"]);
  assert.equal(sensitiveHidden.length, ordinaryHidden.length);
  assert.ok(!sensitiveHidden.includes("messages"));
  assert.ok(!ordinaryHidden.includes("notes"));
  assert.ok(sensitiveHidden.includes("notes"), "toisen piilotus ei saa vaikuttaa toiseen");
  assert.ok(ordinaryHidden.includes("messages"), "toisen piilotus ei saa vaikuttaa toiseen");
  console.log("ok  piilotus kohtelee arkaluontoista ja tavallista paneelia identtisesti");
}

{
  // 3. isPanelHidden on ainoa paikka jossa piilotus päätetään, ja se katsoo
  //    vain listaa. Sama tulos riippumatta siitä monesko paneeli on kyseessä.
  assert.equal(isPanelHidden("schedule", ["schedule"]), true);
  assert.equal(isPanelHidden("schedule", ["messages"]), false);
  assert.equal(isPanelHidden("schedule", "schedule" as unknown as string[]), false, "merkkijono ei ole lista");
  console.log("ok  isPanelHidden katsoo vain listaa");
}

// --- Oletusasettelu kestää uuden paneelin ---
{
  const ids = [...PANEL_IDS];
  assert.ok(ids.includes("news"), "uutispaneelin on oltava PANEL_IDS:ssä");
  assert.equal(Object.keys(defaultPanelLayout).length, ids.length, "oletusasettelussa on oltava jokainen paneeli");

  let area = 0;
  for (const id of ids) {
    const p = defaultPanelLayout[id];
    assert.ok(p, `${id} puuttuu oletusasettelusta`);
    assert.ok(p.colSpan >= MIN_PANEL_SPAN && p.rowSpan >= MIN_PANEL_SPAN, `${id} on oletuksena liian pieni`);
    assert.ok(p.col >= 1 && p.col + p.colSpan - 1 <= GRID_COLUMNS, `${id} ylittää sarakkeet`);
    assert.ok(p.row >= 1 && p.row + p.rowSpan - 1 <= GRID_ROWS, `${id} ylittää rivit`);
    if (!defaultHiddenPanels.includes(id)) area += p.colSpan * p.rowSpan;
  }
  assert.equal(area, GRID_COLUMNS * GRID_ROWS, "oletusasettelun on täytettävä ruudukko tasan, ilman aukkoja");

  // Päällekkäisyys solu kerrallaan — pinta-alan summa yksinään ei sulkisi sitä pois.
  const owner = new Map<string, PanelId>();
  for (const id of ids) {
    if (defaultHiddenPanels.includes(id)) continue;
    const p = defaultPanelLayout[id];
    for (let c = p.col; c < p.col + p.colSpan; c++) {
      for (let r = p.row; r < p.row + p.rowSpan; r++) {
        const key = `${c},${r}`;
        assert.equal(owner.get(key), undefined, `solu ${key}: ${id} ja ${owner.get(key)} ovat päällekkäin`);
        owner.set(key, id);
      }
    }
  }
  console.log("ok  oletusasettelu täyttää 6x8-ruudukon tasan myös uutispaneelin kanssa");
}

// --- Päällekkäisyys: päivityksen tuoma uusi paneeli käyttäjän omaan asetteluun ---
//
// Palvelin täydentää uuden paneelin käyttäjän vanhaan asetteluun sen
// OLETUSPAIKALLE ja kytkee sen pois päältä (server/src/core/settings.ts,
// `adoptNewPanels`). Käyttäjän omassa asettelussa se paikka voi olla jo
// varattu, jolloin kytkimen painaminen laittaa kaksi korttia samoihin
// ruutuihin. Tämä testi lukitsee sen, että tilanne huomataan — ei sitä että
// se estettäisiin.
{
  // Aito tapaus tuotantonäytöltä: kalenteri on venytetty sarakkeille 3-4,
  // riveille 4-8, ja uutisten oletuspaikka (3,7) 2x2 jää kokonaan sen sisään.
  const kayttajan: PanelLayout = taydenna({
    schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 4 },
    messages: { col: 1, row: 5, colSpan: 2, rowSpan: 4 },
    weather: { col: 3, row: 1, colSpan: 2, rowSpan: 3 },
    electricity: { col: 5, row: 1, colSpan: 2, rowSpan: 4 },
    calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 5 },
    notes: { col: 5, row: 5, colSpan: 2, rowSpan: 4 },
    news: { ...defaultPanelLayout.news },
  });

  assert.deepEqual(
    overlappingVisiblePanels(kayttajan, [...defaultHiddenPanels, "news"]),
    [],
    "pois kytketty paneeli ei voi mennä minkään päälle — se ei ole ruudulla",
  );
  assert.deepEqual(
    overlappingVisiblePanels(kayttajan, [...defaultHiddenPanels]),
    ["calendar", "news"],
    "päälle kytkettynä uutiset ja kalenteri ovat samoissa ruuduissa",
  );
  console.log("ok  päivityksen tuoma paneeli tunnistetaan päällekkäiseksi vasta kun se kytketään päälle");
}

{
  // Vanhojen seitsemän paneelin oletusasettelu on kunnossa niiden näkyvyyskombinaatioilla — muuten
  // varoitus vilkkuisi tavallisessa käytössä eikä sitä uskoisi silloin kun
  // siihen on aihetta.
  const combos: PanelId[][] = [[...defaultHiddenPanels], [...defaultHiddenPanels, "news"], [...defaultHiddenPanels, "calendar"], [...defaultHiddenPanels, "schedule", "messages"], [...PANEL_IDS]];
  for (const hidden of combos) {
    assert.deepEqual(
      overlappingVisiblePanels(defaultPanelLayout, hidden),
      [],
      `oletusasettelu ei saa olla päällekkäinen (piilossa: ${hidden.join(",") || "ei mitään"})`,
    );
  }
  console.log("ok  oletusasettelu ei tuota päällekkäisyysvaroitusta vanhojen paneelien näkyvyysvalinnoilla");
}

// --- Piilotettu paneeli ei varaa ruutuja ---
//
// Tämä on koko kytkimen hyöty: pois kytkeminen VAPAUTTAA tilaa, jotta
// naapurin voi kasvattaa sen paikalle. Jos piilotettu paneeli varaisi yhä
// ruutunsa, oletusasettelussa (48/48 solua varattuna) piilottaminen ei
// vapauttaisi yhtään mitään eikä kytkimestä olisi muuta hyötyä kuin tyhjä
// laatikko ruudulla.
{
  // Sähkö on oletuksena (5,4) 2x3. Piilotettuna sen ruudut ovat vapaita, ja
  // 2x3-kokoinen kortti mahtuu niihin. Haettavana on `news`, jotta haun
  // oma poissulku (paneeli ei ole itselleen tiellä) ei sekoitu tuloksen
  // tulkintaan.
  const spot = findFreeSpot(defaultPanelLayout, [...defaultHiddenPanels, "electricity"], "news", 2, 3);
  assert.deepEqual(spot, { col: 5, row: 4, colSpan: 2, rowSpan: 3 }, "piilotetun paneelin ruudut ovat vapaita");
  assert.equal(
    findFreeSpot(defaultPanelLayout, [...defaultHiddenPanels], "news", 2, 3),
    null,
    "täydessä ruudukossa ei ole 2x3:n kokoista vapaata paikkaa kun kaikki näkyvät",
  );
  console.log("ok  piilotetun paneelin ruudut vapautuvat muiden käyttöön");
}

{
  // Haku käy ruudukon ylhäältä alas ja vasemmalta oikealle, joten tulos on
  // sama joka kerta — sattumanvarainen paikka olisi se mitä käyttäjä ei voi
  // ennakoida.
  const kaksiVapaata: PanelLayout = {
    ...defaultPanelLayout,
    schedule: { col: 1, row: 1, colSpan: 4, rowSpan: 3 },
  };
  const first = findFreeSpot(kaksiVapaata, [...defaultHiddenPanels, "schedule", "calendar", "news"], "notes", 2, 2);
  const second = findFreeSpot(kaksiVapaata, [...defaultHiddenPanels, "schedule", "calendar", "news"], "notes", 2, 2);
  assert.deepEqual(first, second, "haun on oltava toisteinen");
  assert.deepEqual(first, { col: 1, row: 1, colSpan: 2, rowSpan: 2 }, "ensimmäinen vapaa ylhäältä vasemmalta");
  console.log("ok  vapaan paikan haku on toisteinen ja alkaa vasemmalta ylhäältä");
}

// --- Paneelin ottaminen takaisin käyttöön ---
{
  // 1. Parkkipaikka vapaa: paneeli palaa TÄSMÄLLEEN siihen. Juuri tämä tekee
  //    kytkimestä peruutettavan — pois ja takaisin ei muuta mitään.
  const outcome = enablePanel(defaultPanelLayout, [...defaultHiddenPanels, "news"], "news");
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.relocated, false, "vapaalle parkkipaikalle palaava paneeli ei saa siirtyä");
  assert.deepEqual(outcome.layout.news, defaultPanelLayout.news, "sijoitus säilyy bitilleen");
  assert.deepEqual(outcome.hiddenPanels, [...defaultHiddenPanels]);
  assert.equal(outcome.layout, defaultPanelLayout, "asettelua ei saa kopioida turhaan kun mikään ei muutu");
  console.log("ok  vapaalle paikalle palaava paneeli palaa täsmälleen entiseen kohtaansa");
}

{
  // 2. Parkkipaikka varattu mutta tilaa on muualla: paneeli sijoitetaan
  //    sinne, eikä yhtäkään NAAPURIA siirretä.
  const layout: PanelLayout = taydenna({
    schedule: { col: 1, row: 1, colSpan: 4, rowSpan: 3 },
    messages: { col: 1, row: 4, colSpan: 4, rowSpan: 3 },
    weather: { col: 5, row: 1, colSpan: 2, rowSpan: 3 },
    electricity: { col: 5, row: 4, colSpan: 2, rowSpan: 3 },
    // Kalenteri on venytetty uutisten oletuspaikan päälle, kuten oikealla näytöllä.
    calendar: { col: 1, row: 7, colSpan: 4, rowSpan: 2 },
    notes: { col: 5, row: 7, colSpan: 2, rowSpan: 2 },
    news: { ...defaultPanelLayout.news },
  });
  // Muistilista piilossa → sen 2x2 (5,7) on vapaa.
  const outcome = enablePanel(layout, [...defaultHiddenPanels, "news", "notes"], "news");
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.relocated, true);
  assert.deepEqual(outcome.layout.news, { col: 5, row: 7, colSpan: 2, rowSpan: 2 });
  assert.deepEqual(outcome.hiddenPanels, ["notes", ...defaultHiddenPanels], "vain käyttöön otettu paneeli poistuu listalta");
  for (const id of PANEL_IDS) {
    if (id === "news") continue;
    assert.deepEqual(outcome.layout[id], layout[id], `${id}: naapuria ei saa siirtää`);
  }
  assert.deepEqual(outcome.layout.news, { ...outcome.layout.news }, "koko säilyy");
  assert.equal(outcome.layout.news.colSpan, layout.news.colSpan, "kokoa ei saa pienentää mahtumisen vuoksi");
  assert.equal(outcome.layout.news.rowSpan, layout.news.rowSpan, "kokoa ei saa pienentää mahtumisen vuoksi");
  console.log("ok  varatulta parkkipaikalta paneeli siirtyy vapaaseen kohtaan, naapureihin koskematta");
}

{
  // 3. Mikään ei mahdu: EI oteta käyttöön. Tämä on se oikea tilanne johon
  //    päivitys törmää — käyttäjän asettelu täyttää ruudukon 48/48.
  const taysi: PanelLayout = taydenna({
    schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 4 },
    messages: { col: 1, row: 5, colSpan: 2, rowSpan: 4 },
    weather: { col: 3, row: 1, colSpan: 2, rowSpan: 3 },
    electricity: { col: 5, row: 1, colSpan: 2, rowSpan: 4 },
    calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 5 },
    notes: { col: 5, row: 5, colSpan: 2, rowSpan: 4 },
    news: { ...defaultPanelLayout.news },
  });
  const outcome = enablePanel(taysi, [...defaultHiddenPanels, "news"], "news");
  assert.equal(outcome.rejected, "no-room");
  assert.deepEqual(outcome.hiddenPanels, ["news", ...defaultHiddenPanels], "hylätty käyttöönotto ei saa poistaa paneelia listalta");
  assert.equal(outcome.layout, taysi, "hylätty käyttöönotto ei saa muuttaa asettelua");
  assert.deepEqual(
    overlappingVisiblePanels(outcome.layout, outcome.hiddenPanels),
    [],
    "hylkäyksen jälkeen ruudukossa ei saa olla päällekkäisyyttä",
  );
  console.log("ok  täydessä ruudukossa käyttöönotto hylätään eikä mitään muuteta");
}

{
  // Kun käyttäjä tekee tilaa, sama kytkin toimii — eikä vaadi muuta kuin
  // yhden kortin kutistamisen.
  const taysi: PanelLayout = taydenna({
    schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 4 },
    messages: { col: 1, row: 5, colSpan: 2, rowSpan: 4 },
    weather: { col: 3, row: 1, colSpan: 2, rowSpan: 3 },
    electricity: { col: 5, row: 1, colSpan: 2, rowSpan: 4 },
    calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 3 },
    notes: { col: 5, row: 5, colSpan: 2, rowSpan: 4 },
    news: { ...defaultPanelLayout.news },
  });
  const outcome = enablePanel(taysi, [...defaultHiddenPanels, "news"], "news");
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.relocated, false, "kalenterin kutistaminen vapautti juuri parkkipaikan");
  assert.deepEqual(outcome.layout.news, { col: 3, row: 7, colSpan: 2, rowSpan: 2 });
  assert.deepEqual(overlappingVisiblePanels(outcome.layout, outcome.hiddenPanels), []);
  console.log("ok  tilan tekeminen riittää: sama kytkin onnistuu eikä paneeli siirry");
}

{
  // Käyttöönotto ei saa KOSKAAN jättää näkyviä paneeleja päällekkäin —
  // palvelin hylkäisi sellaisen tallennuksen 400:lla.
  const layout: PanelLayout = {
    ...defaultPanelLayout,
    calendar: { col: 1, row: 7, colSpan: 4, rowSpan: 2 },
  };
  for (const hidden of [[...defaultHiddenPanels, "news"], [...defaultHiddenPanels, "news", "notes"], [...defaultHiddenPanels, "news", "notes", "weather"]] as PanelId[][]) {
    const outcome = enablePanel(layout, hidden, "news");
    assert.deepEqual(
      overlappingVisiblePanels(outcome.layout, outcome.hiddenPanels),
      [],
      `käyttöönotto jätti päällekkäisyyden (piilossa: ${hidden.join(",")})`,
    );
  }
  console.log("ok  käyttöönotto ei jätä näkyviä paneeleja päällekkäin millään lähtötilanteella");
}

{
  // Jo näkyvän paneelin "käyttöönotto" ei tee mitään.
  const outcome = enablePanel(defaultPanelLayout, [...defaultHiddenPanels], "news");
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.relocated, false);
  assert.equal(outcome.layout, defaultPanelLayout);
  console.log("ok  jo näkyvän paneelin käyttöönotto ei muuta mitään");
}

console.log("\nkaikki paneelien näkyvyystestit läpi");
