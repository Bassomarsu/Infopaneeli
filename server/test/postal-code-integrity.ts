/**
 * Niputetun postinumeroaineiston EHEYS — ei hakulogiikka.
 *
 * server/test/postal-codes.ts kysyy "toimiiko haku oikein". Tämä kysyy
 * "onko haettava aineisto oikein", ja se on eri kysymys. Haku voi olla
 * täysin virheetön ja silti palauttaa väärän paikkakunnan sään, jos rivi
 * itsessään osoittaa väärään paikkaan.
 *
 * Tämä on tämän projektin pahin vikaluokka: VÄÄRÄ TIETO ILMAN MERKINTÄÄ.
 * Tuntematon postinumero varoittaa ja säilyttää edellisen sijainnin (ks.
 * core/weather-location.ts). Tunnettu mutta väärään paikkaan osoittava
 * postinumero ei tee kumpaakaan — sääkortti näyttää luottavaisesti
 * "Helsinki" ja Pieksämäen sään.
 *
 * Aineistoa ei korjata säännöllä vaan NIMETYLLÄ LISTALLA, jonka jokaisella
 * rivillä on todiste (ks. skriptit/rakenna-postinumerot.mjs). Tämän testin
 * tehtävä on estää listaa mätänemästä, ja siksi se kaatuu MOLEMPIIN
 * suuntiin:
 *
 *   A. aineistossa on rivi joka osuu kaukaiselle vieraalle alueelle eikä ole
 *      listalla  ->  uusi vika, kaadu ja nimeä se
 *   B. listalla on rivi jota ei enää tarvitse korjata tai jonka todiste ei
 *      enää päde  ->  merkintä on vanhentunut, kaadu ja kerro se
 *
 * Ilman B-suuntaa lista muuttuu kuolleeksi koodiksi ensimmäisessä
 * aineistopäivityksessä jossa lähde korjaa oman virheensä.
 *
 * VERKKO: osa tarkistuksista hakee Postin PCF-tiedoston ja Tilastokeskuksen
 * Paavon ajon aikana. Jos verkkoa ei ole, ne OHITETAAN selkeällä viestillä
 * eivätkä kaada testiä — muuten koko testisarja muuttuisi verkkoriippuvaiseksi.
 * Verkottomat tarkistukset ajetaan aina.
 *
 * PCF:n rooli: se saa kertoa MIKÄ rivi on rikki, muttei mitä tilalle. Mitään
 * PCF:stä johdettua ei ole niputetussa aineistossa (lisenssiperustelu on
 * rakennusskriptissä), eikä tämä testi kirjoita mitään.
 *
 * Aja:  npm run test:postal-code-integrity --workspace=server
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupPostalCode, postalTableSize } from "../src/core/postal-codes.ts";

type PostalEntry = [place: string, latitude: number, longitude: number];
interface Korjausloki {
  aineisto: string;
  paavonAlueita: number;
  korjatut: {
    postinumero: string; paikka: string; ennen: [number, number]; jalkeen: [number, number];
    siirtymaKm: number; tunnistin: string; todiste: string;
  }[];
  poistetut: { postinumero: string; paikka: string; ennen: [number, number]; syy: string }[];
  poistojenYlaraja: number;
  vanhentuneetKoodit: {
    selite: string;
    koodit: { postinumero: string; paikka: string; koordinaatti: [number, number]; tilastokeskusTunteeYha: boolean }[];
  };
  tunnetutPuutteet: { postinumero: string; paikka: string; syy: string }[];
  lisatyt: { postinumero: string; paikka: string; koordinaatti: [number, number]; kopioituKoodilta: string; peruste: string }[];
  hyvaksytytPoikkeamat: { postinumero: string; paikka: string; etaisyysKm: number; syy: string }[];
}

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
const table = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "postinumerot.json"), "utf8")) as Record<string, PostalEntry>;
const loki = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "postinumerot-korjaukset.json"), "utf8")) as Korjausloki;

/** Kuinka kaukana omasta kunnastaan rivi saa olla ennen kuin se on uusi vika. */
const KUNTARAJA_KM = 20;

const rad = Math.PI / 180;
function etaisyysKm(a: [number, number], b: [number, number]): number {
  const dlat = (b[0] - a[0]) * rad;
  const dlon = (b[1] - a[1]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function mediaani(luvut: number[]): number {
  const s = [...luvut].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? (s[k] as number) : (((s[k - 1] as number) + (s[k] as number)) / 2);
}

// ---------------------------------------------------------------- verkottomat

/**
 * Suomen karkea ympäröivä laatikko. Tarkoitus ei ole tarkkuus vaan se, että
 * täysin hakoteille joutunut rivi (nollasaari, väärä maa, merkkijonosta
 * väärin luettu luku) jää kiinni edes karkeasti.
 */
function testEveryRowIsInsideFinland(): void {
  const rivit = Object.entries(table);
  assert.ok(rivit.length > 3000, `aineistossa vain ${rivit.length} riviä`);

  const virheet: string[] = [];
  for (const [pn, arvo] of rivit) {
    if (!/^\d{5}$/.test(pn)) virheet.push(`${pn}: avain ei ole viisinumeroinen`);
    if (!Array.isArray(arvo) || arvo.length !== 3) {
      virheet.push(`${pn}: rivin muoto ei ole [nimi, lat, lon]`);
      continue;
    }
    const [nimi, lat, lon] = arvo;
    if (typeof nimi !== "string" || nimi.trim() === "") virheet.push(`${pn}: tyhjä paikannimi`);
    if (!Number.isFinite(lat) || lat < 59.5 || lat > 70.2) virheet.push(`${pn} ${nimi}: leveysaste ${lat}`);
    if (!Number.isFinite(lon) || lon < 19.0 || lon > 31.7) virheet.push(`${pn} ${nimi}: pituusaste ${lon}`);
  }

  assert.deepEqual(virheet, [], `aineistossa kelvottomia rivejä:\n  ${virheet.join("\n  ")}`);
  console.log(`ok  kaikki ${rivit.length} riviä ovat muodoltaan kelvollisia ja Suomen sisällä`);
}

/**
 * Verkoton yleistarkistus: samannimisten rykelmästä karannut rivi.
 *
 * Tämä ei tarvitse mitään ulkoista lähdettä, joten se toimii AINA — myös
 * silloin kun verkkoa ei ole ja alempi kuntatarkistus ohitetaan. Se on
 * karkeampi mutta ei koskaan poissa.
 *
 * Kolme yksityiskohtaa tekee siitä käyttökelpoisen sen sijaan että se
 * huutaisi oikeista riveistä:
 *
 *   1. MEDIAANI, EI KESKIARVO. 248 km sivussa oleva rivi vetäisi keskiarvon
 *      mukanaan ja piilottaisi itsensä. Mediaani ei liiku sen takia.
 *   2. RYKELMÄN TIIVEYS MITATAAN MEDIAANIPOIKKEAMALLA, ei suurimmalla
 *      poikkeamalla. Muuten juuri se rikkinäinen rivi tekisi ryhmästä
 *      "hajanaisen" ja ohittaisi tarkistuksen — tarkistus vaimentaisi itse
 *      sen mitä etsii.
 *   3. HAJANAISET RYHMÄT OHITETAAN. TIKKALA on kaksi eri kylää 120 km:n
 *      päässä toisistaan (41860 Keski-Suomessa, 82350 Keski-Karjalassa).
 *      Kummallakin on oma postinumeroalue ja kumpikin on OIKEIN.
 *
 * Ja siksi raja on 50 km eikä 30: 93900 KUUSAMO on 33 km muiden Kuusamon
 * koodien mediaanista, koska se on Oulangan kansallispuisto isossa kunnassa.
 * 95540 TORNIO on 32 km ja 38510 SASTAMALA 24 km, samasta syystä.
 */
function testNoRowIsStrandedFromItsNamesakes(): void {
  const MIN_RYHMAKOKO = 3;
  const TIIVIIN_RYKELMAN_MEDIAANIPOIKKEAMA_KM = 15;
  const RAJA_KM = 50;

  const ryhmat = new Map<string, { pn: string; lat: number; lon: number }[]>();
  for (const [pn, [nimi, lat, lon]] of Object.entries(table)) {
    const lista = ryhmat.get(nimi) ?? [];
    lista.push({ pn, lat, lon });
    ryhmat.set(nimi, lista);
  }

  const harhautuneet: string[] = [];
  let tarkastettuja = 0;
  for (const [nimi, jasenet] of ryhmat) {
    if (jasenet.length < MIN_RYHMAKOKO) continue;
    const kp: [number, number] = [mediaani(jasenet.map((j) => j.lat)), mediaani(jasenet.map((j) => j.lon))];
    const poikkeamat = jasenet.map((j) => etaisyysKm([j.lat, j.lon], kp));
    if (mediaani(poikkeamat) > TIIVIIN_RYKELMAN_MEDIAANIPOIKKEAMA_KM) continue;

    tarkastettuja += 1;
    jasenet.forEach((j, i) => {
      const d = poikkeamat[i] as number;
      if (d > RAJA_KM) harhautuneet.push(`${j.pn} ${nimi}: ${d.toFixed(1)} km samannimisten mediaanista`);
    });
  }

  assert.ok(tarkastettuja > 50, `tarkistettavia tiiviitä nimiryhmiä oli vain ${tarkastettuja} — tarkistus ei purrut`);
  assert.deepEqual(harhautuneet, [], `postinumeroita jotka osoittavat kauas samannimisistään:\n  ${harhautuneet.join("\n  ")}`);
  console.log(`ok  yksikään rivi ei ole yli ${RAJA_KM} km samannimisistään (${tarkastettuja} tiivistä nimiryhmää)`);
}

/** Korjausloki ja aineisto vastaavat toisiaan, ja jokaisella merkinnällä on perustelu. */
function testCorrectionLogMatchesData(): void {
  assert.ok(loki.korjatut.length > 0, "korjauslistan on oltava epätyhjä — muuten jälki on kadonnut");

  for (const k of loki.korjatut) {
    const rivi = table[k.postinumero];
    assert.ok(rivi, `korjattu ${k.postinumero} puuttuu aineistosta — korjaus ei saa pudottaa riviä`);
    assert.equal(rivi[0], k.paikka, `${k.postinumero}: paikannimi ei saa muuttua korjauksessa`);
    assert.deepEqual([rivi[1], rivi[2]], k.jalkeen, `${k.postinumero}: aineistossa eri koordinaatti kuin loki lupaa`);
    assert.notDeepEqual([rivi[1], rivi[2]], k.ennen, `${k.postinumero}: korjaus ei ole mennyt läpi`);
    assert.ok(k.todiste && k.todiste.length > 20, `${k.postinumero}: korjaukselle on kirjattava todiste`);
    assert.ok(
      Math.abs(etaisyysKm(k.ennen, k.jalkeen) - k.siirtymaKm) < 1.0,
      `${k.postinumero}: kirjattu siirtymä ${k.siirtymaKm} km ei vastaa koordinaattien eroa`,
    );
  }
  for (const k of loki.poistetut) {
    assert.equal(table[k.postinumero], undefined, `poistetun ${k.postinumero} ei pidä olla aineistossa`);
    assert.equal(lookupPostalCode(k.postinumero), null, `${k.postinumero}: haun on palautettava null`);
  }
  for (const k of loki.lisatyt) {
    const rivi = table[k.postinumero];
    assert.ok(rivi, `lisätty ${k.postinumero} puuttuu aineistosta`);
    assert.deepEqual([rivi[1], rivi[2]], k.koordinaatti, `${k.postinumero}: eri koordinaatti kuin loki lupaa`);
    const lahde = table[k.kopioituKoodilta];
    assert.ok(lahde, `${k.postinumero}: lähderivi ${k.kopioituKoodilta} puuttuu`);
    assert.deepEqual(
      [rivi[1], rivi[2]], [lahde[1], lahde[2]],
      `${k.postinumero}: koordinaatin pitää olla sama kuin lähderivillä ${k.kopioituKoodilta}`,
    );
    assert.ok(k.peruste && k.peruste.length > 20, `${k.postinumero}: lisäykselle on kirjattava peruste`);
  }
  for (const k of loki.vanhentuneetKoodit.koodit) {
    const rivi = table[k.postinumero];
    assert.ok(rivi, `vanhentunut koodi ${k.postinumero} puuttuu aineistosta — sen piti SÄILYÄ, poista merkintä`);
    assert.deepEqual([rivi[1], rivi[2]], k.koordinaatti, `${k.postinumero}: koordinaatti ei vastaa lokia`);
  }
  for (const k of loki.tunnetutPuutteet) {
    assert.equal(table[k.postinumero], undefined, `tunnettu puute ${k.postinumero} onkin aineistossa — poista merkintä`);
    assert.ok(k.syy && k.syy.length > 20, `${k.postinumero}: puutteelle on kirjattava syy`);
  }
  for (const k of loki.hyvaksytytPoikkeamat) {
    assert.ok(table[k.postinumero], `hyväksytty poikkeama ${k.postinumero} puuttuu aineistosta — poista merkintä`);
    assert.ok(k.syy && k.syy.length > 20, `${k.postinumero}: hyväksytylle poikkeamalle on kirjattava syy`);
  }

  console.log(
    `ok  korjausloki vastaa aineistoa (${loki.korjatut.length} siirrettyä, ${loki.poistetut.length} poistettua, ` +
    `${loki.lisatyt.length} lisättyä, ${loki.vanhentuneetKoodit.koodit.length} säilytettyä vanhentunutta, ` +
    `${loki.hyvaksytytPoikkeamat.length} hyväksyttyä poikkeamaa)`,
  );
}

/**
 * Kattavuus ja koskemattomuus: korjaus ei saa liikuttaa mitään muuta.
 *
 * Alaraja on 3608: yksi rivi poistettiin (97999, jonka koordinaatti oli
 * myös väärin) ja yksi lisättiin (22110). Lakkautetut mutta koordinaatiltaan
 * oikeat koodit SÄILYTETÄÄN — ks. korjauslokin `vanhentuneetKoodit`.
 */
function testCorrectionDidNotCostCoverage(): void {
  assert.ok(postalTableSize() >= 3608, `aineistossa ${postalTableSize()} koodia — kattavuus on laskenut`);

  const helsinki = lookupPostalCode("00100");
  const lokero = lookupPostalCode("00101");
  assert.ok(helsinki && lokero);
  assert.equal(lokero.place, "Helsinki");
  assert.ok(etaisyysKm([lokero.latitude, lokero.longitude], [helsinki.latitude, helsinki.longitude]) < 15);

  const seinajoki = lookupPostalCode("60100");
  const korjattu = lookupPostalCode("60110");
  assert.ok(seinajoki && korjattu);
  assert.ok(
    etaisyysKm([korjattu.latitude, korjattu.longitude], [seinajoki.latitude, seinajoki.longitude]) < 10,
    "60110 on yhä kaukana Seinäjoen muista koodeista",
  );

  // Koskemattomat rivit. 99600 on tässä siksi, että Paavon ALUEKESKIPISTE olisi
  // 40,1 km pohjoisempana erämaassa — GeoNamesin piste on taajamassa, ja sään
  // kannalta taajama on oikea. Jos joku joskus vaihtaa lähteeksi keskipisteet,
  // tämä rivi huomaa sen.
  assert.ok(Math.abs(helsinki.latitude - 60.1714) < 0.001, `00100 on siirtynyt: ${helsinki.latitude}`);
  const sodankyla = lookupPostalCode("99600");
  assert.ok(sodankyla && Math.abs(sodankyla.latitude - 67.4843) < 0.01, "99600 on siirtynyt Paavon keskipisteeseen");
  const maarianhamina = lookupPostalCode("22100");
  assert.ok(maarianhamina && Math.abs(maarianhamina.latitude - 60.0997) < 0.05, "22100 on siirtynyt");

  console.log(`ok  kattavuus ${postalTableSize()} koodia, koskemattomat rivit ennallaan (00100, 99600, 22100)`);
}

// --------------------------------------------------------------- verkolliset

class VerkkoVirhe extends Error {}

async function hae(url: string, kuvaus: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new VerkkoVirhe(`${kuvaus}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new VerkkoVirhe(`${kuvaus}: HTTP ${res.status}`);
  return res;
}

const PAAVO = "https://geo.stat.fi/geoserver/postialue/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeName=postialue:pno_2026&outputFormat=application/json&srsName=EPSG:4326";

type Bbox = [number, number, number, number];
type Rengas = [number, number][];

/** 0 jos piste on laatikon sisällä, muuten etäisyys sen reunaan kilometreinä. */
function bboxEtaisyys(lon: number, lat: number, bb: Bbox): number {
  const dx = Math.max(bb[0] - lon, 0, lon - bb[2]) * 111.32 * Math.cos(lat * rad);
  const dy = Math.max(bb[1] - lat, 0, lat - bb[3]) * 110.57;
  return Math.hypot(dx, dy);
}

function renkaassa(x: number, y: number, r: Rengas): boolean {
  let s = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
    const [xi, yi] = r[i] as [number, number];
    const [xj, yj] = r[j] as [number, number];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) s = !s;
  }
  return s;
}
function monikulmiossa(lon: number, lat: number, polys: Rengas[][]): boolean {
  for (const poly of polys) {
    if (!renkaassa(lon, lat, poly[0] as Rengas)) continue;
    let reika = false;
    for (let r = 1; r < poly.length; r += 1) if (renkaassa(lon, lat, poly[r] as Rengas)) { reika = true; break; }
    if (!reika) return true;
  }
  return false;
}
/** Etäisyys monikulmion lähimpään reunaan kilometreinä (tasoprojektio). */
function reunaEtaisyys(lon: number, lat: number, polys: Rengas[][]): number {
  const kx = 111.32 * Math.cos(lat * rad);
  const ky = 110.57;
  const px = lon * kx;
  const py = lat * ky;
  let min = Infinity;
  for (const poly of polys) for (const r of poly) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
      const a = r[j] as [number, number];
      const b = r[i] as [number, number];
      const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Kaksisuuntainen tarkistus Postin PCF:ää ja Tilastokeskuksen Paavoa vasten.
 *
 * --- Mitä mitataan -------------------------------------------------------
 * Nämä tarkistukset käyttävät POLYGONIETÄISYYTTÄ, joka on TUNNISTIN eikä
 * virheen mitta. Virheen mitta on siirtymä (ks. korjauslokin `virheenMitta`).
 * Ero on olennainen: 60110 Seinäjoen polygonietäisyys oli 0,0 km vaikka rivi
 * oli 30,2 km väärässä paikassa, koska Seinäjoki nieli Peräseinäjoen
 * kuntaliitoksessa 2009. Siksi TÄMÄ TARKISTUS EI OLISI LÖYTÄNYT 60110:tä —
 * se on korjauslistalla käsin todennettuna, ja se on kirjattu sinne näkyviin.
 *
 * --- Miksi bbox eikä täysi geometria -------------------------------------
 * Paavon monikulmiot ovat koko maalta 20 MB, laatikot 0,5 MB. Laatikko on
 * liian salliva, eli nämä tarkistukset ALIRAPORTOIVAT — ja se on oikea suunta
 * testille, joka ei saa huutaa väärästä. Kymmenien kilometrien virheet, joita
 * tässä etsitään, näkyvät laatikollakin.
 *
 * --- Suunnat -------------------------------------------------------------
 * A: aineistossa on vika jota ei ole listalla  -> kaadu ja nimeä se
 * B: listalla on merkintä jota ei enää tarvita -> kaadu ja kerro se
 */
async function testAgainstPostiAndPaavo(): Promise<void> {
  // Kynnykset. Perustelut ovat mittauksessa, ks. rakennusskriptin
  // "Tunnistimia tarvitaan kaksi" -lohko.
  const PL_PUSKURI_KM = 2;      // alle tämän on kuntarajan ja alueen reunan yleistyskohinaa
  const OMA_ALUE_PUSKURI_KM = 20; // aineiston toiseksi suurin poikkeama on 13,9 km

  // 1. PCF: mikä koodi on olemassa, missä kunnassa ja mitä tyyppiä.
  //    Tiedostonimessä on poimintapäivä (PCF_<yyyymmdd>.dat) eikä pysyvää nimeä
  //    ole, joten nimi LUETAAN hakemistolistauksesta. Päivämäärän arvaaminen
  //    tuottaisi 404:n aina kun aineistoa ei ole päivitetty tänään, ja tämä
  //    tarkistus lakkaisi ajautumasta huomaamatta.
  const listaus = await (await hae("https://www.posti.fi/webpcode/unzip/", "PCF-hakemistolistaus")).text();
  const nimi = listaus.match(/PCF_\d{8}\.dat/)?.[0];
  if (!nimi) throw new VerkkoVirhe("PCF-tiedoston nimeä ei löytynyt hakemistolistauksesta");
  const pcfTeksti = Buffer.from(
    await (await hae(`https://www.posti.fi/webpcode/unzip/${nimi}`, "PCF")).arrayBuffer(),
  ).toString("latin1");

  const pcf = new Map<string, { kunta: string; kuntakoodi: string; tyyppi: string }>();
  for (const rivi of pcfTeksti.split(/\r?\n/)) {
    if (rivi.length < 220) continue;
    const pn = rivi.substr(13, 5).trim();
    if (!/^\d{5}$/.test(pn)) continue;
    pcf.set(pn, { kunta: rivi.substr(179, 20).trim(), kuntakoodi: rivi.substr(176, 3).trim(), tyyppi: rivi.substr(110, 1) });
  }
  if (pcf.size < 3000) throw new VerkkoVirhe(`PCF:stä tuli vain ${pcf.size} riviä`);

  // 2. Paavo: alueiden laatikot ja kuntakoodit yhdellä 0,5 MB:n haulla.
  const laatikot = await (await hae(`${PAAVO}&propertyName=${encodeURIComponent("posti_alue,kunta")}`, "Paavo")).json();
  if (laatikot.numberMatched !== laatikot.numberReturned) throw new VerkkoVirhe("Paavo katkaisi vastauksen");
  const kunnittain = new Map<string, Bbox[]>();
  const alueenLaatikko = new Map<string, Bbox>();
  for (const f of laatikot.features ?? []) {
    if (!f.bbox) continue;
    const pn = f.properties?.posti_alue as string;
    const k = String(f.properties?.kunta ?? "").padStart(3, "0");
    alueenLaatikko.set(pn, f.bbox as Bbox);
    const lista = kunnittain.get(k) ?? [];
    lista.push(f.bbox as Bbox);
    kunnittain.set(k, lista);
  }

  const tunnetut = new Set([
    ...loki.korjatut.map((k) => k.postinumero),
    ...loki.poistetut.map((k) => k.postinumero),
    ...loki.hyvaksytytPoikkeamat.map((k) => k.postinumero),
    ...loki.vanhentuneetKoodit.koodit.map((k) => k.postinumero),
  ]);

  // ================= SUUNTA A: vika jota ei ole listalla =================
  const uudetViat: string[] = [];

  // A1. Jokaisen niputetun koodin on oltava olemassa Postin rekisterissä.
  //     Lakkautettu koodi näyttää aineistossa täysin kelvolliselta ja sääkortti
  //     esittää sille paikkakunnan — väärää tietoa ilman merkintää.
  for (const pn of Object.keys(table)) {
    if (!pcf.has(pn) && !tunnetut.has(pn)) {
      uudetViat.push(`${pn} ${table[pn]?.[0]}: Posti ei tunne koodia — lakkautettu, kuuluu poistaa`);
    }
  }

  // A2. Tunnistin 1 — PL-koodi oman kuntansa ulkopuolella.
  let plMitattuja = 0;
  for (const [pn, [paikka, lat, lon]] of Object.entries(table)) {
    const p = pcf.get(pn);
    if (!p || p.tyyppi !== "2") continue;
    const bbs = kunnittain.get(p.kuntakoodi);
    if (!bbs) continue;
    plMitattuja += 1;
    let min = Infinity;
    for (const bb of bbs) { const d = bboxEtaisyys(lon, lat, bb); if (d < min) min = d; if (min === 0) break; }
    if (min > PL_PUSKURI_KM && !tunnetut.has(pn)) {
      uudetViat.push(`${pn} ${paikka}: PL-koodi ${min.toFixed(2)} km oman kuntansa (${p.kunta}) ulkopuolella`);
    }
  }

  // A3. Tunnistin 2 — koodilla on oma alue, mutta piste on kaukana sen ulkopuolella.
  let alueMitattuja = 0;
  for (const [pn, [paikka, lat, lon]] of Object.entries(table)) {
    const bb = alueenLaatikko.get(pn);
    if (!bb) continue;
    alueMitattuja += 1;
    const d = bboxEtaisyys(lon, lat, bb);
    if (d > OMA_ALUE_PUSKURI_KM && !tunnetut.has(pn)) {
      uudetViat.push(`${pn} ${paikka}: ${d.toFixed(1)} km oman postinumeroalueensa ulkopuolella`);
    }
  }

  assert.ok(plMitattuja > 400, `PL-koodeja mitattiin vain ${plMitattuja}`);
  assert.ok(alueMitattuja > 2500, `omalla alueella olevia koodeja mitattiin vain ${alueMitattuja}`);
  assert.deepEqual(
    uudetViat,
    [],
    "Aineistossa on vikoja joita ei ole korjauslistalla. Tarkista kukin ja lisää joko " +
    `korjattaviin, poistettaviin tai hyväksyttyihin poikkeamiin (skriptit/rakenna-postinumerot.mjs):\n  ${uudetViat.join("\n  ")}`,
  );

  // ================= SUUNTA B: merkintä jota ei enää tarvita ==============
  const vanhentuneet: string[] = [];

  // B1. Korjatun ja hyväksytyn koodin on yhä oltava Postin rekisterissä.
  //     Jos koodi lakkautetaan, sitä ei pidä korjata vaan poistaa.
  for (const k of [...loki.korjatut, ...loki.hyvaksytytPoikkeamat]) {
    if (!pcf.has(k.postinumero)) {
      vanhentuneet.push(`${k.postinumero} ${k.paikka}: Posti ei enää tunne koodia — siirrä se poistettaviin`);
    }
  }
  // B2. Poistetun koodin on yhä oltava poissa Postin rekisteristä. Jos koodi
  //     palaa käyttöön, poisto on vanhentunut ja rivi kuuluu takaisin.
  for (const k of loki.poistetut) {
    if (pcf.has(k.postinumero)) {
      vanhentuneet.push(`${k.postinumero} ${k.paikka}: Posti tuntee koodin taas — poisto on vanhentunut, palauta rivi`);
    }
  }
  // B3. Lisätyn koodin on yhä oltava olemassa; muuten lisäys on turha.
  for (const k of loki.lisatyt) {
    if (!pcf.has(k.postinumero)) {
      vanhentuneet.push(`${k.postinumero} ${k.paikka}: Posti ei tunne koodia — lisäys on vanhentunut, poista merkintä`);
    }
  }
  // B3b. Vanhentuneeksi merkityn koodin on yhä oltava poissa Postin
  //      rekisteristä. Jos Posti ottaa koodin takaisin käyttöön, merkintä on
  //      turha ja rivi on taas tavallinen.
  for (const k of loki.vanhentuneetKoodit.koodit) {
    if (pcf.has(k.postinumero)) {
      vanhentuneet.push(
        `${k.postinumero} ${k.paikka}: Posti tuntee koodin taas — se ei ole enää vanhentunut, poista merkintä`,
      );
    }
  }
  // B3c. Tunnetuksi puutteeksi merkityn koodin on yhä oltava olemassa Postilla
  //      mutta poissa aineistosta; muuten merkintä on turha.
  for (const k of loki.tunnetutPuutteet) {
    if (!pcf.has(k.postinumero)) {
      vanhentuneet.push(`${k.postinumero} ${k.paikka}: Posti ei tunne koodia — puute on poistunut, poista merkintä`);
    }
  }
  // B4. Korjatun PL-rivin VANHAN koordinaatin on yhä oltava kuntansa
  //     ulkopuolella. Jos ei ole, lähde on korjannut virheen ja merkintä on turha.
  //
  //     Tässä EI voi käyttää laatikoita kuten suunnassa A. Laatikko on liian
  //     salliva, ja suunnassa A se on turvallinen (aliraportoi), mutta täällä
  //     se väittäisi merkintää turhaksi vaikka se ei ole: mitattuna 87101:n
  //     vanha piste on 5,97 km kuntansa monikulmion ulkopuolella mutta 0,00 km
  //     sen laatikoista. Siksi näille haetaan oikea geometria — vain niiden
  //     kuntien osalta joita lista koskee, mikä on 0,6 MB koko maan 20 MB:n sijaan.
  const korjatutPl = loki.korjatut
    .map((k) => ({ k, p: pcf.get(k.postinumero) }))
    .filter((x): x is { k: typeof loki.korjatut[number]; p: { kunta: string; kuntakoodi: string; tyyppi: string } } =>
      x.p !== undefined && x.p.tyyppi === "2");
  const kuntakoodit = [...new Set(korjatutPl.map((x) => x.p.kuntakoodi))];
  if (kuntakoodit.length > 0) {
    const suodatin = `kunta IN (${kuntakoodit.map((k) => `'${k}'`).join(",")})`;
    const geom = await (await hae(`${PAAVO}&CQL_FILTER=${encodeURIComponent(suodatin)}`, "Paavo (geometria)")).json();
    const kunnanMonikulmiot = new Map<string, Rengas[][]>();
    for (const f of geom.features ?? []) {
      if (!f.geometry) continue;
      const k = String(f.properties?.kunta ?? "").padStart(3, "0");
      const polys: Rengas[][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      kunnanMonikulmiot.set(k, [...(kunnanMonikulmiot.get(k) ?? []), ...polys]);
    }
    for (const { k, p } of korjatutPl) {
      const polys = kunnanMonikulmiot.get(p.kuntakoodi);
      if (!polys) continue;
      const sisalla = monikulmiossa(k.ennen[1], k.ennen[0], polys);
      const d = sisalla ? 0 : reunaEtaisyys(k.ennen[1], k.ennen[0], polys);
      if (d <= PL_PUSKURI_KM) {
        vanhentuneet.push(
          `${k.postinumero} ${k.paikka}: vanha koordinaatti ${k.ennen[0]}/${k.ennen[1]} ei ole enää ` +
          `kuntansa (${p.kunta}) ulkopuolella (${d.toFixed(2)} km) — lähde on ehkä korjannut rivin, tarkista merkintä`,
        );
      }
    }
  }

  assert.deepEqual(
    vanhentuneet,
    [],
    `Korjauslistalla on vanhentuneita merkintöjä (skriptit/rakenna-postinumerot.mjs):\n  ${vanhentuneet.join("\n  ")}`,
  );

  const vanhentuneita = loki.vanhentuneetKoodit.koodit.length;
  console.log(
    `ok  PCF+Paavo: ${Object.keys(table).length - vanhentuneita} koodia Postin rekisterissä ` +
    `(+ ${vanhentuneita} tunnettua vanhentunutta), ${plMitattuja} PL-koodia omassa kunnassaan, ` +
    `${alueMitattuja} koodia oman alueensa lähellä`,
  );
  console.log(`ok  korjauslistan ${loki.korjatut.length + loki.poistetut.length + loki.lisatyt.length + loki.hyvaksytytPoikkeamat.length} merkintää ovat yhä tarpeen`);
}

testEveryRowIsInsideFinland();
testNoRowIsStrandedFromItsNamesakes();
testCorrectionLogMatchesData();
testCorrectionDidNotCostCoverage();

try {
  await testAgainstPostiAndPaavo();
} catch (err) {
  if (!(err instanceof VerkkoVirhe)) throw err;
  console.log(`ohi  PCF+Paavo-tarkistus ohitettu, ei verkkoyhteyttä (${err.message})`);
  console.log("     Verkottomat tarkistukset ajettiin normaalisti.");
}

console.log("\nKaikki postinumeroaineiston eheystestit läpi.");
