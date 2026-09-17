import { GRID_ROWS } from "./types.ts";

/**
 * Ruudukon solukorkeus pikseleinä, ja siitä johdettu yhden paneelin korkeus.
 *
 * Tämä on `App.vue`n `measureGridRows`in laskutoimitus omana funktionaan, eikä
 * se ole siirretty tänne siisteyden vuoksi: `cardOverflow.ts`:n
 * COMPACT_CARD_HEIGHT on kynnys JOTA VASTEN nämä luvut osuvat, eikä kumpaakaan
 * voinut aiemmin verrata toiseen testissä. Kynnys oli 3,9 px päässä käyttäjän
 * oman seinänäytön 2 × 2 -kortista, eikä mikään olisi huomannut jos se olisi
 * mennyt yli — 16 px lisää näytön korkeuteen olisi sammuttanut tiiviin tilan
 * kaikilta kahdeltatoista kortilta kerralla.
 *
 * Nyt sama kaava on testin käytettävissä (ks. web/test/card-overflow.ts).
 */

/**
 * Yhden ruudukkorivin korkeus. Kaikki neljä syötettä mitataan selaimesta:
 * näkymän korkeus, ruudukon yläreunan etäisyys sivun ylälaidasta (yläpalkki),
 * `.app`in alatäyte ja ruudukon `row-gap`.
 *
 * Kahdeksan riviä mahtuu AINA näkymään — ruudukko ei kasva näytön yli
 * sovitustilassa (ks. Settings.gridOverflow). Siksi jakaja on GRID_ROWS eikä
 * paneelien todellinen rivimäärä.
 */
export function gridRowHeight(
  viewportHeight: number,
  gridTop: number,
  bottomPadding: number,
  rowGap: number,
): number {
  return Math.max(1, (viewportHeight - gridTop - bottomPadding - rowGap * (GRID_ROWS - 1)) / GRID_ROWS);
}

/**
 * Paneelin korkeus pikseleinä, kun se kattaa `rowSpan` riviä.
 *
 * Välit ovat mukana: kahden rivin paneeli syö myös niiden VÄLISEN raon, joten
 * se on korkeampi kuin kaksi erillistä riviä.
 */
export function panelPixelHeight(rowHeight: number, rowGap: number, rowSpan: number): number {
  return rowHeight * rowSpan + rowGap * (rowSpan - 1);
}
