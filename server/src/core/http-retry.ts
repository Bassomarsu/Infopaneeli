import { logger } from "./logging.ts";

export interface FetchRetryOptions {
  /** Lähteen nimi virheviestiä ja lokia varten, esim. "Open-Meteo". */
  label: string;
  /** Yhden yrityksen yläraja (yhteys + runko). Jokainen yritys saa oman `AbortSignal.timeout`insa. */
  attemptTimeoutMs: number;
  /** Yritysten kokonaismäärä ensimmäinen mukaan lukien. */
  maxAttempts?: number;
  /** Ensimmäisen uusinnan viive; kaksinkertaistuu jokaisella uusinnalla. */
  baseDelayMs?: number;
  /**
   * Pisin `Retry-After`, jonka verran odotetaan. Jos palvelin pyytää pidempää
   * taukoa, ei uusita lainkaan: seuraava säännöllinen kierros on silloin
   * oikea vastaus, ja lyhyempi odotus olisi pyynnön vastaista.
   */
  maxRetryAfterMs?: number;
  /**
   * Epoch ms, johon mennessä KOKO haun on oltava valmis. Soittaja antaa yhden
   * ja saman rajan kaikille kutsuille jotka kuuluvat samaan hakuun, jotta
   * orpoa uusintaa ei jää pyörimään providerin aikarajan (`timeoutMs`)
   * jälkeen: Provider ei peruuta kesken jäänyttä hakua, se vain lakkaa
   * odottamasta sitä. Oletus: kutsun alusta 60 s.
   */
  deadlineAt?: number;
  /** Vain testiä varten. */
  sleep?: (ms: number) => Promise<void>;
  /** Vain testiä varten. */
  random?: () => number;
  /** Vain testiä varten. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ohimenevä vika: ylikuormitus. Muut 4xx ovat meidän pyyntömme vika eikä korjaudu toistamalla. 429 käsitellään erikseen. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** `Retry-After` on joko sekunteja tai HTTP-päivämäärä. Tuntematon muoto -> null. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `fetch`, joka uusii ohimenevät viat: verkkovirheet, aikakatkaisun, 5xx:t,
 * 429:n (vain jos palvelin antaa kohtuullisen `Retry-After`in) sekä vastauksen
 * jonka runkoa ei saa luettua tai jäsennettyä. Muut 4xx heitetään heti.
 *
 * RUNKO LUETAAN TÄÄLLÄ (`parse`), ei soittajassa: katkennut runko tai
 * välityspalvelimen 200 + HTML on samanlainen ohimenevä vika kuin 503, ja
 * jos jäsennys tehtäisiin uusinnan ulkopuolella, se maksaisi koko kierroksen.
 * Jäsennys kuuluu myös yrityksen aikarajaan, koska signaali katkaisee myös
 * rungon luvun.
 *
 * Tarkoitus on kuroa umpeen se aukko, jossa yksi hetkellinen 503 maksoi
 * koko hakukierroksen. Siksi uusinnat ovat sekunteja, eivät minuutteja, ja
 * niitä on vähän: kuormitettua palvelua ei saa takoa.
 *
 * Kun kaikki yritykset epäonnistuvat, heitetään virhe, jonka viestissä on
 * viimeisin syy ja yritysten määrä — Provider kirjaa sen `provider_failed`-
 * riville sellaisenaan. Yksittäisiä uusintoja ei kirjata oletuslokitasolla.
 */
export async function fetchWithRetry<T>(
  fetcher: typeof fetch,
  url: string,
  init: Omit<RequestInit, "signal">,
  options: FetchRetryOptions,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const deadlineAt = options.deadlineAt ?? now() + 60_000;

  for (let attempt = 1; ; attempt++) {
    // Yrityksen oma raja ei ylitä yhteistä deadlinea, vaikka soittaja olisi
    // käyttänyt suurimman osan siitä jo aiemmin.
    const timeoutMs = Math.min(options.attemptTimeoutMs, deadlineAt - now());
    if (timeoutMs <= 0) {
      throw new Error(`${options.label} request failed: time budget exhausted`);
    }

    let failure = new Error(`${options.label} request failed`);
    let retryAfterMs: number | null = null;
    let retryable = true;

    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        try {
          return await parse(response);
        } catch (err) {
          // Katkennut runko, HTML 200-vastauksessa tai puuttuvat kentät.
          failure = err instanceof Error ? err : new Error(String(err));
        }
      } else {
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
        // Runko luetaan tyhjäksi, jotta yhteys vapautuu uusintaa varten.
        await response.body?.cancel().catch(() => undefined);
        failure = new Error(`${options.label} returned HTTP ${response.status}`);
        // 429 uusitaan vain jos palvelin itse kertoo kuinka kauan odottaa.
        // Ilman `Retry-After`ia emme tiedä milloin rajoitus päättyy, ja
        // arvaaminen on juuri sitä takomista jota rajoitus yrittää estää.
        retryable = response.status === 429 ? retryAfterMs !== null : isRetryableStatus(response.status);
      }
    } catch (err) {
      // Verkkovika tai aikakatkaisu.
      failure = new Error(`${options.label} request failed: ${errorMessage(err)}`, { cause: err });
    }

    const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5);
    const delay = retryAfterMs === null ? backoff : Math.max(retryAfterMs, backoff);
    const tooSlow = retryAfterMs !== null && retryAfterMs > maxRetryAfterMs;
    // Viive JA seuraavan yrityksen oma aikaraja mahtuvat deadlineen. Muuten
    // uusinta voisi alkaa hetkellä, jolloin se ei ehdi valmistua ennen kuin
    // Provider on jo lakannut odottamasta.
    const noTime = now() + delay + options.attemptTimeoutMs > deadlineAt;

    if (!retryable) throw failure;
    if (attempt >= maxAttempts || tooSlow || noTime) {
      throw new Error(attempt > 1 ? `${failure.message} (${attempt} attempts)` : failure.message, {
        cause: failure.cause ?? failure,
      });
    }

    logger.debug(
      { event: "http_retry", source: options.label, attempt, delayMs: Math.round(delay), reason: failure.message },
      "ohimenevä vika — yritetään uudelleen",
    );
    await sleep(delay);
  }
}
