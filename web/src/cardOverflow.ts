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
 * näytöllä, koska rivikorkeus johdetaan näkymästä (App.vuen measureGridRows):
 *
 *   2736 × 1824 (seinänäyttö)  416 px
 *   1920 × 1080                230 px
 *   1366 ×  768                152 px
 *
 * 420 px asettuu juuri seinänäytön 2 × 2:n yläpuolelle, koska sekin vuotaa yli
 * (ruokalista piilotti siinä 899 px mitattuna). Seuraava koko ylöspäin,
 * 2 × 3 samalla näytöllä, on ~640 px eikä ole enää tiivis. Raja on siis
 * "pienin kortti jonka käyttäjä voi tehdä", ei mielivaltainen pikselimäärä.
 */
export const COMPACT_CARD_HEIGHT = 420;

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
 * Montako pikseliä sisällöstä on piilossa, KUN ilmoitusriviä ei lasketa.
 *
 * `noticeHeight` lisätään takaisin käytettävissä olevaan tilaan, eikä tämä ole
 * hienosäätöä vaan välttämätöntä. Ilmoitus vie itse tilaa kortista, joten
 * ilman tätä syntyy heiluri: sisältö mahtuu -> ilmoitus pois -> tila kasvaa ->
 * mahtuu yhä... mutta juuri mahtuva sisältö kaataisi sen toisin päin: ilmoitus
 * näkyviin -> tila pienenee -> sisältö ei mahdu -> ilmoitus näkyviin. Kortti
 * jäisi välkkymään ruudulla jota katsotaan koko päivä.
 *
 * Kun mitta otetaan aina ilman ilmoitusta, vastaus riippuu vain sisällöstä ja
 * kortin koosta — ei siitä mitä edellinen mittaus päätti.
 */
export function hiddenPixels(contentHeight: number, visibleHeight: number, noticeHeight: number): number {
  const available = visibleHeight + Math.max(0, noticeHeight);
  const hidden = contentHeight - available;
  return hidden > OVERFLOW_TOLERANCE_PX ? Math.round(hidden) : 0;
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
 * MOLEMMAT luvut on mitattava niin kuin ilmoitusriviä EI OLISI — ks.
 * `hiddenPixels`. Muuten ilmoitus voi jäädä pystyyn omasta ansiostaan: se vie
 * tilaa, työntää viimeisen rivin taitteen alle ja lukee siitä perusteen omalle
 * olemassaololleen silloinkin kun sisältö on jo kutistunut mahtuvaksi.
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
 * Tähän annettava rivimäärä on se mitä katsoja OIKEASTI menettää, eli mitattu
 * ilmoitusrivin kanssa. Se on aina vähintään yhtä suuri kuin `cardIsClipped`in
 * luku (ilmoitus vie tilaa, ei anna sitä), joten kortti ei voi aliarvioida
 * piiloon jäänyttä — ja aliarvio olisi tässä sama vika pienempänä.
 */
export function clipNotice(hiddenRows: number): string {
  if (hiddenRows === 1) return "+1 rivi ei mahdu";
  if (hiddenRows > 1) return `+${hiddenRows} riviä ei mahdu`;
  return "Sisältö ei mahdu näkyviin";
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
