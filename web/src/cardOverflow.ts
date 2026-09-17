/**
 * Mitä kortti tekee kun sen sisältö ei mahdu.
 *
 * Kortti leikkaa ylivuotavan sisältönsä piiloon (`.card { overflow: hidden }`),
 * ja seinänäyttöä ei vieritetä. Piiloon jäänyt rivi on siis seinällä sama asia
 * kuin rivi jota ei ole — paitsi että katsoja ei tiedä sitä. MIN_PANEL_SPAN
 * takaa vain otsikon ja "vanhentunut"-merkin säilymisen (ks. types.ts); se ei
 * ole koskaan luvannut että sisältö mahtuu.
 *
 * Tämä moduuli on se lupaus jota MIN_PANEL_SPAN ei anna: kortti EI saa
 * leikata sisältöään hiljaa. Sama periaate kuin kalenterin `covered: false`
 * -viivoituksessa ja siinä miksi tuntematon postinumero ei vaihda paikkakuntaa
 * — näkyvä vajaus on parempi kuin hiljainen väärä tieto.
 *
 * Erillinen tiedosto eikä CardShell.vuen sisällä, samasta syystä kuin
 * news.ts:n `fittingItemCount`: nämä ovat sovelluksen sääntöjä, ja ne on
 * voitava testata ilman selainta.
 */

/**
 * Korkeus jonka alapuolella kortti luopuu koristeistaan (ks. `isCompactCard`).
 *
 * Luku on MITATTU eikä arvattu. Sama 2 × 2 -kortti on eri kokoinen joka
 * näytöllä, koska rivikorkeus johdetaan näkymästä (App.vuen measureGridRows,
 * laskutoimitus gridGeometry.ts:ssä):
 *
 *   2736 × 1824 (seinänäyttö)  2 × 2 = 416 px   2 × 3 = 633 px
 *   1920 × 1080                2 × 2 = 230 px   2 × 3 = 354 px
 *   1366 ×  768                2 × 2 = 152 px   2 × 3 = 237 px
 *
 * TÄMÄ OLI 420, JA SE OLI 3,9 PX PÄÄSSÄ KÄYTTÄJÄN OMASTA KORTISTA.
 *
 * Korttikorkeus on suoraan verrannollinen näytön korkeuteen (mitatuista
 * luvuista: 2 × 2 ≈ näytön korkeus / 4 − 40 px), joten 420 vastasi näytön
 * korkeutta 1840. Käyttäjän näyttö on 1824. Kuudentoista pikselin korkeampi
 * näyttö olisi sammuttanut tiiviin tilan yhtä aikaa KAIKILTA kahdeltatoista
 * kortilta, eikä mikään olisi kertonut siitä — vika olisi näyttänyt siltä
 * että kortit vain yhtäkkiä näyttävät vähemmän.
 *
 * 560 px valittiin niin että kynnyksen kummallakin puolella on varaa
 * jokaisella yleisellä näyttökorkeudella (test/card-overflow.ts laskee nämä
 * samasta kaavasta kuin sovellus):
 *
 *   näyttö    2 × 2   2 × 3   -> 2 × 2 tiivis, 2 × 3 ei (ellei mainita)
 *    768 px    152     237       molemmat tiiviitä (kortit ovat pieniä)
 *   1080 px    230     354       molemmat tiiviitä
 *   1440 px    320     489       molemmat tiiviitä
 *   1824 px    416     633       VARA KYNNYKSEEN 144 px / 73 px
 *   2160 px    500     759       vara 60 px / 199 px  (4K)
 *
 * Yläraja on näytön korkeus ~2400, jossa 2 × 2 kasvaisi kynnyksen yli. Se ei
 * vastaa mitään yleistä näyttöä, kun taas vanha 420 osui 1840:een eli
 * 16 pikselin päähän tuetusta laitteesta.
 */
export const COMPACT_CARD_HEIGHT = 560;

/**
 * Onko kortti niin matala että koristeet vievät tilaa sisällöltä.
 *
 * Mitattu PIKSELIKORKEUS, ei ruudukon solumäärä: sama `rowSpan: 2` on
 * seinänäytöllä 416 px ja läppärillä 152 px, eikä solumäärä siis kerro
 * mahtuuko mikään. Juuri tämä ero on koko vian syy — seinänäytöllä kortit
 * näyttivät hyvältä, ja jokainen pienempi ruutu leikkasi hiljaa.
 *
 * Nolla ja negatiivinen eivät ole "hyvin tiivis" vaan "ei mitattu": kortti
 * joka ei ole vielä asettunut (tai on `display: none`) antaa nollan, eikä
 * siitä saa päätellä mitään.
 */
export function isCompactCard(heightPx: number): boolean {
  return heightPx > 0 && heightPx < COMPACT_CARD_HEIGHT;
}

/**
 * Alle tämän jäävää ylivuotoa ei ilmoiteta.
 *
 * Osapikselit: `scrollHeight` on kokonaisluku mutta elementtien todellinen
 * korkeus ei ole, joten tarkalleen mahtuva sisältö raportoi säännöllisesti
 * 1 px ylivuotoa. Ilmoitus siitä olisi väärä tieto siinä missä vaikeneminen
 * oikeasta ylivuodosta — kumpaakaan ei haluta.
 */
export const OVERFLOW_TOLERANCE_PX = 2;

/**
 * Montako pikseliä sisällöstä on piilossa.
 *
 * KAKSI LUKUA, EI KOLMEA — ilmoitusrivin korkeus ei ole tässä eikä saa tulla
 * takaisin. Rivi on `position: absolute` kortin alalaidassa (ks. style.css),
 * joten se EI vie kortin rungolta yhtään korkeutta: `visibleHeight` on sama
 * riippumatta siitä näkyykö ilmoitus. Vastaus riippuu siis vain sisällöstä ja
 * kortin koosta.
 *
 * Aiempi versio otti rivin korkeuden parametrina ja lisäsi sen takaisin,
 * koska rivi oli silloin normaalissa virrassa ja kutisti runkoa. Se oli
 * korjaus heiluriin (sisältö mahtuu -> ilmoitus pois -> tilaa lisää ->
 * ilmoitus takaisin), mutta samalla se söi rungosta rivin verran korkeutta
 * JOKA KORTISSA jossa ilmoitus näkyi — pörssisähkön kaaviosta se vei
 * viimeisetkin 14,5 px:stä nollaan. Asemointi poistaa kummankin ongelman
 * kerralla: heiluria ei voi syntyä jos mitta ei riipu ilmoituksesta.
 */
export function hiddenPixels(contentHeight: number, visibleHeight: number): number {
  const hidden = contentHeight - visibleHeight;
  return hidden > OVERFLOW_TOLERANCE_PX ? Math.round(hidden) : 0;
}

/**
 * Mahtuuko ilmoitusrivi kortin runkoon.
 *
 * Rivi on asemoitu kortin alalaitaan, joten se ei voi enää työntyä kortin
 * ULKOPUOLELLE — mutta liian matalassa kortissa se voisi peittää OTSIKON.
 * Silloin se rikkoisi juuri sen lupauksen jonka varassa MIN_PANEL_SPAN on
 * (ks. types.ts): otsikko ja "vanhentunut"-merkki säilyvät aina, jotta
 * rikkinäisen lähteen huomaa. Vajaa näkymä on pienempi vahinko kuin kortti
 * jota ei tunnista.
 *
 * `bodyHeight` on kortin rungon korkeus, eli se mitä otsikon jälkeen jää.
 * Ilmoitus näytetään vain jos se mahtuu siihen kokonaan.
 */
export function noticeFitsInCard(bodyHeight: number, noticeHeight: number): boolean {
  return noticeHeight > 0 && bodyHeight >= noticeHeight;
}

/** Yhden mitatun rivin pystysuora ala kortin leikkaavassa laatikossa. */
export interface RowBand {
  top: number;
  bottom: number;
  /**
   * Rivi jonka kortti itse on jo piilottanut (uutiskortti tekee näin:
   * `fittingItemCount` jättää ylimääräiset otsikot `visibility: hidden`
   * -tilaan, jolloin ne ovat asettelussa mutta eivät luettavissa). Sellainen
   * rivi on piilossa vaikka se olisi kokonaan taitteen yläpuolella.
   */
  concealed?: boolean;
}

/**
 * Montako riviä jää lukematta, kun näkyvä kaistale on `top`…`bottom`.
 *
 * Rivi lasketaan piiloon jääneeksi jos se ei mahdu KOKONAAN näkyvään
 * kaistaleeseen. Puoliksi näkyvä rivi on nimenomaan se tapaus jota vastaan
 * tämä koko moduuli on: puolikas päivämäärä tai puolikas ateria näyttää
 * luetulta mutta ei ole sitä.
 *
 * Yläreuna on mukana, koska vieritettävällä laitteella (puhelin, läppäri)
 * kortin sisältöä voi olla myös taitteen yläpuolella.
 */
export function clippedRowCount(rows: readonly RowBand[], visibleTop: number, visibleBottom: number): number {
  let count = 0;
  for (const row of rows) {
    if (row.concealed === true) {
      count += 1;
      continue;
    }
    // Osapikselivara samaan suuntaan kuin `hiddenPixels`: viimeinen rivi
    // päättyy usein murto-osan verran laatikon reunan alle vaikka se näkyy.
    if (row.bottom > visibleBottom + OVERFLOW_TOLERANCE_PX) count += 1;
    else if (row.top < visibleTop - OVERFLOW_TOLERANCE_PX) count += 1;
  }
  return count;
}

/**
 * Näytetäänkö ilmoitus lainkaan.
 *
 * KUMPIKIN luku riittää yksinään, eikä se ole varmuuden vuoksi:
 *
 *  - Pikseliylivuoto ilman rivejä: sää- ja pörssisähkökortissa ei ole
 *    toistuvia rivejä lainkaan, mutta kaavio leikkautuu silti.
 *  - Rivejä ilman pikseliylivuotoa: uutiskortti siivoaa ylivuotonsa itse
 *    (`fittingItemCount` + `visibility: hidden`), jolloin kortti ei vuoda yli
 *    yhtään mutta otsikoita jää silti lukematta. "Ei ylivuotoa" ei siis
 *    tarkoita "kaikki näkyy".
 *
 * KUMPIKAAN luku ei saa riippua ilmoitusrivistä. `hiddenPx` ei riipu, koska
 * rivi on asemoitu eikä vie rungolta korkeutta. Rivimäärä tässä on nimenomaan
 * `concealed`-rivit — kortin ITSENSÄ piilottamat — eikä se mitä ilmoitusrivi
 * peittää. Muuten ilmoitus jäisi pystyyn omasta ansiostaan: se peittää
 * alimman rivin ja lukee siitä perusteen omalle olemassaololleen silloinkin
 * kun sisältö on jo kutistunut mahtuvaksi.
 */
export function cardIsClipped(hiddenPx: number, hiddenRows: number): boolean {
  return hiddenPx > 0 || hiddenRows > 0;
}

/**
 * Ilmoituksen teksti. Rivimäärä kerrotaan aina kun se tiedetään: "+3 riviä ei
 * mahdu" kertoo paljonko puuttuu, kun taas pikselimäärä ei kerro katsojalle
 * mitään. Riveistä tietämätön kortti (sää, pörssisähkö) saa silti oman
 * ilmoituksensa — vaiteliaisuus on tässä se yksi vaihtoehto joka ei kelpaa.
 *
 * Tähän annettava rivimäärä on se mitä katsoja OIKEASTI menettää: rivit jotka
 * jäävät kortin alareunan alle TAI ilmoitusrivin peittoon. Se on aina
 * vähintään yhtä suuri kuin `cardIsClipped`in luku, joten kortti ei voi
 * aliarvioida piiloon jäänyttä — ja aliarvio olisi tässä sama vika pienempänä.
 */
export function clipNotice(hiddenRows: number): string {
  if (hiddenRows === 1) return "+1 rivi ei mahdu";
  if (hiddenRows > 1) return `+${hiddenRows} riviä ei mahdu`;
  return "Sisältö ei mahdu";
}

/**
 * Ilmoituksen ruudunlukijateksti. Erillinen näkyvästä tekstistä, koska
 * "+3 riviä ei mahdu" luetaan ääneen huonosti ja koska ilmoituksen merkitys
 * ("tämä kortti näyttää vajaan listan") on se olennainen osa.
 */
export function clipNoticeLabel(hiddenRows: number): string {
  if (hiddenRows === 1) return "Kortin sisältö ei mahdu näkyviin: yksi rivi on piilossa. Suurenna korttia asettelun muokkaustilassa.";
  if (hiddenRows > 1) return `Kortin sisältö ei mahdu näkyviin: ${hiddenRows} riviä on piilossa. Suurenna korttia asettelun muokkaustilassa.`;
  return "Kortin sisältö ei mahdu näkyviin. Suurenna korttia asettelun muokkaustilassa.";
}
