import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { normalizeAddress, trustedHosts } from "../core/trusted-hosts.ts";

/**
 * The kiosk browser talks to the server over loopback. Anything arriving from
 * elsewhere is a phone on the home network, which is allowed to touch the
 * shopping list but not the children's school data (unless it presents a
 * valid FULL_PIN, see below).
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  const ip = request.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * FULL_PIN antaa täydet oikeudet — sama taso kuin TRUSTED_HOSTS-listalla
 * olevalla laitteella, myös lasten Wilma-tiedot. Koska se paljastaa
 * koulutiedot, sille on tiukempi alaraja kuin EDIT_PINille (joka antaa vain
 * muistilistan/asetusten/hälytysten muokkauksen ja jolle neljä numeroa on
 * käytännössä riittävä — ks. tiimin päätös).
 *
 * Liian lyhyt FULL_PIN ei oteta käyttöön lainkaan sen sijaan että vain
 * varoitettaisiin: ominaisuus pois päältä on turvallisempi lopputulos kuin
 * ominaisuus heikolla suojalla, jonka kukaan ei ehkä huomaa lokista.
 */
const FULL_PIN_MIN_LENGTH = 6;

/** True vain jos FULL_PIN on asetettu JA riittävän pitkä — muualla koodissa käytetään aina tätä, ei suoraan config.fullPiniä. */
export const fullPinEnabled = config.fullPin.length >= FULL_PIN_MIN_LENGTH;

// Käynnistyslogi samaan tapaan kuin trusted-hosts.ts:n "trusted_hosts_configured":
// heikennetty tietoturva-asetelma ei saa jäädä huomaamatta. Ei koskaan itse
// koodia — vain se että se on liian lyhyt ja mikä raja on. Moduulitason
// sivuvaikutus (ei erillinen start()-kutsu): access.ts ladataan aina
// palvelimen käynnistyessä (api.ts -> index.ts), joten tämä ehtii ennen
// kuin mikään pyyntö voi saapua, eikä index.ts:ää tarvitse koskea.
if (config.fullPin.length > 0 && !fullPinEnabled) {
  logger.warn(
    { event: "full_pin_too_short", minLength: FULL_PIN_MIN_LENGTH },
    "FULL_PIN on asetettu mutta lyhyempi kuin vaadittu vähimmäispituus — täysiä oikeuksia ei ole otettu käyttöön",
  );
}

/**
 * Nelinumeroinen EDIT_PIN sallii 10 000 yhdistelmää; FULL_PIN vaatii
 * vähintään kuusi merkkiä eli vähintään 1 000 000. Sama yhdistetty
 * rajoitin suojaa molempia yhdellä otsikolla tehtyä arvausta kohti (ks.
 * classifyProvidedPin/attemptPin alempana) — yksi merkkijono testataan
 * kumpaakin koodia vasten yhdellä kertaa, joten erillisiä per-taso-
 * rajoittimia ei tarvita eikä niitä voisi mielekkäästi erottaakaan
 * samasta otsikosta.
 *
 * Rajat: 5 väärää yritystä lukitsee lähteen 15 minuutiksi. Perhe joka
 * näppäilee koodin väärin kerran tai kaksi ei koskaan osu lukitukseen.
 * Lukitusaika nostettiin 5 minuutista 15 minuuttiin kun FULL_PIN alkoi
 * paljastaa lasten koulutietoja — pelkkä 4-numeroinen EDIT_PIN riittäisi
 * lyhyemmällä ajalla, mutta rajoitin on yhteinen, ja panokset ovat nyt
 * suuremmat. Lukittuna arvausnopeus on korkeintaan yksi yritys 15
 * minuutissa: 10 000 yhdistelmän EDIT_PIN kestäisi läpikäydä ~104 päivää,
 * miljoonan yhdistelmän FULL_PIN ~28 vuotta. Onnistunut todennus (kumpi
 * tahansa koodi) nollaa laskurin kokonaan.
 */
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60_000;

/**
 * Muistinvarainen, lähdekohtainen (IP) yritysrajoitin. Ei säily
 * uudelleenkäynnistyksen yli — se on tarkoituksella riittävä, koska
 * palvelin ei muutenkaan pyöri tuotannossa niin usein uudelleen että
 * lyhytikäinen laskuri menettäisi merkityksensä, ja pysyvä tallennus toisi
 * monimutkaisuutta ilman todellista turvallisuushyötyä kotiverkon uhkamallissa.
 */
export class PinAttemptLimiter {
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number>();
  private readonly lockedUntil = new Map<string, number>();

  // Ei TS:n parametrimuotoista kenttien lyhennettä (`constructor(private x)`):
  // ks. sama perustelu web/src/composables/useAlarms.ts:n RungTrackerissa —
  // erasableSyntaxOnly on päällä, eikä Node osaa muuntaa sitä ajonaikaisesti.
  constructor(maxAttempts: number, lockoutMs: number, now: () => number = Date.now) {
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.now = now;
  }

  /** Jäljellä oleva lukitusaika millisekunteina, tai null jos lähde ei ole lukittu. */
  lockRemainingMs(key: string): number | null {
    const until = this.lockedUntil.get(key);
    if (until === undefined) return null;
    const remaining = until - this.now();
    if (remaining <= 0) {
      // Lukitus on vanhentunut — siivotaan pois, jotta lähde saa täyden
      // uuden yritysmäärän seuraavalla kutsulla eikä jää "puoliksi lukituksi".
      this.lockedUntil.delete(key);
      this.failures.delete(key);
      return null;
    }
    return remaining;
  }

  recordFailure(key: string): void {
    if (this.lockRemainingMs(key) !== null) return; // jo lukittu, ei pidennetä uusilla arvauksilla
    const count = (this.failures.get(key) ?? 0) + 1;
    if (count >= this.maxAttempts) {
      this.lockedUntil.set(key, this.now() + this.lockoutMs);
      this.failures.delete(key);
    } else {
      this.failures.set(key, count);
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }
}

export const pinAttemptLimiter = new PinAttemptLimiter(MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS);

type PinMatch = "full" | "edit" | "wrong" | "absent";

/**
 * Yksi yhteinen luokittelu annetulle merkkijonolle. "absent" (otsikkoa ei
 * annettu lainkaan) on eri asia kuin "wrong" (jotain annettiin, mutta se ei
 * täsmää kumpaankaan koodiin) — ero ratkaisee alempana rajoittimen
 * kannalta, ks. attemptPin.
 */
function classifyProvidedPin(provided: string | undefined): PinMatch {
  if (typeof provided !== "string" || provided.length === 0) return "absent";
  if (fullPinEnabled && provided === config.fullPin) return "full";
  if (config.editPin && provided === config.editPin) return "edit";
  return "wrong";
}

type PinAttemptOutcome =
  | { outcome: "locked"; retryAfterSeconds: number }
  | { outcome: "full" }
  | { outcome: "edit" }
  | { outcome: "wrong" }
  | { outcome: "absent" };

/**
 * Luokittelu + rajoitininteraktio YHDELLE annetulle merkkijonolle yhdestä
 * lähteestä. Kutsutaan täsmälleen kerran per HTTP-pyyntö (resolveAccess
 * lukupolulle/kirjoitusportille, verifyEditPin todennuspäätepisteelle) —
 * ei koskaan ketjutettuna toisen tämän funktion kutsun kanssa saman
 * pyynnön sisällä, koska muuten sama arvaus laskettaisiin kahdesti
 * epäonnistuneeksi yritykseksi.
 *
 * Vain "wrong" (jotain annettiin, ei täsmää kumpaankaan) lasketaan
 * epäonnistuneeksi yritykseksi. "absent" (esim. näyttölaitteen tai PIN:iä
 * käyttämättömän puhelimen jokainen pyyntö) ei koskaan — muuten pelkkä
 * /api/dashboardin normaali pollaus lukitsisi itsensä. "edit"-tason
 * kelvollinen koodi luetuksena "trusted"-kontekstissa (ei täsmää
 * FULL_PINiin) ei myöskään ole arvaus, vaan täysin normaalia liikennettä
 * PIN:llä muokkaavalta puhelimelta.
 */
function attemptPin(ip: string, provided: string | undefined): PinAttemptOutcome {
  const key = normalizeAddress(ip);
  const lockedForMs = pinAttemptLimiter.lockRemainingMs(key);
  if (lockedForMs !== null) return { outcome: "locked", retryAfterSeconds: Math.ceil(lockedForMs / 1000) };

  const match = classifyProvidedPin(provided);
  if (match === "full" || match === "edit") {
    pinAttemptLimiter.recordSuccess(key);
    return { outcome: match };
  }
  if (match === "wrong") {
    pinAttemptLimiter.recordFailure(key);
    return { outcome: "wrong" };
  }
  return { outcome: "absent" };
}

interface AccessDecision {
  /** Näyttölaite, TRUSTED_HOSTS, tai kelvollinen FULL_PIN — sisältää myös lasten Wilma-tiedot. */
  trusted: boolean;
  /** trusted TAI kelvollinen EDIT_PIN — muistilista/asetukset/hälytykset, ei Wilmaa. */
  editable: boolean;
  locked: boolean;
  retryAfterSeconds: number | null;
}

/**
 * Yksi pääsypäätös per pyyntö — isTrustedRequest ja requireEditAccess
 * johdetaan tästä eivätkä kutsu toisiaan, jotta yksi otsikko luokitellaan
 * ja rajoitetaan täsmälleen kerran (ks. attemptPin-kommentti).
 */
function resolveAccess(request: FastifyRequest): AccessDecision {
  if (isLocalRequest(request)) return { trusted: true, editable: true, locked: false, retryAfterSeconds: null };

  if (trustedHosts.isTrusted(request.ip)) {
    // Individual grants stay at debug — fine-grained enough to confirm the
    // feature works, quiet enough not to add a line per request in the
    // default `warn` log.
    logger.debug({ event: "trusted_host_access", ip: normalizeAddress(request.ip) }, "request from trusted host");
    return { trusted: true, editable: true, locked: false, retryAfterSeconds: null };
  }

  const provided = request.headers["x-edit-pin"];
  const result = attemptPin(request.ip, typeof provided === "string" ? provided : undefined);

  switch (result.outcome) {
    case "locked":
      return { trusted: false, editable: false, locked: true, retryAfterSeconds: result.retryAfterSeconds };
    case "full":
      return { trusted: true, editable: true, locked: false, retryAfterSeconds: null };
    case "edit":
      return { trusted: false, editable: true, locked: false, retryAfterSeconds: null };
    default: // "wrong" tai "absent"
      return { trusted: false, editable: false, locked: false, retryAfterSeconds: null };
  }
}

/**
 * True for the display itself, or for a device on the TRUSTED_HOSTS list in
 * .env (core/trusted-hosts.ts), or for a request carrying a valid FULL_PIN.
 * This is the one place that decision is made — api.ts checks this instead
 * of isLocalRequest wherever "does this client get the full picture"
 * matters, so a trusted phone (by list or by code) stays indistinguishable
 * from the wall display everywhere.
 */
export function isTrustedRequest(request: FastifyRequest): boolean {
  return resolveAccess(request).trusted;
}

export function requireEditAccess(request: FastifyRequest, reply: FastifyReply): boolean {
  const decision = resolveAccess(request);
  if (decision.editable) return true;

  if (decision.locked) {
    void reply
      .code(429)
      .header("retry-after", String(decision.retryAfterSeconds))
      .send({ error: "Liian monta väärää PIN-yritystä.", retryAfterSeconds: decision.retryAfterSeconds });
    return false;
  }

  if (!config.editPin && !fullPinEnabled) {
    void reply.code(403).send({ error: "Muokkaus sallittu vain näyttölaitteelta. Aseta EDIT_PIN salliaksesi puhelimen." });
    return false;
  }

  void reply.code(401).send({ error: "Väärä tai puuttuva PIN" });
  return false;
}

export type PinLevel = "full" | "edit";

/**
 * POST /api/edit-access käyttää tätä: kertoo MIKÄ taso annetulla koodilla
 * saavutetaan (jos mikään), ilman että se vielä tekee mitään kirjoitusta —
 * selain kutsuu tätä ennen kuin tallentaa koodin itselleen. Ei ohita
 * luotettuja laitteita kuten requireEditAccess/isTrustedRequest — tarkoitus
 * on nimenomaan todeta annetun merkkijonon paikkansapitävyys.
 *
 * Kutsuu attemptPinia suoraan, ei resolveAccessia — tämä on aina oman,
 * erillisen HTTP-pyyntönsä (POST /api/edit-access) ainoa pääsytarkistus,
 * joten jokainen todellinen arvaus lasketaan tässä täsmälleen kerran.
 */
export function verifyEditPin(request: FastifyRequest, reply: FastifyReply, providedRaw: unknown): PinLevel | null {
  if (!config.editPin && !fullPinEnabled) {
    void reply.code(403).send({ error: "Muokkaus sallittu vain näyttölaitteelta. Aseta EDIT_PIN salliaksesi puhelimen." });
    return null;
  }

  const provided = typeof providedRaw === "string" ? providedRaw : undefined;
  const result = attemptPin(request.ip, provided);

  if (result.outcome === "full" || result.outcome === "edit") return result.outcome;

  if (result.outcome === "locked") {
    void reply
      .code(429)
      .header("retry-after", String(result.retryAfterSeconds))
      .send({ error: "Liian monta väärää PIN-yritystä.", retryAfterSeconds: result.retryAfterSeconds });
    return null;
  }

  // "wrong" tai "absent" — leipätekstissä puuttuva koodi on tässä
  // nimenomaisessa reitissä yhtä kelvoton kuin väärä, koska koko pyynnön
  // tarkoitus on todeta jokin koodi oikeaksi.
  void reply.code(401).send({ error: "Väärä tai puuttuva PIN" });
  return null;
}
