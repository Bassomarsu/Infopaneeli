// web/skriptit/tyhjenna-dist.mjs
//
// Tyhjentää web/dist:n ENNEN vite buildia.
//
// Tämä oli aiemmin yksirivinen `node -e "fs.rmSync('dist',{recursive:true,
// force:true})"` package.jsonissa. Se ei toiminut: `fs.rmSync` palaa
// joissakin ympäristöissä virheettä poistamatta mitään — todennettu
// 17.9.2026 tämän projektin levyllä erikseen tiedostolla ja hakemistolla,
// `force`illa ja ilman. `unlinkSync` ja `rmdirSync` toimivat samalla levyllä.
//
// Seuraus oli hiljainen ja kasautuva: jokainen käännös jätti edellisen
// tiivisteelliset assetit paikalleen, dist/assets kasvoi 20 tiedostoon, ja
// julkaisukoonti pysähtyi omaan tarkistukseensa ("sisältää 18 tiedostoa
// joihin mikään ei viittaa"). Ilman sitä tarkistusta vanhat käännökset
// olisivat matkanneet julkaisupakettiin.
//
// Sama juurisyy on kirjattu server/test/test-env.ts:ään ja
// skriptit/tee-julkaisu.mjs:n ARCHIVE_EXCLUDES-kommenttiin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function poistaPuu(kohde) {
  let tiedot;
  try {
    tiedot = fs.lstatSync(kohde);
  } catch {
    return; // Ei ole olemassa — ei mitään poistettavaa.
  }
  // Linkkiä EI seurata: sen kohde on toisaalla eikä kuulu tähän. Windowsissa
  // hakemistolinkki (junction) irtoaa vain `rmdirSync`illä ja tiedostolinkki
  // vain `unlinkSync`illä, eikä `lstat` erottele niitä — siksi molemmat.
  if (tiedot.isSymbolicLink()) {
    try {
      fs.unlinkSync(kohde);
    } catch {
      fs.rmdirSync(kohde);
    }
    return;
  }
  if (tiedot.isDirectory()) {
    for (const nimi of fs.readdirSync(kohde)) poistaPuu(path.join(kohde, nimi));
    fs.rmdirSync(kohde);
    return;
  }
  fs.unlinkSync(kohde);
}

const webRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const dist = path.join(webRoot, "dist");

poistaPuu(dist);

// Varmistus, koska juuri hiljainen epäonnistuminen on tämän tiedoston syy.
if (fs.existsSync(dist)) {
  console.error(`✖ web/dist:iä ei saatu poistettua: ${dist}`);
  process.exit(1);
}
