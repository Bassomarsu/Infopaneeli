import { getSettings } from "../core/settings.ts";
import { readCache } from "../core/store.ts";
import { Provider } from "../core/provider.ts";
import { localDateKey, shiftDateKey } from "../core/time.ts";

export interface MenuMeal { type: string; name: string }
export interface MenuDay { date: string; meals: MenuMeal[] }
export interface MenuData {
  locationId: string;
  locationName: string;
  sourceUrl: string;
  days: MenuDay[];
}
export const MENU_LOCATION_ID = "karstula_koulut";
const sourceUrl = (id: string) => `https://kouluruoka.fi/menu/${id}/`;

/**
 * LÄHTEEN MUOTO VAIHTUI. Sivuston oma Gatsby-aineisto
 * `https://kouluruoka.fi/page-data/menu/<id>/page-data.json` vastaa nykyään
 * HTTP 404:llä (todettu 16.9.2026) ja palauttaa 7,5 kt HTML:ää. Sama JSON on
 * siirtynyt itse ruokalistasivun sisään, elementtiin
 * `<script id="gatsby-inlined-page-data">`.
 *
 * RAKENNE ON TÄSMÄLLEEN SAMA (`result.pageContext.menu` kenttineen), joten
 * `parseMenuPage` ei muutu lainkaan — vain se, mistä JSON kaivetaan esiin.
 * Seuraavan viikon osoite on yhä `<id>/2/`; se luetaan sivuston omasta
 * ruokalistapohjasta (`window.location.href = /menu/${id}/${next ? "2/" : ""}`),
 * eikä siihen siis liity arvausta.
 *
 * Kouluhakemisto (core/menu-schools.ts) käyttää yhä `page-data`-polkuja ja ne
 * vastaavat edelleen HTTP 200:lla — katosi vain ruokalistasivujen aineisto.
 *
 * Tämä polku EI OLE LUVATTU RAJAPINTA vaan sivuston sisäinen koontiartefakti,
 * mikä juuri osoittautui todeksi kun se katosi; ks. docs/widget-sources.md.
 */
const INLINE_DATA_ID = "gatsby-inlined-page-data";

/**
 * Ruokalistasivu on ~55 kt (mitattu 16.9.2026). Katto on olemassa samasta
 * syystä kuin news.ts:n MAX_FEED_BYTES: osoitteen takaa voi vastata jotain
 * aivan muuta, ja rikkinäinen vastaus saa epäonnistua mutta se ei saa
 * puskuroida kymmeniä megatavuja muistiin laitteella, joka pyörii kuukausia
 * ilman uudelleenkäynnistystä. Ilman tätä 80 Mt:n vastaus meni läpi, kasvatti
 * keon 140 Mt:iin JA tallentui SQLite-välimuistiin, josta se olisi lähtenyt
 * ulos jokaisessa /api/dashboard-vastauksessa.
 */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Vastauksen runko merkkijonona, enintään MAX_PAGE_BYTES tavua.
 *
 * `content-length` tarkistetaan ensin, mutta se ei yksin riitä: otsake voi
 * puuttua (chunked) tai valehdella, jolloin `response.text()` puskuroisi silti
 * rajattomasti. Siksi runko luetaan paloissa ja katkaistaan heti rajan
 * ylittyessä — sama tapa kuin integrations/waste-vingo.ts:ssä.
 */
async function readCappedText(response: Response): Promise<string> {
  const tooLarge = () => new Error("Ruokalistasivu on odottamattoman suuri");
  if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_PAGE_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  // `fetch`in oma `text()` purkaa aina UTF-8:na riippumatta content-typestä,
  // jossa kouluruoka.fi ei ilmoita merkistöä lainkaan. Tehdään sama tässä.
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * JSON-olion loppuindeksi (viimeisen `}`:n jälkeinen kohta), kun `start`
 * osoittaa avaavaan `{`:iin. Heittää, jos olio ei sulkeudu ennen `limit`iä.
 *
 * TÄSSÄ EI KÄYTETÄ SÄÄNNÖLLISTÄ LAUSEKETTA, ja se on suorituskykyvaatimus eikä
 * tyyliseikka — sama syy kuin news.ts:n RSS-jäsentimessä (ks. sen kommentti
 * tagien etsinnästä). Lauseke muotoa `\{[\s\S]*\}` perääntyisi sulkemattomalla
 * syötteellä neliöllisesti, ja jäsennys on synkronista: se jäädyttäisi koko
 * tapahtumasilmukan, myös `/api/kiosk/exit`-päätepisteen, eli kioskista ei
 * pääsisi ulos sillä aikaa. Tämän silmukan kohdistin etenee aina eteenpäin,
 * joten työ on lineaarinen sivun pituuteen nähden.
 *
 * `charCodeAt` eikä `source[i]`: jälkimmäinen varaisi yhden merkin merkkijonon
 * joka kierroksella, ja näitä kierroksia on pahimmillaan MAX_PAGE_BYTES.
 */
function jsonObjectEnd(source: string, start: number, limit: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const code = source.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true; // \
      else if (code === 0x22) inString = false; // "
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x7b) depth++; // {
    else if (code === 0x7d && --depth === 0) return i + 1; // }
  }
  throw new Error("Ruokalistasivun upotettu data katkesi kesken");
}

/**
 * Sivun sisään upotettu Gatsby-aineisto oliona, sellaisena kuin
 * `page-data.json` sen ennen palautti.
 *
 * Skriptin runko on `(function(){var d={…};…window.pageData=d;})()`, joten
 * pelkkä ensimmäinen `{` osuisi funktion runkoon eikä JSONiin. Ankkurina on
 * `{"` — JSON alkaa aina merkkijonoavaimella, eikä minifioidussa
 * `JSON.stringify`-tulosteessa ole välilyöntiä aaltosulkeen jälkeen — joten
 * tämä kestää sen, että kääre muuttuu (muuttujan nimi, `var`/`let`,
 * nuolifunktio) ilman että jäsennintä tarvitsee koskea.
 *
 * Skriptin sisältöä ei entiteettipureta: HTML:ssä `<script>` on raakatekstiä,
 * ja Gatsby kirjoittaa `<`-merkit JSONiin `<`-muodossa, jonka JSON.parse
 * purkaa itse. Vahvistettu elävästä sivusta: yhtään kirjaimellista `</`-paria
 * ei esiinny JSONin sisällä.
 */
export function extractInlinedPageData(html: string): unknown {
  const marker = html.indexOf(INLINE_DATA_ID);
  if (marker === -1) throw new Error("Ruokalistasivulta puuttuu upotettu data");
  const tagEnd = html.indexOf(">", marker + INLINE_DATA_ID.length);
  if (tagEnd === -1) throw new Error("Ruokalistasivulta puuttuu upotettu data");
  // Sulkeva tagi rajaa etsinnän. Jos sitä ei ole, sivu on katkennut kesken:
  // yritetään silti loppuun asti, jolloin jäsennys kaatuu selkeään virheeseen
  // sen sijaan että palauttaisi puolikkaan viikon.
  const close = html.indexOf("</script", tagEnd + 1);
  const limit = close === -1 ? html.length : close;
  const start = html.indexOf('{"', tagEnd + 1);
  if (start === -1 || start >= limit) throw new Error("Ruokalistasivun upotettua dataa ei tunnistettu");
  try {
    return JSON.parse(html.slice(start, jsonObjectEnd(html, start, limit))) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Ruokalistasivun upotettua dataa ei voi lukea");
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ruokalistan rakenne muuttui");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Ruokalistan tiedot ovat puutteelliset");
  return value.trim();
}

/** Dates have no year in day labels. Match to the seven actual dates of Start,
 * so missing weekdays and weeks crossing New Year never shift the meals. */
export function parseMenuPage(body: unknown, locationId = MENU_LOCATION_ID): MenuData {
  const menu = record(record(record(body).result).pageContext).menu;
  const m = record(menu);
  if (m.RestaurantId !== locationId) throw new Error("Ruokalista kuuluu eri koululle");
  const start = text(m.Start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start) {
    throw new Error("Ruokalistan viikko puuttuu");
  }
  if (!Array.isArray(m.Days) || m.Days.length > 7) throw new Error("Ruokalistan päivät puuttuvat");
  const dates = Array.from({ length: 7 }, (_, i) => shiftDateKey(start, i));
  const seen = new Set<string>();
  const days = m.Days.map((raw): MenuDay => {
    const day = record(raw);
    const match = /(?:^|\s)(\d{1,2})\.(\d{1,2})\.$/.exec(text(day.Date));
    const date = dates.find(d => Number(d.slice(5, 7)) === Number(match?.[2]) && Number(d.slice(8)) === Number(match?.[1]));
    if (!date || seen.has(date)) throw new Error("Ruokalistan päivämäärä on virheellinen");
    seen.add(date);
    if (!Array.isArray(day.Meals)) throw new Error("Ruokalistan ateriat puuttuvat");
    return { date, meals: day.Meals.map(rawMeal => {
      const meal = record(rawMeal);
      return { type: text(meal.MealType), name: text(meal.Name) };
    }) };
  });
  return { locationId, locationName: text(m.RestaurantName), sourceUrl: sourceUrl(locationId), days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function fetchMenu(fetcher: typeof fetch = fetch, now: Date = new Date(), locationId = MENU_LOCATION_ID): Promise<MenuData> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(locationId)) throw new Error("Virheellinen koulutunniste");
  const weeks = await Promise.all(["", "2/"].map(async suffix => {
    const response = await fetcher(`${sourceUrl(locationId)}${suffix}`, {
      headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000),
    });
    // Next week is legitimately absent during school holidays — and until it
    // is published, which is the ordinary case mid-week.
    if (suffix && response.status === 404) return null;
    if (!response.ok) throw new Error(`Ruokalistan haku epäonnistui (HTTP ${response.status})`);
    return parseMenuPage(extractInlinedPageData(await readCappedText(response)), locationId);
  }));
  const first = weeks[0]!;
  if (!first) throw new Error("Ruokalista puuttuu");
  const today = localDateKey(now);
  const days = [...new Map(weeks.flatMap(w => w?.days ?? []).map(d => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date));
  // An old HTTP 200 must not overwrite the last usable cache with a healthy badge.
  if (days.length && days.every(d => d.date < shiftDateKey(today, -2))) throw new Error("Lähteen ruokalista on vanhentunut");
  return { ...first, days };
}

export interface MenuSchool extends MenuData { status: 'ok'|'stale'|'failed'|'loading'; error: string|null; fetchedAt: string|null }
export interface MenuCollection { schools: MenuSchool[] }
export function selectedMenuData(data: unknown, ids: string[], fetchedAt: string|null = null): MenuCollection {
  const raw = data as Partial<MenuCollection & MenuData> | null;
  const schools = Array.isArray(raw?.schools) ? raw.schools : raw?.locationId && Array.isArray(raw.days) ? [{...raw, status:'stale',error:null,fetchedAt} as MenuSchool] : [];
  return {schools:ids.map(id=>schools.find(s=>s.locationId===id) ?? {locationId:id,locationName:id,sourceUrl:sourceUrl(id),days:[],status:'loading',error:null,fetchedAt:null})};
}
/**
 * Kaikkien valittujen koulujen kaatuminen on PROVIDERIN virhe, ei kortin
 * yksityiskohta.
 *
 * Aiemmin virhe jäi koulukohtaiseen `error`-kenttään ja provideri palautti
 * `status:'ok'`. Seuraukset mitattiin: perääntyminen, katkaisija ja lokitus
 * eivät lauenneet koskaan, eikä lokiin tullut riviäkään vaikka ainoa valittu
 * koulu epäonnistui — samalla ajolla wilma ja calendar kirjasivat
 * `provider_failed` normaalisti. Lähde ehti olla poikki päiviä näyttämättä
 * siltä miltä katkos näyttää.
 *
 * Koulukohtainen eristys säilyy: kun edes yksi koulu onnistui, kierros on
 * onnistunut ja epäonnistuneen koulun oma virhe näkyy sen omassa kentässä.
 * Tyhjä valinta ei ole virhe — silloin ei ole mitään mikä olisi epäonnistunut.
 */
function failIfEverySchoolFailed(ids: string[], schools: MenuSchool[]): void {
  if (!ids.length || schools.some(school => school.status === 'ok')) return;
  const reasons = [...new Set(schools.map(school => school.error).filter((error): error is string => !!error))];
  if (ids.length === 1) throw new Error(reasons[0] ?? 'Ruokalistan haku epäonnistui');
  throw new Error(`Ruokalistan haku epäonnistui kaikille ${ids.length} koululle: ${reasons.join(' / ')}`);
}
export async function fetchSelectedMenus(fetcher: typeof fetch = fetch, selection = () => getSettings().menuSchoolIds, previous: unknown = null, now = new Date()): Promise<MenuCollection> {
  // A setting can change during either network request. Finish with the current
  // selection, so Provider's busy guard cannot strand the new school for 4h.
  for(let attempt=0;attempt<4;attempt++) {
    const ids=[...selection()]; const old=selectedMenuData(previous,ids).schools;
    const schools=await Promise.all(ids.map(async (id): Promise<MenuSchool> => {
      try {return {...await fetchMenu(fetcher,now,id),status:'ok',error:null,fetchedAt:new Date().toISOString()};}
      catch(error) {const cached=old.find(s=>s.locationId===id)!;return {...cached,status:cached.fetchedAt?'stale':'failed',error:error instanceof Error?error.message:'Ruokalistan haku epäonnistui'};}
    }));
    // Valinta tarkistetaan ENNEN virheen heittämistä: juuri poistetun koulun
    // epäonnistuminen ei saa näkyä uuden valinnan virheenä, vaan kierros
    // uusitaan kuten ennenkin.
    if(JSON.stringify(ids)===JSON.stringify(selection())){failIfEverySchoolFailed(ids,schools);return {schools};}
    previous={schools};
  }
  throw new Error('Kouluvalinta muuttui haun aikana. Yritetään uudelleen.');
}
export function createMenuProvider(): Provider<MenuCollection> {
  return new Provider<MenuCollection>({ id: 'menu', intervalMs: 4*60*60*1000, initialDelayMs:7000,
    fetch:()=>{ const cached=readCache<unknown>('menu'); return fetchSelectedMenus(fetch,()=>getSettings().menuSchoolIds,selectedMenuData(cached?.data,getSettings().menuSchoolIds,cached?.fetchedAt)); } });
}
