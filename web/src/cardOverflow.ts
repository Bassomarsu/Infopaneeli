/**
 * Milloin kortti on niin matala että sen koristeet on jätettävä pois.
 *
 * Kortti leikkaa ylivuotavan sisältönsä piiloon (`.card { overflow: hidden }`),
 * ja yhdeksällä kortilla on rungossaan `overflow: auto` — sisältö on siis
 * vieritettävissä, ja vierityspalkki kertoo itse että lista jatkuu. Sovellusta
 * käytetään kosketuksella kaikkialla (viestit avautuvat painalluksesta,
 * kalenterin otsikko avaa kuukausinäkymän, kioskista poistutaan pitkällä
 * painalluksella), joten vieritys on seinänäytölläkin oikea ja riittävä vihje.
 *
 * Tässä oli aiemmin myös mitattu ilmoitus ("+5 riviä ei mahdu"). Se on
 * poistettu: se kertoi saman asian toiseen kertaan sen vieressä mikä sen jo
 * kertoi, ja maksoi kortin alalaidasta tilaa sekä jokaisesta DOM-muutoksesta
 * uuden mittauksen näytöllä joka on auki päiväkausia.
 *
 * Jäljelle jäävä sääntö on tilansäästö eikä ilmoitus, ja se on tässä eikä
 * CardShell.vuen sisällä samasta syystä kuin `calendarMonth.ts` ja
 * `electricityChart.ts`: .vue-tiedostoa ei voi tuoda node-testiin, ja tämä on
 * sovelluksen sääntö joka on voitava testata ilman selainta.
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
 * Tiivis tila karsii VAIN koristeita — täytteitä, toistettuja lähdemainintoja,
 * rivikohtaisia muokkauspainikkeita — eikä koskaan yhtään ateriaa, tapahtumaa
 * tai ostosta. Mitattuna käyttäjän seinänäytöllä se toi roskat, kauppalistan,
 * kausimuistutukset ja nimipäivät leikkautuneesta kokonaan näkyväksi.
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
