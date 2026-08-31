import fs from "node:fs";
import path from "node:path";
import { config, isPaikkyConfigured } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { FatalProviderError, Provider } from "../core/provider.ts";
import { isoToLocalClock, localDateKey, localParts, shiftDateKey } from "../core/time.ts";

export interface PaikkyChild {
  id: string;
  firstName: string;
  lastName: string;
}

/** Kellonajat Europe/Helsinki, "HH:MM". `to` on null jos uloskirjausta ei ole. */
export interface PaikkyTimeRange {
  type: string;
  from: string;
  to: string | null;
}

export interface PaikkyDay {
  date: string;
  /**
   * `"unknown"` = Päikky palautti tyypin jota tämä versio ei tunne. Se on oma
   * arvonsa eikä `"unplannable"` juuri siksi, että vaimennus menisi väärään
   * suuntaan: jos `plannable` joskus nimetään uudelleen, jokainen varaamaton
   * päivä lukisi seinällä rauhoittavasti "ei hoitoa".
   */
  type: "past" | "current" | "locked" | "plannable" | "unplannable" | "unknown";
  /**
   * Suunnitellut hoitoajat (markings). Tyhjä taulukko EI tarkoita "ei hoitoa":
   * `type: "plannable"` ja tyhjä `planned` on varaamaton päivä, joka vaatii
   * toimenpiteen. "Ei hoitoa" -päivä (viikonloppu, päiväkoti kiinni) ei tule
   * tähän listaan lainkaan.
   */
  planned: PaikkyTimeRange[];
  /** Menneen päivän merkintätyyppi, esim. "SCHEDULED_DAY_OFF". */
  markingType: string | null;
  needsAttention: boolean;
  /**
   * `lockingTime` sellaisenaan. ISO-8601 UTC — HUOM: tarkoituksella eri muoto
   * kuin from/to, jotka ovat paikallisia "HH:MM"-merkkijonoja.
   */
  lockingAt: string | null;
}

export interface PaikkyToday {
  date: string;
  /** "PRESENT" | "NOT_PRESENT" | "LEFT_FOR_TODAY" | poissaolotyyppi | null */
  status: string | null;
  /** Toteutunut sisäänkirjaus "HH:MM" (kalenterin presentFrom). */
  presentFrom: string | null;
  planned: PaikkyTimeRange[];
}

export interface PaikkyChildData {
  child: PaikkyChild;
  /** Nousevassa päiväjärjestyksessä, kukin päivä täsmälleen kerran. */
  days: PaikkyDay[];
  today: PaikkyToday | null;
}

export interface PaikkyMessage {
  id: string;
  type: string;
  title: string;
  sender: string | null;
  sentAt: string | null;
  unread: boolean | null;
  preview: string | null;
}

export interface PaikkyData {
  children: PaikkyChildData[];
  messages: PaikkyMessage[];
  /**
   * Viestihaun virhe, kun hoitoajat silti onnistuivat. null = ei virhettä.
   * Lyhyt ihmisluettava syy, EI stack tracea eikä tokenia.
   */
  messagesError: string | null;
}

/**
 * `X-Paikky-Client` on pakollinen: väärä tai puuttuva arvo vastaa 400
 * `invalid-client`. Versionumero on vapaaehtoinen, mutta palvelin voi
 * mitätöidä istunnon jos se alittaa `minVersion`-rajan, joten se lähetetään.
 */
const CLIENT_HEADERS = {
  "x-paikky-client": "guardian-web",
  "x-paikky-locale": "fi",
  "x-paikky-version": "1.32.10",
  accept: "application/json",
} as const;

const REQUEST_TIMEOUT_MS = 20_000;

/** Kuinka monta viestiä listataan yhdellä kierroksella. */
const MESSAGE_LIMIT = 20;

/** Näytön tarvitsema ikkuna: tänään ja seuraavat seitsemän päivää. */
const WINDOW_DAYS = 7;

const PREVIEW_LENGTH = 200;

const DAY_TYPES = new Set(["past", "current", "locked", "plannable", "unplannable"]);

/** Yhden hakukierroksen tila — ks. apiGet:n 401-käsittely. */
interface CycleContext {
  reauthenticated: boolean;
}

interface RawMarking {
  type?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Päiväolion koko avainjoukko on mitattu (elo-, syys- ja lokakuu):
 * `changeable`, `lockingTime`, `markingType`, `markings`, `needsAttention`,
 * `planningPeriod`, `presentFrom`, `status`, `type`. Tässä on niistä ne joita
 * näyttö käyttää; `changeable` ja `planningPeriod` koskevat hoitoajan
 * muuttamista, eikä infonäyttö muuta mitään.
 */
interface RawCalendarDay {
  type?: unknown;
  status?: unknown;
  presentFrom?: unknown;
  markingType?: unknown;
  needsAttention?: unknown;
  lockingTime?: unknown;
  markings?: unknown;
}

/**
 * `days[pvm][lapsenId]`. Kumpi taso tahansa voi puuttua: `days[pvm]` on tyhjä
 * olio viikonloppuna ja voi olla olemassa ilman lapsen avainta. Kumpikaan ei
 * ole virhetila, joten kumpaakaan ei lueta ilman tarkistusta.
 */
type CalendarDays = Record<string, Record<string, RawCalendarDay | undefined> | undefined>;

interface CalendarResponse {
  results?: { days?: CalendarDays };
}

interface ChildrenResponse {
  results?: { children?: unknown };
}

interface CommunicationsResponse {
  results?: { communications?: unknown };
}

type DayIndex = Map<string, Record<string, RawCalendarDay | undefined>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Päikky antaa tunnisteet milloin numerona, milloin merkkijonona. */
function idOf(value: unknown): string | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) return String(numeric);
  return asString(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Kalenterin ajat ovat UTC-ISO:a; muunnos on core/time.ts:ssä, ks. sen kommentti. */
function toLocalClock(value: unknown): string | null {
  const iso = asString(value);
  return iso === null ? null : isoToLocalClock(iso);
}

function parseMarkings(raw: unknown): PaikkyTimeRange[] {
  if (!Array.isArray(raw)) return [];
  const ranges: PaikkyTimeRange[] = [];
  for (const item of raw) {
    const marking = asRecord(item) as RawMarking | null;
    if (!marking) continue;
    const from = toLocalClock(marking.from);
    // Ilman alkuaikaa merkintää ei voi näyttää — pudotetaan se, ei koko päivää.
    if (from === null) continue;
    // Merkintä jolla on kellonajat on läsnäoloa, ellei tyyppi muuta kerro;
    // tyhjä tyyppi näyttäisi kortissa vain rikkinäiseltä.
    ranges.push({ type: asString(marking.type) ?? "PRESENT", from, to: toLocalClock(marking.to) });
  }
  return ranges;
}

/**
 * Tuntematon päivätyyppi kirjataan kerran per arvo, ei kerran per kierros:
 * rajapinnan muutos ilmoittaa itsestään lokissa sen sijaan että se muuttaisi
 * hiljaa sitä mitä kortti näyttää.
 */
const seenDayTypes = new Set<string>();

function parseDayType(raw: unknown): PaikkyDay["type"] {
  const value = asString(raw);
  if (value !== null && DAY_TYPES.has(value)) return value as PaikkyDay["type"];

  const key = value ?? "(puuttuu)";
  if (!seenDayTypes.has(key)) {
    seenDayTypes.add(key);
    logger.warn(
      { event: "paikky_unknown_day_type", dayType: key },
      "tuntematon Päikyn päivätyyppi — merkitään tuntemattomaksi, ei tulkita miksikään",
    );
  }
  return "unknown";
}

function buildDay(date: string, entry: RawCalendarDay): PaikkyDay {
  return {
    date,
    type: parseDayType(entry.type),
    planned: parseMarkings(entry.markings),
    markingType: asString(entry.markingType),
    // Esiintyi mittauksissa vain arvolla false tai puuttui kokonaan, joten
    // vain nimenomainen true kelpaa todeksi.
    needsAttention: entry.needsAttention === true,
    lockingAt: asString(entry.lockingTime),
  };
}

/**
 * `status` ja `presentFrom` ovat kalenterin kuluvan päivän oliossa valmiina —
 * uloskirjausaikaa ei ole eikä sitä haeta erikseen, ks. fetchPaikky.
 */
function buildToday(date: string, entry: RawCalendarDay | undefined): PaikkyToday | null {
  if (!entry) return null;
  return {
    date,
    status: asString(entry.status),
    presentFrom: toLocalClock(entry.presentFrom),
    planned: parseMarkings(entry.markings),
  };
}

function parseChildren(body: ChildrenResponse): PaikkyChild[] {
  // `results`-kääre kuten kaikissa muissakin Päikyn vastauksissa.
  const raw = body.results?.children;
  if (!Array.isArray(raw)) return [];
  const children: PaikkyChild[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const id = idOf(record.id);
    if (id === null) continue;
    children.push({
      id,
      firstName: asString(record.firstName) ?? "",
      lastName: asString(record.lastName) ?? "",
    });
  }
  return children;
}

/**
 * Istunto elää muistissa prosessin ajan. Kirjautumisvastauksessa ei ole
 * refresh-tokenia eikä vanhenemisaikaa, joten tokenin vanhenemisen ainoa
 * merkki on 401 — uusi kirjautuminen tehdään vasta sitten. Päikyn tili
 * lukkiutuu epäonnistuneista yrityksistä, ja sama tunnus on huoltajan
 * puhelimessa.
 */
class PaikkySession {
  private accessToken: string | null = null;

  /** Onko token jo olemassa — eli tuottaako seuraava authorize() kirjautumisen. */
  hasToken(): boolean {
    return this.accessToken !== null;
  }

  async authorize(): Promise<string> {
    if (this.accessToken !== null) return this.accessToken;
    const token = await login();
    this.accessToken = token;
    logger.debug({ event: "paikky_login" }, "kirjauduttu Päikkyyn");
    return token;
  }

  invalidate(): void {
    this.accessToken = null;
  }
}

const session = new PaikkySession();

/**
 * Kirjautumisen epäonnistuminen on aina kohtalokas: uudelleenyrittäminen ei
 * korjaa väärää salasanaa eikä hylättyä asiakasversiota, mutta lukitsee tilin.
 * Katkaisija (core/provider.ts) hoitaa jäähdytyksen, ks. createPaikkyProvider.
 */
function loginFailure(status: number): FatalProviderError {
  if (status === 401 || status === 403) {
    return new FatalProviderError(
      "AuthenticationError",
      "Päikky-kirjautuminen epäonnistui. Tarkista PAIKKY_USERNAME ja PAIKKY_PASSWORD.",
    );
  }
  if (status === 400) {
    return new FatalProviderError(
      "ClientRejected",
      "Päikky hylkäsi asiakasohjelman (client- tai versiotarkistus). Rajapinta on todennäköisesti muuttunut.",
    );
  }
  return new FatalProviderError("LoginFailed", `Päikky vastasi kirjautumiseen HTTP ${status}.`);
}

async function login(): Promise<string> {
  // Verkkovirhe ja aikakatkaisu nousevat tästä tavallisena virheenä, eivät
  // FatalProviderErrorina: silloin tunnuksia ei ole edes tarkistettu, ja
  // katkaisijan avaaminen jättäisi näytön pimeäksi tunneiksi sen jälkeen kun
  // yhteys on jo palannut. Normaali backoff on täällä jo 30 min.
  const response = await fetch(`${config.paikky.baseUrl}/api/v1/login`, {
    method: "POST",
    headers: { ...CLIENT_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      username: config.paikky.username,
      password: config.paikky.password,
      remember: "false",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Vastauksen runkoa ei koskaan lokiteta eikä liitetä virheeseen — se
  // sisältää käyttöoikeustunnuksen.
  if (!response.ok) throw loginFailure(response.status);

  // Kirjautumisvastaus on kääritty samoin kuin kaikki muutkin päätepisteet:
  // `{ status, results: { accessToken, userId, username, entityId,
  // loginVersion }, etag }`. Todennettu oikealla kutsulla 31.8.2026 — tämä oli
  // aluksi väärin, koska tynkävastaus oli kirjoitettu oletuksen mukaan eikä
  // mitatun mukaan. Kääreetön muoto luetaan silti varalta: rajapinta on
  // dokumentoimaton, eikä sen muodosta ole mitään takuuta.
  const body = (await response.json()) as { accessToken?: unknown; results?: { accessToken?: unknown } };
  const token = asString(body.results?.accessToken) ?? asString(body.accessToken);
  if (token === null) {
    throw new FatalProviderError(
      "AuthenticationError",
      "Päikky ei palauttanut käyttöoikeustunnusta kirjautumisessa.",
    );
  }
  return token;
}

function request(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: { ...CLIENT_HEADERS, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function apiGet<T>(cycle: CycleContext, endpoint: string): Promise<T> {
  const url = `${config.paikky.baseUrl}/api/${endpoint}`;
  // Oliko token jo olemassa ennen tätä kutsua. Jos ei, se luotiin juuri tähän
  // kutsuun, eikä uusi kirjautuminen voi tuottaa sen kelpaavampaa — silloin
  // 401 menee suoraan fataaliksi alla eikä kuluta toista yritystä.
  const hadToken = session.hasToken();
  let response = await request(url, await session.authorize());

  // Korkeintaan yksi uudelleenkirjautuminen per hakukierros, ja vain kun token
  // on peräisin aiemmalta kierrokselta: se on ainoa tapaus jossa 401 tarkoittaa
  // "vanhentunut istunto" eikä "palvelin hylkää tunnukset". Silmukka olisi
  // suorin tie tilin lukitukseen.
  if (response.status === 401 && hadToken && !cycle.reauthenticated) {
    cycle.reauthenticated = true;
    session.invalidate();
    response = await request(url, await session.authorize());
  }

  if (response.status === 401) {
    // 401 tuoreen kirjautumisen jälkeen on kohtalokas, ei tavallinen virhe.
    // Kirjautuminen voi onnistua ja silti tuottaa tokenin jonka palvelin
    // hylkää (esim. `loginVersion` alittaa `minVersion`-rajan, tai salasana on
    // vanhentunut). Tavallisena virheenä tämä olisi ONNISTUNUT kirjautuminen
    // joka 30. minuutti ikuisesti — katkaisija ei laukeaisi koskaan, koska se
    // laskee vain fataaleja, ja jokainen kierros olisi rivi kunnan lokissa
    // huoltajan nimellä. Uudelleenyritys ei määritelmällisesti voi auttaa.
    session.invalidate();
    throw new FatalProviderError(
      "AuthenticationError",
      "Päikky hylkäsi tuoreen istunnon (HTTP 401). Sovellusversio tai salasana voi olla vanhentunut.",
    );
  }
  if (!response.ok) {
    throw new Error(`Päikky vastasi virheellä HTTP ${response.status} (${endpoint})`);
  }

  return (await response.json()) as T;
}

/**
 * Kalenterivastaus kattaa ruudukon kokonaisina viikkoina (mitattu: 35 päivää,
 * 28.9.–1.11. kun pyydettiin lokakuuta), joten kahden kuukauden vastauksissa
 * on samoja päiviä. Päivämäärä on avain: sama päivä kirjoittuu saman avaimen
 * päälle eikä päädy kahdeksi riviksi.
 */
function mergeCalendar(index: DayIndex, body: CalendarResponse): void {
  const days = body.results?.days;
  if (!days) return;
  for (const [date, byChild] of Object.entries(days)) {
    // Tyhjä olio merkitsee "ei hoitoa tänä päivänä" — se on silti kattavuutta,
    // ei puuttuva päivä.
    index.set(date, byChild ?? {});
  }
}

function nextMonthKey(monthKey: string): string {
  const [rawYear, rawMonth] = monthKey.split("-").map(Number);
  const year = rawYear ?? 0;
  const month = rawMonth ?? 1;
  return month >= 12 ? `${year + 1}-01` : `${year}-${pad2(month + 1)}`;
}

function windowDates(todayKey: string): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset <= WINDOW_DAYS; offset += 1) dates.push(shiftDateKey(todayKey, offset));
  return dates;
}

function buildChildData(child: PaikkyChild, index: DayIndex, todayKey: string): PaikkyChildData {
  const days: PaikkyDay[] = [];
  for (const [date, byChild] of index) {
    // Ruudukko ulottuu viikkoja taaksepäin; menneet päivät ovat näytöllä pelkkää kohinaa.
    if (date < todayKey) continue;
    const entry = byChild[child.id];
    // Puuttuva päivä tai puuttuva lapsen avain = ei hoitoa (viikonloppu tai
    // päiväkoti kiinni). Normaalitila, ei virhe — ja syy siihen miksi tätä ei
    // lueta ilman tarkistusta: ilman sitä joka viikonloppu kaataisi kierroksen.
    if (!entry) continue;
    days.push(buildDay(date, entry));
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  return { child, days, today: buildToday(todayKey, index.get(todayKey)?.[child.id]) };
}

/**
 * Viestin kentät on luettu huoltajasovelluksen koodista, ei nähty oikeana
 * datana (postilaatikko oli tyhjä kun rajapinta mitattiin). Siksi jokainen
 * kenttä on valinnainen ja tuntematon rakenne pudottaa yhden viestin, ei koko
 * haun: hoitoajat ovat tämän kortin tärkein sisältö, eivät viestit.
 */
function parseMessage(item: unknown): PaikkyMessage | null {
  const record = asRecord(item);
  if (!record) return null;

  const id = idOf(record.uniqueId) ?? idOf(record.id) ?? idOf(record.messageId);
  if (id === null) return null;

  return {
    id,
    type: asString(record.type) ?? "message",
    title: firstString(record, ["title", "subject", "header", "topic"]) ?? "",
    sender: parseSender(record),
    sentAt: parseTimestamp(record.created) ?? parseTimestamp(record.sentAt) ?? parseTimestamp(record.timestamp),
    unread: parseUnread(record),
    preview: parsePreview(record),
  };
}

/**
 * Vain `creator`, joka on ainoa renderöintikoodista luettu lähettäjäkenttä.
 * Pidempi avainlista osuisi lähes varmasti johonkin, ja "ei tiedossa" on
 * rehellisempi kuin väärästä kentästä poimittu nimi.
 */
function parseSender(record: Record<string, unknown>): string | null {
  const value = record.creator;
  const direct = asString(value);
  if (direct !== null) return direct;

  const nested = asRecord(value);
  if (!nested) return null;
  const name = firstString(nested, ["name", "displayName", "fullName"]);
  if (name !== null) return name;
  const parts = [asString(nested.firstName), asString(nested.lastName)].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function parseTimestamp(value: unknown): string | null {
  const epoch = asFiniteNumber(value);
  const date = epoch !== null ? new Date(epoch) : new Date(asString(value) ?? "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Lukutilaa ei päätellä kentän puuttumisesta kumpaankaan suuntaan: null on
 * "ei tiedossa", ja kortti osaa näyttää sen. Wilman puolella arvaus "puuttuva
 * = lukematon" jätti laskurin ikuisesti nollaa suuremmaksi.
 */
function parseUnread(record: Record<string, unknown>): boolean | null {
  if (typeof record.unread === "boolean") return record.unread;
  if (typeof record.isRead === "boolean") return !record.isRead;
  if (typeof record.read === "boolean") return !record.read;
  // Aikaleimakentistä (readAt yms.) ei päätellä mitään: ne osuisivat lähes
  // varmasti johonkin, jolloin "ei tiedossa" ei toteutuisi käytännössä koskaan
  // ja väärä arvaus menisi suoraan kortin lukemattomien laskuriin.
  return null;
}

function parsePreview(record: Record<string, unknown>): string | null {
  // Kolme yksiselitteistä nimeä. `message` ja `description` pudotettiin: ne
  // voisivat yhtä hyvin olla jotain muuta kuin viestin leipäteksti.
  const raw = firstString(record, ["preview", "body", "text"]);
  if (raw === null) return null;
  const plain = raw
    // Rivinvaihdon tuottavat tagit väliksi, muut pois kokonaan — muuten
    // "<b>retki</b>." muuttuisi muotoon "retki ." keskellä esikatselua.
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return null;
  return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : plain;
}

let communicationsSnapshotSaved = false;

/**
 * Ensimmäinen viestivastaus jossa on yksikin viesti, talteen kerran per
 * prosessi ja **lokitasosta riippumatta**. saveDebugSnapshot vaatisi
 * debugModen, ja koska oletus on `warn`, juuri se hetki jolloin viestin
 * rakenne olisi ensi kertaa nähtävissä menisi ohi — jäsennin jäisi pysyvästi
 * arvausten varaan (ks. parseMessage). Tiedosto voi sisältää henkilötietoja;
 * `data/` on gitignoressa eikä sitä tarjoilla mistään reitistä.
 */
function saveFirstCommunications(body: unknown): void {
  communicationsSnapshotSaved = true;
  try {
    fs.mkdirSync(config.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(config.snapshotDir, `paikky-communications-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
    logger.warn(
      { event: "paikky_communications_snapshot", file },
      "ensimmäinen Päikky-viestivastaus tallennettu — tästä näkee viestin oikeat kentät",
    );
  } catch (err) {
    // Tallennuksen epäonnistuminen ei saa kaataa hakua; viestit jäsennetään silti.
    logger.warn({ event: "paikky_snapshot_failed", err }, "Päikky-viestivastauksen tallennus epäonnistui");
  }
}

async function fetchMessages(cycle: CycleContext): Promise<PaikkyMessage[]> {
  const body = await apiGet<CommunicationsResponse>(cycle, `v2/communications?n=${MESSAGE_LIMIT}`);
  const raw = body.results?.communications;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (!communicationsSnapshotSaved) saveFirstCommunications(body);

  const messages: PaikkyMessage[] = [];
  for (const item of raw) {
    try {
      const message = parseMessage(item);
      if (message) messages.push(message);
    } catch (err) {
      logger.debug({ event: "paikky_message_parse_failed", err }, "yksittäisen Päikky-viestin jäsennys epäonnistui");
    }
  }
  return messages;
}

/** Onko viestihaku tällä hetkellä rikki — jotta lokiin menee tilan muutos, ei rivi per kierros. */
let messagesFailing = false;

/** Lyhyt yksirivinen syy korttiin ja lokiin. Ei stack tracea, ei tunnuksia. */
function messageFailureReason(err: unknown): string {
  const line = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  if (line === "") return "Viestien haku epäonnistui.";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * Viestihaun virhe ei kaada kierrosta. `v2/communications` on koko toteutuksen
 * heikoiten todennettu osa — postilaatikko oli tyhjä mittaushetkellä, kenttien
 * nimet ovat koodista luettuja ja polku on jo kertaalleen vaihtunut — ja jos se
 * hajoaa pysyvästi, hoitoajat jäisivät ikuisesti vanhentuneiksi vaikka ne
 * toimisivat. Hoitoajat ovat se mitä käyttäjä pyysi. Vika ei silti jää
 * hiljaiseksi: se menee sekä lokiin että `messagesError`-kenttänä korttiin.
 */
async function fetchMessagesOrNote(
  cycle: CycleContext,
): Promise<{ messages: PaikkyMessage[]; error: string | null }> {
  try {
    const messages = await fetchMessages(cycle);
    if (messagesFailing) {
      messagesFailing = false;
      logger.warn({ event: "paikky_messages_recovered", provider: "paikky" }, "Päikyn viestihaku toimii taas");
    }
    return { messages, error: null };
  } catch (err) {
    // Tunnistautumisvirhe ei ole viestien ongelma vaan istunnon, ja se kuuluu
    // katkaisijalle. Sitä ei niellä tänne.
    if (err instanceof FatalProviderError) throw err;
    const reason = messageFailureReason(err);
    if (!messagesFailing) {
      messagesFailing = true;
      logger.error(
        { event: "paikky_messages_failed", provider: "paikky", reason },
        "Päikyn viestihaku epäonnistui — hoitoajat näytetään silti",
      );
    }
    return { messages: [], error: reason };
  }
}

/**
 * Kolme tai neljä kutsua per kierros, yksi kirjautuminen. `v2/calendar/balance`
 * jätetään tarkoituksella hakematta (ks. docs/paikky-rajapinta.md): sen `plan`
 * kahdentaa kalenterin `markings`-tiedon ja `actual` täyttyy vasta
 * uloskirjauksesta, eli ainoa oma tieto valmistuu illalla kun näyttöä ei enää
 * katsota. "Paikalla nyt" saadaan kalenterin `status`- ja `presentFrom`-
 * kentistä ilman lisäkutsua, ja jokainen kutsu on rivi kunnan lokissa
 * huoltajan nimellä. `v2/default_plans` jätetään hakematta samasta syystä.
 */
async function fetchPaikky(): Promise<PaikkyData> {
  if (!isPaikkyConfigured()) {
    throw new FatalProviderError(
      "NotConfigured",
      "Päikky-tunnuksia ei ole asetettu. Täytä PAIKKY_* arvot .env-tiedostoon.",
    );
  }

  const cycle: CycleContext = { reauthenticated: false };

  const children = parseChildren(await apiGet<ChildrenResponse>(cycle, "v2/guardians/self/children"));
  if (children.length === 0) {
    throw new Error("Päikystä ei löytynyt yhtään lasta");
  }

  const todayKey = localDateKey();
  const currentMonth = todayKey.slice(0, 7);
  const index: DayIndex = new Map();
  mergeCalendar(index, await apiGet<CalendarResponse>(cycle, `v2/calendar?month=${currentMonth}`));

  // Seuraava kuukausi haetaan vain jos ikkuna oikeasti jää vajaaksi — ei sillä
  // oletuksella että ruudukko ylivuotaa kuukauden yli. Kuukausi joka alkaa
  // maanantaina ja päättyy sunnuntaina (2026–2030: vain helmikuu 2027) antaa
  // tasan oman pituutensa, jolloin huominen puuttuisi vastauksesta.
  if (windowDates(todayKey).some((date) => !index.has(date))) {
    mergeCalendar(index, await apiGet<CalendarResponse>(cycle, `v2/calendar?month=${nextMonthKey(currentMonth)}`));
  }

  const { messages, error: messagesError } = await fetchMessagesOrNote(cycle);
  const childData = children.map((child) => buildChildData(child, index, todayKey));

  // Ruudukossa on aina kolmisenkymmentä päivää, joten tyhjä on rakenteen
  // muutos eikä loma. Lapsikohtaista tyhjää EI lokiteta: kesäloma tai pitkä
  // poissaolo on täysin normaali tila, ja siitä kirjoitettu virherivi puolen
  // tunnin välein olisi juuri sitä kohinaa jota tämä loki välttää.
  if (index.size === 0) {
    logger.error(
      {
        event: "paikky_empty_parse",
        provider: "paikky",
        month: currentMonth,
        children: children.length,
      },
      "Päikky ei palauttanut yhtään kalenteripäivää — vastausrakenne on voinut muuttua",
    );
  }

  return { children: childData, messages, messagesError };
}

/** Samalla linjalla Wilman kanssa: yöllä ei kysellä, mikään ei silti muutu. */
function outsideQuietHours(now: Date): boolean {
  const { hour } = localParts(now);
  return hour >= 5 && hour < 23;
}

export function createPaikkyProvider(): Provider<PaikkyData> {
  return new Provider<PaikkyData>({
    id: "paikky",
    // Hoitoajat eivät muutu minuuteittain, ja kunnan tietosuojaselosteen mukaan
    // jokainen luku kirjautuu lokiin huoltajan nimellä. Puoli tuntia riittää.
    intervalMs: 30 * 60 * 1000,
    // Wilma lähtee 2 s, sää 5 s ja kalenteri 10 s kohdalla; tämä ei osu
    // niiden päälle eikä tee kahta kirjautumista samalla sekunnilla.
    initialDelayMs: 15_000,
    // Kolme tai neljä peräkkäistä kutsua, kukin enintään 20 s.
    timeoutMs: 2 * 60 * 1000,
    shouldRun: outsideQuietHours,

    // Katkaisijan luvut ovat Päikylle omansa, EIVÄT provider.ts:n oletuksia.
    // Oletukset on mitoitettu Wilmalle, jossa istunto elää kirjaston omassa
    // evästepurkissa: siellä epäonnistunut kierros ei välttämättä ole
    // kirjautumisyritys lainkaan. Päikyssä token on muistissa ja sen ainoa
    // uusimistapa on kirjautuminen, joten epäonnistunut kierros on käytännössä
    // aina yksi kirjautumisyritys tilille, joka lukkiutuu ja joka on samaan
    // aikaan huoltajan puhelimessa (ks. apiGet: tuoreella tokenilla saatu 401
    // ei kuluta toista yritystä). Wilman oletuksilla (fatalLimit 3,
    // 30 min → 4 h, 12 manuaalitestiä) väärä salasana tuottaisi noin 21
    // yritystä vuorokaudessa.
    //
    // Näillä luvuilla: 2 yritystä 30 min välein, sitten koeyritykset 2 h, 4 h,
    // 8 h ja 12 h välein — noin 5 vuorokaudessa. Manuaalitestien katto 3
    // (väli pysyy provider.ts:n 5 minuutissa), joten pahin tapaus on noin 9
    // kirjautumisyritystä vuorokaudessa, aina vähintään puoli tuntia
    // toisistaan. Aito hetkellinen katko korjaantuu silti saman päivän aikana.
    //
    // HUOM: "Testaa yhteys" avaa jäähdytyksen, mutta se EI auta väärään
    // salasanaan. Palvelin lukee .env-tiedoston vain käynnistyessään
    // (--env-file, ks. server/package.json), joten korjattu salasana vaatii
    // uudelleenkäynnistyksen — nappi yrittäisi uudestaan samalla vanhalla
    // arvolla ja kuluttaisi yhden kirjautumisyrityksen turhaan.
    fatalLimit: 2,
    probeCooldownMs: 2 * 60 * 60 * 1000,
    maxProbeCooldownMs: 12 * 60 * 60 * 1000,
    manualTestDailyLimit: 3,

    // Ilman tätä backoff olisi Päikyllä kuollut kirjain: se laskee
    // `intervalMs * 2^n` ja leikkaa tuloksen `maxBackoffMs`iin, jonka oletus on
    // 30 min — täsmälleen tämän providerin `intervalMs`. Ei-fataali vika
    // (HTTP 500, 429, verkkokatko) toistuisi siis normaalitahtia loputtomiin
    // hidastumatta lainkaan. Wilmalla oletus toimii vain siksi, että sen väli
    // on 20 min. Kahden tunnin katto harventaa rikkinäisen päivän liikenteen
    // murto-osaan, mutta palautuu silti saman päivän aikana.
    maxBackoffMs: 2 * 60 * 60 * 1000,

    fetch: fetchPaikky,
  });
}
