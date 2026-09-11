/**
 * Rakentaa suomalaisten postinumeroiden hakutaulun sään sijaintia varten.
 *
 * Kaksi lahdetta, koska kumpikaan ei yksin riita:
 *   - GeoNames FI (CC BY 4.0): 3576 postinumeroa nimineen ja koordinaatteineen,
 *     mutta AHVENANMAA PUUTTUU kokonaan (22xxx). Todennettu: 22100 ei loydy.
 *   - Tilastokeskuksen Paavo (CC BY 4.0): kattaa Ahvenanmaan, mutta antaa
 *     aluenimia ("Karstula Keskus") eika postitoimipaikkoja, joten sita
 *     kaytetaan VAIN paikkaamaan GeoNamesin aukko.
 *
 * Ahvenanmaan nimet tulevat Paavon SUOMENKIELISESTA nimikentasta, joten
 * 22100 on taulussa "Maarianhamina" eika postin kayttama "Mariehamn". Kaytto-
 * liittyma on suomenkielinen, joten se on tassa oikea valinta -- mutta se on
 * tietoinen valinta eika aineiston virhe, ja kannattaa muistaa jos joku
 * ihmettelee miksi haku nayttaa eri nimen kuin postin oma hakupalvelu.
 *
 * Ajetaan kasin kun aineisto halutaan paivittaa -- postinumerot muuttuvat noin
 * 0,2 % vuodessa. Loppukayttaja ei aja tata koskaan.
 *
 * --- Attribuutio (CC BY 4.0 edellyttaa) ---------------------------------
 * Postinumeroaineisto: GeoNames (https://www.geonames.org/), lisenssi CC BY 4.0
 * (https://creativecommons.org/licenses/by/4.0/). Ahvenanmaan postinumeroalueiden
 * keskipisteet: Tilastokeskus, Paavo-postinumeroalueittainen avoin tieto, lisenssi
 * CC BY 4.0. Aineistoja on muokattu: mukaan on otettu vain postinumero, paikannimi
 * ja koordinaatit.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const OUT = process.argv[2];
if (!OUT) {
  console.error("kaytto: node rakenna-postinumerot.mjs <ulostulo.json>");
  process.exit(2);
}

const GEONAMES_ZIP = "https://download.geonames.org/export/zip/FI.zip";
const PAAVO_WFS =
  "https://geo.stat.fi/geoserver/postialue/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeName=postialue:pno_2026&outputFormat=application/json&srsName=EPSG:4326" +
  "&CQL_FILTER=" + encodeURIComponent("posti_alue LIKE '22%'");

/**
 * Purku `tar`illa eika kasin kirjoitetulla zip-jasentimella. Ensimmainen
 * versio jasensi zipin itse ja luki hiljaa roskaa: 36 rivia 3576:n sijaan ja
 * nolla kelvollista postinumeroa. Tama on rakennusskripti, ei tuotantokoodia,
 * joten ulkoinen purkaja on oikea valinta -- bsdtar on Windows 10:sta lahtien
 * ja kaikissa Linux-jakeluissa.
 */
async function lataaGeoNames() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geonames-"));
  const zipPolku = path.join(tmp, "FI.zip");

  const res = await fetch(GEONAMES_ZIP);
  if (!res.ok) throw new Error(`GeoNames HTTP ${res.status}`);
  fs.writeFileSync(zipPolku, Buffer.from(await res.arrayBuffer()));

  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const purku = spawnSync(tar, ["-xf", zipPolku, "-C", tmp, "FI.txt"], { stdio: "inherit" });
  if (purku.status !== 0) throw new Error(`purku epäonnistui (koodi ${purku.status})`);

  const txt = fs.readFileSync(path.join(tmp, "FI.txt"), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });

  const taulu = {};
  let rivit = 0;
  for (const rivi of txt.split("\n")) {
    if (!rivi.trim()) continue;
    rivit += 1;
    // Sarkainerotettu: maa, postinumero, paikka, ..., lat(9), lon(10)
    const s = rivi.split("\t");
    const pn = s[1];
    const nimi = s[2];
    const lat = Number(s[9]);
    const lon = Number(s[10]);
    if (!/^\d{5}$/.test(pn) || !nimi || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Ensimmainen esiintyma voittaa: aineistossa on muutama duplikaatti.
    if (!(pn in taulu)) taulu[pn] = [nimi, Number(lat.toFixed(4)), Number(lon.toFixed(4))];
  }
  return { taulu, rivit };
}

/** Monikulmion pinta-ala ja painopiste tasokoordinaatteina (riittaa saan tarkkuudella). */
function rengas(koords) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = koords.length - 1; i < koords.length; j = i, i += 1) {
    const [x1, y1] = koords[j];
    const [x2, y2] = koords[i];
    const risti = x1 * y2 - x2 * y1;
    a += risti;
    cx += (x1 + x2) * risti;
    cy += (y1 + y2) * risti;
  }
  a /= 2;
  if (a === 0) return null;
  return { ala: Math.abs(a), x: cx / (6 * a), y: cy / (6 * a) };
}

/** Pinta-alapainotettu keskipiste: monisaarinen alue ei saa painottua pikkuluodoille. */
function keskipiste(geom) {
  const polygonit = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let ala = 0;
  let x = 0;
  let y = 0;
  for (const poly of polygonit) {
    const r = rengas(poly[0]); // ulkorengas; reiat jatetaan huomiotta
    if (!r) continue;
    ala += r.ala;
    x += r.x * r.ala;
    y += r.y * r.ala;
  }
  return ala === 0 ? null : { lon: x / ala, lat: y / ala };
}

async function lataaAhvenanmaa() {
  const res = await fetch(PAAVO_WFS);
  if (!res.ok) throw new Error(`Paavo HTTP ${res.status}`);
  const json = await res.json();
  const taulu = {};
  for (const f of json.features ?? []) {
    const pn = f.properties?.posti_alue;
    const nimi = f.properties?.nimi;
    if (!/^\d{5}$/.test(pn ?? "") || !nimi || !f.geometry) continue;
    const kp = keskipiste(f.geometry);
    if (!kp) continue;
    taulu[pn] = [String(nimi).trim(), Number(kp.lat.toFixed(4)), Number(kp.lon.toFixed(4))];
  }
  return taulu;
}

const { taulu: geo, rivit } = await lataaGeoNames();
console.log(`GeoNames: ${rivit} riviä, ${Object.keys(geo).length} kelvollista postinumeroa`);

const ahvenanmaa = await lataaAhvenanmaa();
console.log(`Paavo (22xxx): ${Object.keys(ahvenanmaa).length} aluetta`);

let lisatty = 0;
for (const [pn, arvo] of Object.entries(ahvenanmaa)) {
  if (pn in geo) continue; // GeoNames voittaa: sen nimet ovat postitoimipaikkoja
  geo[pn] = arvo;
  lisatty += 1;
}
console.log(`Ahvenanmaalta lisätty ${lisatty} postinumeroa joita GeoNamesissa ei ollut`);

const jarjestetty = Object.fromEntries(Object.keys(geo).sort().map((k) => [k, geo[k]]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(jarjestetty));
const koko = fs.statSync(OUT).size;
console.log(`\nkirjoitettu ${OUT}`);
console.log(`  postinumeroita : ${Object.keys(jarjestetty).length}`);
console.log(`  koko           : ${koko} tavua (${zlib.gzipSync(fs.readFileSync(OUT)).length} gzipattuna)`);
