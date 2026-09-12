import { ref, type Ref } from "vue";

/**
 * Sään sijainnin postinumerohaku asetuspaneelia varten.
 *
 * Logiikka on omassa moduulissaan eikä komponentissa kahdesta syystä:
 * viivästetty haku ja vanhentuneiden vastausten hylkääminen ovat juuri sitä
 * mitä ei voi silmämääräisesti todentaa, ja node-testi (test/weather-location.ts)
 * pääsee tähän käsiksi ilman selainta — sama kuvio kuin useEditAccess.ts:llä
 * ja useLongPress.ts:llä.
 */

/**
 * Kapein mahdollinen fetch-rajapinta, jotta tähän kelpaa sekä globaali
 * `fetch` että useEditAccessin `editFetch` (joka ottaa vain merkkijono-URLin)
 * — ja testeissä väärennetty toteutus.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export const POSTAL_CODE_LENGTH = 5;

/** Kuinka kauan näppäimistö saa olla hiljaa ennen kuin haku lähtee. */
export const LOOKUP_DEBOUNCE_MS = 350;

/** `GET /api/postal-code/:code` -vastaus. */
export interface PostalCodePlace {
  code: string;
  place: string;
  latitude: number;
  longitude: number;
}

/**
 * Hakukentän tila. `incomplete` ja `unknown` ovat tarkoituksella eri arvoja:
 * kolme numeroa on kesken kirjoittamista eikä virhe, kun taas viisi numeroa
 * jota ei tunneta on nimenomaan virhe josta pitää kertoa. Jos nämä
 * sulautuisivat yhdeksi "ei kelpaa" -tilaksi, kenttä huutaisi virhettä heti
 * ensimmäisestä näppäimestä.
 */
export type PostalLookupState =
  | { kind: "empty" }
  | { kind: "incomplete" }
  | { kind: "loading"; code: string }
  | { kind: "found"; code: string; place: PostalCodePlace }
  | { kind: "unknown"; code: string }
  | { kind: "error"; code: string; message: string };

export interface PostalCodeLookup {
  state: Ref<PostalLookupState>;
  /** Kertoo kentän uuden raakasisällön; palauttaa siitä siivotun numerosarjan. */
  setInput(raw: string): string;
  /** Ajastin pois — kutsuttava kun komponentti puretaan. */
  dispose(): void;
}

/** Kentästä palvelimelle asti kulkee vain numeroita, korkeintaan viisi. */
export function normalizePostalCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, POSTAL_CODE_LENGTH);
}

export function isCompletePostalCode(code: string): boolean {
  return code.length === POSTAL_CODE_LENGTH && /^\d+$/.test(code);
}

function isPostalCodePlace(value: unknown): value is PostalCodePlace {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["code"] === "string" &&
    typeof row["place"] === "string" &&
    typeof row["latitude"] === "number" &&
    typeof row["longitude"] === "number"
  );
}

/**
 * Rakentaa yhden hakukentän tilakoneen.
 *
 * Haku lähtee vasta kun numeroita on viisi JA kirjoittaminen on tauonnut
 * `debounceMs`:n verran — muuten "43500" tuottaisi viisi turhaa pyyntöä ja
 * vastaukset saapuisivat mielivaltaisessa järjestyksessä. Sama syy `requested`
 * -vahdille: hitaampi vanha vastaus ei saa ylikirjoittaa uudempaa tulosta.
 *
 * Kerran haettu numero muistetaan välimuistissa, jotta kentän tyhjennys ja
 * uudelleenkirjoitus (tai edestakainen korjailu) ei hae samaa uudestaan.
 */
export function createPostalCodeLookup(
  fetchImpl: FetchLike = defaultFetch,
  debounceMs: number = LOOKUP_DEBOUNCE_MS,
): PostalCodeLookup {
  const state = ref<PostalLookupState>({ kind: "empty" });
  const cache = new Map<string, PostalCodePlace | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Viimeisin numero jonka käyttäjä on kentässä — vain tämän vastaus kelpaa. */
  let requested: string | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function applyCached(code: string, cached: PostalCodePlace | null): void {
    state.value = cached === null ? { kind: "unknown", code } : { kind: "found", code, place: cached };
  }

  async function run(code: string): Promise<void> {
    try {
      const response = await fetchImpl(`/api/postal-code/${encodeURIComponent(code)}`);
      if (response.status === 404) {
        cache.set(code, null);
        if (requested === code) applyCached(code, null);
        return;
      }
      if (!response.ok) {
        if (requested === code) {
          state.value = { kind: "error", code, message: `Haku epäonnistui (HTTP ${response.status})` };
        }
        return;
      }
      const body: unknown = await response.json();
      if (!isPostalCodePlace(body)) {
        if (requested === code) {
          state.value = { kind: "error", code, message: "Palvelin palautti odottamattoman vastauksen" };
        }
        return;
      }
      cache.set(code, body);
      if (requested === code) applyCached(code, body);
    } catch {
      // Verkkovirhe ei ole sama asia kuin tuntematon postinumero: numero voi
      // olla aivan oikea, joten sitä ei merkitä välimuistiin tuntemattomaksi.
      if (requested === code) {
        state.value = { kind: "error", code, message: "Postinumeron haku ei onnistunut — ei yhteyttä palvelimeen" };
      }
    }
  }

  function setInput(raw: string): string {
    const code = normalizePostalCode(raw);
    clearTimer();
    requested = code;

    if (code.length === 0) {
      state.value = { kind: "empty" };
      return code;
    }
    if (!isCompletePostalCode(code)) {
      state.value = { kind: "incomplete" };
      return code;
    }
    if (cache.has(code)) {
      applyCached(code, cache.get(code) ?? null);
      return code;
    }
    state.value = { kind: "loading", code };
    timer = setTimeout(() => {
      timer = null;
      void run(code);
    }, debounceMs);
    return code;
  }

  return {
    state,
    setInput,
    dispose: clearTimer,
  };
}

/**
 * Nyt käytössä oleva sään sijainti. `source` kertoo kummasta päästä
 * etusijajärjestystä (asetus > .env) arvo tulee — ilman sitä tyhjä
 * postinumerokenttä näyttäisi siltä kuin sijaintia ei olisi lainkaan.
 */
export interface CurrentWeatherLocation {
  place: string;
  /**
   * null = lähdettä EI tiedetä. Tällöin kutsuja ei saa väittää lähdettä
   * lainkaan: pelkkä paikannimi on rehellinen, arvattu lähde ei. Näin käy kun
   * palvelin on vanhempi eikä kerro lähdettä, tai kun sijainti on
   * vanhentunut — tuntematon postinumero, jonka takia edellinen sijainti on yhä
   * voimassa (palvelimen "retained").
   */
  source: "settings" | "env" | null;
}

/**
 * Kysyy palvelimelta mikä sijainti on oikeasti käytössä.
 *
 * Tieto luetaan `/api/dashboard`:sta, joka kuljettaa sekä paikannimen
 * (`place`) että lähteen (`placeSource`). Omaa päätepistettä ei ole: sijainti
 * on tässä vastauksessa jo valmiiksi, joten erillinen haku olisi ylimääräinen
 * pyyntö joka kerta kun asetuspaneeli avataan. (Sellaista yritettiin aiemmin,
 * mutta reittiä ei ollut olemassa — haara vastasi aina 404 ja lähde jäi
 * arvattavaksi.)
 *
 * Lähdettä ei päätellä selaimessa, koska sitä ei voi päätellä: `.env`:ssä voi
 * olla joko postinumero tai koordinaatit, eikä kumpikaan näy tänne. Palvelin
 * tietää totuuden, ja jos se ei kerro sitä, vastaus on `null` eikä arvaus.
 */
export async function fetchCurrentWeatherLocation(
  fetchImpl: FetchLike = defaultFetch,
): Promise<CurrentWeatherLocation | null> {
  try {
    const response = await fetchImpl("/api/dashboard");
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown> | null;
    const place = body?.["place"];
    if (typeof place !== "string" || place.trim() === "") return null;
    return { place, source: readSource(body?.["placeSource"]) };
  } catch {
    return null;
  }
}

/**
 * Palvelimen lähdetunnus käyttäjän kielelle. Mikä tahansa .env:stä ratkennut
 * lähde — env-postinumero, env-koordinaatit ja sisäänrakennettu oletus — on
 * käyttäjälle sama ".env": se mikä oli ennen kuin asetuksiin koskettiin.
 * Kaikki muu, myös tuntemattoman numeron takia voimassa pidetty vanha sijainti
 * ja puuttuva kenttä, on "ei tiedetä".
 */
function readSource(value: unknown): "settings" | "env" | null {
  if (value === "settings") return "settings";
  if (value === "env") return "env";
  return null;
}
