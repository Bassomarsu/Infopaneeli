#!/usr/bin/env node
// skriptit/tee-julkaisu.mjs
//
// Rakentaa Infonäytön asennuspaketit (Windows ja Linux) koneelle, jolla EI
// ole Node.js:ää eikä npm:ää asennettuna — paketti sisältää oman niputetun
// Node-ajonaikaisen ympäristönsä.
//
// Paketin juuren rakenne EI ole tämän skriptin päätettävissä: se on sidottu
// server/src/core/config.ts:n polkupäättelyyn (serverRoot = server/src/../..,
// projectRoot = serverRoot/..). Jos rakennetta pitää muuttaa, muutos alkaa
// config.ts:stä, ei täältä.
//
// Käyttö: npm run release (ajetaan projektin juuresta)

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const isWindows = process.platform === "win32";

// Windowsilla EI luoteta pelkkään "tar" PATH-hakuun: Git for Windowsin oma
// usr/bin/tar.exe (vanhempi libarchive-käännös) tulkitsee "G:\..."-tyyppiset
// polut virheellisesti etäarkistoksi ("Cannot connect to G: resolve failed"),
// jos se sattuu olemaan PATHilla ennen Windowsin omaa System32\tar.exeä —
// juuri näin kävi tätä skriptiä kehitettäessä. Windowsin sisäänrakennettu
// bsdtar (System32\tar.exe, mukana Windows 10 1803:sta lähtien) osaa nämä
// polut oikein, joten käytetään sitä suoraan absoluuttisella polulla PATH-
// järjestyksestä riippumatta.
const TAR_CMD = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

// --- Node-versio -----------------------------------------------------------
//
// Naulattu tarkkaan versioon eikä esim. "uusin 24.x" haettuna ajonaikaisesti,
// jotta koonti on toistettavissa kuukausienkin päästä samalla tuloksella.
// Päivitä tätä vakiota TIETOISESTI, ei automaattisesti osana koontia.
//
// Miksi juuri 24.19.0:
//   - Juuren package.json vaatii "engines.node": ">=24.0.0" — palvelin ajaa
//     server/src/*.ts-tiedostot suoraan Node.n natiivilla type strippingillä,
//     EI transpiloi mitään etukäteen (ks. server/package.json "start"-skripti).
//   - Type stripping toimii ilman komentorivilippua tässä koodikannassa
//     tarkoituksella: server/tsconfig.json rajaa syntaksin
//     "erasableSyntaxOnly": true -tilaan juuri tätä varten. Se vaatii Node
//     22.7:ää uudemman, ja 24 on pienin pääversio jonka projektin
//     engines-kenttä sallii — pienempää ei siis pidä pakata, vaikka se
//     teknisesti toimisikin.
//   - 24.19.0 on Node 24 -linjan ("Krypton") tuorein LTS-julkaisu tätä
//     skriptiä viimeksi päivitettäessä (elokuu 2026). LTS eikä "Current",
//     koska paketti asennetaan laitteelle joka pyörii kuukausia ilman
//     valvontaa — ei kannata niputtaa versiota jonka tukiaika on lyhyt.
const NODE_VERSION = "24.19.0";

const PLATFORMS = [
  {
    id: "win-x64",
    archiveFile: `node-v${NODE_VERSION}-win-x64.zip`,
    distDirName: `node-v${NODE_VERSION}-win-x64`,
    binInDist: "node.exe",
    binInPkg: "node.exe",
    packageExt: "zip",
  },
  {
    id: "linux-x64",
    archiveFile: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    distDirName: `node-v${NODE_VERSION}-linux-x64`,
    binInDist: "bin/node",
    binInPkg: "bin/node",
    packageExt: "tar.gz",
  },
];

// julkaisu-valimuisti/node    — ladatut & tarkistetut Node-jakelut (pysyvä välimuisti)
// julkaisu-valimuisti/tyo     — koonnin työtila (tyhjennetään joka ajolla)
// julkaisu                   — valmiit paketit
const cacheDir = path.join(repoRoot, "julkaisu-valimuisti");
const nodeCacheDir = path.join(cacheDir, "node");
const workDir = path.join(cacheDir, "tyo");
const outDir = path.join(repoRoot, "julkaisu");

// Synkroninen vaihemerkki: console.log puskuroituu kun tuloste menee putkeen,
// ja puskuri katoaa jos prosessi tapetaan äkisti. writeSync kirjoittaa heti.
function step(msg) {
  fs.writeSync(1, `[VAIHE] ${msg}
`);
}

function fail(message) {
  console.error(`\n✖ KOONTI KESKEYTETTY: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: "inherit",
    // npm on Windows on .cmd-tiedosto — spawnSync ei löydä sitä ilman shelliä.
    // TAR_CMD sen sijaan on aina suora .exe-polku, joten se ajetaan ILMAN
    // shelliä: cmd.exe:n kautta kiertäminen on paitsi turhaa, myös riski —
    // ks. TAR_CMD:n kommentti siitä miten PATH-järjestys voi tuoda väärän
    // tar.exe:n väliin.
    shell: opts.shell ?? isWindows,
    env: opts.env,
  });
  if (result.error) {
    fail(`Komennon käynnistys epäonnistui: ${cmd} — ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Komento epäonnistui (koodi ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function gitOutput(args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", shell: isWindows });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function checkGit() {
  const status = gitOutput(["status", "--porcelain"]);
  const commit = gitOutput(["rev-parse", "--short", "HEAD"]) ?? "tuntematon";
  if (status === null) {
    console.warn("⚠ Git-tilaa ei saatu selville (ei git-repo?) — jatketaan silti.");
    return { clean: true, commit };
  }
  const clean = status.length === 0;
  if (!clean) {
    console.warn(
      "⚠ Työpuu on LIKAINEN (tallentamattomia muutoksia). Koonti ei ole " +
        "toistettavissa tästä tilasta — paketti sisältää levyllä olevan\n" +
        "  sisällön, ei viimeisimmän commitin sisältöä. Tämä EI keskeytä " +
        "koontia, mutta VERSIO.txt merkitsee tilan.",
    );
  }
  return { clean, commit };
}

// --- Node-jakelun lataus ja tarkiste ---------------------------------------

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`Lataus epäonnistui (${res.status} ${res.statusText}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadShasums() {
  fs.mkdirSync(nodeCacheDir, { recursive: true });
  const cachePath = path.join(nodeCacheDir, `SHASUMS256.txt-v${NODE_VERSION}`);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf8");
  }
  console.log(`Ladataan SHASUMS256.txt (Node v${NODE_VERSION})...`);
  const buf = await fetchBuffer(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
  fs.writeFileSync(cachePath, buf);
  return buf.toString("utf8");
}

function expectedSha(shasums, filename) {
  const line = shasums.split("\n").find((l) => l.trim().endsWith(`  ${filename}`));
  if (!line) {
    fail(
      `SHASUMS256.txt ei sisällä riviä tiedostolle ${filename}. Node-versio ` +
        `${NODE_VERSION} on väärä tai nodejs.org muutti tiedoston muotoa — ` +
        `ei arvata, keskeytetään.`,
    );
  }
  return line.trim().split(/\s+/)[0].toLowerCase();
}

// Lataa (tai käyttää välimuistista) yhden alustan Node-jakelun ja tarkistaa
// SHA256:n SHASUMS256.txt:tä vasten JOKA kerta, myös välimuistiosumalla —
// ei luoteta siihen että levyllä oleva tiedosto on pysynyt ehjänä.
// Tämä EI ole valinnainen: paketti asennetaan perheen koneelle ja ajaa
// Wilma-salasanaa, joten väärennetty tai korruptoitunut Node-binääri ei saa
// päätyä pakettiin huomaamatta. Palauttaa myös tarkistetun SHA256:n, koska
// VERSIO.txt kirjaa sen ylös (ks. buildVersionManifest).
async function ensureNodeArchive(platform, shasums) {
  const dest = path.join(nodeCacheDir, platform.archiveFile);
  const expected = expectedSha(shasums, platform.archiveFile);

  if (!fs.existsSync(dest)) {
    console.log(`Ladataan ${platform.archiveFile}...`);
    const buf = await fetchBuffer(`https://nodejs.org/dist/v${NODE_VERSION}/${platform.archiveFile}`);
    fs.writeFileSync(dest, buf);
  } else {
    console.log(`${platform.archiveFile} löytyi välimuistista (${nodeCacheDir}).`);
  }

  const actual = sha256File(dest);
  if (actual !== expected) {
    fs.rmSync(dest, { force: true }); // ei jätetä viallista tiedostoa välimuistiin
    fail(
      `SHA256 EI TÄSMÄÄ tiedostolle ${platform.archiveFile}!\n` +
        `  odotettu (SHASUMS256.txt): ${expected}\n` +
        `  saatu:                     ${actual}\n` +
        `Tämä on eheystarkistuksen katkos, ei satunnainen virhe — koontia ei jatketa.`,
    );
  }
  console.log(`✓ SHA256 täsmää: ${platform.archiveFile}`);
  return { path: dest, sha256: actual };
}

// Poimii yhden tiedoston jakelun sisältä (esim. "node-v24.19.0-win-x64/node.exe")
// säilyttäen alkuperäisen sisällön tavu tavulta. Käyttää järjestelmän tar-
// komentoa (Windows 10 1803+: sisäänrakennettu bsdtar), joka tunnistaa sekä
// zipin että gzipatun tarin automaattisesti riippumatta tiedostopäätteestä.
function extractSingleFile(archivePath, entryName, destFilePath) {
  const tmpDir = fs.mkdtempSync(path.join(workDir, "extract-"));
  run(TAR_CMD, ["-xf", archivePath, "-C", tmpDir, entryName], { shell: false });
  const extracted = path.join(tmpDir, entryName);
  if (!fs.existsSync(extracted)) {
    fail(`Odotettua tiedostoa ei löytynyt jakelusta: ${entryName} (${archivePath})`);
  }
  fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
  fs.copyFileSync(extracted, destFilePath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Tuotantoriippuvuudet ----------------------------------------------------

function findNativeModules(dir) {
  const found = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        found.push(path.relative(repoRoot, full));
      }
    }
  }
  walk(dir);
  return found;
}

// Asentaa tuotantoriippuvuudet SUORAAN pakettiin (stagingRoot/node_modules),
// ei väliaikaishakemistoon josta kopioitaisiin — kopiointi tuhansien
// node_modules-tiedostojen yli oli juuri se vaihe joka hidasti koontia
// minuutteja ja törmäsi Windowsin ohimeneviin tiedostolukkoihin (ks.
// copyTree). Asennus tehdään ERIKSEEN per alusta (kahdesti npm ci, kerran
// per paketti) — tämä on tietoinen valinta kopioinnin sijaan, vaikka
// node_modulesin sisältö onkin alustariippumaton (node:sqlite on Node 24:n
// sisäänrakennettu, ei natiivimoduuli, ks. server/src/core/store.ts, ja muut
// riippuvuudet on tarkistettu puhtaaksi JS:ksi alla).
function installProdDependencies(stagingRoot) {
  // server/package.json on pysyvä osa pakettia (Node tarvitsee sen
  // "type": "module" -kentän server/src:n ESM-tuontien ratkaisuun) —
  // kirjoitetaan suoraan lopulliseen paikkaansa. package.json, package-lock.json
  // ja web/package.json ovat VAIN npm ci:tä varten (työtilarakenteen
  // tunnistus) ja poistetaan heti asennuksen jälkeen.
  fs.mkdirSync(path.join(stagingRoot, "server"), { recursive: true });
  fs.mkdirSync(path.join(stagingRoot, "web"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "server", "package.json"),
    path.join(stagingRoot, "server", "package.json"),
  );
  const tempPackageJson = path.join(stagingRoot, "package.json");
  const tempLockfile = path.join(stagingRoot, "package-lock.json");
  const tempWebPackageJson = path.join(stagingRoot, "web", "package.json");
  fs.copyFileSync(path.join(repoRoot, "package.json"), tempPackageJson);
  fs.copyFileSync(path.join(repoRoot, "package-lock.json"), tempLockfile);
  fs.copyFileSync(path.join(repoRoot, "web", "package.json"), tempWebPackageJson);

  console.log("Asennetaan tuotantoriippuvuudet suoraan pakettiin (npm ci --omit=dev)...");
  run("npm", ["ci", "--omit=dev"], { cwd: stagingRoot });

  const nodeModules = path.join(stagingRoot, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    fail("npm ci --omit=dev ei tuottanut node_modules-kansiota.");
  }

  // Työtilojen omat paketit linkittyvät node_modulesiin symlinkkeinä
  // (@infonaytto/server, @infonaytto/web) jotka osoittavat tässä tapauksessa
  // näihin samoihin hakemistoihin — niitä ei tarvita (server/src on jo omalla
  // paikallaan, ei node_modulesin kautta) ja ne olisivat vain haitaksi.
  // .bin sisältää samasta syystä komentotiedostoja joita ei koskaan ajeta:
  // palvelin käynnistetään suoraan `node .../index.ts`, ei npm-skriptin kautta.
  // web/node_modules taas syntyisi vain jos jokin riippuvuus ei hoituisi
  // juuren hoiston kautta — tässä projektissa ei synny, mutta poistetaan
  // silti varmuuden vuoksi.
  fs.rmSync(path.join(nodeModules, "@infonaytto"), { recursive: true, force: true });
  fs.rmSync(path.join(nodeModules, ".bin"), { recursive: true, force: true });
  fs.rmSync(path.join(nodeModules, ".package-lock.json"), { force: true });
  fs.rmSync(path.join(stagingRoot, "web", "node_modules"), { recursive: true, force: true });

  const nativeModules = findNativeModules(nodeModules);
  if (nativeModules.length > 0) {
    fail(
      "Tuotantoriippuvuuksista löytyi natiivimoduuleja (.node-tiedostoja) — " +
        "paketti EI OLE alustariippumaton:\n" +
        nativeModules.map((f) => `  - ${f}`).join("\n"),
    );
  }
  console.log("✓ Ei natiivimoduuleja tuotantoriippuvuuksissa (node:sqlite on Node 24:n sisäänrakennettu).");

  // Väliaikaiset manifestit pois — ne eivät kuulu sitovaan pakettirakenteeseen.
  fs.rmSync(tempPackageJson, { force: true });
  fs.rmSync(tempLockfile, { force: true });
  fs.rmSync(tempWebPackageJson, { force: true });
}

// --- Tar-otsikoiden suoritusoikeuden korjaus --------------------------------
//
// NTFS:llä ei ole POSIX-suoritusoikeusbittiä, joten kun Linux-Node-binääri
// puretaan Windows-koontikoneella ja pakataan sitten uudelleen omaan
// pakettiimme, exec-bitti katoaisi matkalla (tiedosto päätyisi 0666:ksi eikä
// 0755:ksi) — Linux-kohdekoneella "Permission denied" ensimmäisellä
// käynnistysyrityksellä. Ratkaisu: puretaan/pakataan sisältö normaalisti
// levyn kautta, mutta korjataan lopullisen .tar.gz:n ustar-otsikoiden
// mode-kenttä suoraan tavutasolla juuri niille tiedostoille joiden pitää
// olla suoritettavia. Testattu erikseen: bsdtar -tvf näyttää korjauksen
// jälkeen "-rwxr-xr-x" oikealle tiedostolle.
function setExecutableBits(tarBuffer, targetNames) {
  const out = Buffer.from(tarBuffer);
  const targets = new Set(targetNames);
  const found = new Set();
  let offset = 0;
  while (offset + 512 <= out.length) {
    const header = out.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // arkiston loppumerkki

    const name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/s, "");
    const sizeStr = header.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const isRegularFile = typeflag === "0" || typeflag === "\0";

    if (isRegularFile && targets.has(name)) {
      Buffer.from("000755 \0", "latin1").copy(out, offset + 100); // mode-kenttä
      const hdr = out.subarray(offset, offset + 512);
      hdr.fill(0x20, 148, 156); // chksum lasketaan välilyönneillä täytettynä
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += hdr[i];
      Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(out, offset + 148);
      found.add(name);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { buf: out, found };
}

function fixLinuxExecutableBits(archivePath, topFolderName, platform, extraTargets) {
  const raw = fs.readFileSync(archivePath);
  const tarBuf = zlib.gunzipSync(raw);

  // Binääri on paketissa node/-hakemiston alla (extractSingleFile kirjoittaa
  // sen polkuun stagingRoot/node/<binInPkg>), joten "node/" kuuluu mukaan.
  // Ilman sitä tämä etsi polkua joka ei ole koskaan ollut olemassa — ja koska
  // puuttuva polku keskeyttää koonnin, Linux-pakettia ei syntynyt lainkaan.
  // Se on oikea käytös: ilman suoritusoikeutta paketin oma node ei käynnisty.
  const targets = [`${topFolderName}/node/${platform.binInPkg}`, ...extraTargets];
  const { buf: patched, found } = setExecutableBits(tarBuf, targets);

  const missing = targets.filter((t) => !found.has(t));
  if (missing.length > 0) {
    fail(`Suoritusoikeuden asetus epäonnistui — arkistosta ei löytynyt näitä polkuja:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
  }
  fs.writeFileSync(archivePath, zlib.gzipSync(patched));
  console.log(`✓ Suoritusoikeus (755) asetettu: ${[...found].join(", ")}`);
}

// --- Arkistointi ja tarkistus ------------------------------------------------

// Mitä työtilasta EI kuulu pakettiin. Nämä suljetaan pois ARKISTOINNISSA
// eikä poistamalla niitä työtilasta, koska poisto on osoittautunut
// epäluotettavaksi: joissakin ympäristöissä fs.rmSync palaa virheettä
// poistamatta mitään, jolloin "siivottu" tiedosto matkaa hiljaa pakettiin.
// Arkistoijan poissulku on todennettavissa valmiista arkistosta (ks.
// verifyArchiveContents), poisto ei ole.
//
//  - juuren package.json / package-lock.json / web/package.json ovat vain
//    npm ci:n työtilantunnistusta varten, eivät osa sitovaa pakettirakennetta
//  - node_modules/@infonaytto on työtilalinkki takaisin tähän samaan puuhun
//    (kahdentaisi server/- ja web/-sisällön pakettiin)
//  - node_modules/.bin sisältää komentotiedostoja joita ei koskaan ajeta:
//    palvelin käynnistetään suoraan `node .../index.ts`
//  - riippuvuuksien test/, .github/, benchmarks/ ja examples/ eivät kuulu
//    ajettavaan pakettiin, mutta poissulku ei ole tässä pelkkää siivousta:
//    ILMAN SITÄ KOONTI KAATUU. Windowsin bsdtar 3.8.8 (libarchive 3.8.8)
//    segfaulttaa tiedostoon `@fastify/send/test/fixtures/snow ☃/index.html`
//    — hakemistonimessä on U+2603. Kaatuminen on hiljainen: exit-koodi on
//    0xC0000005 eikä virheilmoituksessa lue mitään tiedostosta, ja arkisto
//    jää katkelmaksi. Rajaus `*/node_modules/*/…` pitää poissulun
//    riippuvuuksissa: oma server/-puu sisältää vain package.jsonin ja src/:n,
//    eikä siihen saa kohdistua mitään. Huom: libarchiven poissulkukuviossa
//    `*` osuu myös kauttaviivaan, joten yksi taso kattaa myös @scope-paketit.
const ARCHIVE_EXCLUDES = [
  // Asentimien testit, molemmat alustat. Pääte oli aiemmin sidottu .ps1:een,
  // jolloin Linux-asentimen testit olisivat päätyneet pakettiin — ja koonti
  // pysähtyi siihen, koska test-asenna.sh sisältää kirjaimellisen
  // WILMA_PASSWORD-arvon testifikstuurina eikä salaisuustarkistus voi erottaa
  // fikstuuria oikeasta salasanasta. Testit eivät kuulu pakettiin muutenkaan.
  "*/asennus/test-*",
  "*/package-lock.json",
  "*/node_modules/.package-lock.json",
  "*/node_modules/.bin",
  "*/node_modules/@infonaytto",
  "*/node_modules/*/test",
  "*/node_modules/*/.github",
  "*/node_modules/*/benchmarks",
  "*/node_modules/*/examples",
];

/**
 * Vite antaa jokaiselle käännökselle uudet tiivistenimet, ja web/dist
 * tyhjennetään ennen käännöstä (ks. web/package.json). Jos tyhjennys
 * epäonnistuu HILJAA — mitä `fs.rmSync` joissakin ympäristöissä tekee: palaa
 * virheettä poistamatta mitään — vanhat niput jäävät kansioon ja päätyvät
 * pakettiin. Sovellus toimii silti, koska index.html viittaa vain uusiin,
 * joten mikään ei paljasta vikaa: paketti vain lihoo käännös käännökseltä.
 * Tämä on ehtinyt tapahtua kahdesti.
 *
 * Tarkistus on viittausperustainen eikä lukumääräperustainen: kelvollinen on
 * tiedosto, johon index.html tai jokin assets-kansion CSS viittaa. Näin fontit
 * ja kuvat, joihin viitataan vain tyylitiedostosta, eivät tuota väärää
 * hälytystä.
 */
function assertNoStaleAssets(webDist) {
  const assetsDir = path.join(webDist, "assets");
  if (!fs.existsSync(assetsDir)) return;

  const files = fs.readdirSync(assetsDir);
  const sources = [fs.readFileSync(path.join(webDist, "index.html"), "utf8")];
  for (const file of files) {
    if (file.endsWith(".css")) sources.push(fs.readFileSync(path.join(assetsDir, file), "utf8"));
  }
  const referenced = sources.join("\n");

  const orphans = files.filter((file) => !referenced.includes(file));
  if (orphans.length > 0) {
    fail(
      `web/dist/assets sisältää ${orphans.length} tiedostoa joihin mikään ei viittaa — ` +
        "edellisen käännöksen jäänteitä, jotka päätyisivät pakettiin.\n" +
        `  ${orphans.slice(0, 8).join(", ")}${orphans.length > 8 ? ", …" : ""}\n` +
        "Poista web/dist kokonaan ja aja koonti uudelleen.",
    );
  }
}

function createArchive(stagingParent, topFolderName, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  const excludeArgs = ARCHIVE_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
  // -a: pakkaustapa (zip/gzip) päätellään tiedostopäätteestä.
  // Juuren package.json ja web/package.json suljetaan pois nimenomaisilla
  // poluilla, koska pelkkä "*/package.json" veisi mukanaan myös jokaisen
  // riippuvuuden oman package.jsonin — ilman niitä Node ei ratkaise moduuleja.
  const exactExcludes = [
    `${topFolderName}/package.json`,
    `${topFolderName}/web/package.json`,
  ].flatMap((p) => ["--exclude", p]);
  run(
    TAR_CMD,
    ["-a", "-cf", outFile, "--format", "ustar", ...excludeArgs, ...exactExcludes, "-C", stagingParent, topFolderName],
    { shell: false },
  );
}

// Valmiin arkiston sisältötarkistus: mitä siellä EI saa olla ja mitä siellä ON
// oltava. Kolme asiaa, ja kaikki kolme samasta syystä — vasta puretusta
// arkistosta näkee mikä oikeasti lähtee laitteelle:
//
//   1. salaisuudet eivät saa päätyä pakettiin (vaatimus 6)
//   2. sitovan pakettirakenteen pakolliset tiedostot ovat mukana
//   3. ARCHIVE_EXCLUDESin kieltämät tiedostot eivät ole mukana
//
// Nimi kertoo kaikki kolme tarkoituksella: funktio oli ennen `verifyNoSecrets`,
// ja kohdat 2 ja 3 asuivat sen sisällä nimeltä mainitsematta. Kommentit
// viittasivat niihin olemattomalla nimellä `verifyPackageContents`, joten
// koodista etsittiin tarkistusta jota ei ollut olemassa.
//
// Salaisuustarkistus etsii MERKKIJONOA "WILMA_PASSWORD=<arvo>" (.env-tyylinen
// SIJOITUS), ei pelkkää sanaa "WILMA_PASSWORD" — server/src/core/config.ts
// sisältää täysin laillisesti tekstin `str("WILMA_PASSWORD")` (ympäristö-
// muuttujan NIMI, ei arvo), ja se tiedosto kuuluu pakettiin. Pelkkä sanahaku
// olisi kaatanut jokaisen koonnin aina, myös silloin kun mitään salaista ei
// ole vuotanut.
function verifyArchiveContents(archivePath, topFolderName) {
  const verifyDir = fs.mkdtempSync(path.join(workDir, "verify-"));
  run(TAR_CMD, ["-xf", archivePath, "-C", verifyDir], { shell: false });
  const root = path.join(verifyDir, topFolderName);
  const offenders = [];
  // Etsitaan KIRJAIMELLISTA salasanaa, ei muuttujan nimea eika mallipohjaa.
  // Asennusskriptit (asenna.sh, asenna.ps1) KIRJOITTAVAT .env-tiedoston, joten
  // ne sisaltavat valttamatta rivin WILMA_PASSWORD=... jonka arvo on
  // muuttujaviittaus. Pelkka sanahaku kaatoi jokaisen koonnin naihin — ja
  // tarkistus joka kaatuu aina lakkaa olemasta tarkistus, koska se opitaan
  // ohittamaan.
  //
  // Arvo tulkitaan mallipohjaksi jos se alkaa muuttujan tunnuksella ($ % { <)
  // tai on merkkijonoyhdistely (lainausmerkki + operaattori). Kaikki muu
  // ei-tyhja arvo on kirjaimellinen ja siis vuoto.
  const SIGIL = /^["']?[$%{<]/;
  const CONCAT = /^["']\s*[+&.]/;
  function isLiteralSecret(line) {
    const m = line.match(/WILMA_PASSWORD\s*=\s*(.*)$/);
    if (!m) return false;
    const value = m[1].trim();
    if (value === "") return false;
    if (SIGIL.test(value)) return false;
    if (CONCAT.test(value)) return false;
    return true;
  }
  const textFilePattern = /\.(ts|json|js|mjs|cjs|txt|md|sh|ps1|cmd|bat)$/i;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === ".env") {
        offenders.push(`.env-tiedosto paketissa: ${path.relative(root, full)}`);
        continue;
      }
      if (textFilePattern.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        const bad = text.split(/\r?\n/).find(isLiteralSecret);
        if (bad !== undefined) {
          offenders.push(`WILMA_PASSWORD kirjaimellisena tiedostossa: ${path.relative(root, full)}`);
        }
      }
    }
  }
  walk(root);

  // Sitova pakettirakenne todennetaan VALMIISTA arkistosta, ei työtilasta:
  // asennusskriptit (asenna.ps1, asenna.sh) olettavat tasan nämä polut, ja
  // puuttuva tiedosto huomattaisiin muuten vasta kohdelaitteella.
  const required = [
    path.join("server", "src", "index.ts"),
    // Postinumeroaineisto: ilman sita sovellus KAYNNISTYY NORMAALISTI mutta
    // jokainen postinumerohaku epaonnistuu. Siksi se on pakollisten listalla
    // eika pelkastaan kopiointisuodattimen varassa (ks. copyServerSrc).
    path.join("server", "src", "data", "postinumerot.json"),
    path.join("web", "dist", "index.html"),
    "node_modules",
    "VERSIO.txt",
    path.join("asennus", "asenna.ps1"),
    path.join("asennus", "asenna.sh"),
    // Asennusohjeet viittaavat naihin nimeltä. Puuttuva tiedosto ei kaada
    // mitaan, mutta jattaa ohjeeseen kuolleen viittauksen — ja se huomattaisiin
    // vasta laitteella, jossa perustelua juuri tarvitaan.
    path.join("docs", "tietoturva.md"),
    path.join("docs", "wilma.md"),
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(root, rel))) offenders.push(`pakollinen puuttuu: ${rel}`);
  }

  // Ja se mitä EI kuulu mukaan (ks. ARCHIVE_EXCLUDES). Poissulku ilman
  // tarkistusta olisi pelkkä toive — juuri tähän kaatui aiempi versio, jossa
  // luotettiin tiedostojen poistamiseen työtilasta.
  const forbidden = [
    path.join("asennus", "test-asenna.ps1"),
    "package.json",
    "package-lock.json",
    path.join("web", "package.json"),
    path.join("node_modules", "@infonaytto"),
    path.join("node_modules", ".bin"),
  ];
  for (const rel of forbidden) {
    if (fs.existsSync(path.join(root, rel))) offenders.push(`ei kuulu pakettiin: ${rel}`);
  }

  fs.rmSync(verifyDir, { recursive: true, force: true });

  if (offenders.length > 0) {
    fail(`Pakettitarkistus epäonnistui:\n${offenders.map((o) => `  - ${o}`).join("\n")}`);
  }
  console.log("✓ Pakettitarkistus läpäisty: rakenne oikea, ei salaisuuksia eikä ylimääräistä.");
}

// --- Kopiointi ---------------------------------------------------------------

// Oma rekursiivinen kopiointi fs.cpSyncin sijaan.
//
// fs.cpSync kaatui tassa ymparistossa toistuvasti virheeseen jonka teksti on
// "Toiminto suoritettiin" (errno 0) — siis onnistumiskoodi virheena. Oire
// tuli aina samaan tiedostoon (server/src/core/alarm-sounds.ts) ja toistui
// jokaisella yrityksella, joten kyse ei ollut ohimenevasta lukosta vaan
// cpSyncin omasta kaytoksesta Windowsilla filter-funktion kanssa.
//
// readdirSync + copyFileSync tekee saman tyon ilman sita kerrosta, ja
// copyFileSync on todennettu tassa ymparistossa myos 92 MB:n binaarilla.
// Sivutuotteena virheilmoitus kertoo nyt tasmalleen minka tiedoston kohdalla
// kopiointi kaatui, mita cpSync ei kertonut.
function copyTree(label, src, dest, fileFilter) {
  let stat;
  try {
    stat = fs.statSync(src);
  } catch (err) {
    fail(`Kopioitavaa ei loydy (${label}): ${src} — ${err.message}`);
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(label, path.join(src, entry.name), path.join(dest, entry.name), fileFilter);
    }
    return;
  }

  if (fileFilter && !fileFilter(src)) return;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (err) {
    fail(`Kopiointi epaonnistui (${label}): ${src} -> ${dest} — ${err.message}`);
  }
}

function copyServerSrc(destDir) {
  // Puolustava suodatin: server/src sisaltaa lahdekoodin lisaksi niputetun
  // postinumeroaineiston (server/src/data/postinumerot.json), mutta ei mitaan
  // muuta — jos joku pudottaa sinne editorin roskatiedoston (.DS_Store yms.),
  // se ei saa paatya pakettiin.
  //
  // .json on tassa listassa siksi etta ILMAN SITA AINEISTO JAISI POIS
  // HILJAA: kehityksessa kaikki toimisi, mutta tuotannossa jokainen
  // postinumero olisi "ei loydy" eika mikaan kertoisi miksi. Sama tiedosto on
  // myos verifyArchiveContentsin pakollisten listalla, jotta puuttuminen
  // pysayttaa koonnin sen sijaan etta se huomattaisiin kohdelaitteella.
  copyTree("server/src", path.join(repoRoot, "server", "src"), destDir, (f) => f.endsWith(".ts") || f.endsWith(".json"));
}

function copyDir(label, src, dest, fileFilter) {
  copyTree(label, src, dest, fileFilter);
}

/**
 * Asentimien testit eivät kuulu ajettavaan pakettiin. Suodatus tehdään jo
 * lavastusvaiheessa eikä vasta arkistoitaessa, jotta KAIKKI myöhemmät vaiheet
 * näkevät saman todellisuuden: pelkkä arkiston poissulku jätti tiedostot
 * lavastukseen, jolloin suoritusoikeuslista poimi test-asenna.sh:n ja koonti
 * pysähtyi siihen ettei sitä löytynyt valmiista arkistosta.
 */
function eiAsentimenTesti(polku) {
  return !path.basename(polku).startsWith("test-");
}

// --- VERSIO.txt ja LUEMINUT.txt ---------------------------------------------

// Vaatimus 5: sovelluksen versio, niputetun Noden versio JA SHA256, koontipäivä,
// tiedostojen lukumäärä ja yhteiskoko. EI tiedostokohtaisia tarkisteita — ne
// olisivat tuhansia rivejä (koko node_modules) eivätkä vastaisi siihen
// kysymykseen johon tämän tiedoston on tarkoitus vastata ("mitä laitteelle
// asennettiin"); siihen vastaa arkiston oma SHA256, joka on arkiston vieressä
// SHA256SUMS.txt-tiedostossa (VERSIO.txt on arkiston SISÄLLÄ eikä voi siis
// sisältää oman arkistonsa tarkistetta).
function buildVersionManifest({ appVersion, platform, gitInfo, nodeArchiveSha, stagingRoot }) {
  let fileCount = 0;
  let totalBytes = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        fileCount++;
        totalBytes += fs.statSync(full).size;
      }
    }
  }
  walk(stagingRoot);

  const header = [
    "Infonäyttö — julkaisupaketti",
    "=============================",
    "",
    `Sovelluksen versio:      ${appVersion}`,
    `Alusta:                  ${platform.id}`,
    `Niputettu Node:          v${NODE_VERSION}`,
    `Niputetun Noden SHA256:  ${nodeArchiveSha}  (${platform.archiveFile}, tarkistettu SHASUMS256.txt:tä vasten)`,
    `Koontipäivä (UTC):       ${new Date().toISOString()}`,
    `Git-commit:              ${gitInfo.commit}${gitInfo.clean ? "" : "  (TYÖPUU OLI LIKAINEN koontihetkellä)"}`,
    `Tiedostoja paketissa:    ${fileCount}`,
    `Yhteiskoko (pakkaamaton): ${formatBytes(totalBytes)}`,
    "",
    "Tämän arkiston oman SHA256-tarkisteen näet julkaisu/SHA256SUMS.txt-",
    "tiedostosta — sillä voi todeta että laitteelle asennettu arkisto on",
    "juuri se joka täällä koottiin.",
    "",
  ];

  return header.join("\n");
}

function buildReadme({ appVersion, platform }) {
  const installGuide = platform.id === "win-x64" ? "asennus/KAYTTOONOTTO.md" : "asennus/KAYTTOONOTTO-LINUX.md";
  return [
    `Infonäyttö ${appVersion} — asennuspaketti (${platform.id})`,
    "=".repeat(40 + platform.id.length),
    "",
    "Tämä paketti sisältää niputetun Node.js-ajonaikaisen ympäristön. Kohde-",
    "koneelle EI tarvitse asentaa Node.js:ää eikä npm:ää erikseen.",
    "",
    `Asennusohje: ${installGuide}`,
    "",
    "Paketin sisältö ja sen alkuperä (versiot, tarkisteet) on eritelty",
    "tiedostossa VERSIO.txt.",
    "",
    "data/-kansio ja .env-tiedosto EIVÄT sisälly tähän pakettiin — palvelin",
    "luo data/-kansion itse ensimmäisellä käynnistyksellä, ja .env syntyy",
    "asennuksen yhteydessä. Ks. asennusohje.",
    "",
  ].join("\n");
}

// --- Pääohjelma ---------------------------------------------------------------

async function main() {
  console.log("Infonäyttö — julkaisupaketin koonti\n");

  // --platform win-x64 rajaa koonnin yhteen alustaan. Molempien paketointi on
  // oletus; rajaus on olemassa sitä varten että epäonnistuneen ajon voi
  // uusia ilman että toinen, jo onnistunut alusta kootaan turhaan uudelleen.
  const platformArg = process.argv.indexOf("--platform");
  const wanted = platformArg === -1 ? null : process.argv[platformArg + 1];
  const platforms = wanted ? PLATFORMS.filter((p) => p.id === wanted) : PLATFORMS;
  if (platforms.length === 0) {
    fail(`Tuntematon alusta: ${wanted}. Vaihtoehdot: ${PLATFORMS.map((p) => p.id).join(", ")}`);
  }
  if (wanted) console.log(`Rajattu alustaan: ${wanted}\n`);

  const gitInfo = checkGit();

  // Työtila TÄYTYY olla tyhjä: edellisen ajon jäänteet päätyisivät muuten
  // suoraan pakettiin (havaittu käytännössä — vanha package.json ja
  // package-lock.json matkasivat valmiiseen arkistoon asti). rmSync ei
  // kuitenkaan aina kerro epäonnistuneensa: joissakin ympäristöissä se palaa
  // virheettä poistamatta mitään. Siksi tulos TARKISTETAAN eikä oleteta.
  fs.rmSync(workDir, { recursive: true, force: true });
  if (fs.existsSync(workDir)) {
    fail(
      `Työtilaa ei saatu tyhjennettyä: ${workDir}\n` +
        `Jäljellä: ${fs.readdirSync(workDir).join(", ")}\n` +
        `Poista se käsin ja aja koonti uudelleen — vanhat tiedostot päätyisivät muuten pakettiin.`,
    );
  }
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(nodeCacheDir, { recursive: true });

  console.log("--- 1/5: Tyyppitarkistus ---");
  run("npm", ["run", "typecheck"]);

  console.log("\n--- 2/5: Testit ---");
  // Vaatimus 4: rikkinäistä ei paketoida. npm test EI sisällä test:smokea
  // (se vaatii oikean Wilma-yhteyden, ks. README) — koonti pysyy verkotta
  // ajettavana muuten paitsi Node-latauksen ja tarkisteen osalta.
  run("npm", ["test"]);

  console.log("\n--- 3/5: Frontendin käännös ---");
  run("npm", ["run", "build"]);
  const webDist = path.join(repoRoot, "web", "dist");
  if (!fs.existsSync(path.join(webDist, "index.html"))) {
    fail("web/dist/index.html puuttuu käännöksen jälkeen — build epäonnistui hiljaisesti?");
  }
  assertNoStaleAssets(webDist);

  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

  console.log(`\n--- 4/5: Node v${NODE_VERSION} lataus ja tarkiste ---`);
  const shasums = await loadShasums();
  const archives = {};
  for (const platform of platforms) {
    archives[platform.id] = await ensureNodeArchive(platform, shasums);
  }

  console.log("\n--- 5/5: Paketointi ---");
  const asennusDir = path.join(repoRoot, "asennus");
  const docsDir = path.join(repoRoot, "docs");

  const results = [];
  for (const platform of platforms) {
    console.log(`\n>> ${platform.id}`);
    const topFolderName = `infonaytto-${appVersion}-${platform.id}`;
    const stagingParent = path.join(workDir, `staging-${platform.id}`);
    const stagingRoot = path.join(stagingParent, topFolderName);
    fs.mkdirSync(stagingRoot, { recursive: true });

    // Tuotantoriippuvuudet asennetaan suoraan tähän — ei väliaikaishakemistoa
    // josta kopioitaisiin (ks. installProdDependencies-funktion kommentti).
    step("riippuvuudet staging-juureen");
    installProdDependencies(stagingRoot);

    step("node-binaarin purku");
    extractSingleFile(
      archives[platform.id].path,
      `${platform.distDirName}/${platform.binInDist}`,
      path.join(stagingRoot, "node", platform.binInPkg),
    );

    // server/package.json on jo paikallaan (installProdDependencies kirjoitti
    // sen suoraan lopulliseen sijaintiinsa).
    step("server/src kopiointi");
    copyServerSrc(path.join(stagingRoot, "server", "src"));

    step("web/dist kopiointi");
    copyDir("web/dist", webDist, path.join(stagingRoot, "web", "dist"));
    step("asennus kopiointi");
    copyDir("asennus", asennusDir, path.join(stagingRoot, "asennus"), eiAsentimenTesti);

    // docs/ on mukana koska ASENNUSOHJEET VIITTAAVAT SIIHEN. Perustelut
    // (tilin lukituksen esto, PIN-tasot, kioskista poistuminen) siirrettiin
    // README:sta docs/-kansioon, ja README ei ole paketissa — ilman tata
    // jokainen "ks. docs/tietoturva.md" osoittaisi laitteella tyhjaan.
    // Muutama kymmenen kilotavua tekstia, ei salaisuuksia.
    step("docs kopiointi");
    copyDir("docs", docsDir, path.join(stagingRoot, "docs"));

    step("LUEMINUT.txt");
    fs.writeFileSync(path.join(stagingRoot, "LUEMINUT.txt"), buildReadme({ appVersion, platform }));

    step("VERSIO.txt (kavelee kaikki tiedostot)");
    // VERSIO.txt kirjoitetaan viimeisenä, jotta sen tiedostomäärä ja
    // yhteiskoko kattavat kaiken muun paketissa olevan.
    fs.writeFileSync(
      path.join(stagingRoot, "VERSIO.txt"),
      buildVersionManifest({
        appVersion,
        platform,
        gitInfo,
        nodeArchiveSha: archives[platform.id].sha256,
        stagingRoot,
      }),
    );

    const outFile = path.join(outDir, `${topFolderName}.${platform.packageExt}`);
    // Juuren sisältö lokiin: sitova pakettirakenne on tämän skriptin ainoa
    // sopimus asennusskriptien kanssa, joten siihen ilmestyvä ylimääräinen
    // tiedosto kuuluu näkyä ilman että pakettia tarvitsee purkaa erikseen.
    step(`arkiston luonti — juuressa: ${fs.readdirSync(stagingRoot).sort().join(", ")}`);
    createArchive(stagingParent, topFolderName, outFile);

    if (platform.id === "linux-x64") {
      // Luetaan LAVASTUKSESTA eikä reposta: lista on silloin sama kuin se mitä
      // arkistoon oikeasti päätyi. Repon kansiosta luettuna se sisälsi myös
      // asentimen testit, jotka suodatetaan paketista pois — ja koska puuttuva
      // polku keskeyttää koonnin, Linux-pakettia ei syntynyt lainkaan. Kaksi
      // eri lähdettä samalle listalle oli koko vian syy.
      const asennusStaging = path.join(stagingRoot, "asennus");
      const extraTargets = fs.existsSync(asennusStaging)
        ? fs
            .readdirSync(asennusStaging)
            .filter((name) => name.endsWith(".sh"))
            .map((name) => `${topFolderName}/asennus/${name}`)
        : [];
      fixLinuxExecutableBits(outFile, topFolderName, platform, extraTargets);
    }

    step("paketin sisällön tarkistus");
    verifyArchiveContents(outFile, topFolderName);

    const size = fs.statSync(outFile).size;
    const archiveHash = sha256File(outFile);
    results.push({ platform: platform.id, file: outFile, size, archiveHash });
    console.log(`✓ ${path.basename(outFile)} — ${formatBytes(size)} — sha256 ${archiveHash}`);

    // Siivotaan tämän alustan työtila heti pois — ei jätetä isoa node_modulesia
    // makaamaan koko koonnin loppuun asti, ja seuraava alusta saa puhtaan pohjan.
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }

  // Arkistojen omat tarkisteet arkistojen viereen. VERSIO.txt on paketin
  // SISÄLLÄ eikä voi sisältää oman arkistonsa tarkistetta, joten tämä on
  // ainoa paikka jossa "onko asennettu tiedosto ehjä" -kysymykseen vastataan.
  // Sama muoto kuin nodejs.orgin SHASUMS256.txt:ssä, jotta `sha256sum -c`
  // ja `Get-FileHash` toimivat sellaisenaan. Luetaan olemassa oleva tiedosto
  // ensin ja YHDISTETÄÄN uudet rivit siihen (ei korvata) — --platform-rajattu
  // ajo ei saa pyyhkiä pois toisen, aiemmin koostetun alustan riviä.
  const sumsFile = path.join(outDir, "SHA256SUMS.txt");
  const existingSums = new Map();
  if (fs.existsSync(sumsFile)) {
    for (const line of fs.readFileSync(sumsFile, "utf8").split("\n")) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) existingSums.set(m[2], m[1]);
    }
  }
  for (const r of results) {
    existingSums.set(path.basename(r.file), r.archiveHash);
  }
  const sumsLines = [...existingSums.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, hash]) => `${hash}  ${name}`);
  fs.writeFileSync(sumsFile, sumsLines.join("\n") + "\n");

  console.log("\n=== Valmis ===");
  for (const r of results) {
    console.log(`${path.basename(r.file)}  ${formatBytes(r.size)}  sha256=${r.archiveHash}`);
  }
  if (!gitInfo.clean) {
    console.log("\n⚠ MUISTA: työpuu oli likainen koonnin aikana — tulos ei ole toistettavissa puhtaasta tilasta.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
