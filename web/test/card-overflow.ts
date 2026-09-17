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
  noticeFitsInCard,
} from "../src/cardOverflow.ts";
import { gridRowHeight, panelPixelHeight } from "../src/gridGeometry.ts";

// --- Kuinka paljon on piilossa ---
{
  assert.equal(hiddenPixels(300, 300), 0, "täsmälleen mahtuva ei vuoda yli");
  assert.equal(hiddenPixels(200, 300), 0, "mahtuva ei vuoda yli");
  assert.equal(hiddenPixels(400, 300), 100, "sata pikseliä piilossa");
  console.log("ok  piilossa olevan sisällön määrä");
}

{
  // Osapikselit: `scrollHeight` pyöristyy ylöspäin, joten tarkalleen mahtuva
  // sisältö raportoi säännöllisesti 1 px ylivuotoa. Siitä ilmoittaminen olisi
  // väärää tietoa siinä missä vaikeneminenkin.
  assert.equal(hiddenPixels(301, 300), 0, "yhden pikselin ylivuoto on mittausvirhe");
  assert.equal(hiddenPixels(302, 300), 0, "toleranssin raja ei vielä ilmoiteta");
  assert.equal(hiddenPixels(303, 300), 3, "toleranssin yli menevä ilmoitetaan");
  assert.equal(OVERFLOW_TOLERANCE_PX, 2);
  console.log("ok  osapikselin ylivuoto ei laukaise ilmoitusta");
}

{
  // ILMOITUSRIVI EI SAA VIEDÄ SISÄLLÖLTÄ TILAA — tätä ei voi todeta muuten
  // kuin rajapinnasta: funktiolla EI OLE parametria jolla ilmoituksen korkeus
  // voisi vaikuttaa vastaukseen. Rivi on `position: absolute` (style.css),
  // joten kortin rungon korkeus on sama näkyi ilmoitus tai ei.
  //
  // Aiempi versio otti korkeuden kolmantena parametrina ja lisäsi sen takaisin
  // käytettävissä olevaan tilaan. Se esti heilurin (ilmoitus pois -> tilaa
  // lisää -> ilmoitus takaisin), mutta maksoi rungosta rivin verran korkeutta
  // joka kortissa: pörssisähkön pylväskaaviosta näkyi ennen 14,5 / 21,8 px ja
  // sen jälkeen 0 / 21,8 px (mitattu 1920 x 1080, koko 2 x 2). Asemointi
  // poistaa molemmat ongelmat, ja tämä testi lukitsee sen: kaksi lukua sisään.
  assert.equal(hiddenPixels.length, 2, "ilmoituksen korkeus ei saa palata parametriksi");
  console.log("ok  ilmoitusrivin korkeus ei voi vaikuttaa ylivuotomittaan");
}

// --- Mahtuuko ilmoitus ylipäätään ---
{
  // Asemoitu rivi ei voi enää valua kortin ULKOPUOLELLE, mutta matalassa
  // kortissa se voisi peittää OTSIKON. Otsikko ja "vanhentunut"-merkki ovat
  // juuri se mitä MIN_PANEL_SPAN lupaa säilyttää (types.ts), ja rikkinäisen
  // lähteen huomaa vain niistä. Vajaa näkymä on pienempi vahinko kuin kortti
  // jota ei tunnista.
  assert.equal(noticeFitsInCard(200, 24), true, "tavallisessa kortissa mahtuu");
  assert.equal(noticeFitsInCard(24, 24), true, "täsmälleen runkonsa kokoinen mahtuu");
  assert.equal(noticeFitsInCard(23, 24), false, "runkoa korkeampi ei mahdu");
  assert.equal(noticeFitsInCard(0, 24), false, "runko kutistunut nollaan: otsikko voittaa");
  console.log("ok  ilmoitus väistää kun runkoa ei ole tarpeeksi");
}

{
  // Mittaamaton rivi (korkeus 0) ei ole "mahtuu hyvin". Ilmoitus renderöidään
  // aina DOMiin juuri siksi että sen korkeus on mitattavissa; nolla tarkoittaa
  // ettei mittausta ole vielä tehty, eikä siitä saa päätellä mitään.
  assert.equal(noticeFitsInCard(500, 0), false, "mittaamattomasta rivistä ei päätellä mitään");
  console.log("ok  mittaamaton ilmoitusrivi ei ole 'mahtuu'");
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
  assert.equal(clipNotice(0), "Sisältö ei mahdu", "rivitön kortti saa silti ilmoituksen");
  console.log("ok  ilmoituksen teksti kertoo rivimäärän");
}

{
  // ILMOITUS EI SAA ALIARVIOIDA. Asemoitu rivi peittää alimman kaistaleen
  // sisällöstä, joten LUKU mitataan ilmoituksen yläreunasta — siitä mihin
  // katsojan luettavissa oleva sisältö oikeasti loppuu. Peruste sen sijaan ei
  // saa katsoa ilmoituksen peittämiä rivejä lainkaan, muuten ilmoitus pitäisi
  // itsensä pystyssä senkin jälkeen kun sisältö on kutistunut mahtuvaksi.
  const rows = [
    { top: 0, bottom: 50 },
    { top: 50, bottom: 100 },
    { top: 100, bottom: 150 },
  ];
  const NOTICE = 24;
  const kortinAlareuna = 150;
  const ilmoituksenYlareuna = kortinAlareuna - NOTICE;
  assert.equal(clippedRowCount(rows, 0, kortinAlareuna), 0, "kortin reunaan asti kaikki mahtuisi");
  assert.equal(clippedRowCount(rows, 0, ilmoituksenYlareuna), 1, "ilmoitus peittää alimman rivin");
  // Peruste tulee muualta kuin rivilaskurista: pikseliylivuodosta tai kortin
  // itsensä piilottamista riveistä. Pelkkä ilmoituksen peittämä rivi ei riitä.
  assert.equal(cardIsClipped(0, 0), false, "peitetty rivi ei yksin perustele ilmoitusta");
  console.log("ok  ilmoituksen peittämä rivi lasketaan lukuun muttei perusteeseen");
}

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

console.log("\nkaikki kortin ylivuototestit läpi");
