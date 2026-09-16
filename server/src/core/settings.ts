import { isNewsCategory } from "./news-categories.ts";
import { getSetting, setSetting } from "./store.ts";
import { parseClockTime } from "./time.ts";
import { isPostalCode } from "./postal-codes.ts";

/**
 * The wall display is one screen that never scrolls, so panels are placed on a
 * fixed grid rather than flowed. Six columns and eight rows is fine enough to
 * express the sizes anyone actually wants, and coarse enough that a fingertip
 * on a 12" touch screen can hit a cell.
 */
export const GRID_COLUMNS = 6;
export const GRID_ROWS = 8;
/** Generous safety bound for browser CSS grid tracks, independent of viewport capacity. */
/**
 * Kortti leikkaa ylivuotavan sisältönsä piiloon (`overflow: hidden`), eikä
 * otsikko voi kutistua. Liian pieneksi kutistettu paneeli ei siis kaadu vaan
 * katoaa hiljaa — myös otsikkonsa ja "vanhentunut"-merkkinsä osalta, jolloin
 * rikkinäistä lähdettä ei enää huomaa. Alaraja on siksi rajapinnassa asti,
 * eikä pelkkä käyttöliittymän sääntö.
 */
export const MIN_PANEL_SPAN = 2;

export const PANEL_IDS = [
  "schedule",
  "messages",
  "weather",
  "electricity",
  "calendar",
  "notes",
  "news",
  "waste",
  "menu",
  "shopping",
  "nameday",
  "seasonal",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/**
 * Rivien yläraja VIERITYSTILASSA (gridOverflow: "scroll"). Sovitustilassa
 * raja on GRID_ROWS, ja se tarkistetaan erikseen parsePanelLayoutissa.
 *
 * Luku on JOHDETTU eikä valittu: pahin mielekäs asettelu on jokainen paneeli
 * omalla rivillään yhdessä sarakkeessa, kukin kaksinkertaisena
 * vähimmäiskorkeuteensa nähden. Sitä pidemmälle venytetty ruudukko ei ole
 * asettelu vaan vahinko.
 *
 * Aiemmin tässä luki 10 000 ilman perustelua. Katselmoija asetti yhden
 * paneelin riville 300: palvelin hyväksyi sen ja sivun korkeudeksi tuli
 * 37 769 px. Muokkaustilan automaattivieritys (scrollBy 30 px per liike)
 * tekee siitä helpon vahingossa, eikä seinänäyttöä vieritetä takaisin.
 */
export const MAX_LAYOUT_ROWS = PANEL_IDS.length * MIN_PANEL_SPAN * 2;

/** Ks. Settings.gridOverflow. Pidettävä samana kuin web/src/types.ts. */
export type GridOverflow = "fit" | "scroll";

const PANEL_ID_SET: ReadonlySet<string> = new Set(PANEL_IDS);

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && PANEL_ID_SET.has(value);
}

export interface PanelPlacement {
  /** 1-based, inclusive. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export type PanelLayout = Record<PanelId, PanelPlacement>;

/**
 * Reproduces the layout the display shipped with, expressed on the grid.
 *
 * Ruudukko on täynnä: 6 × 8 = 48 solua, ja paneelit kattavat ne ilman aukkoja
 * ja ilman päällekkäisyyttä (tarkistettu testissä, ks. test/panel-settings.ts —
 * `parsePanelLayout` ei huomaisi päällekkäisyyttä). Uudelle paneelille on siis
 * aina otettava tila joltakin toiselta.
 *
 * Uutiskortti sai tilansa KALENTERILTA, joka kapeni neljästä sarakkeesta
 * kahteen. Vaihtoehto olisi ollut madaltaa jotakin — mutta 8 riviä jakautuu
 * vähimmäiskorkeuden (MIN_PANEL_SPAN) takia enintään neljään paneeliin
 * pystysuunnassa, joten uusi rivi olisi pakottanut lukujärjestyksen tai
 * viestit kolmesta rivistä kahteen. Ne ovat näytön kaksi tärkeintä korttia.
 * Leveyden ottaminen kalenterilta koskee vain yhtä korttia eikä lyhennä
 * yhtäkään: alarivistä tulee kolme samankokoista 2 × 2 -korttia
 * (kalenteri | uutiset | muistilista).
 */
/**
 * Paneelit jotka ovat oletuksena piilossa.
 *
 * Kaksitoista paneelia täyttää ruudukon kokonaan pienimmällä sallitulla
 * koolla (6×8 solua, minimi 2×2), joten kaikkien näyttäminen kerralla tekisi
 * jokaisesta kortista liian pienen luettavaksi. Nämä viisi ovat uusimmat, ja
 * käyttäjä ottaa käyttöön ne jotka haluaa.
 *
 * Tämä on myös se joukko johon "Palauta oletusasettelu" palauttaa. Tyhjä
 * lista siinä näyttäisi kaikki kaksitoista päällekkäin — oletusasettelussa
 * piilotettujen sijoitus on parkkipaikka, ei piirtopaikka.
 */
export const defaultHiddenPanels: readonly PanelId[] = ["waste", "menu", "shopping", "nameday", "seasonal"];

export const defaultPanelLayout: PanelLayout = {
  schedule: { col: 1, row: 1, colSpan: 4, rowSpan: 3 },
  messages: { col: 1, row: 4, colSpan: 4, rowSpan: 3 },
  calendar: { col: 1, row: 7, colSpan: 2, rowSpan: 2 },
  news: { col: 3, row: 7, colSpan: 2, rowSpan: 2 },
  weather: { col: 5, row: 1, colSpan: 2, rowSpan: 3 },
  electricity: { col: 5, row: 4, colSpan: 2, rowSpan: 3 },
  notes: { col: 5, row: 7, colSpan: 2, rowSpan: 2 },
  // PARKKIPAIKAT. Nämä viisi ovat oletuksena piilossa (ks.
  // defaultSettings.hiddenPanels), ja piilotetun paneelin sijoitus on
  // parkkipaikka eikä piirtopaikka — sitä ei renderöidä, joten se saa mennä
  // näkyvien päälle. Vaihtoehto olisi ollut kutistaa kaikki kaksitoista
  // paneelia 2x2:een, jolloin uusi asennus näyttäisi aivan toiselta kuin
  // ennen ja lukujärjestys mahtuisi neljään riviin tekstiä.
  waste: { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
  menu: { col: 3, row: 1, colSpan: 2, rowSpan: 2 },
  shopping: { col: 5, row: 1, colSpan: 2, rowSpan: 2 },
  nameday: { col: 1, row: 3, colSpan: 2, rowSpan: 2 },
  seasonal: { col: 3, row: 3, colSpan: 2, rowSpan: 2 },
};

/**
 * Ankkuri jota vasten "minuuttia ennen" lasketaan relative-tilan
 * hälytyksessä: joko päivän ensimmäisen oppitunnin alku tai globaali
 * aamupalan alkuaika (ks. Settings.breakfastTime).
 */
export type AlarmAnchor = "schoolStart" | "breakfast";

/**
 * Yhden viikonpäivän sääntö relative-tilan hälytykselle: viikonpäivä
 * (Date.getDayn numerointi, 0 = sunnuntai … 6 = lauantai — sama kuin
 * web/src/composables/useAlarms.ts:n WEEKDAYS-taulukko) kantaa mukanaan
 * sinä päivänä käytettävän ankkurin. Näin sama hälytys voi maanantaina
 * seurata aamupalaa ja tiistaina koulun alkua ilman erillistä per-päivä
 * enable-lippua ja ankkuria toisistaan irrallaan.
 */
export interface AlarmWeekdayRule {
  weekday: number;
  anchor: AlarmAnchor;
}

/**
 * Kahden toisensa poissulkevan hälytystyypin unioni. Tämä (eikä yhteinen
 * "minutesBefore + anchor + fixedTime" -kenttäjoukko) on tahallinen valinta:
 * kiinteän kellonajan hälytykselle (`fixed`) EI OLE minuutteja, oppilasta
 * eikä ankkuria — se ei seuraa mitään — ja relative-hälytykselle ei ole
 * kellonaikaa. Kelvottomia yhdistelmiä (esim. kiinteä aika + "30 min ennen
 * koulun alkua") ei siis voi edes muodostaa, ei vain validointi torju niitä.
 */
export type AlarmTrigger =
  | {
      mode: "relative";
      /** Minuuttia ennen kunkin päivän ankkuria. */
      minutesBefore: number;
      /** Null = mikä tahansa oppilas — aikaisin tunneista kaikkien lasten kesken. */
      studentNumber: string | null;
      /** Viikonpäivät joina hälytys on aktiivinen; kukin omalla ankkurillaan. Tyhjä lista = ei koskaan. */
      weekdays: AlarmWeekdayRule[];
    }
  | {
      mode: "fixed";
      /** "HH:MM" paikallista aikaa. */
      time: string;
      /** Viikonpäivät joina hälytys on aktiivinen. Tyhjä lista = ei koskaan. */
      weekdays: number[];
    };

/**
 * Koulukello. Pidettävä samana kuin web/src/types.ts:n Alarm.
 *
 * Vanhoja (ennen trigger-kenttää tallennettuja) hälytyksiä ei enää ole
 * tässä muodossa muistissa — ne muunnetaan tähän heti luvun yhteydessä, ks.
 * parseTrigger ja getSettings alla. Levylle tallennettuna ne voivat silti
 * olla vanhaa muotoa kunnes käyttäjä tallentaa jotain, koska getSettings ei
 * kirjoita normalisoitua muotoa takaisin — vain lukee sen läpinäkyvästi.
 */
export interface Alarm {
  id: string;
  label: string;
  trigger: AlarmTrigger;
  enabled: boolean;
  /**
   * Äänen tunniste, ei tiedostopolku. Tämä pitää oven auki myöhemmin
   * lisättävälle omalle äänitiedostolle ilman skeemamuutosta — kenttä ei siis
   * ole suljettu enum, vaikka validointi tänään tunteekin vain sisäänrakennetut
   * äänet (ks. parseAlarms).
   */
  soundId: string;
  /** 0–1. */
  volume: number;
  /** Montako kertaa ääni toistetaan laukeamisen yhteydessä. */
  repeatCount: number;
}

export interface Settings {
  /** Student numbers to show; null means every child found in Wilma. */
  visibleStudents: string[] | null;
  /** Päikyn näytettävät lapset. null = kaikki. Arvot ovat PaikkyChild.id. */
  visiblePaikkyChildren: string[] | null;
  /** `single` shows one child at a time, `split` shows them side by side. */
  scheduleLayout: "single" | "split";
  /** Local time of day when the schedule switches to the next school day. */
  rolloverTime: string;
  /** Hide message bodies on the wall display; sender and unread count remain. */
  hideMessagePreviews: boolean;
  /**
   * Piilota yläpalkin "seuraava hälytys" -banneri. Oletus on `false` eli
   * banneri näkyy — käyttäjä pyysi ominaisuuden ja sille katkaisijan, ei
   * toisin päin.
   *
   * Nimi on `hide...` eikä `show...` tarkoituksella, samoin kuin
   * `hideMessagePreviews` yllä: `getSettings()` levittää tallennetun olion
   * oletusten päälle, ja eksplisiittinen `undefined` menisi oletuksen yli.
   * Falsy-arvo tarkoittaa silloin "ei piiloteta" eli oletus säilyy oikein
   * päin; `show...`-suunnassa sama vahinko kääntäisi oletuksen nurin.
   */
  hideNextAlarm: boolean;
  nightModeStart: string;
  nightModeEnd: string;
  /**
   * Aamupalan alkuaika, "HH:MM" paikallista aikaa. Yksi globaali asetus —
   * ei hälytys- eikä lapsikohtainen (ks. AlarmTrigger.mode "relative"
   * -haaran anchor: "breakfast").
   */
  breakfastTime: string;
  /**
   * Sään sijainti postinumerona, tai null jos sitä ei ole asetettu (jolloin
   * .env päättää, ks. core/weather-location.ts).
   *
   * Tämä on tässä eikä pelkässä .env:ssä siksi, että .env luetaan vain
   * käynnistyksessä: asetuksista vaihdettu postinumero vaihtaa sääkortin
   * paikkakunnan ilman palvelimen uudelleenkäynnistystä.
   */
  weatherPostalCode: string | null;
  menuSchoolIds: string[];
  newsCategories: string[];
  /** Where each panel sits. Null means "never edited", so the default is used. */
  panelLayout: PanelLayout | null;
  /**
   * Paneelit jotka on kytketty pois näytöltä. Tyhjä lista = kaikki näkyvät.
   *
   * Suunta on `hidden` eikä `visible` samasta syystä kuin
   * `hideMessagePreviews` ja `hideNextAlarm` yllä: `getSettings()` levittää
   * tallennetun olion oletusten päälle, ja puuttuva avain tarkoittaa silloin
   * tyhjää listaa eli "kaikki näkyy". `visiblePanels`-suunnassa sama puuttuva
   * avain tai tyhjä lista tarkoittaisi tyhjää ruutua, ja jokainen myöhemmin
   * lisättävä paneeli olisi oletuksena piilossa.
   */
  hiddenPanels: PanelId[];
  /**
   * "fit" näyttää kahdeksan riviä. "scroll" säilyttää rivien ja korttien
   * koon, mutta sallii lisärivit alaspäin. Paluu sovitukseen hylätään
   * tallennusta muuttamatta, jos näkyviä kortteja on kahdeksan rivin alla.
   */
  gridOverflow: GridOverflow;
  alarms: Alarm[];
}

export const defaultSettings: Settings = {
  visibleStudents: null,
  visiblePaikkyChildren: null,
  scheduleLayout: "split",
  rolloverTime: "12:00",
  hideMessagePreviews: false,
  hideNextAlarm: false,
  nightModeStart: "21:30",
  nightModeEnd: "06:00",
  breakfastTime: "08:00",
  weatherPostalCode: null,
  menuSchoolIds: ["karstula_koulut"],
  newsCategories: ["paauutiset"],
  panelLayout: null,
  hiddenPanels: [...defaultHiddenPanels],
  gridOverflow: "fit",
  alarms: [],
};

const KEY = "settings";

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY);
  const merged = { ...defaultSettings, ...(stored ?? {}) };
  merged.newsCategories = parseNewsCategories(merged.newsCategories);
  merged.menuSchoolIds = parseMenuSchoolIds(merged.menuSchoolIds);
  merged.alarms = normalizeStoredAlarms(merged.alarms);
  merged.hiddenPanels = normalizeStoredHiddenPanels(merged.hiddenPanels);
  // Oletuspiilotukset yhdistetään VAIN kun tallennetusta oliosta puuttuu
  // `hiddenPanels`-avain kokonaan — ei aina kun asettelua ei ole tallennettu.
  //
  // Ehto oli aiemmin `panelLayout === null`, ja se luki asetukset uusiksi
  // JOKAISELLA haulla: käyttäjä otti paneelin käyttöön, tallennus onnistui
  // ilman varoitusta, ja seuraava luku piilotti sen takaisin. Mitattuna
  // käyttöliittymässä rasti katosi heti kun asetusikkuna avattiin uudelleen.
  //
  // Vika oli erityisen ilkeä siksi, että RAJAPINNASTA MITATTUNA SE NÄYTTI
  // TOIMIVAN: `PUT` palautti 200 ja uuden tilan, ja vasta levylle katsomalla
  // näki ettei `hiddenPanels` sisältänyt paneelia — se lisättiin takaisin
  // vasta luvussa. Todenna tämä siis levyltä, älä vastauksesta.
  //
  // Tuore asennus saa oletuspiilotukset yhä: silloin tallennettua oliota ei
  // ole lainkaan, joten avain puuttuu. Päivityspolku on erikseen
  // adoptNewPanelsissa eikä muutu tästä.
  // Kun asettelua EI ole tallennettu, käytössä on defaultPanelLayout — ja
  // siinä viisi uusinta paneelia ovat PARKKIPAIKOILLA toisten päällä (ks.
  // defaultHiddenPanels). Ne voivat siis näkyä vain jos niille löytyy paikka.
  //
  // Tässä on kaksi vaatimusta jotka ovat helposti ristiriidassa, ja molemmat
  // on mitattu rikki:
  //
  //  1. Käyttäjän valinta on säilyttävä. Aiemmin oletuspiilotukset lisättiin
  //     takaisin JOKAISELLA luvulla, jolloin asetuslistasta käyttöön otettu
  //     paneeli katosi heti kun ikkuna avattiin uudelleen — eikä vikaa näkynyt
  //     rajapinnasta, koska PUT palautti oikean tilan ja piilotus tapahtui
  //     vasta luvussa.
  //  2. Näkyvät paneelit eivät saa mennä päällekkäin. Pelkkä tallennetun
  //     listan kunnioittaminen päästäisi parkkipaikalla olevan paneelin
  //     näkyviin toisen kortin päälle.
  //
  // Sääntö joka täyttää molemmat: paneeli pysyy piilossa VAIN jos sille ei ole
  // paikkaa. Silloin piilotus ei ole mielivaltainen vaan sama asia jonka
  // käyttöliittymä kertoo ("ei mahdu ruudukkoon, pienennä jotakin korttia").
  //
  // Roska-arvo (esim. merkkijono taulukon sijaan) ei ole valinta vaan
  // rikkinäinen rivi, ja se normalisoidaan oletuksiin.
  if (stored === null || !Array.isArray(stored.hiddenPanels)) {
    merged.hiddenPanels = [...new Set([...merged.hiddenPanels, ...defaultHiddenPanels])];
  } else if (merged.panelLayout === null) {
    const piilossa = new Set(merged.hiddenPanels);
    for (const id of defaultHiddenPanels) {
      if (piilossa.has(id)) continue;
      const oma = defaultPanelLayout[id];
      const osuu = PANEL_IDS.some(
        (muu) => muu !== id && !piilossa.has(muu) && placementsOverlap(oma, defaultPanelLayout[muu]),
      );
      if (osuu) piilossa.add(id);
    }
    merged.hiddenPanels = [...piilossa];
  }

  adoptNewPanels(merged);
  return merged;
}

/** Kelpaako tallennettu sijoittelu muodoltaan? Rajat tarkistaa parsePanelLayout. */
function isStoredPlacement(value: unknown): value is PanelPlacement {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (["col", "row", "colSpan", "rowSpan"] as const).every((k) => typeof p[k] === "number");
}

/**
 * Päivityspolku: mitä tehdään paneelille, joka on lisättävään ohjelmistoon
 * mutta jota ei ole käyttäjän tallennetussa asettelussa.
 *
 * UUSI PANEELI MENEE `hiddenPanels`iin, EI ASETTELUUN. Käyttäjän asettelu on
 * käsin tehtyä työtä, eikä päivitys saa muuttaa sitä. Asettelu täyttää
 * ruudukon kokonaan (ks. defaultPanelLayout), joten vapaata paikkaa ei ole
 * MISSÄÄN — mikä tahansa automaattinen sijoitus menisi jonkin olemassa
 * olevan kortin päälle. Piilotettu uusi kortti ei riko mitään, näkyy
 * asetuksissa kytkimenä ja odottaa että käyttäjä tekee sille tilaa.
 *
 * KERTALUONTEISUUS ILMAN MERKKIÄ. Ehto luetaan datasta itsestään —
 * "tunniste puuttuu tallennetusta asettelusta" — eikä erillisestä
 * "migraatio tehty" -lipusta, samasta syystä kuin migrateMessageReads
 * tunnistaa kohteensa taulun sarakkeista eikä versionumerosta
 * (ks. core/store.ts): erillinen lippu voi ajautua eri mieleen kuin tila
 * jota se kuvaa, ehto datasta ei voi.
 *
 * Ehto myös NOLLAUTUU ITSESTÄÄN eikä voi palautua: `parsePanelLayout` vaatii
 * JOKAISEN paneelin, joten mikä tahansa asettelun tallennus kirjoittaa
 * levylle täyden seitsemän paneelin asettelun. Heti kun käyttäjä ottaa
 * uutiset käyttöön ja tallentaa, tunniste on asettelussa eikä tämä enää
 * laukea — ei myöskään seuraavalla käynnistyksellä. Ja jos hän piilottaa
 * kortin myöhemmin itse, se on hänen valintansa eikä tämä koske siihen.
 *
 * EI KIRJOITA LEVYLLE. Sama ratkaisu kuin normalizeStoredAlarmsilla: luetaan
 * läpinäkyvästi, ei tallenneta normalisoitua muotoa takaisin. Tämä on myös
 * vahvin mahdollinen vastaus siihen ettei puolittaista tilaa saa syntyä —
 * migrateMessageReads tarvitsee transaktion ja varmuuskopion koska se
 * kirjoittaa, tässä ei ole kirjoitusta jonka voisi keskeyttää. Kutsu on
 * idempotentti ja kestää keskeytyksen määritelmällisesti.
 *
 * UUTTA ASENNUSTA EI KOSKETA: `panelLayout === null` tarkoittaa "ei koskaan
 * muokattu", jolloin käytössä on defaultPanelLayout — siinä uutiset ovat
 * mukana ja näkyvät normaalisti.
 */
/**
 * Ensimmäinen vapaa `colSpan × rowSpan` -kokoinen alue, tai null jos
 * ruudukko on täynnä.
 *
 * Läpikäynti on rivi kerrallaan ylhäältä alas ja vasemmalta oikealle, ja
 * DETERMINISTISYYS ON TÄSSÄ VAATIMUS EIKÄ SATTUMA: `adoptNewPanels` ajetaan
 * joka `getSettings()`-kutsulla eikä se kirjoita tulosta levylle, joten
 * saman kannan on tuotettava sama sijoitus joka kerta. Muuten paneelin
 * paikka hyppisi pyynnöstä toiseen.
 */
function findFreeSpot(
  layout: PanelLayout,
  occupants: readonly PanelId[],
  size: PanelPlacement,
): PanelPlacement | null {
  const occupied = new Set<string>();
  for (const id of occupants) {
    const p = layout[id];
    for (let c = p.col; c < p.col + p.colSpan; c++) {
      for (let r = p.row; r < p.row + p.rowSpan; r++) occupied.add(`${c},${r}`);
    }
  }

  for (let row = 1; row + size.rowSpan - 1 <= GRID_ROWS; row++) {
    for (let col = 1; col + size.colSpan - 1 <= GRID_COLUMNS; col++) {
      let fits = true;
      for (let c = col; c < col + size.colSpan && fits; c++) {
        for (let r = row; r < row + size.rowSpan && fits; r++) {
          if (occupied.has(`${c},${r}`)) fits = false;
        }
      }
      if (fits) return { col, row, colSpan: size.colSpan, rowSpan: size.rowSpan };
    }
  }
  return null;
}

function adoptNewPanels(settings: Settings): void {
  const stored = settings.panelLayout;
  if (stored === null || typeof stored !== "object") return;

  const layout = stored as unknown as Record<string, unknown>;
  const absent = PANEL_IDS.filter((id) => !(id in layout));
  const unusable = PANEL_IDS.filter((id) => !isStoredPlacement(layout[id]));
  if (unusable.length === 0) return;

  // Sijoittelu täydennetään KAIKILLE kelvottomille, myös rikkinäisille:
  // muuten getSettings palauttaisi vajaan asettelun, jonka asetuspaneeli
  // lähettää sellaisenaan takaisin (se levittää koko settings-olion
  // PUT:iin) ja parsePanelLayout torjuisi sen 400:lla. Päivitetyn
  // asennuksen asetuspaneeli olisi siis käyttökelvoton.
  //
  // Paikaksi etsitään ensisijaisesti VAPAA alue käyttäjän omasta
  // asettelusta, ja vasta jos sellaista ei ole, tyydytään oletuspaikkaan.
  // Ero näkyy vain asettelussa johon käyttäjä on jättänyt tilaa: siellä uusi
  // kortti on käyttökelpoinen heti kytkimen kääntämisen jälkeen, kun taas
  // oletuspaikka olisi todennäköisesti jonkin päällä. Täydessä ruudukossa
  // vapaata ei ole eikä tulos muutu — se on tavallisin tapaus, koska
  // defaultPanelLayout täyttää ruudukon kokonaan.
  //
  // Oletuspaikka jää siis varasijaksi, ja se saa olla päällekkäinen:
  // piilotetun paneelin sijoitus on parkkipaikka eikä piirtopaikka
  // (ks. assertNoVisibleOverlap).
  const completed = { ...(stored as PanelLayout) };
  const occupants = PANEL_IDS.filter((id) => !unusable.includes(id));
  for (const id of unusable) {
    completed[id] = findFreeSpot(completed, occupants, defaultPanelLayout[id]) ?? { ...defaultPanelLayout[id] };
    // Seuraava täydennettävä ei saa mennä juuri sijoitetun päälle.
    occupants.push(id);
  }
  settings.panelLayout = completed;

  // Piilotetaan vain AIDOSTI UUDET, ei rikkinäisiä: rikkinäinen sijoittelu
  // on käyttäjän olemassa oleva kortti, jota ei saa kytkeä pois hänen
  // selkänsä takana.
  for (const id of absent) {
    if (!settings.hiddenPanels.includes(id)) settings.hiddenPanels.push(id);
  }
}

export class SettingsValidationError extends Error {}

/**
 * Only known keys are accepted and each is validated, because these come
 * straight from a phone on the home network.
 */
export function updateSettings(patch: unknown): Settings {
  if (typeof patch !== "object" || patch === null) {
    throw new SettingsValidationError("Asetusten täytyy olla objekti");
  }
  const input = patch as Record<string, unknown>;
  const next: Settings = { ...getSettings() };

  if ("visibleStudents" in input) {
    next.visibleStudents = parseVisibleIds(
      input["visibleStudents"],
      "visibleStudents: lista opiskelijanumeroita tai null",
    );
  }

  if ("visiblePaikkyChildren" in input) {
    next.visiblePaikkyChildren = parseVisibleIds(
      input["visiblePaikkyChildren"],
      "visiblePaikkyChildren: lista lapsitunnisteita tai null",
    );
  }

  if ("gridOverflow" in input) {
    const value = input["gridOverflow"];
    if (value !== "fit" && value !== "scroll") {
      throw new SettingsValidationError("gridOverflow: 'fit' tai 'scroll'");
    }
    next.gridOverflow = value;
  }

  if ("scheduleLayout" in input) {
    const value = input["scheduleLayout"];
    if (value !== "single" && value !== "split") {
      throw new SettingsValidationError("scheduleLayout: 'single' tai 'split'");
    }
    next.scheduleLayout = value;
  }

  for (const key of ["rolloverTime", "nightModeStart", "nightModeEnd", "breakfastTime"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "string" || parseClockTime(value) === null) {
      throw new SettingsValidationError(`${key}: kellonaika muodossa HH:MM`);
    }
    next[key] = value;
  }

  if ("newsCategories" in input) next.newsCategories = parseNewsCategories(input["newsCategories"]);
  if ("menuSchoolIds" in input) next.menuSchoolIds = parseMenuSchoolIds(input["menuSchoolIds"]);
  if ("weatherPostalCode" in input) {
    next.weatherPostalCode = parseWeatherPostalCode(input["weatherPostalCode"]);
  }

  // Oma lohkonsa, ei osa panelLayoutia: kortin piilottaminen ei saa vaatia
  // koko asettelun lähettämistä, eikä piilotettu kortti menetä paikkaansa
  // ruudukolla. Näin käyttöön palautettu kortti ilmestyy sinne mistä se
  // otettiin pois.
  //
  // ENNEN panelLayoutia, koska asettelun päällekkäisyystarkistus tarvitsee
  // tietää mitkä paneelit ovat näkyvissä — ja sama pyyntö voi muuttaa
  // molempia (muokkaustilan "Valmis" lähettää ne parina).
  if ("hiddenPanels" in input) {
    next.hiddenPanels = parseHiddenPanels(input["hiddenPanels"]);
  }

  if ("panelLayout" in input) {
    next.panelLayout = parsePanelLayout(input["panelLayout"], next.hiddenPanels, next.gridOverflow);
  }

  if ("alarms" in input) {
    next.alarms = parseAlarms(input["alarms"]);
  }

  if ("hideMessagePreviews" in input) {
    const value = input["hideMessagePreviews"];
    if (typeof value !== "boolean") {
      throw new SettingsValidationError("hideMessagePreviews: true tai false");
    }
    next.hideMessagePreviews = value;
  }

  // Oma lohkonsa eikä jaettua boolean-silmukkaa hideMessagePreviewsin kanssa:
  // asetukset tulevat kotiverkon puhelimelta, ja virheviestin pitää nimetä
  // juuri se kenttä joka oli väärin.
  //
  // `typeof value !== "boolean"` on tahallisen tiukka eikä tyyppipakotusta
  // (`Boolean(value)`, `value === "true"`): merkkijono "false" on
  // JavaScriptissä tosi, joten pakotus kääntäisi juuri sen tapauksen väärin.
  if ("hideNextAlarm" in input) {
    const value = input["hideNextAlarm"];
    if (typeof value !== "boolean") {
      throw new SettingsValidationError("hideNextAlarm: true tai false");
    }
    next.hideNextAlarm = value;
  }

  if (next.gridOverflow === "fit" && PANEL_IDS.some(id => !next.hiddenPanels.includes(id) && ((next.panelLayout ?? defaultPanelLayout)[id].row + (next.panelLayout ?? defaultPanelLayout)[id].rowSpan - 1 > GRID_ROWS))) {
    throw new SettingsValidationError("Sovitus ei mahdu ruudulle. Siirrä näkyvät paneelit kahdeksan ensimmäisen rivin sisään tai säilytä ylivuoto.");
  }
  assertNoVisibleOverlap(next.panelLayout ?? defaultPanelLayout, next.hiddenPanels);
  setSetting(KEY, next);
  return next;
}

/**
 * `visibleStudents` (Wilma) ja `visiblePaikkyChildren` (Päikky) ovat sama
 * asetus kahdelle lähteelle: null = näytä kaikki, muuten lista tunnisteita.
 * Suodatus tehdään selaimessa — palvelin ei tiedä keitä lapsia lähde tänään
 * palauttaa, eikä poistuneen lapsen tunniste listassa siksi ole virhe — joten
 * tässä varmistetaan vain muoto ennen tallennusta. Virheteksti tulee kutsujalta,
 * jotta se nimeää oikean kentän.
 */
function parseVisibleIds(value: unknown, message: string): string[] | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  throw new SettingsValidationError(message);
}

/**
 * Vain MUOTO tarkistetaan, ei sitä tunteeko niputettu aineisto numeron.
 * Tuntematon mutta muodollisesti kelvollinen postinumero on eri vika kuin
 * roskasyöte: aineisto voi olla vanhentunut, ja silloin oikea vastaus on
 * varoitus lokiin ja edellinen sijainti voimassa (ks. core/weather-location.ts)
 * — ei tallennuksen torjuminen, joka jättäisi käyttäjän jumiin väärään
 * paikkakuntaan. Tyhjä merkkijono normalisoidaan nulliksi, jotta "tyhjennä
 * kenttä" käyttöliittymässä tarkoittaa samaa kuin "ei asetettu".
 */
function parseWeatherPostalCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SettingsValidationError("weatherPostalCode: viisinumeroinen postinumero tai null");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!isPostalCode(trimmed)) {
    throw new SettingsValidationError("weatherPostalCode: viisinumeroinen postinumero tai null");
  }
  return trimmed;
}

/**
 * Lista piilotettavista paneeleista. Tuntematon tunniste on virhe: se
 * tarkoittaa että selain ja palvelin ovat eri mieltä siitä mitä paneeleja on
 * olemassa, ja hiljainen hylkäys jättäisi käyttäjän luulemaan että kortti
 * piilotettiin. Virheteksti nimeää kentän ja indeksin.
 *
 * DUPLIKAATIT SIISTITÄÄN, EI HYLÄTÄ. Tämä poikkeaa hälytysten
 * viikonpäivälistoista (parseRelativeWeekdays), joissa sama päivä kahdesti
 * hylätään — ja ero on tarkoituksellinen: siellä kaksi alkiota voi olla eri
 * mieltä (sama päivä, eri ankkuri), joten päällekkäisyys on aito
 * ristiriita. Tässä alkiolla ei ole muuta sisältöä kuin tunniste, joten
 * "piilota sää" kahdesti tarkoittaa täsmälleen samaa kuin kerran. Nopea
 * kaksoisnapautus puhelimessa ei ansaitse 400:aa, jonka jälkeen paneeli olisi
 * jumissa kunnes joku tyhjentää listan käsin. Järjestys säilyy ensimmäisen
 * esiintymän mukaan.
 *
 * Kaikkien paneelien piilottamista ei estetä: tyhjä ruutu on outo mutta
 * käyttäjän oma valinta, ja asetuspaneeli ei ole paneeli — sitä kautta
 * pääsee aina takaisin.
 */
export function parseHiddenPanels(value: unknown): PanelId[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError("hiddenPanels: lista paneelitunnisteita");
  }
  const out: PanelId[] = [];
  value.forEach((raw, index) => {
    if (!isPanelId(raw)) {
      throw new SettingsValidationError(`hiddenPanels[${index}]: tuntematon paneelitunniste`);
    }
    if (!out.includes(raw)) out.push(raw);
  });
  return out;
}

/**
 * Sama siivous lukua varten: ei koskaan heitä. Tallennettu lista on
 * normaalisti aina parseHiddenPanelsin kirjoittamaa, mutta tunniste voi jäädä
 * roikkumaan jos paneeli joskus poistetaan tai jos laitteella on ajettu
 * uudempi versio ja palattu vanhempaan. Tuntematon tunniste ei saa kaataa
 * asetusten lukua eikä vuotaa dashboardiin.
 */
function normalizeStoredHiddenPanels(value: unknown): PanelId[] {
  if (!Array.isArray(value)) return [];
  const out: PanelId[] = [];
  for (const raw of value) {
    if (isPanelId(raw) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

function positiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new SettingsValidationError(`panelLayout.${label}: kokonaisluku väliltä 1–${max}`);
  }
  return value;
}

/**
 * A layout that does not fit the grid would push panels off the wall display
 * with no way to drag them back, so the bounds are enforced here rather than
 * trusted from the client. Every panel must be present: a partial layout would
 * silently drop a card.
 */
function placementsOverlap(a: PanelPlacement, b: PanelPlacement): boolean {
  return (
    a.col <= b.col + b.colSpan - 1 &&
    a.col + a.colSpan - 1 >= b.col &&
    a.row <= b.row + b.rowSpan - 1 &&
    a.row + a.rowSpan - 1 >= b.row
  );
}

/**
 * Kaksi paneelia ei saa olla päällekkäin — MUTTA VAIN NÄKYVIEN KESKEN.
 *
 * Rajoista huolimatta mikään ei aiemmin estänyt lähettämästä kaikkia
 * seitsemää paneelia samaan 2×2-soluun: jokainen mahtuu ruudukkoon
 * erikseen, ja vain sitä tarkistettiin. Päällekkäisyys tallentui ensimmäisellä
 * tallennuksella, ja siitä tuli pysyvä tila.
 *
 * PIILOTETUN PANEELIN SIJOITUS ON PARKKIPAIKKA, EI PIIRTOPAIKKA. Sitä ei
 * renderöidä, joten se ei voi mennä minkään päälle. Ero on välttämätön eikä
 * hienosäätöä: päivityspolku (ks. adoptNewPanels) parkkeeraa uuden paneelin
 * oletuspaikkaansa, joka menee käyttäjän kortin päälle aina kun hänen
 * asettelunsa on täynnä — eikä se voi olla muualla, koska vapaata solua ei
 * ole. Jos tämä tarkistus koskisi myös piilotettuja, päivitetyn asennuksen
 * asetuspaneeli palauttaisi 400:n heti ensimmäisestä tallennuksesta ja olisi
 * käyttökelvoton.
 *
 * ÄLÄ siis "yhtenäistä" tätä koskemaan kaikkia paneeleita.
 */
function assertNoVisibleOverlap(layout: PanelLayout, hiddenPanels: readonly PanelId[]): void {
  const visible = PANEL_IDS.filter((id) => !hiddenPanels.includes(id));
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i] as PanelId;
      const b = visible[j] as PanelId;
      if (placementsOverlap(layout[a], layout[b])) {
        throw new SettingsValidationError(`panelLayout: ${a} ja ${b} ovat päällekkäin`);
      }
    }
  }
}

/**
 * `hiddenPanels` kertoo mitkä paneelit ovat näkyvissä päällekkäisyys-
 * tarkistusta varten (ks. assertNoVisibleOverlap). Ilman sitä kaikkia
 * käsitellään näkyvinä, mikä on tiukin tulkinta ja siksi turvallinen oletus.
 */
export function parsePanelLayout(value: unknown, hiddenPanels: readonly PanelId[] = [], overflow: GridOverflow = "fit"): PanelLayout | null {
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new SettingsValidationError("panelLayout: objekti tai null");
  }
  const input = value as Record<string, unknown>;
  const layout = {} as PanelLayout;

  for (const id of PANEL_IDS) {
    const raw = input[id];
    if (typeof raw !== "object" || raw === null) {
      throw new SettingsValidationError(`panelLayout.${id}: puuttuu`);
    }
    const item = raw as Record<string, unknown>;
    const col = positiveInt(item["col"], `${id}.col`, GRID_COLUMNS);
    const row = positiveInt(item["row"], `${id}.row`, MAX_LAYOUT_ROWS);
    const colSpan = positiveInt(item["colSpan"], `${id}.colSpan`, GRID_COLUMNS);
    const rowSpan = positiveInt(item["rowSpan"], `${id}.rowSpan`, MAX_LAYOUT_ROWS);

    if (colSpan < MIN_PANEL_SPAN || rowSpan < MIN_PANEL_SPAN) {
      throw new SettingsValidationError(
        `panelLayout.${id}: paneelin on oltava vähintään ${MIN_PANEL_SPAN}×${MIN_PANEL_SPAN} solua`,
      );
    }

    if (col + colSpan - 1 > GRID_COLUMNS) {
      throw new SettingsValidationError(`panelLayout.${id}: ei mahdu leveyssuunnassa`);
    }
    if (row > MAX_LAYOUT_ROWS - rowSpan + 1 || (overflow === "fit" && !hiddenPanels.includes(id) && row + rowSpan - 1 > GRID_ROWS)) {
      throw new SettingsValidationError(`panelLayout.${id}: ei mahdu korkeussuunnassa`);
    }
    layout[id] = { col, row, colSpan, rowSpan };
  }

  assertNoVisibleOverlap(layout, hiddenPanels);

  return layout;
}

/**
 * Yläraja hälytysten määrälle — nämä säilytetään yhdessä JSON-blobissa
 * (ks. store.ts), joten mikään ei muuten estäisi listaa kasvamasta rajatta.
 */
export const MAX_ALARMS = 20;
const ALARM_LABEL_MAX_LENGTH = 60;
const ALARM_MINUTES_MIN = 1;
const ALARM_MINUTES_MAX = 240;
const ALARM_REPEAT_MIN = 1;
const ALARM_REPEAT_MAX = 8;
const ALARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALARM_SOUND_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** Kaikki viikonpäivät Date.getDayn numeroinnilla, sunnuntaista alkaen. */
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function numberInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsValidationError(`${label}: luku väliltä ${min}–${max}`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const num = numberInRange(value, label, min, max);
  if (!Number.isInteger(num)) {
    throw new SettingsValidationError(`${label}: kokonaisluku väliltä ${min}–${max}`);
  }
  return num;
}

function parseWeekdayNumber(value: unknown, label: string): number {
  return integerInRange(value, label, 0, 6);
}

/**
 * Relative-tilan viikonpäivälista: jokainen alkio kantaa oman ankkurinsa
 * (ks. AlarmWeekdayRule), ja sama viikonpäivä saa esiintyä listassa vain
 * kerran — muuten kaksi sääntöä kilpailisi samasta päivästä.
 */
function parseRelativeWeekdays(value: unknown, index: number): AlarmWeekdayRule[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: lista`);
  }
  const seen = new Set<number>();
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays[${i}]: objekti`);
    }
    const item = raw as Record<string, unknown>;
    const weekday = parseWeekdayNumber(item["weekday"], `alarms[${index}].trigger.weekdays[${i}].weekday`);
    if (seen.has(weekday)) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: viikonpäivä ${weekday} toistuu`);
    }
    seen.add(weekday);
    const anchor = item["anchor"];
    if (anchor !== "schoolStart" && anchor !== "breakfast") {
      throw new SettingsValidationError(
        `alarms[${index}].trigger.weekdays[${i}].anchor: 'schoolStart' tai 'breakfast'`,
      );
    }
    return { weekday, anchor };
  });
}

/** Fixed-tilan viikonpäivälista: pelkkiä viikonpäivänumeroita, ei ankkuria. */
function parseFixedWeekdays(value: unknown, index: number): number[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: lista`);
  }
  const seen = new Set<number>();
  return value.map((raw, i) => {
    const weekday = parseWeekdayNumber(raw, `alarms[${index}].trigger.weekdays[${i}]`);
    if (seen.has(weekday)) {
      throw new SettingsValidationError(`alarms[${index}].trigger.weekdays: viikonpäivä ${weekday} toistuu`);
    }
    seen.add(weekday);
    return weekday;
  });
}

/** Tiukka validointi uuden muodon trigger-oliolle (ks. AlarmTrigger). */
function parseTriggerObject(value: unknown, index: number): AlarmTrigger {
  if (typeof value !== "object" || value === null) {
    throw new SettingsValidationError(`alarms[${index}].trigger: objekti`);
  }
  const t = value as Record<string, unknown>;
  const mode = t["mode"];

  if (mode === "relative") {
    const minutesBefore = integerInRange(
      t["minutesBefore"],
      `alarms[${index}].trigger.minutesBefore`,
      ALARM_MINUTES_MIN,
      ALARM_MINUTES_MAX,
    );
    const studentNumberRaw = t["studentNumber"];
    if (studentNumberRaw !== null && typeof studentNumberRaw !== "string") {
      throw new SettingsValidationError(`alarms[${index}].trigger.studentNumber: merkkijono tai null`);
    }
    const weekdays = parseRelativeWeekdays(t["weekdays"], index);
    return { mode: "relative", minutesBefore, studentNumber: studentNumberRaw as string | null, weekdays };
  }

  if (mode === "fixed") {
    const time = t["time"];
    if (typeof time !== "string" || parseClockTime(time) === null) {
      throw new SettingsValidationError(`alarms[${index}].trigger.time: kellonaika muodossa HH:MM`);
    }
    const weekdays = parseFixedWeekdays(t["weekdays"], index);
    return { mode: "fixed", time, weekdays };
  }

  throw new SettingsValidationError(`alarms[${index}].trigger.mode: 'relative' tai 'fixed'`);
}

/**
 * Palauttaa hälytyksen triggerin — joko uuden muodon `trigger`-kentästä, tai
 * jos sitä ei ole, tulkitsee ennen tätä muutosta tallennetun vanhan muodon
 * (pelkkä top-level minutesBefore + studentNumber, ei viikonpäiviä eikä
 * ankkuria) migraationa.
 *
 * Migraation oletus on KAIKKI viikonpäivät, ei esim. ma–pe: vanha hälytys
 * laukesi aiemmin minä tahansa päivänä jolloin päivän ensimmäinen tunti
 * löytyi, riippumatta viikonpäivästä (ks. entinen alarmTargetForDate web-
 * puolella). Jos migraatio rajaisi sen ma–pe:hen, poikkeuksellinen
 * koulupäivä (esim. lauantaityöpäivä) hiljenisi äänettömästi — sama
 * hälytyksen pitää siis jatkaa toimimista TÄSMÄLLEEN entiseen tapaan ilman
 * että käyttäjä koskee siihen, ei "järkevän oloisesti mutta eri tavalla".
 */
function parseTrigger(item: Record<string, unknown>, index: number): AlarmTrigger {
  if (item["trigger"] !== undefined) {
    return parseTriggerObject(item["trigger"], index);
  }

  const minutesBefore = integerInRange(
    item["minutesBefore"],
    `alarms[${index}].minutesBefore`,
    ALARM_MINUTES_MIN,
    ALARM_MINUTES_MAX,
  );
  const studentNumberRaw = item["studentNumber"];
  if (studentNumberRaw !== null && typeof studentNumberRaw !== "string" && studentNumberRaw !== undefined) {
    throw new SettingsValidationError(`alarms[${index}].studentNumber: merkkijono tai null`);
  }
  const studentNumber = typeof studentNumberRaw === "string" ? studentNumberRaw : null;

  return {
    mode: "relative",
    minutesBefore,
    studentNumber,
    weekdays: ALL_WEEKDAYS.map((weekday) => ({ weekday, anchor: "schoolStart" })),
  };
}

/**
 * Hälytykset tulevat kotiverkon puhelimelta siinä missä muutkin asetukset,
 * joten jokainen kenttä rajataan tässä eikä luoteta clientin lähettämään
 * muotoon. soundId ei ole suljettu enum (ks. kommentti Alarm-tyypissä), joten
 * se hyväksytään minä tahansa tunnisteenomaisena merkkijonona sen sijaan että
 * torjuttaisiin kaikki paitsi tämänhetkiset sisäänrakennetut äänet.
 */
function parseAlarm(raw: unknown, index: number): Alarm {
  if (typeof raw !== "object" || raw === null) {
    throw new SettingsValidationError(`alarms[${index}]: objekti`);
  }
  const item = raw as Record<string, unknown>;

  const id = item["id"];
  if (typeof id !== "string" || !ALARM_ID_PATTERN.test(id)) {
    throw new SettingsValidationError(`alarms[${index}].id: tunniste`);
  }

  const label = item["label"];
  if (typeof label !== "string" || label.trim().length === 0 || label.length > ALARM_LABEL_MAX_LENGTH) {
    throw new SettingsValidationError(`alarms[${index}].label: teksti 1–${ALARM_LABEL_MAX_LENGTH} merkkiä`);
  }

  const trigger = parseTrigger(item, index);

  const enabled = item["enabled"];
  if (typeof enabled !== "boolean") {
    throw new SettingsValidationError(`alarms[${index}].enabled: true tai false`);
  }

  const soundId = item["soundId"];
  if (typeof soundId !== "string" || !ALARM_SOUND_ID_PATTERN.test(soundId)) {
    throw new SettingsValidationError(`alarms[${index}].soundId: tunniste`);
  }

  const volume = numberInRange(item["volume"], `alarms[${index}].volume`, 0, 1);

  const repeatCount = integerInRange(
    item["repeatCount"],
    `alarms[${index}].repeatCount`,
    ALARM_REPEAT_MIN,
    ALARM_REPEAT_MAX,
  );

  return { id, label, trigger, enabled, soundId, volume, repeatCount };
}

export function parseAlarms(value: unknown): Alarm[] {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError("alarms: lista");
  }
  if (value.length > MAX_ALARMS) {
    throw new SettingsValidationError(`alarms: enintään ${MAX_ALARMS} hälytystä`);
  }

  const seenIds = new Set<string>();
  return value.map((raw, index) => {
    const alarm = parseAlarm(raw, index);
    if (seenIds.has(alarm.id)) {
      throw new SettingsValidationError(`alarms[${index}].id: sama tunniste toistuu useammassa hälytyksessä`);
    }
    seenIds.add(alarm.id);
    return alarm;
  });
}

/**
 * Sama muunnos kuin parseAlarms, mutta lukua varten: ei koskaan heitä.
 * Tallennettu data on normaalisti aina joko jo tätä muotoa (parseAlarmsin
 * kautta kirjoitettu) tai ennen tätä muutosta tallennettua vanhaa muotoa
 * (parseTrigger tulkitsee sen migraationa, ks. yllä) — kummankin pitäisi
 * onnistua aina. Yksittäisen rivin odottamaton hylkääminen on siis
 * viimesijainen suoja aidosti korruptoitunutta dataa vastaan, ei odotettu
 * polku: sellaisen ei pidä kaataa koko infonäyttöä, joten rivi jätetään pois
 * ja virhe kirjataan konsoliin sen sijaan.
 */
function normalizeStoredAlarms(value: unknown): Alarm[] {
  if (!Array.isArray(value)) return [];
  const out: Alarm[] = [];
  value.forEach((raw, index) => {
    try {
      out.push(parseAlarm(raw, index));
    } catch (err) {
      console.error(`Tallennettu hälytys #${index} ei kelpaa, jätetään pois asetuksista:`, err);
    }
  });
  return out;
}

export function parseMenuSchoolIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) throw new SettingsValidationError("Valitse enintään kahdeksan koulun ruokalistaa.");
  return [...new Set(value)] as string[];
}

function parseNewsCategories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || !value.every(isNewsCategory)) throw new SettingsValidationError("Uutiskategoriat: valitse 1–8 tunnettua kategoriaa");
  return [...new Set(value as string[])];
}
