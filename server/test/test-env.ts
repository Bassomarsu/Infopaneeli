/**
 * Import this *first* in any test that loads the logger or the database.
 *
 * Without it the tests write into the same log and the same SQLite file as the
 * real display: `data/logs/` fills with rows about `test-flaky-1234`, and
 * `provider_cache` accumulates dozens of `test-recover-*` rows next to the real
 * weather and Wilma payloads. Both directly undermine the two things that make
 * a fault diagnosable — a log short enough to read, and a database whose
 * contents mean what they say.
 *
 * ES modules evaluate their dependencies in source order, so a side-effect
 * import on the first line runs before `config.ts` is evaluated further down.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DIR = "data/logs-test";
const DB_PATH = "data/infonaytto-test.db";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
process.env.LOG_DIR = path.resolve(projectRoot, process.env.LOG_DIR ?? LOG_DIR);
process.env.DB_PATH = path.resolve(projectRoot, process.env.DB_PATH ?? DB_PATH);

/**
 * Wipe the previous run's state before anything opens it.
 *
 * The logging contract test asserts things like "a source that stays broken
 * logs exactly one line", counted by reading the log back. Those counts are
 * only meaningful against an empty log: the fake providers are named after
 * `process.pid`, and Windows recycles PIDs, so a leftover file eventually
 * produces two lines for what looks like the same provider and the assertion
 * fails for a reason that has nothing to do with the code. Starting clean is
 * the fix — unique ids would only paper over it, and a stale file would still
 * grow without bound.
 *
 * Guarded on the path so a future edit cannot point this at `data/logs/` or
 * the real database. Deleting either would destroy exactly the evidence the
 * log exists to preserve.
 */
/**
 * Poista tiedosto tai hakemisto ilman `fs.rmSync`ia.
 *
 * `fs.rmSync` on tämän koneen projektilevyllä (G:) HILJAINEN TYHJÄKÄYNTI: se
 * palaa virheettä eikä poista mitään — ei tiedostoa, ei hakemistoa, ei edes
 * tyhjää hakemistoa. Sama kutsu toimii C-asemalla, ja `unlinkSync` sekä
 * `rmdirSync` toimivat molemmilla. Todennettu 17.9.2026 erikseen tiedostolla
 * ja hakemistolla, `force`illa ja ilman, hiekkalaatikon kanssa ja ilman.
 *
 * Merkitys on isompi kuin miltä näyttää: alla oleva "pyyhi edellisen ajon
 * tila" on käyttänyt `rmSync`iä, eli se ei ole koskaan pyyhkinyt mitään tällä
 * koneella. Lokisopimustestit, jotka laskevat rivejä ja olettavat tyhjän
 * lokin, ovat nojanneet lupaukseen joka ei pidä.
 */
function poistaPuu(target: string): void {
  let tiedot: fs.Stats;
  try {
    tiedot = fs.lstatSync(target);
  } catch {
    return; // Ei ole olemassa — ei mitään poistettavaa.
  }
  // Linkkiä ei seurata: sen kohde on toisaalla. Windowsissa hakemistolinkki
  // irtoaa vain `rmdirSync`illä ja tiedostolinkki vain `unlinkSync`illä.
  if (tiedot.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
    }
    return;
  }
  if (tiedot.isDirectory()) {
    for (const nimi of fs.readdirSync(target)) poistaPuu(path.join(target, nimi));
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

function resetIfTestPath(target: string, mustContain: string): void {
  if (!target.includes(mustContain)) return;
  try {
    poistaPuu(path.resolve(target));
  } catch {
    // A locked file on Windows is not worth failing the suite over; the test
    // that cares reads the newest log file and will simply see the old one.
  }
}

/**
 * Lakaise aiempien ajojen jäljet.
 *
 * Nimissä on `process.pid`, ja Windows kierrättää PID:t hitaasti, joten yllä
 * oleva "pyyhi oma polku" ei osu edellisen ajon tiedostoihin lainkaan — se
 * pyyhkii vain saman PID:n. Ilman lakaisua `data/` kasvaa yhdellä kannalla,
 * yhdellä avaimella ja yhdellä lokihakemistolla jokaista testiajoa kohden:
 * 17.9.2026 siellä oli 401 tiedostoa ja 150 hakemistoa, 11 Mt, kaikki roskaa.
 *
 * Ikäraja on olemassa siksi, että kaksi testiajoa voi olla käynnissä yhtä
 * aikaa (esimerkiksi kaksi agenttia). Tuoreisiin ei kosketa, koska ne voivat
 * olla toisen ajon käytössä juuri nyt — juuri se sekaannus kaataa
 * `provider-manual-test.ts`:n satunnaisesti.
 *
 * Etuliitteet ovat ankkuroidut, joten `data/infonaytto.db` ja `data/logs/`
 * eivät voi osua tähän: ne ovat oikea kanta ja oikea loki.
 */
const STALE_MS = 60 * 60 * 1000;

function sweepStaleTestArtifacts(): void {
  const dataDir = path.resolve(projectRoot, "data");
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!/^(infonaytto-test|logs-test)/.test(name)) continue;
    const target = path.join(dataDir, name);
    try {
      if (now - fs.lstatSync(target).mtimeMs < STALE_MS) continue;
      poistaPuu(target);
    } catch {
      // Toisen ajon käytössä tai lukittu — seuraava ajo yrittää uudelleen.
    }
  }
}

sweepStaleTestArtifacts();

const logDir = process.env.LOG_DIR;
const dbPath = process.env.DB_PATH;

resetIfTestPath(logDir, "logs-test");
resetIfTestPath(dbPath, "infonaytto-test");

/**
 * Siivoa oman ajon jäljet lopuksi, jotta lakaisulle jää mahdollisimman vähän.
 *
 * `process.on("exit")` sallii vain synkronisen työn, siksi synkroniset kutsut.
 * Windows ei anna poistaa auki olevaa tiedostoa, joten tietokanta jää usein
 * jäljelle — sen takia lakaisu yllä on varmistus eikä koriste, eikä tämän
 * epäonnistuminen saa kaataa testiä.
 *
 * Avaintiedosto poistetaan erikseen: se on oma tiedostonsa `DB_PATH`:n vieressä
 * (ks. waste-lockout-env.ts).
 */
process.on("exit", () => {
  resetIfTestPath(logDir, "logs-test");
  resetIfTestPath(dbPath, "infonaytto-test");
  resetIfTestPath(`${dbPath}.waste-key`, "infonaytto-test");
});
