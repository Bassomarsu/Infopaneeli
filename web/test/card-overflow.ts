/**
 * Milloin kortti luopuu koristeistaan.
 *
 * Miksi tämä testataan erikseen eikä selaimessa: kynnys ja korttien
 * todelliset korkeudet eivät saa olla kahdessa eri maailmassa. Mittaus
 * (ResizeObserver, getBoundingClientRect) on CardShell.vuessa, mutta PÄÄTÖS on
 * täällä — sama jako kuin `calendarMonth.ts`:llä ja `electricityChart.ts`:llä.
 *
 * Tiedostossa oli aiemmin myös leikkausilmoituksen säännöt ("+5 riviä ei
 * mahdu"). Ne on poistettu ominaisuuden mukana: kortit vierittävät sisältönsä,
 * ja vierityspalkki kertoo itse että listaa on enemmän.
 *
 * Aja (web-hakemistosta):  node test/card-overflow.ts
 */
import assert from "node:assert/strict";
import { COMPACT_CARD_HEIGHT, isCompactCard } from "../src/cardOverflow.ts";
import { gridRowHeight, panelPixelHeight } from "../src/gridGeometry.ts";

// --- Tiivis kortti ---
{
  // MITATUT kortin korkeudet koolla 2 x 2, joka on pienin sallittu
  // (MIN_PANEL_SPAN) ja usean kortin oletuskoko:
  assert.equal(isCompactCard(416), true, "2 x 2 seinanaytolla (2736 x 1824) on tiivis");
  assert.equal(isCompactCard(230), true, "2 x 2 naytolla 1920 x 1080 on tiivis");
  assert.equal(isCompactCard(152), true, "2 x 2 naytolla 1366 x 768 on tiivis");
  // Seuraava koko ylospain seinanaytolla (2 x 3, mitattu 633 px) ei ole.
  assert.equal(isCompactCard(633), false, "2 x 3 seinanaytolla ei ole tiivis");
  assert.equal(isCompactCard(COMPACT_CARD_HEIGHT), false, "raja itse ei ole tiivis");
  assert.equal(isCompactCard(COMPACT_CARD_HEIGHT - 1), true);
  console.log("ok  tiiviin kortin raja osuu mitattujen korttikokojen valiin");
}

{
  // Nolla ei ole "hyvin tiivis" vaan "ei mitattu": kortti joka ei ole viela
  // asettunut antaa nollan, eika siita saa paatella mitaan. Vaarin pain
  // erehtyminen piilottaisi koristeet kortista jonka kokoa ei tiedeta.
  assert.equal(isCompactCard(0), false, "mittaamaton kortti ei ole tiivis");
  assert.equal(isCompactCard(-10), false, "mahdoton korkeus ei ole tiivis");
  console.log("ok  mittaamattomasta kortista ei paatella tiiviytta");
}

/*
 * KYNNYS EI SAA OLLA KORTIN VIERESSA.
 *
 * Tama on se testi jota ei ollut. COMPACT_CARD_HEIGHT oli 420 ja kayttajan
 * oman seinanayton 2 x 2 -kortti on 416,1 px — 3,9 px paassa. Korttikorkeus
 * johdetaan nayton korkeudesta, joten 1840 px korkea naytto (16 px enemman)
 * olisi sammuttanut tiiviin tilan yhta aikaa kaikilta kahdeltatoista
 * kortilta. Mikaan ei olisi huomannut: kynnys oli yhdessa tiedostossa ja
 * korttikorkeuden kaava toisessa, eika kumpikaan tiennyt toisesta.
 *
 * Nyt kortin korkeus lasketaan tassa SAMASTA kaavasta jota sovellus kayttaa
 * (gridGeometry.ts, App.vuen measureGridRows), ja testi kaatuu jos kynnys
 * tulee lahemmas kuin MIN_MARGIN_PX yhtakaan tuettua nayttokorkeutta.
 */
{
  // MITATTU SELAIMESTA, ei arvattu. Samat luvut leveyksilla 2736, 1920 ja
  // 1366: ruudukon ylareuna 85,98 px sivun ylalaidasta (ylapalkki + vali),
  // .appin alatayte 20,8 px, ruudukon row-gap 17,6 px (= 1.1rem).
  //
  // Kapeammalla naytolla ylapalkki voi kaariytya, jolloin ruudukko alkaa
  // alempaa ja kortti on MATALAMPI — nama arvot antavat siis kullekin
  // nayttokorkeudelle SUURIMMAN mahdollisen kortin, mika on oikea suunta:
  // kynnysta lahestytaan ylhaalta.
  const GRID_TOP = 85.98;
  const BOTTOM_PADDING = 20.8;
  const ROW_GAP = 17.6;
  const MIN_MARGIN_PX = 20;

  function cardHeight(viewportHeight: number, rowSpan: number): number {
    const rowHeight = gridRowHeight(viewportHeight, GRID_TOP, BOTTOM_PADDING, ROW_GAP);
    return panelPixelHeight(rowHeight, ROW_GAP, rowSpan);
  }

  // Kaava on sama jota sovellus kayttaa, joten sen on tuotettava ne korkeudet
  // jotka selaimesta on mitattu. Jos tama hajoaa, muut vaitteet tasta
  // tiedostosta eivat enaa tarkoita mitaan.
  assert.ok(Math.abs(cardHeight(1824, 2) - 416) < 2, "2 x 2 @1824 = " + cardHeight(1824, 2).toFixed(1) + ", mitattu 416");
  assert.ok(Math.abs(cardHeight(1080, 2) - 230) < 2, "2 x 2 @1080 = " + cardHeight(1080, 2).toFixed(1) + ", mitattu 230");
  assert.ok(Math.abs(cardHeight(768, 2) - 152) < 2, "2 x 2 @768 = " + cardHeight(768, 2).toFixed(1) + ", mitattu 152");
  assert.ok(Math.abs(cardHeight(1824, 3) - 633) < 2, "2 x 3 @1824 = " + cardHeight(1824, 3).toFixed(1) + ", mitattu 633");
  console.log("ok  ruudukon kaava tuottaa selaimesta mitatut korttikorkeudet");

  // 768 = tavallinen lappari, 1080 = Full HD, 1440 = QHD, 1824 = KAYTTAJAN OMA
  // seinanaytto, 2160 = 4K. Pienin sallittu kortti (2 x 2) on tiivis jokaisella
  // naista, ja varaa kynnykseen on reilusti.
  for (const viewport of [768, 1080, 1440, 1824, 2160]) {
    const pienin = cardHeight(viewport, 2);
    assert.equal(isCompactCard(pienin), true, "2 x 2 @" + viewport + " ei ole tiivis (" + pienin.toFixed(1) + " px)");
    const vara = COMPACT_CARD_HEIGHT - pienin;
    assert.ok(
      vara >= MIN_MARGIN_PX,
      "2 x 2 @" + viewport + " on " + vara.toFixed(1) + " px kynnyksesta — alle " + MIN_MARGIN_PX +
        " px:n vara tarkoittaa etta pieni muutos nayton tai ylapalkin korkeudessa sammuttaa tiiviin tilan kaikilta korteilta",
    );
  }
  console.log("ok  pienin kortti pysyy tiiviina kaikilla tuetuilla nayttokorkeuksilla");

  {
    // Kayttajan oma naytto erikseen ja nimella: tama on se laite jolla vika
    // loydettiin ja jolla korjaus mitattiin.
    const vara = COMPACT_CARD_HEIGHT - cardHeight(1824, 2);
    assert.ok(vara > 100, "seinanayton 2 x 2 on vain " + vara.toFixed(1) + " px kynnyksesta");
    // Ja toinen suunta: 2 x 3 samalla naytolla EI saa olla tiivis, muuten
    // kynnys on liian korkealla eivatka isot kortit nayta koristeitaan.
    assert.equal(isCompactCard(cardHeight(1824, 3)), false, "seinanayton 2 x 3 ei saa olla tiivis");
    console.log("ok  seinanayton 2 x 2 on tiivis reilulla varalla, 2 x 3 ei ole");
  }
}

console.log("\nkaikki tiiviin kortin testit läpi");
