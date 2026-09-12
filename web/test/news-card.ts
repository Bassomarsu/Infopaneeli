/**
 * Uutiskortin logiikka: ikämerkintä, montako otsikkoa mahtuu, ja se ettei
 * otsikkoa koskaan muokata.
 *
 * Otsikon koskemattomuus ei ole makuasia vaan Ylen käyttöehto
 * (https://yle.fi/aihe/a/20-10008076): sisältöä ei saa muokata. Näyttötilan
 * takia katkaisu on sallittua, mutta se tehdään kortissa CSS:llä, ei
 * merkkijonoa leikkaamalla — siksi tässä testataan nimenomaan, että otsikko
 * ja linkki tulevat läpi merkki merkiltä samoina.
 *
 * Aja (web-hakemistosta):  node test/news-card.ts
 */
import assert from "node:assert/strict";
import { fittingItemCount, newsRows, relativeAge } from "../src/components/news.ts";
import type { NewsItem } from "../src/types.ts";

const NOW = new Date("2026-09-12T12:00:00+03:00");

function item(id: string, minutesAgo: number, title = `Otsikko ${id}`): NewsItem {
  return {
    id,
    title,
    link: `https://yle.fi/a/${id}`,
    publishedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    summary: null,
  };
}

// --- Ikämerkintä ---
{
  assert.equal(relativeAge(new Date(NOW.getTime() - 10_000).toISOString(), NOW), "nyt", "alle minuutti");
  assert.equal(relativeAge(new Date(NOW.getTime() - 60_000).toISOString(), NOW), "1 min");
  assert.equal(relativeAge(new Date(NOW.getTime() - 59 * 60_000).toISOString(), NOW), "59 min");
  assert.equal(relativeAge(new Date(NOW.getTime() - 60 * 60_000).toISOString(), NOW), "1 t", "tunnin rajalla vaihtuu tunteihin");
  assert.equal(relativeAge(new Date(NOW.getTime() - 23 * 60 * 60_000).toISOString(), NOW), "23 t");
  assert.equal(relativeAge(new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString(), NOW), "1 vrk", "vuorokauden rajalla vaihtuu vuorokausiin");
  assert.equal(relativeAge(new Date(NOW.getTime() - 72 * 60 * 60_000).toISOString(), NOW), "3 vrk");
  console.log("ok  ikämerkinnän rajat: min -> t -> vrk");
}

{
  // Palvelimen ja lähteen kellot eivät ole samassa sekunnissa. Tulevaisuuden
  // aikaleima ei saa tuottaa negatiivista ikää ("-1 min sitten").
  assert.equal(relativeAge(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW), "nyt");
  console.log("ok  tulevaisuuden aikaleima näytetään muodossa 'nyt', ei negatiivisena");
}

{
  // Puuttuva tai rikkinäinen aikaleima => ei merkintää lainkaan. Arvaaminen
  // olisi pahempaa kuin tyhjä: väärä ikä on väärää tietoa seinällä.
  assert.equal(relativeAge(null, NOW), null);
  assert.equal(relativeAge(undefined, NOW), null);
  assert.equal(relativeAge("", NOW), null);
  assert.equal(relativeAge("eilen joskus", NOW), null);
  assert.equal(relativeAge(123 as unknown as string, NOW), null);
  console.log("ok  kelvoton aikaleima jättää ikämerkinnän pois eikä arvaa mitään");
}

// --- Montako mahtuu ---
//
// Rivin korkeus vaihtelee (otsikko vie yhden tai kaksi tekstiriviä), joten
// mahtuvien määrä mitataan rivien todellisista alareunoista eikä lasketa
// kertolaskuna. Koordinaatisto: listan yläreuna on 0.
{
  // Kolme yksirivistä (40 px) ja väli 8 px: alareunat 40, 88, 136.
  assert.equal(fittingItemCount(200, [40, 88, 136]), 3, "kaikki mahtuvat");
  assert.equal(fittingItemCount(100, [40, 88, 136]), 2, "kolmas ei mahdu kokonaan");
  assert.equal(fittingItemCount(88, [40, 88, 136]), 2, "tasan alareunaan päättyvä mahtuu");
  console.log("ok  mahtuvien rivien määrä mitataan rivien todellisista alareunoista");
}

{
  // Juuri tämä on se tapaus jota kertolasku ei osaa: ensimmäinen otsikko on
  // yksirivinen ja loput kaksirivisiä. "korkeus / ensimmäisen rivin korkeus"
  // antaisi neljä, jolloin neljäs rivi jäisi puoliksi näkyviin.
  const bottoms = [40, 120, 200, 280];
  assert.equal(fittingItemCount(210, bottoms), 3, "vaihteleva rivikorkeus ei saa yliarvioida");
  assert.notEqual(Math.floor(210 / 40), fittingItemCount(210, bottoms), "kertolasku antaisi eri, väärän vastauksen");
  console.log("ok  vaihteleva rivikorkeus ei yliarvioi mahtuvien määrää");
}

{
  // Alapikselin liukuma (tolerancePx) on olemassa siksi, ettei selaimen
  // murtolukumitta saa pudottaa riviä pois hiuksenhienosti. Raja on
  // inklusiivinen: tasan liukuman verran yli menevä rivi mahtuu vielä.
  assert.equal(fittingItemCount(100, [50, 100.4]), 2, "liukuman sisällä oleva rivi mahtuu");
  assert.equal(fittingItemCount(100, [50, 100.5]), 2, "tasan liukuman rajalla oleva rivi mahtuu vielä");
  assert.equal(fittingItemCount(100, [50, 100.6]), 1, "liukuman yli menevä rivi ei mahdu");
  console.log("ok  alapikselin liukuma on inklusiivinen eikä pudota riviä hiuksenhienosti");
}

{
  // Mahtuminen katkeaa ENSIMMÄISEEN joka ei mahdu — myöhempi lyhyt rivi ei
  // saa hypätä mahtumattoman ohi, koska rivit renderöidään järjestyksessä.
  assert.equal(fittingItemCount(100, [40, 150, 60]), 1);
  console.log("ok  mahtuminen katkeaa ensimmäiseen joka ei mahdu");
}

{
  // Alaraja on 1 eikä 0: kortissa on dataa, ja tyhjä kortti näyttäisi
  // rikkinäiseltä. Aidosti tyhjä lista on eri asia ja antaa 0.
  assert.equal(fittingItemCount(10, [40, 88]), 1, "liian matala paneeli näyttää silti yhden");
  assert.equal(fittingItemCount(200, []), 0, "tyhjä lista ei tuota riviä tyhjästä");
  assert.equal(fittingItemCount(Number.NaN, [40]), 1, "mittaamaton korkeus ei saa nollata korttia");
  assert.equal(fittingItemCount(200, [Number.NaN, 88]), 1, "kelvoton rivimitta ei saa kaataa");
  console.log("ok  kelvoton tai liian pieni mitta päätyy yhteen riviin, ei nollaan");
}

// --- Rivit kortille ---
{
  const items = [item("a", 5), item("b", 30), item("c", 1500)];
  const rows = newsRows(items, NOW);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"], "järjestys säilyy");
  assert.deepEqual(rows.map((r) => r.age), ["5 min", "30 min", "1 vrk"]);
  assert.deepEqual(newsRows([], NOW), []);
  assert.deepEqual(newsRows(null, NOW), []);
  assert.deepEqual(newsRows(undefined, NOW), []);
  console.log("ok  rivien muodostus ja ikämerkintä");
}

{
  // OTSIKKOA JA LINKKIÄ EI MUOKATA. Ylen ehto. Ikä on ainoa laskettu kenttä.
  const pitka =
    "Tutkijat löysivät Itämerestä uuden levälajin joka saattaa muuttaa käsitystä " +
    "rehevöitymisen etenemisestä rannikkoalueilla, kertoo tuore tutkimus";
  const items: NewsItem[] = [
    { id: "x", title: pitka, link: "https://yle.fi/a/74-20245318?origin=rss", publishedAt: NOW.toISOString(), summary: "ingressi" },
  ];
  const rows = newsRows(items, NOW);
  assert.equal(rows[0]?.title, pitka, "otsikon on oltava merkki merkiltä sama kuin syötteessä");
  assert.equal(rows[0]?.title.length, pitka.length, "otsikkoa ei katkaista merkkijonona");
  assert.equal(
    rows[0]?.link,
    "https://yle.fi/a/74-20245318?origin=rss",
    "linkki sellaisenaan — ei omaa osoitteenrakennusta, ei kyselyparametrien siivousta",
  );
  console.log("ok  otsikkoa ja linkkiä ei muokata millään tavalla");
}

{
  // Tyhjä otsikko tai puuttuva linkki eivät saa kaataa korttia. Ne tulevat
  // läpi sellaisinaan; kortti näyttää mitä syötteessä oli.
  const rows = newsRows(
    [{ id: "y", title: "", link: "", publishedAt: "roskaa", summary: null }],
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.age, null, "kelvoton aikaleima jättää ikämerkinnän pois");
  console.log("ok  puutteellinen juttu ei kaada korttia");
}

console.log("\nkaikki uutiskortin testit läpi");
