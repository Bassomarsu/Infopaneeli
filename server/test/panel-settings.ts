/**
 * Paneelien oletusasettelu ja `hiddenPanels`-asetus.
 *
 * Oletusasettelun kattavuus on tässä siksi, että `parsePanelLayout` EI sitä
 * tarkista: se hyväksyy kaksi paneelia päällekkäin, kunhan kumpikin mahtuu
 * ruudukkoon erikseen. Uuden paneelin lisääminen täyteen ruudukkoon on
 * täsmälleen se muutos, jossa päällekkäisyys syntyy huomaamatta.
 *
 * Aja:  npm run test:panels --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  MIN_PANEL_SPAN,
  PANEL_IDS,
  SettingsValidationError,
  defaultPanelLayout,
  getSettings,
  isPanelId,
  parseHiddenPanels,
  parsePanelLayout,
  updateSettings,
  type PanelId,
  type PanelLayout,
} from "../src/core/settings.ts";
import { getSetting, setSetting } from "../src/core/store.ts";

function testEveryPanelHasADefaultPlacement(): void {
  for (const id of PANEL_IDS) {
    assert.ok(defaultPanelLayout[id], `oletusasettelusta puuttuu paneeli ${id}`);
  }
  assert.equal(
    Object.keys(defaultPanelLayout).length,
    PANEL_IDS.length,
    "oletusasettelussa on paneeli jota PANEL_IDS ei tunne",
  );
  assert.equal(PANEL_IDS.includes("news" as PanelId), true, "news puuttuu PANEL_IDS-listalta");
  console.log("ok  jokaisella tunnetulla paneelilla on oletuspaikka");
}

/**
 * Solu solulta: jokainen ruudukon solu kuuluu tasan yhdelle paneelille.
 * Kaksi laskentaa samasta asiasta (päällekkäisyys ja aukot) yhdellä
 * läpikäynnillä, jotta virheilmoitus kertoo kumpi vika on kyseessä ja missä.
 */
function testDefaultLayoutTilesTheGridExactly(): void {
  const owner = new Map<string, PanelId>();

  for (const id of PANEL_IDS) {
    const p = defaultPanelLayout[id];
    assert.ok(p.colSpan >= MIN_PANEL_SPAN && p.rowSpan >= MIN_PANEL_SPAN, `${id}: alle vähimmäiskoon`);
    assert.ok(p.col >= 1 && p.col + p.colSpan - 1 <= GRID_COLUMNS, `${id}: ei mahdu leveyssuunnassa`);
    assert.ok(p.row >= 1 && p.row + p.rowSpan - 1 <= GRID_ROWS, `${id}: ei mahdu korkeussuunnassa`);

    for (let col = p.col; col < p.col + p.colSpan; col++) {
      for (let row = p.row; row < p.row + p.rowSpan; row++) {
        const key = `${col},${row}`;
        const taken = owner.get(key);
        assert.equal(taken, undefined, `solu ${key}: ${id} on paneelin ${taken} päällä`);
        owner.set(key, id);
      }
    }
  }

  const empty: string[] = [];
  for (let col = 1; col <= GRID_COLUMNS; col++) {
    for (let row = 1; row <= GRID_ROWS; row++) {
      if (!owner.has(`${col},${row}`)) empty.push(`${col},${row}`);
    }
  }
  assert.deepEqual(empty, [], "oletusasetteluun jäi tyhjiä soluja");
  assert.equal(owner.size, GRID_COLUMNS * GRID_ROWS);
  console.log(`ok  oletusasettelu kattaa ruudukon ${GRID_COLUMNS}×${GRID_ROWS} tasan kerran`);
}

function testParsePanelLayoutRequiresNews(): void {
  const withoutNews: Record<string, unknown> = {};
  for (const id of PANEL_IDS) {
    if (id !== "news") withoutNews[id] = defaultPanelLayout[id];
  }
  assert.throws(
    () => parsePanelLayout(withoutNews),
    (err: unknown) => err instanceof SettingsValidationError && /news/.test(err.message),
    "vajaa asettelu pudottaisi uutiskortin hiljaa pois",
  );
  assert.deepEqual(parsePanelLayout(defaultPanelLayout), defaultPanelLayout);
  console.log("ok  parsePanelLayout vaatii myös news-paneelin");
}

function testIsPanelId(): void {
  assert.equal(isPanelId("news"), true);
  assert.equal(isPanelId("weather"), true);
  assert.equal(isPanelId("uutiset"), false);
  assert.equal(isPanelId(""), false);
  assert.equal(isPanelId(null), false);
  assert.equal(isPanelId(3), false);
  console.log("ok  isPanelId tunnistaa vain tunnetut paneelit");
}

function testHiddenPanelsAccepted(): void {
  assert.deepEqual(parseHiddenPanels([]), []);
  assert.deepEqual(parseHiddenPanels(["news"]), ["news"]);
  assert.deepEqual(parseHiddenPanels(["electricity", "news"]), ["electricity", "news"]);
  assert.deepEqual(parseHiddenPanels([...PANEL_IDS]), [...PANEL_IDS], "kaikkien piilottaminen on sallittua");
  console.log("ok  kelvollinen hiddenPanels-lista hyväksytään");
}

function testHiddenPanelsDeduplicates(): void {
  assert.deepEqual(
    parseHiddenPanels(["news", "weather", "news"]),
    ["news", "weather"],
    "duplikaatti siistitään, järjestys ensimmäisen esiintymän mukaan",
  );
  console.log("ok  duplikaatit siistitään eikä hylätä");
}

function testHiddenPanelsRejectsBadInput(): void {
  const cases: Array<[string, unknown, RegExp]> = [
    ["ei ole lista", { news: true }, /hiddenPanels/],
    ["null ei ole lista", null, /hiddenPanels/],
    ["merkkijono ei ole lista", "news", /hiddenPanels/],
    ["tuntematon tunniste", ["uutiset"], /hiddenPanels\[0\]/],
    ["tuntematon toisena", ["news", "saa"], /hiddenPanels\[1\]/],
    ["ei-merkkijono", ["news", 7], /hiddenPanels\[1\]/],
    ["null alkiona", [null], /hiddenPanels\[0\]/],
  ];
  for (const [why, value, pattern] of cases) {
    assert.throws(
      () => parseHiddenPanels(value),
      (err: unknown) => err instanceof SettingsValidationError && pattern.test(err.message),
      `${why}: virheviestin pitää nimetä kenttä`,
    );
  }
  console.log("ok  kelvoton hiddenPanels hylätään kentän nimeävällä viestillä");
}

function testDefaultIsEmpty(): void {
  setSetting("settings", {});
  assert.deepEqual(getSettings().hiddenPanels, [], "puuttuva avain = kaikki näkyvät");
  console.log("ok  oletuksena mikään paneeli ei ole piilossa");
}

function testRoundTripThroughSettings(): void {
  setSetting("settings", {});
  const saved = updateSettings({ hiddenPanels: ["news", "electricity"] });
  assert.deepEqual(saved.hiddenPanels, ["news", "electricity"]);
  assert.deepEqual(getSettings().hiddenPanels, ["news", "electricity"], "asetus säilyy levyllä");

  // Muun asetuksen päivitys ei saa nollata listaa.
  updateSettings({ hideNextAlarm: true });
  assert.deepEqual(getSettings().hiddenPanels, ["news", "electricity"]);

  updateSettings({ hiddenPanels: [] });
  assert.deepEqual(getSettings().hiddenPanels, []);
  console.log("ok  hiddenPanels kulkee tallennuksen läpi eikä muu päivitys nollaa sitä");
}

/**
 * Selainpuoli lähettää hiddenPanelsia kahdesta paikasta, kummastakin
 * OSITTAISENA PUT /api/settings -rungossa: asetuspaneelista koko
 * settings-olion mukana, ja asettelun muokkauksen "Valmis"-napista
 * pelkkänä parina { panelLayout, hiddenPanels }. Kumpikin kenttä on oma
 * `in input` -lohkonsa updateSettingsissa, joten ne eivät voi kaataa
 * toisiaan — mutta juuri se on väite jonka näiden kahden käyttökohdan
 * pitää testata eikä olettaa.
 */
function testLayoutEditorPartialUpdate(): void {
  setSetting("settings", {});
  updateSettings({ hiddenPanels: ["weather"] });

  const saved = updateSettings({ panelLayout: defaultPanelLayout, hiddenPanels: ["news"] });
  assert.deepEqual(saved.hiddenPanels, ["news"]);
  assert.deepEqual(saved.panelLayout, defaultPanelLayout, "asettelu ja piilotus tallentuvat samasta pyynnöstä");

  // "Palauta oletusasettelu" -nappi.
  const reset = updateSettings({ panelLayout: null, hiddenPanels: [] });
  assert.equal(reset.panelLayout, null);
  assert.deepEqual(reset.hiddenPanels, []);
  assert.deepEqual(getSettings().hiddenPanels, []);
  console.log("ok  asettelun muokkaimen osittainen PUT vie sekä asettelun että piilotukset");
}

/**
 * Päivityspolku. Tallennettu asettelu on tiimivetäjän todentama oikea
 * käyttäjän asettelu, joka täyttää ruudukon kokonaan ilman news-paneelia —
 * eli vapaata paikkaa ei ole missään.
 */
const STORED_LAYOUT_BEFORE_NEWS: Record<string, unknown> = {
  schedule: { col: 1, row: 1, colSpan: 2, rowSpan: 4 },
  weather: { col: 3, row: 1, colSpan: 2, rowSpan: 3 },
  electricity: { col: 5, row: 1, colSpan: 2, rowSpan: 4 },
  messages: { col: 1, row: 5, colSpan: 2, rowSpan: 4 },
  calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 5 },
  notes: { col: 5, row: 5, colSpan: 2, rowSpan: 4 },
};

function testNewPanelIsHiddenNotPlaced(): void {
  setSetting("settings", { panelLayout: STORED_LAYOUT_BEFORE_NEWS });
  const settings = getSettings();

  assert.deepEqual(settings.hiddenPanels, ["news"], "uusi paneeli menee piiloon");

  // Käyttäjän kuusi korttia säilyttävät TÄSMÄLLEEN paikkansa.
  for (const [id, placement] of Object.entries(STORED_LAYOUT_BEFORE_NEWS)) {
    assert.deepEqual(settings.panelLayout?.[id as PanelId], placement, `${id} siirtyi — päivitys muutti asettelua`);
  }
  console.log("ok  uusi paneeli piilotetaan eikä käyttäjän asettelua muuteta");
}

function testUpgradedSettingsSurviveTheSettingsPanelRoundTrip(): void {
  // Asetuspaneeli levittää koko settings-olion PUT:iin, panelLayout mukaan
  // lukien. Jos getSettings palauttaisi vajaan asettelun, tämä olisi 400 ja
  // päivitetyn asennuksen asetuspaneeli olisi käyttökelvoton.
  setSetting("settings", { panelLayout: STORED_LAYOUT_BEFORE_NEWS });
  const echoed = getSettings();
  const saved = updateSettings({ ...echoed });
  assert.deepEqual(saved.hiddenPanels, ["news"]);
  assert.deepEqual(saved.panelLayout?.schedule, STORED_LAYOUT_BEFORE_NEWS["schedule"]);
  console.log("ok  päivitetty asennus selviää asetuspaneelin koko-olion PUT:ista");
}

function testMigrationDoesNotRepeatAfterUserEnablesPanel(): void {
  setSetting("settings", { panelLayout: STORED_LAYOUT_BEFORE_NEWS });
  assert.deepEqual(getSettings().hiddenPanels, ["news"]);

  // Käyttäjä ottaa uutiset käyttöön. Hänen on TEHTÄVÄ SILLE TILAA: parkkipaikka
  // (3,7) on kalenterin päällä, ja näkyvien kesken päällekkäisyys hylätään.
  const parked = { ...(getSettings().panelLayout as PanelLayout) };
  assert.throws(
    () => updateSettings({ panelLayout: parked, hiddenPanels: [] }),
    (err: unknown) => err instanceof SettingsValidationError && /päällekkäin/.test(err.message),
    "parkkipaikaltaan suoraan näkyviin otettu paneeli on kalenterin päällä",
  );

  // Kalenteri kutistuu viidestä rivistä kolmeen, uutiset saa vapautuneet.
  const layout: PanelLayout = {
    ...parked,
    calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 3 },
    news: { col: 3, row: 7, colSpan: 2, rowSpan: 2 },
  };
  updateSettings({ panelLayout: layout, hiddenPanels: [] });

  assert.deepEqual(getSettings().hiddenPanels, [], "migraatio ei saa piilottaa korttia uudelleen");
  assert.deepEqual(getSettings().hiddenPanels, [], "eikä seuraavallakaan lukukerralla");

  // Käyttäjä piilottaa sen myöhemmin itse — se on hänen valintansa ja säilyy.
  updateSettings({ hiddenPanels: ["news"] });
  assert.deepEqual(getSettings().hiddenPanels, ["news"]);
  console.log("ok  migraatio ei palaudu sen jälkeen kun käyttäjä on ottanut paneelin käyttöön");
}

function testFreshInstallIsUntouched(): void {
  setSetting("settings", {});
  const settings = getSettings();
  assert.equal(settings.panelLayout, null, "uudella asennuksella ei ole tallennettua asettelua");
  assert.deepEqual(settings.hiddenPanels, [], "uutiset näkyvät uudessa asennuksessa normaalisti");
  console.log("ok  uutta asennusta migraatio ei koske");
}

function testBrokenPlacementIsRepairedButNotHidden(): void {
  // Rikkinäinen sijoittelu on käyttäjän OLEMASSA OLEVA kortti. Se
  // täydennetään jotta round-trip ei kaadu, mutta sitä ei kytketä pois.
  setSetting("settings", {
    panelLayout: { ...STORED_LAYOUT_BEFORE_NEWS, notes: { col: "x", row: null } },
  });
  const settings = getSettings();
  assert.deepEqual(settings.hiddenPanels, ["news"], "vain aidosti uusi paneeli piilotetaan");

  // Korjattu sijoittelu on kelvollinen ja käyttökelpoinen — ei välttämättä
  // oletuspaikka, koska vapaa alue (tässä notesin oma vanha paikka) on
  // parempi kuin oletus. Testataan ominaisuus eikä tiettyä lukuparia.
  const notes = settings.panelLayout?.notes;
  assert.ok(notes, "notesille on sijoittelu");
  assert.ok(notes.colSpan >= MIN_PANEL_SPAN && notes.rowSpan >= MIN_PANEL_SPAN);
  assert.ok(notes.col + notes.colSpan - 1 <= GRID_COLUMNS && notes.row + notes.rowSpan - 1 <= GRID_ROWS);
  for (const id of ["schedule", "messages", "weather", "calendar", "electricity"] as const) {
    const other = settings.panelLayout?.[id];
    assert.ok(other, `${id}`);
    const overlap =
      notes.col <= other.col + other.colSpan - 1 &&
      notes.col + notes.colSpan - 1 >= other.col &&
      notes.row <= other.row + other.rowSpan - 1 &&
      notes.row + notes.rowSpan - 1 >= other.row;
    assert.equal(overlap, false, `korjattu notes meni paneelin ${id} päälle`);
  }
  console.log("ok  rikkinäinen sijoittelu korjataan vapaaseen tilaan mutta korttia ei kytketä pois");
}

/**
 * Uusi paneeli etsii VAPAAN alueen käyttäjän omasta asettelusta, jos
 * sellainen on. Ero näkyy vain asettelussa johon on jätetty tilaa; täydessä
 * ruudukossa tulos on oletuspaikka (ks. seuraava testi).
 */
function testNewPanelPrefersFreeSpace(): void {
  // Kalenteri kutistettu 5 rivistä 3:een -> sarakkeet 3-4, rivit 7-8 vapaina.
  setSetting("settings", {
    panelLayout: { ...STORED_LAYOUT_BEFORE_NEWS, calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 3 } },
  });
  const settings = getSettings();
  assert.deepEqual(settings.hiddenPanels, ["news"], "uusi paneeli on yhä piilossa");
  assert.deepEqual(
    settings.panelLayout?.news,
    { col: 3, row: 7, colSpan: 2, rowSpan: 2 },
    "uutiset löytää vapaan alueen eikä jää päällekkäiseksi",
  );

  // Ja käyttöön otettuna se kelpaa suoraan, ilman että mitään tarvitsee siirtää.
  const enabled = updateSettings({ panelLayout: settings.panelLayout, hiddenPanels: [] });
  assert.deepEqual(enabled.hiddenPanels, []);
  console.log("ok  uusi paneeli sijoittuu vapaaseen tilaan kun sitä on");
}

function testFullGridFallsBackToDefaultSpot(): void {
  // Tiimivetäjän todentama oikea asettelu: 48/48 solua varattuna.
  setSetting("settings", { panelLayout: STORED_LAYOUT_BEFORE_NEWS });
  const settings = getSettings();
  assert.deepEqual(
    settings.panelLayout?.news,
    defaultPanelLayout.news,
    "täydessä ruudukossa vapaata ei ole, joten oletuspaikka on varasija",
  );
  // Se on kalenterin päällä — sallittua vain koska paneeli on piilossa.
  assert.deepEqual(settings.hiddenPanels, ["news"]);
  console.log("ok  täysi ruudukko putoaa oletuspaikkaan, joka saa olla päällekkäinen");
}

/** Sijoitus ei saa hyppiä lukukerrasta toiseen: ks. findFreeSpot. */
function testFreeSpotIsDeterministic(): void {
  setSetting("settings", {
    panelLayout: { ...STORED_LAYOUT_BEFORE_NEWS, calendar: { col: 3, row: 4, colSpan: 2, rowSpan: 3 } },
  });
  const first = getSettings().panelLayout?.news;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(getSettings().panelLayout?.news, first, "sijoitus vaihtui lukukertojen välillä");
  }
  console.log("ok  vapaan alueen valinta on deterministinen");
}

function testMigrationIsIdempotentAndWritesNothing(): void {
  setSetting("settings", { panelLayout: STORED_LAYOUT_BEFORE_NEWS });
  const first = getSettings();
  const second = getSettings();
  assert.deepEqual(second, first, "toistuva luku antaa saman tuloksen");
  assert.deepEqual(second.hiddenPanels, ["news"], "lista ei kasva joka lukukerralla");

  // Levylle ei ole kirjoitettu mitään: tallennettu muoto on yhä alkuperäinen,
  // joten keskeytys ei voi jättää puolittaista tilaa.
  const raw = getSetting<Record<string, unknown>>("settings");
  assert.equal("hiddenPanels" in (raw ?? {}), false, "getSettings ei kirjoita normalisointia takaisin");
  assert.equal(Object.keys((raw?.["panelLayout"] ?? {}) as object).length, 6, "tallennettu asettelu on koskematon");
  console.log("ok  migraatio on idempotentti eikä kirjoita levylle");
}

/**
 * Päällekkäisyys hylätään NÄKYVIEN paneelien kesken. Ennen tätä `PUT
 * /api/settings` hyväksyi kaikki seitsemän paneelia samaan soluun ja
 * palautti 200 — jokainen mahtui ruudukkoon erikseen, ja vain sitä
 * tarkistettiin.
 */
function testVisibleOverlapIsRejected(): void {
  const sameCell = {} as Record<string, unknown>;
  for (const id of PANEL_IDS) sameCell[id] = { col: 1, row: 1, colSpan: 2, rowSpan: 2 };
  assert.throws(
    () => parsePanelLayout(sameCell),
    (err: unknown) => err instanceof SettingsValidationError && /päällekkäin/.test(err.message),
    "kaikki seitsemän samassa solussa ei saa mennä läpi",
  );

  // Kahden paneelin osittainenkin limitys riittää.
  const partial = { ...defaultPanelLayout, notes: { col: 4, row: 7, colSpan: 2, rowSpan: 2 } };
  assert.throws(
    () => parsePanelLayout(partial),
    (err: unknown) => err instanceof SettingsValidationError && /news ja notes|notes ja news/.test(err.message),
    "yhden solun limitys riittää hylkäykseen",
  );

  // Oletusasettelu ei limity lainkaan.
  assert.deepEqual(parsePanelLayout(defaultPanelLayout), defaultPanelLayout);
  console.log("ok  näkyvien paneelien päällekkäisyys hylätään");
}

/**
 * …mutta piilotetun paneelin sijoitus on PARKKIPAIKKA eikä piirtopaikka.
 * Tämä ei ole hienosäätöä: päivityspolku parkkeeraa uuden paneelin
 * oletuspaikkaansa, joka on väistämättä jonkin päällä kun käyttäjän asettelu
 * on täynnä. Jos tämä hylättäisiin, päivitetyn asennuksen asetuspaneeli
 * palauttaisi 400:n heti ensimmäisestä tallennuksesta.
 */
function testHiddenPanelMayOverlap(): void {
  const parked = { ...defaultPanelLayout, news: { col: 1, row: 7, colSpan: 2, rowSpan: 2 } }; // kalenterin päällä
  assert.throws(
    () => parsePanelLayout(parked, []),
    SettingsValidationError,
    "näkyvänä sama sijoitus hylätään",
  );
  assert.deepEqual(
    parsePanelLayout(parked, ["news"]),
    parked,
    "piilotettuna sama sijoitus hyväksytään — sitä ei renderöidä",
  );
  console.log("ok  piilotettu paneeli saa olla toisen päällä, näkyvä ei");
}

function testHiddenPanelsIsParsedBeforeLayout(): void {
  // Sama pyyntö muuttaa molempia: muokkaustilan "Valmis" lähettää ne parina.
  // Jos asettelu validoitaisiin VANHAA hiddenPanelsia vasten, kortin
  // piilottaminen ja päällekkäiseksi siirtäminen samalla kertaa hylättäisiin.
  setSetting("settings", {});
  const parked = { ...defaultPanelLayout, news: { col: 1, row: 7, colSpan: 2, rowSpan: 2 } };
  const saved = updateSettings({ panelLayout: parked, hiddenPanels: ["news"] });
  assert.deepEqual(saved.hiddenPanels, ["news"]);
  assert.deepEqual(saved.panelLayout?.news, parked.news);

  // Ja päinvastoin: saman pyynnön sisällä näkyväksi otettu ei saa limittyä.
  assert.throws(
    () => updateSettings({ panelLayout: parked, hiddenPanels: [] }),
    (err: unknown) => err instanceof SettingsValidationError && /päällekkäin/.test(err.message),
  );
  setSetting("settings", {});
  console.log("ok  hiddenPanels luetaan ennen asettelua samassa pyynnössä");
}

function testStoredGarbageIsNormalisedOnRead(): void {
  // Esim. uudemmalla versiolla tallennettu tunniste, jota tämä versio ei
  // tunne. Asetusten luku ei saa kaatua eikä tunniste vuotaa dashboardiin.
  setSetting("settings", { hiddenPanels: ["news", "tuntematon", "news", 5, null] });
  assert.deepEqual(getSettings().hiddenPanels, ["news"]);

  setSetting("settings", { hiddenPanels: "news" });
  assert.deepEqual(getSettings().hiddenPanels, []);

  setSetting("settings", {});
  console.log("ok  tallennettu roska siivotaan luettaessa ilman poikkeusta");
}

testEveryPanelHasADefaultPlacement();
testDefaultLayoutTilesTheGridExactly();
testParsePanelLayoutRequiresNews();
testIsPanelId();
testHiddenPanelsAccepted();
testHiddenPanelsDeduplicates();
testHiddenPanelsRejectsBadInput();
testDefaultIsEmpty();
testRoundTripThroughSettings();
testLayoutEditorPartialUpdate();
testVisibleOverlapIsRejected();
testHiddenPanelMayOverlap();
testHiddenPanelsIsParsedBeforeLayout();
testNewPanelIsHiddenNotPlaced();
testUpgradedSettingsSurviveTheSettingsPanelRoundTrip();
testMigrationDoesNotRepeatAfterUserEnablesPanel();
testFreshInstallIsUntouched();
testBrokenPlacementIsRepairedButNotHidden();
testNewPanelPrefersFreeSpace();
testFullGridFallsBackToDefaultSpot();
testFreeSpotIsDeterministic();
testMigrationIsIdempotentAndWritesNothing();
testStoredGarbageIsNormalisedOnRead();

console.log("\npaneeliasetukset ok");
