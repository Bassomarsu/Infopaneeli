/**
 * Uutiskortin puhdas logiikka: ikämerkintä, näytettävät rivit, ja se montako
 * riviä paneeliin oikeasti mahtuu. Omassa moduulissaan eikä NewsCard.vuessa
 * samasta syystä kuin `calendarMonth.ts` ja `electricityChart.ts` —
 * .vue-tiedostoa ei voi tuoda node-testiin, ja juuri nämä ovat se osa jonka
 * on oltava oikein riippumatta siitä miltä kortti näyttää.
 */
import type { NewsItem } from "../types";

/**
 * Kuinka vanha uutinen on, lyhyenä suomenkielisenä merkintänä.
 *
 * MIKSI SUHTEELLINEN IKÄ EIKÄ KELLONAIKA: seinänäytön ohi kävelevällä on
 * vain yksi kysymys, "onko tämä uutta". Suhteellinen ikä vastaa siihen
 * suoraan; kellonaika vaatii vertaamista yläpalkin kelloon, ja juuri
 * vuorokauden vaihteessa — jolloin "23.50" ja "00.10" ovat eri päiviltä —
 * vertailu menee helpoimmin väärin. Kellonaika olisi myös lyhyt vain
 * kuluvana päivänä ja vaatisi päivämäärän heti perään.
 *
 * Palauttaa null jos aikaleimaa ei ole tai se ei jäsenny — silloin kortti
 * jättää ikämerkinnän kokonaan pois eikä arvaa mitään. Tulevaisuuden
 * aikaleima (palvelimen ja lähteen kellot eivät ole samassa sekunnissa)
 * näytetään muodossa "nyt", ei negatiivisena.
 */
export function relativeAge(publishedAt: string | null | undefined, now: Date): string | null {
  if (typeof publishedAt !== "string" || publishedAt.length === 0) return null;
  const then = new Date(publishedAt);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return null;

  const minutes = Math.floor((now.getTime() - ms) / 60_000);
  if (minutes < 1) return "nyt";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} t`;

  return `${Math.floor(hours / 24)} vrk`;
}

/** Yksi valmiiksi muotoiltu rivi kortille. */
export interface NewsRow {
  id: string;
  /** Otsikko SELLAISENAAN, ks. newsRows. */
  title: string;
  /** Ylen oma osoite juttuun, sellaisenaan. */
  link: string;
  /** Null = aikaleimaa ei ollut tai se ei jäsentynyt; silloin merkintää ei näytetä. */
  age: string | null;
}

/**
 * Rivit kortille.
 *
 * `title` ja `link` menevät LÄPI KOSKEMATTOMINA. Ylen käyttöehdot
 * (https://yle.fi/aihe/a/20-10008076) kieltävät sisällön muokkaamisen, ja
 * vaativat että linkki vie suoraan vastaavaan juttuun Ylen sivustolla.
 * Näyttötilan takia otsikon saa katkaista, mutta se tehdään kortissa
 * CSS:llä (`-webkit-line-clamp`) eikä täällä merkkijonoa leikkaamalla —
 * leikattu otsikko olisi muokattu otsikko, ja se voisi päätyä muuallekin
 * kuin ruudulle.
 *
 * Ainoa laskettu kenttä on `age`.
 */
export function newsRows(items: readonly NewsItem[] | null | undefined, now: Date): NewsRow[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    link: item.link,
    age: relativeAge(item.publishedAt, now),
  }));
}

/**
 * Montako riviä paneeliin mahtuu KOKONAAN, mitattuna renderöidyistä
 * riveistä: `areaBottom` on listan alareunan y-koordinaatti ja `itemBottoms`
 * kunkin rivin alareuna samassa koordinaatistossa, järjestyksessä.
 *
 * MIKSI MITATAAN EIKÄ LASKETA: rivin korkeus vaihtelee, koska otsikko vie
 * yhden tai kaksi riviä sen mukaan kuinka pitkä se on ja kuinka leveä paneeli
 * on. Kertolasku "korkeus / rivin korkeus" olisi siis oikein vain silloin kun
 * kaikki otsikot sattuvat olemaan yhtä pitkiä — ja ylös päin erehtyessään se
 * jättäisi viimeisen rivin puoliksi näkyviin paneelin alareunaan.
 *
 * Tämä ei voi jäädä heilumaan kahden arvon välille: KAIKKI rivit
 * renderöidään aina, ja ylimääräiset vain piilotetaan `visibility`illä
 * paikoilleen. Asettelu ei siis muutu mittauksen tuloksesta, joten mittaus
 * antaa joka kerta saman vastauksen.
 *
 * Alaraja on 1 eikä 0: jos paneeli on niin matala ettei yksikään rivi mahdu
 * kokonaan, on parempi näyttää yksi katkaistu otsikko kuin tyhjä kortti,
 * jossa on dataa mutta ei mitään näkyvissä.
 */
export function fittingItemCount(
  areaBottom: number,
  itemBottoms: readonly number[],
  /** Alapikselin verran liukumaa — selaimen mitat eivät ole tasalukuja. */
  tolerancePx = 0.5,
): number {
  if (itemBottoms.length === 0) return 0;
  if (!Number.isFinite(areaBottom)) return 1;
  let count = 0;
  for (const bottom of itemBottoms) {
    if (!Number.isFinite(bottom) || bottom > areaBottom + tolerancePx) break;
    count += 1;
  }
  return Math.max(1, count);
}
