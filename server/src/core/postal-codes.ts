import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Suomalaisen postinumeron muunnos sään sijainniksi.
 *
 * Aineisto on NIPUTETTU (server/src/data/postinumerot.json), ei haettu verkosta
 * pyynnön yhteydessä. Se ei ole mukavuusratkaisu vaan mitattu valinta: vuoden
 * aikana käyttöön otetuista seitsemästä suomalaisesta postinumerosta
 * zippopotam.us tunsi yhden ja Nominatim ei yhtäkään. Verkkohaku ei siis toisi
 * tuoreutta, vain uuden vikapisteen laitteeseen jonka on määrä toimia vuosia
 * ilman että kukaan koskee siihen. Open-Meteon oma geokoodaus taas on tähän
 * kelvoton: `name=43500` palauttaa Tortosan Espanjasta, ei Karstulaa.
 *
 * Aineisto rakennetaan käsin skriptillä skriptit/rakenna-postinumerot.mjs.
 * Loppukäyttäjä ei aja sitä koskaan — postinumerot muuttuvat noin 0,2 %
 * vuodessa, joten päivitys kuuluu julkaisusykliin eikä ajonaikaan.
 *
 * --- Attribuutio (CC BY 4.0 edellyttää) ---------------------------------
 * Postinumeroaineisto: GeoNames (https://www.geonames.org/), lisenssi CC BY 4.0
 * (https://creativecommons.org/licenses/by/4.0/). Ahvenanmaan postinumeroalueiden
 * keskipisteet: Tilastokeskus, Paavo-postinumeroalueittainen avoin tieto, lisenssi
 * CC BY 4.0. Aineistoja on muokattu: mukaan on otettu vain postinumero, paikannimi
 * ja koordinaatit.
 *
 * Ahvenanmaan nimet tulevat Paavon suomenkielisestä nimikentästä, joten 22100 on
 * "Maarianhamina" eikä postin käyttämä "Mariehamn". Käyttöliittymä on
 * suomenkielinen, joten valinta on tietoinen — ei aineiston virhe.
 */

/** `[paikannimi, leveysaste, pituusaste]` — taulukko eikä objekti, koska 3608 riviä kertaantuu. */
type PostalEntry = [place: string, latitude: number, longitude: number];

export interface PostalLocation {
  code: string;
  place: string;
  latitude: number;
  longitude: number;
}

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "postinumerot.json");

const POSTAL_CODE_PATTERN = /^\d{5}$/;

/**
 * Onko arvo suomalaisen postinumeron MUOTOINEN — ei sitä, onko sellainen
 * olemassa. Muoto ja olemassaolo ovat tahallaan eri kysymyksiä: asetusten
 * validointi saa hyväksyä muodollisesti kelvollisen numeron jota tämä aineisto
 * ei tunne (aineisto voi olla vanhentunut), kun taas haku vastaa siihen
 * tunteeko se sen.
 */
export function isPostalCode(value: unknown): value is string {
  return typeof value === "string" && POSTAL_CODE_PATTERN.test(value);
}

let table: Record<string, PostalEntry> | null = null;
let loadMs = 0;

/**
 * Ladataan kerran ja jäädään muistiin. 133 kt jäsennettynä on muutama sata
 * kilotavua kekoa — mitätön verrattuna siihen että jokainen haku lukisi levyltä.
 * Lataus on laiska eikä moduulin latautuessa tapahtuva, jotta yksikkötestit ja
 * asetusten luku eivät maksa sitä turhaan.
 */
function loadTable(): Record<string, PostalEntry> {
  if (table !== null) return table;
  const started = performance.now();
  // Ei try/catchia: jos niputettu aineisto puuttuu, jokainen postinumero olisi
  // "ei löydy" ja käyttäjä näkisi vain tyhjän tuloksen. Se on täsmälleen se
  // hiljainen vika jota vastaan koonti tarkistaa tiedoston olemassaolon (ks.
  // skriptit/tee-julkaisu.mjs, verifyPackageContents) — jos tarkistus on
  // jotenkin ohitettu, virheen pitää kuulua eikä vaimentua.
  table = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, PostalEntry>;
  loadMs = performance.now() - started;
  return table;
}

/** Aineiston latausaika millisekunteina, tai 0 jos sitä ei ole vielä ladattu. Vain lokitusta varten. */
export function postalTableLoadMs(): number {
  return loadMs;
}

/** Montako postinumeroa aineistossa on. Lataa aineiston jos sitä ei ole vielä ladattu. */
export function postalTableSize(): number {
  return Object.keys(loadTable()).length;
}

/**
 * Postinumero → sijainti, tai null jos numero ei ole postinumeron muotoinen tai
 * aineisto ei tunne sitä. Puhdas funktio: ei lokita, ei päätä mitä tuntemattoman
 * numeron kohdalla tehdään — se kuuluu kutsujalle (ks. core/weather-location.ts).
 */
export function lookupPostalCode(code: unknown): PostalLocation | null {
  const trimmed = typeof code === "string" ? code.trim() : code;
  if (!isPostalCode(trimmed)) return null;
  const entry = loadTable()[trimmed];
  if (!entry) return null;
  return { code: trimmed, place: entry[0], latitude: entry[1], longitude: entry[2] };
}
