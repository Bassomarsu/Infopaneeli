/**
 * Kortin ylivuotosäännöt: milloin kortti kertoo leikkaavansa sisältöä, montako
 * riviä on piilossa, ja milloin se luopuu koristeistaan.
 *
 * Miksi tämä testataan erikseen eikä selaimessa: sääntö "kortti ei saa leikata
 * sisältöään hiljaa" on sovelluksen lupaus, ei ulkoasuseikka. Mittaus
 * (ResizeObserver, getBoundingClientRect) on CardShell.vuessa, mutta PÄÄTÖS on
 * täällä — sama jako kuin uutiskortin `fittingItemCount`illa.
 *
 * Aja (web-hakemistosta):  node test/card-overflow.ts
 */
import assert from "node:assert/strict";
import {
  COMPACT_CARD_HEIGHT,
  OVERFLOW_TOLERANCE_PX,
  cardIsClipped,
  clipNotice,
  clipNoticeLabel,
  clippedRowCount,
  hiddenPixels,
  isCompactCard,
} from "../src/cardOverflow.ts";

// --- Kuinka paljon on piilossa ---
{
  assert.equal(hiddenPixels(300, 300, 0), 0, "täsmälleen mahtuva ei vuoda yli");
  assert.equal(hiddenPixels(200, 300, 0), 0, "mahtuva ei vuoda yli");
  assert.equal(hiddenPixels(400, 300, 0), 100, "sata pikseliä piilossa");
  console.log("ok  piilossa olevan sisällön määrä");
}

{
  // Osapikselit: `scrollHeight` pyöristyy ylöspäin, joten tarkalleen mahtuva
  // sisältö raportoi säännöllisesti 1 px ylivuotoa. Siitä ilmoittaminen olisi
  // väärää tietoa siinä missä vaikeneminenkin.
  assert.equal(hiddenPixels(301, 300, 0), 0, "yhden pikselin ylivuoto on mittausvirhe");
  assert.equal(hiddenPixels(302, 300, 0), 0, "toleranssin raja ei vielä ilmoiteta");
  assert.equal(hiddenPixels(303, 300, 0), 3, "toleranssin yli menevä ilmoitetaan");
  assert.equal(OVERFLOW_TOLERANCE_PX, 2);
  console.log("ok  osapikselin ylivuoto ei laukaise ilmoitusta");
}

{
  // TÄMÄ ON SE HEILURI JOTA VASTAAN `noticeHeight` ON OLEMASSA.
  //
  // Ilmoitusrivi vie itse tilaa kortista. Jos mitta otettaisiin sellaisenaan,
  // juuri mahtuva sisältö jäisi välkkymään: ilmoitus näkyviin -> tila pienenee
  // -> sisältö ei mahdu -> ilmoitus näkyviin -> ... Kun ilmoituksen korkeus
  // lisätään takaisin, vastaus riippuu vain sisällöstä ja kortin koosta.
  const noticeHeight = 22;
  // Sisältö 300, näkyvää tilaa 300 kun ilmoitusta EI ole.
  assert.equal(hiddenPixels(300, 300, 0), 0, "ilman ilmoitusta mahtuu");
  // Sama kortti sen jälkeen kun ilmoitus on ilmestynyt ja syönyt 22 px.
  assert.equal(hiddenPixels(300, 300 - noticeHeight, noticeHeight), 0, "ilmoitus ei saa ylläpitää itseään");
  // Ja oikeasti liian suuri sisältö ilmoitetaan kummassakin tilassa samana.
  assert.equal(hiddenPixels(400, 300, 0), 100);
  assert.equal(hiddenPixels(400, 300 - noticeHeight, noticeHeight), 100, "sama vastaus ilmoituksen kanssa ja ilman");
  console.log("ok  ilmoitusrivin oma korkeus ei voi ylläpitää ilmoitusta (ei heiluria)");
}

// --- Montako riviä jää lukematta ---
{
  const rows = [
    { top: 0, bottom: 50 },
    { top: 50, bottom: 100 },
    { top: 100, bottom: 150 },
    { top: 150, bottom: 200 },
  ];
  assert.equal(clippedRowCount(rows, 0, 200), 0, "kaikki mahtuvat");
  assert.equal(clippedRowCount(rows, 0, 100), 2, "kaksi alinta jää piiloon");
  assert.equal(clippedRowCount(rows, 0, 0), 4, "mitään ei näy");
  console.log("ok  piiloon jäävien rivien määrä");
}

{
  // Puoliksi näkyvä rivi on PIILOSSA. Juuri se on tämän moduulin syy:
  // puolikas päivämäärä tai puolikas ateria näyttää luetulta mutta ei ole
  // sitä, ja katsoja luulee nähneensä koko listan.
  const rows = [{ top: 0, bottom: 50 }, { top: 50, bottom: 100 }];
  assert.equal(clippedRowCount(rows, 0, 75), 1, "puoliksi leikkautunut rivi lasketaan piilossa olevaksi");
  console.log("ok  puoliksi näkyvä rivi lasketaan piilossa olevaksi");
}

{
  // Vieritettävällä laitteella sisältöä voi olla myös taitteen YLÄpuolella.
  const rows = [{ top: -60, bottom: -10 }, { top: 0, bottom: 50 }];
  assert.equal(clippedRowCount(rows, 0, 100), 1, "ylös vieritetty rivi on yhtä lailla piilossa");
  console.log("ok  näkyvän kaistaleen yläpuolelle jäänyt rivi lasketaan mukaan");
}

{
  // Uutiskortti piilottaa ylimääräiset otsikot `visibility: hidden` -tilaan
  // (ks. news.ts:n fittingItemCount), jolloin ne ovat asettelussa mutta eivät
  // luettavissa. Sellainen rivi on piilossa vaikka se olisi taitteen
  // yläpuolella — muuten kortti joka jo itse siivosi ylivuotonsa näyttäisi
  // täydeltä, mikä on tarkalleen se hiljainen valhe jota vastaan tämä on.
  const rows = [
    { top: 0, bottom: 50 },
    { top: 50, bottom: 100, concealed: true },
  ];
  assert.equal(clippedRowCount(rows, 0, 200), 1, "kortin itse piilottama rivi lasketaan piilossa olevaksi");
  console.log("ok  kortin itsensä piilottama rivi lasketaan piilossa olevaksi");
}

{
  // Osapikselivara samaan suuntaan kuin `hiddenPixels`: viimeinen rivi
  // päättyy usein murto-osan verran laatikon reunan alle vaikka se näkyy.
  const rows = [{ top: 0, bottom: 100.5 }];
  assert.equal(clippedRowCount(rows, 0, 100), 0, "murto-osan ylitys ei tee rivistä piilossa olevaa");
  assert.equal(clippedRowCount([{ top: 0, bottom: 103 }], 0, 100), 1, "toleranssin yli menevä on piilossa");
  console.log("ok  rivilaskuri sietää osapikselit");
}

// --- Näytetäänkö ilmoitus ---
{
  assert.equal(cardIsClipped(0, 0), false, "mahtuva kortti on hiljaa");
  assert.equal(cardIsClipped(45, 0), true, "pelkkä pikseliylivuoto riittää");
  // Sää- ja pörssisähkökortissa ei ole toistuvia rivejä lainkaan, mutta kaavio
  // leikkautuu silti. Vaikeneminen on se yksi vaihtoehto joka ei kelpaa.
  console.log("ok  pikseliylivuoto yksin riittää ilmoitukseen");
}

{
  // Toinen suunta, ja se on yhtä tärkeä: uutiskortti siivoaa ylivuotonsa itse
  // (news.ts:n `fittingItemCount` jättää mahtumattomat otsikot
  // `visibility: hidden` -tilaan), jolloin kortti ei vuoda yli YHTÄÄN
  // pikseliä — mutta otsikoita jää silti lukematta. Jos pelkkä pikselimäärä
  // ratkaisisi, juuri se kortti joka on jo kertaalleen karsinut sisältöään
  // näyttäisi täydeltä.
  assert.equal(cardIsClipped(0, 3), true, "itse siivonnut kortti ilmoittaa silti");
  console.log("ok  piilotetut rivit yksin riittävät ilmoitukseen");
}

// --- Mitä kortti sanoo ---
{
  assert.equal(clipNotice(3), "+3 riviä ei mahdu", "rivimäärä kerrotaan kun se tiedetään");
  // Yksikkö erikseen: "+1 riviä ei mahdu" on väärää suomea, ja seinänäytöllä
  // yhden rivin tapaus on tavallisin — juuri se viimeinen rivi joka jäi alle.
  assert.equal(clipNotice(1), "+1 rivi ei mahdu");
  assert.equal(clipNotice(0), "Sisältö ei mahdu näkyviin", "rivitön kortti saa silti ilmoituksen");
  console.log("ok  ilmoituksen teksti kertoo rivimäärän");
}

{
  // ILMOITUS EI SAA ALIARVIOIDA. Ilmoitusrivi vie itse tilaa, joten sen
  // kanssa mitattu rivimäärä on aina vähintään yhtä suuri kuin ilman sitä
  // mitattu. Peruste otetaan pienemmästä (ettei ilmoitus jää pystyyn omasta
  // ansiostaan), mutta LUKU suuremmasta — muuten kortti väittäisi kahta
  // piilossa olevaa riviä kun niitä on kolme, eli tekisi pienempänä juuri sen
  // mitä tässä korjataan.
  const rows = [
    { top: 0, bottom: 50 },
    { top: 50, bottom: 100 },
    { top: 100, bottom: 150 },
    { top: 150, bottom: 200 },
  ];
  const NOTICE = 22;
  const fold = 128; // kortin taite kun ilmoitusrivi on paikallaan
  const ilmanIlmoitusta = clippedRowCount(rows, 0, fold + NOTICE);
  const ilmoituksenKanssa = clippedRowCount(rows, 0, fold);
  assert.equal(ilmanIlmoitusta, 1, "ilman ilmoitusta alin rivi jää piiloon");
  assert.equal(ilmoituksenKanssa, 2, "ilmoituksen kanssa kaksi jää piiloon");
  assert.ok(ilmoituksenKanssa >= ilmanIlmoitusta, "luku ei voi olla perustetta pienempi");
  assert.equal(cardIsClipped(0, ilmanIlmoitusta), true);
  assert.equal(clipNotice(ilmoituksenKanssa), "+2 riviä ei mahdu");
  console.log("ok  ilmoitus kertoo suuremman (todellisen) rivimäärän, ei pienempää");
}

{
  // Ruudunlukija saa kokonaisen lauseen, ei "+3 riviä ei mahdu".
  assert.match(clipNoticeLabel(3), /3 riviä/);
  assert.match(clipNoticeLabel(3), /Suurenna korttia/);
  assert.match(clipNoticeLabel(1), /yksi rivi/, "yksikkö myös ruudunlukijalle");
  assert.doesNotMatch(clipNoticeLabel(1), /1 riviä/);
  assert.match(clipNoticeLabel(0), /Suurenna korttia/);
  assert.doesNotMatch(clipNoticeLabel(0), /0 riviä/, "rivitön ilmoitus ei väitä nollaa rivejä");
  console.log("ok  ruudunlukijan teksti kertoo mitä asialle voi tehdä");
}

// --- Tiivis kortti ---
{
  // MITATUT kortin korkeudet koolla 2 x 2, joka on pienin sallittu
  // (MIN_PANEL_SPAN) ja usean kortin oletuskoko:
  assert.equal(isCompactCard(416), true, "2 x 2 seinänäytöllä (2736 x 1824) on tiivis");
  assert.equal(isCompactCard(230), true, "2 x 2 näytöllä 1920 x 1080 on tiivis");
  assert.equal(isCompactCard(152), true, "2 x 2 näytöllä 1366 x 768 on tiivis");
  // Seuraava koko ylöspäin seinänäytöllä (2 x 3, mitattu ~640 px) ei ole.
  assert.equal(isCompactCard(640), false, "2 x 3 seinänäytöllä ei ole tiivis");
  assert.equal(isCompactCard(COMPACT_CARD_HEIGHT), false, "raja itse ei ole tiivis");
  assert.equal(isCompactCard(COMPACT_CARD_HEIGHT - 1), true);
  console.log("ok  tiiviin kortin raja osuu mitattujen korttikokojen väliin");
}

{
  // Nolla ei ole "hyvin tiivis" vaan "ei mitattu": kortti joka ei ole vielä
  // asettunut antaa nollan, eikä siitä saa päätellä mitään. Väärin päin
  // erehtyminen piilottaisi koristeet kortista jonka kokoa ei tiedetä.
  assert.equal(isCompactCard(0), false, "mittaamaton kortti ei ole tiivis");
  assert.equal(isCompactCard(-10), false, "mahdoton korkeus ei ole tiivis");
  console.log("ok  mittaamattomasta kortista ei päätellä tiiviyttä");
}

console.log("\nkaikki kortin ylivuototestit läpi");
