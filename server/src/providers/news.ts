/**
 * Ylen uutissyöte (RSS 2.0).
 *
 * YLEN RSS-SYÖTTEEN KÄYTTÖEHDOT rajaavat tätä tiedostoa, eivät vain sen
 * käyttöä (https://yle.fi/aihe/a/20-10008076, päivitetty 15.11.2024). Ne
 * luettiin ennen toteutusta, ja kirjataan tähän jotta rajoitus ei katoa
 * seuraavassa muokkauksessa:
 *
 *   - Syötettä saa käyttää omassa sovelluksessa ja OTSIKOITA saa näyttää.
 *   - Jokaisen otsikon linkin on johdettava SUORAAN vastaavaan juttuun Ylen
 *     sivustolla. Siksi `link` välitetään syötteestä sellaisenaan,
 *     `?origin=rss` mukaan lukien — sitä ei siistitä eikä korvata `guid`illa.
 *   - Uutisjuttujen VALOKUVIA EI SAA KÄYTTÄÄ. Tämä syöte ei sisällä kuvia
 *     lainkaan, eikä tänne saa lisätä niiden hakemista muualtakaan.
 *   - Sisältöä ei saa muokata, kopioida eikä myydä. Siksi tämä provider hakee
 *     VAIN RSS-syötteen eikä koskaan itse juttusivua: mitään ei kaavita Ylen
 *     sivustolta. Otsikkoa ja ingressiä ei lyhennetä eikä muuteta täällä (XML-
 *     rakenteen purku ja välilyöntien normalisointi eivät ole sisällön
 *     muokkaamista); mahdollinen katkaisu on näyttöpuolen esitysasia.
 *   - Yle voi lopettaa syötteen milloin tahansa ilman ilmoitusta. Provideri
 *     kestää sen kuten minkä tahansa katkoksen: vanha data jää näkyviin ja
 *     katkaisija hidastaa yritykset.
 *
 * XML puretaan tässä tiedostossa ilman uutta riippuvuutta, ks. parseNewsFeed.
 */
import { newsCategories } from "../core/news-categories.ts";
import { Provider, type ProviderSnapshot } from "../core/provider.ts";
import { getSettings } from "../core/settings.ts";

/**
 * Kanoninen osoite. Vanha `feeds.yle.fi`-osoite ohjaa (301) tähän, joten
 * ohjausta ei kannata ottaa joka haulla.
 *
 * Vakio eikä ympäristömuuttuja, samoin kuin Open-Meteon ja porssisahko.netin
 * osoitteet omissa providereissaan: asennus ei kysy tästä mitään eikä
 * aihealueiden osoitteet ovat virallisesta RSS-hakemistosta
 * core/news-categories.ts-tiedostossa.
 */


/**
 * Syötteen oma `ttl` on 5 minuuttia, mutta tämä on seinänäyttö jota katsotaan
 * ohi kulkiessa eikä uutishuone. Vartti on tarpeeksi tuoretta siihen mihin
 * tätä katsotaan, ja kolmasosa siitä liikenteestä minkä ttl sallisi.
 */
const FETCH_INTERVAL_MS = 15 * 60 * 1000;

/** Yksi HTTP-haku, ei koko kierros — kierroksen katto on providerin timeoutMs. */
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Syöte on ~8 kt. Katto on olemassa sen varalta, että osoitteen takaa
 * vastaakin jotain aivan muuta (esim. operaattorin kaappaussivu): rikkinäinen
 * vastaus saa epäonnistua, mutta se ei saa puskuroida kymmeniä megatavuja
 * muistiin laitteella, joka pyörii kuukausia ilman uudelleenkäynnistystä.
 */
const MAX_FEED_BYTES = 2 * 1024 * 1024;

/**
 * Yläraja välitettävien juttujen määrälle. Syötteessä on 12, ja koko lista
 * kulkee `/api/dashboard`-vastauksessa selaimelle minuutin välein — poikkeavan
 * pitkä syöte ei saa moninkertaistaa seinänäytön normaalia liikennettä.
 */
const MAX_ITEMS = 30;

export interface NewsItem {
  /** Syötteen `guid`, tai `link` jos guidia ei ole. */
  id: string;
  title: string;
  /** Syötteen `link` sellaisenaan — ks. käyttöehdot tiedoston alussa. */
  link: string;
  /** ISO 8601. */
  publishedAt: string;
  /** Syötteen `description`, tai null jos sitä ei ole. */
  summary: string | null;
}

export interface NewsData {
  items: NewsItem[];
  categories?: string[];
}

/**
 * XML puretaan itse eikä kirjastolla. `node_modules` menee sellaisenaan
 * julkaisupakettiin, joka on jo 52 Mt, ja mukana oleva `node-ical` on iCalia
 * eikä RSS:ää — uusi riippuvuus maksaisi siis pakettikokoa eikä korvaisi
 * mitään. Vastapainoksi tämä jäsennin ei ole yleiskäyttöinen XML-jäsennin
 * vaan lukee täsmälleen RSS 2.0:n `<item>`-rakenteen: se ei tunne
 * nimiavaruuksia, DTD:itä eikä sisäkkäisiä elementtejä, eikä sen tarvitse.
 *
 * Kaikki tässä tiedostossa oleva jäsennys on TOTAALI: `parseNewsFeed` ei heitä
 * millään syötteellä, vaan palauttaa sen mitä ymmärsi. Tyhjä tulos on
 * kutsujan (fetchNews) tulkittavaksi virheeksi — näin rikkinäinen yksittäinen
 * juttu ei vie mukanaan yhtätoista ehjää.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Yksi ainoa läpikäynti, ei ketjutettuja replace-kutsuja: ketjussa `&amp;lt;`
 * purkautuisi ensin muotoon `&lt;` ja sitten merkiksi `<`, vaikka se
 * tarkoittaa kirjaimellista tekstiä `&lt;`. Tuntematon entiteetti jätetään
 * koskemattomaksi — se on todennäköisemmin osa otsikkoa kuin koodausvirhe.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Elementin tekstisisältö: CDATA-lohkot otetaan kirjaimellisina (entiteetit
 * CDATA:n sisällä EIVÄT ole entiteettejä, vaan tekstiä) ja muut osat
 * entiteettipuretaan. Sulkematon CDATA ei ole virhe jonka takia juttu
 * hylätään: loppu otetaan sellaisenaan.
 *
 * Peräkkäiset välimerkit tiivistetään yhdeksi välilyönniksi ja reunat
 * siistitään. Tämä on XML:n sisennysten purkua, ei sisällön muokkaamista:
 * syötteessä rivinvaihto elementin sisällä on muotoilua eikä otsikon osa.
 */
function decodeXmlText(raw: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", i);
    if (start === -1) {
      out += decodeEntities(raw.slice(i));
      break;
    }
    out += decodeEntities(raw.slice(i, start));
    const end = raw.indexOf("]]>", start + 9);
    if (end === -1) {
      out += raw.slice(start + 9);
      break;
    }
    out += raw.slice(start + 9, end);
    i = end + 3;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * TAGIEN ETSINTÄ TEHDÄÄN `indexOf`illa EIKÄ SÄÄNNÖLLISELLÄ LAUSEKKEELLA, ja
 * tämä on suorituskykyvaatimus eikä tyyliseikka.
 *
 * Aiempi toteutus käytti lauseketta muotoa `<tag…>([\s\S]*?)</tag>`. Kun
 * sulkevaa tagia ei ole, moottori perääntyy: se yrittää jokaisesta avaavasta
 * tagista uudelleen ja skannaa joka kerta dokumentin loppuun, eli työ kasvaa
 * neliöllisesti. Mitattuna, syötteillä jotka mahtuvat MAX_FEED_BYTESin alle:
 *
 *   120 000 avaavaa <title> ilman sulkevaa   0,80 Mt   19 600 ms
 *   200 000 avaavaa <item>  ilman sulkevaa   1,14 Mt   40 200 ms
 *
 * Jäsennys on synkronista, joten tuo on koko tapahtumasilmukka jumissa —
 * myös `/api/kiosk/exit`, eli kioskista ei pääse ulos sillä aikaa.
 * Providerin `timeoutMs` ei auta lainkaan: se ei voi keskeyttää synkronista
 * työtä. Eikä tähän tarvita hyökkääjää, vain rikkinäistä XML:ää lähteestä
 * jota emme hallitse.
 *
 * `indexOf` ei perääntetä: kummankin hakufunktion kohdistin etenee aina
 * eteenpäin, joten yhden dokumentin läpikäynti on lineaarinen sen pituuteen
 * nähden. Siksi tässä ei myöskään tarvita erillistä "avaavien ja sulkevien
 * tagien suhde on absurdi" -tarkistusta: kun työ ei voi kasvaa neliöllisesti,
 * absurdi syöte on vain nopeasti hylätty syöte.
 */

/** Onko `<tag` kohdassa `at` kokonainen tagin nimi, ei vain alkuosa (`<items`)? */
function isNameBoundary(ch: string | undefined): boolean {
  return ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Avaavan `<tag …>`:n SISÄLLÖN alkuindeksi, tai -1. */
function findOpenTag(source: string, tag: string, from: number): number {
  const needle = `<${tag}`;
  let at = source.indexOf(needle, from);
  while (at !== -1) {
    if (isNameBoundary(source[at + needle.length])) {
      const gt = source.indexOf(">", at + needle.length);
      return gt === -1 ? -1 : gt + 1;
    }
    at = source.indexOf(needle, at + needle.length);
  }
  return -1;
}

/** Sulkevan `</tag>`:n aloittavan `<`:n indeksi, tai -1. */
function findCloseTag(source: string, tag: string, from: number): number {
  const needle = `</${tag}`;
  let at = source.indexOf(needle, from);
  while (at !== -1) {
    if (isNameBoundary(source[at + needle.length])) return at;
    at = source.indexOf(needle, at + needle.length);
  }
  return -1;
}

/**
 * Ensimmäinen `<tag>`-elementti lohkon sisältä. Attribuutit sallitaan
 * (`<guid isPermaLink="false">`), itsestään sulkeutuva muoto ei tuota osumaa
 * — sillä ei ole tekstisisältöä jota hakea.
 */
function tagText(block: string, tag: string): string | null {
  const start = findOpenTag(block, tag, 0);
  if (start === -1) return null;
  const close = findCloseTag(block, tag, start);
  if (close === -1) return null;
  const text = decodeXmlText(block.slice(start, close));
  return text === "" ? null : text;
}

/**
 * Sallitut isäntänimet. Kaksi erillistä syytä, kumpikin yksin riittävä:
 *
 * 1. YLEN KÄYTTÖEHDOT vaativat että otsikon linkki johtaa vastaavaan juttuun
 *    YLEN SIVUSTOLLA; muu linkitys on nimenomaisesti kielletty. Pelkkä
 *    http(s)-tarkistus ei siis riitä ehtojen noudattamiseen.
 * 2. Kaapattu tai väärennetty syöte (DNS kotiverkossa, välityspalvelin)
 *    veisi perheen puhelimen mihin tahansa osoitteeseen, ja linkki näyttäisi
 *    tulevan luotetusta lähteestä.
 *
 * Piste on `.yle.fi`:ssä pakollinen: ilman sitä `notyle.fi` läpäisisi
 * tarkistuksen. `URL.hostname` on jo pienaakkostettu ja punycode-muodossa,
 * joten `YLE.FI` ja unicode-huijaukset eivät kierrä tätä.
 */
const ALLOWED_HOST = "yle.fi";

function isAllowedLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // VAIN https. Kaksi syytä miksi `http` pudotetaan eikä vain sallita:
  // syöte antaa aina `https` ja Yle ohjaa `http`:n joka tapauksessa, joten
  // sallivuudesta ei ole mitään hyötyä — mutta jos syötteessä joskus on
  // `http`-linkki (kaapattuna tai virheestä), perheen puhelin avaisi sen
  // salaamattomana osoitteella joka näyttää oikealta.
  //
  // Skeema tarkistetaan siis kahdesta syystä: tämän lisäksi osoite päätyy
  // selaimessa `href`-attribuuttiin, ja `javascript:`-alkuinen "linkki"
  // olisi suoraan koodin suoritus näyttölaitteella.
  if (url.protocol !== "https:") return false;
  const host = url.hostname;
  return host === ALLOWED_HOST || host.endsWith(`.${ALLOWED_HOST}`);
}

/**
 * RFC 822 -aika ISO 8601:ksi, tai null jos sitä ei saa tulkittua.
 *
 * Juttu ilman kelvollista `pubDate`ä jätetään pois, koska `publishedAt` on
 * pakollinen kenttä eikä sille ole rehellistä varasijaa: hakuhetki
 * väittäisi jokaista juttua juuri ilmestyneeksi. Jos Yle joskus vaihtaisi
 * aikamuodon tunnistamattomaksi, koko syöte tyhjenisi ja provideri
 * epäonnistuisi näkyvästi — se on parempi kuin kaksitoista väärää kellonaikaa
 * ruudulla, jota kukaan ei huomaa vääräksi.
 */
function toIsoDate(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : parsed.toISOString();
}

/**
 * `<item>…</item>`-lohkot järjestyksessä. RSS:ssä item ei ole sisäkkäinen.
 *
 * Katkaistaan MAX_ITEMSiin jo TÄSSÄ eikä vasta jäsennyksen jälkeen: muuten
 * poikkeavan pitkä syöte pilkottaisiin kokonaisuudessaan muistiin ennen kuin
 * ylimääräiset heitettäisiin pois. Silmukka ei voi kiertää useammin kuin
 * MAX_ITEMS + 1 kertaa, koska jokainen kierros joko poimii lohkon tai
 * keskeyttää — eikä puuttuva sulkeva tagi jää hakemaan sitä uudelleen
 * jokaisesta avaavasta tagista (ks. findCloseTag yllä).
 */
function itemBlocks(xml: string): string[] {
  const blocks: string[] = [];
  let pos = 0;
  while (blocks.length < MAX_ITEMS) {
    const start = findOpenTag(xml, "item", pos);
    if (start === -1) break;
    const close = findCloseTag(xml, "item", start);
    // Ei sulkevaa tagia enää missään — myöhemmilläkään avaavilla tageilla ei
    // siis voi olla sellaista, joten etsintä loppuu tähän eikä jatku.
    if (close === -1) break;
    blocks.push(xml.slice(start, close));
    pos = close + "</item".length;
  }
  return blocks;
}

/**
 * Ei koskaan heitä. Rikkinäinen syöte — puuttuva kenttä, kesken katkennut
 * XML, tyhjä vastaus, HTML-virhesivu RSS:n sijaan — tuottaa tyhjän tai
 * vajaan listan, ei poikkeusta. Yksittäinen kelvoton juttu pudotetaan;
 * muut säilyvät.
 */
export function parseNewsFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  for (const block of itemBlocks(xml)) {
    if (items.length >= MAX_ITEMS) break;

    const title = tagText(block, "title");
    const link = tagText(block, "link");
    if (title === null || link === null || !isAllowedLink(link)) continue;

    const publishedAt = toIsoDate(tagText(block, "pubDate"));
    if (publishedAt === null) continue;

    // `guid` on tässä syötteessä sama osoite ilman `?origin=rss`-parametria,
    // mutta se on silti oikea tunniste: se pysyy samana vaikka linkin
    // parametrit muuttuisivat. Ilman guidia linkki kelpaa tunnisteeksi.
    const id = tagText(block, "guid") ?? link;
    if (seen.has(id)) continue;
    seen.add(id);

    items.push({ id, title, link, publishedAt, summary: tagText(block, "description") });
  }

  return items;
}

/**
 * Hakeeko uutisia vaikka kortti on piilotettu asetuksista?
 *
 * Ei hae. Tämä on ainoa provideri, jonka koko hyöty katoaa kun kortti on
 * piilossa: siinä ei ole hälytyksiä, ei historiaa eikä muuta näkymätöntä
 * käyttöä. Portti on providerin oma `shouldRun`, jota käytetään jo hiljaisiin
 * tunteihin (Wilma, Päikky) — se luetaan uudelleen joka kierroksella, joten
 * asetuksen muutos vaikuttaa ilman uudelleenkäynnistystä eikä
 * providerirekisteri tai käynnistysjärjestys muutu lainkaan.
 */
export function shouldFetchNews(): boolean {
  return !getSettings().hiddenPanels.includes("news");
}

/**
 * Montako VERKKOHAKUA on tehty sen jälkeen kun kortti viimeksi oli näkyvissä.
 * Nollautuu heti kun kortti palaa käyttöön, ja prosessin käynnistyessä.
 *
 * Tämä on olemassa siksi, että `shouldRun` yksin EI riitä. provider.ts
 * ohittaa `shouldRun`in kokonaan niin kauan kuin dataa ei ole kertaakaan
 * saatu (`this.data !== null && this.options.shouldRun && …`), jotta
 * hiljaiset tunnit eivät jättäisi Wilma-korttia tyhjäksi koko yöksi silloin
 * kun näyttö pystytetään myöhään illalla: ilman ohitusta ensimmäinen haku
 * odottaisi aamuun, eikä käyttäjä erottaisi väärin määriteltyä lähdettä
 * hiljaisesta yöstä.
 *
 * Ohituksen sivuvaikutus tässä providerissa on mitattu, ei päätelty
 * (12 hakukierrosta, laskettu todelliset HTTP-pyynnöt):
 *
 *   piilotettu, syöte toimii, ei välimuistia   ->  1 pyyntö    (ohitus laukeaa kerran)
 *   piilotettu, välimuisti lämmin              ->  0 pyyntöä   (portti pitää heti)
 *   piilotettu, syöte POIKKI, ei välimuistia   -> 12 pyyntöä   <-- ilman tätä laskuria
 *
 * Viimeinen rivi on se syy miksi tämä laskuri on olemassa. Epäonnistunut
 * haku ei aseta dataa, joten ohitus laukeaa uudelleen joka kierroksella, ja
 * pysyvästi pois kytketty kortti hakisi syötettä ikuisesti perääntymisen
 * tahdissa. Se olisi pahempi kuin ominaisuuden puuttuminen kokonaan: se
 * näyttäisi toimivan muttei toimisi.
 *
 * Yksi yritys per piilossaolojakso säilyttää ohituksen hyödyn — käyttöön
 * otetulla kortilla on heti jotain näytettävää — ja poistaa sen hinnan.
 * Uudelleenkäynnistys nollaa laskurin, eli hinta on enintään yksi pyyntö
 * per käynnistys, ei yksi per varttitunti.
 */
let networkAttemptsWhileHidden = 0;

/** Vain testejä varten: nollaa piilossaolon yrityslaskurin. */
export function resetHiddenFetchGuard(): void {
  networkAttemptsWhileHidden = 0;
}

/**
 * MIKSI AIHEALUEET HAETAAN RINNAKKAIN EIKÄ SARJASSA.
 *
 * Alkuperäinen määrittely pyysi sarjassa hakemista kohteliaisuudesta lähdettä
 * kohtaan. Sitä ei tehdä, ja syy on mitattavissa eikä makuasia:
 *
 *   - Kohteliaisuus on pyyntöjen TAHTI, ei rinnakkaisuus. Katto on 8
 *     aihealuetta ja kierros on 15 minuutin välein, eli enintään 32 pyyntöä
 *     tunnissa kumpanakin tapana. Sarja ei vähennä yhtäkään pyyntöä; se vain
 *     levittää samat pyynnöt pidemmälle. Kahdeksan rinnakkaista pyyntöä
 *     vartissa ei ole kuorma yhdellekään CDN:lle.
 *
 *   - Sarja rikkoisi juuri sen takuun, jonka vuoksi `allSettled` otettiin
 *     käyttöön. Yksi HTTP-haku saa kestää HTTP_TIMEOUT_MS = 15 s, ja koko
 *     kierroksen katto on providerin `timeoutMs` = 70 s. Kahdeksan peräkkäistä
 *     jumittunutta hakua on 8 × 15 s = 120 s > 70 s, jolloin providerin oma
 *     aikakatkaisu laukeaa ja HYLKÄÄ KOKO KIERROKSEN — myös ne aihealueet,
 *     jotka ehtivät palauttaa kelvollisia juttuja. Rinnakkain pahin tapaus on
 *     15 s, reilusti katon alla.
 *
 * Jos sarja joskus halutaan, `timeoutMs` on nostettava samalla yli
 * 8 × HTTP_TIMEOUT_MS:n — muuten osittainen onnistuminen katoaa hiljaisesti.
 */
async function fetchNews(): Promise<NewsData> {
  if (shouldFetchNews()) {
    networkAttemptsWhileHidden = 0;
  } else if (networkAttemptsWhileHidden >= 1) {
    // Heitetään tavallisena virheenä eikä FatalProviderErrorina: fataali
    // avaisi katkaisijan, jonka jäähdytys venyy neljään tuntiin, ja kortin
    // käyttöön ottaminen jäisi odottamaan sitä. Tavallisella virheellä
    // perääntyminen kattautuu 30 minuuttiin, joten käyttöön palautettu
    // kortti hakee viimeistään silloin. Yhtään verkkopyyntöä ei lähde:
    // tämä palaa ennen fetchiä.
    throw new Error("Uutiskortti on kytketty pois käytöstä, eikä syötettä haeta");
  } else {
    networkAttemptsWhileHidden++;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const categories = [...getSettings().newsCategories];
    // `allSettled` eikä `all`: yhden aihealueen kaatuminen ei saa viedä
    // muiden juttuja mukanaan. Mitattuna vanhalla `Promise.all`illa: kun
    // kahdesta valitusta aihealueesta toinen kaatui, kortti jäi kylmällä
    // käynnistyksellä TYHJÄKSI (status `failed`) vaikka toinen oli palauttanut
    // kelvollisia juttuja, ja lämpimällä välimuistilla se näytti vanhaa dataa.
    const settled = await Promise.allSettled(categories.map(id => fetchNewsCategory(id)));
    if (categoryKey(categories) !== categoryKey(getSettings().newsCategories)) continue;
    const feeds = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);

    // Sama sääntö kuin ruokalistaproviderissa: virhe nousee ylös vasta kun
    // JOKAINEN valittu syöte epäonnistui. Vasta silloin providerin
    // perääntyminen, katkaisija ja lokitus kuuluvat laueta.
    if (categories.length && !feeds.length) {
      const reasons = [...new Set(settled.flatMap(result =>
        result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []))];
      if (categories.length === 1) throw new Error(reasons[0] ?? "Ylen uutissyötteen haku epäonnistui");
      throw new Error(`Yhdenkään valitun uutissyötteen haku ei onnistunut: ${reasons.join(" / ")}`);
    }

    // Yhdistäminen koskee VAIN jo hyväksyttyjä juttuja: jokainen turvatarkistus
    // (vain https, isäntä yle.fi tai *.yle.fi, lineaarinen jäsennin, tavukatto)
    // tehdään syötekohtaisesti fetchNewsCategoryssa, eikä tässä ole polkua joka
    // ohittaisi ne. Kaksoiskappaleet pois `guid`illa, järjestys julkaisuajan
    // mukaan, katto MAX_ITEMS — kuten ennenkin.
    const items = [...new Map(feeds.flat().map(item => [item.id, item])).values()]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, MAX_ITEMS);
    return { items, categories };
  }
  throw new Error("Uutisvalinnat muuttuivat haun aikana. Yritetään uudelleen.");
}

async function fetchNewsCategory(id: string): Promise<NewsItem[]> {
  const url = newsCategories.find(category => category.id === id)?.url;
  if (!url) throw new Error("Tuntematon uutiskategoria");
  const response = await fetch(url, {
    headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ylen uutissyöte vastasi HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    throw new Error(`Ylen uutissyöte on odottamattoman suuri (${declaredLength} tavua)`);
  }

  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) {
    throw new Error("Ylen uutissyöte on odottamattoman suuri");
  }

  const items = parseNewsFeed(xml);
  if (items.length === 0) {
    // Tyhjä tulos on virhe eikä "ei uutisia": pääuutissyöte ei ole koskaan
    // tyhjä, joten tämä tarkoittaa että vastaus ei ollut odotettua RSS:ää.
    // Virheenä siitä jää yksi rivi lokiin ja vanhat otsikot jäävät ruudulle.
    throw new Error("Ylen uutissyötteestä ei löytynyt yhtään juttua");
  }

  return items;
}

export function createNewsProvider(): Provider<NewsData> {
  return new Provider<NewsData>({
    id: "news",
    intervalMs: FETCH_INTERVAL_MS,
    // Viimeisenä käynnistysjonossa (sähkö 0 s, Wilma 2 s, sää 5 s, kalenteri
    // 10 s, Päikky 15 s): uutiset ovat näistä se, jonka viivästyminen
    // muutamalla sekunnilla käynnistyksessä haittaa vähiten.
    initialDelayMs: 20_000,
    timeoutMs: 70_000,
    shouldRun: shouldFetchNews,
    fetch: fetchNews,
  });
}

function categoryKey(ids: string[]): string { return [...ids].sort().join(","); }

/** Vanhan valinnan otsikoita ei esitetä uuden valinnan tuloksena. */
export function projectNewsSnapshot(snapshot: ProviderSnapshot<unknown>): ProviderSnapshot<unknown> {
  const data = snapshot.data as NewsData | null;
  const selected = getSettings().newsCategories;
  if (!data || categoryKey(data.categories ?? ["paauutiset"]) === categoryKey(selected)) return snapshot;
  return { ...snapshot, data: null, fetchedAt: null, status: snapshot.status === "failed" || snapshot.status === "stale" ? "failed" : "idle" };
}
