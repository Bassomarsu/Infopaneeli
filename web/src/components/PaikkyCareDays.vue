<script setup lang="ts">
import { computed } from "vue";
import type { PaikkyChildData, PaikkyData, PaikkyDay, PaikkyTimeRange, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<PaikkyData>;
  /**
   * Sama asetus kuin lukujärjestyksellä (settings.scheduleLayout), jotta
   * molemmat välilehdet jakautuvat lapsille samalla tavalla — kortin leveys
   * on sama kummallakin.
   */
  layout: "single" | "split";
  /**
   * "HH:MM". Sama asetus kuin lukujärjestyksellä, mutta tulkitaan tässä itse:
   * tämä välilehti EI saa periä useScheduleDayn "seuraava päivä jolla on
   * tunteja" -hyppyä. Syysloman aikana se hyppäisi päiviä eteenpäin juuri kun
   * päiväkoti on auki ja lapsi siellä, jolloin hoitoaikalista näyttäisi
   * väärää päivää. Ks. leadDay alla.
   */
  rolloverTime: string;
  /**
   * Näytettävät lapset (PaikkyChild.id). null, puuttuva TAI tyhjä lista =
   * kaikki. Sama sääntö kuin lukujärjestyksellä (useScheduleDay.ts): kun
   * asetuksista poistaa viimeisenkin valinnan, kortti palaa näyttämään kaikki
   * eikä käyttäjälle jää tapaa tyhjentää sitä vahingossa. ScheduleCard
   * suodattaa kortin otsikon samalla säännöllä, joten ero tuottaisi otsikon
   * joka nimeää lapsen jonka rivejä ei näy.
   *
   * Suodatus on näkymäasia: haku hakee silti kaikki lapset, joten piilotetun
   * lapsen takaisin kytkeminen ei odota seuraavaa pollausta.
   */
  visibleChildren?: string[] | null;
}>();

/**
 * Montako päivää yhdelle lapselle mahtuu ennen kuin lista alkaa vain rullata
 * ohi katsojan. Kuluva päivä on listan ensimmäinen rivi eikä enää oma
 * lohkonsa, joten luku on yhtä suurempi kuin ennen: eteenpäin katsova
 * ikkuna pysyy samana (kuusi tulevaa päivää).
 */
const MAX_DAYS = 7;

/**
 * Käännökset niille koodeille jotka on OIKEASTI nähty rajapinnasta
 * (ks. docs/paikky-rajapinta.md). Tuntematon koodi näytetään sellaisenaan:
 * väärä arvaus olisi pahempi kuin ruma versaalisana, ja näkyvä koodi kertoo
 * että tähän listaan pitää lisätä rivi.
 */
const MARKING_LABELS: Record<string, string> = {
  SCHEDULED_DAY_OFF: "suunniteltu vapaapäivä",
};

const WEEKDAYS = [
  "Sunnuntai",
  "Maanantai",
  "Tiistai",
  "Keskiviikko",
  "Torstai",
  "Perjantai",
  "Lauantai",
];

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function weekdayIndex(key: string): number {
  // UTC-rakennus vain viikonpäivän lukemiseksi, sama kikka kuin
  // CalendarCard.vue:ssa — paikallinen konstruktori voi siirtää päivää
  // kesäajan vaihtumisen kohdalla.
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d}.${m}.`;
}

function minutesOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * "08:00" → "08.00". Kortti näyttää samassa näkymässä sekä rajapinnan
 * kellonaikoja että lukittumishetken, jonka `toLocaleTimeString("fi-FI")`
 * muotoilee pisteellä ("klo 21.00"). Kaksi erotinta samassa kortissa on vain
 * epäjohdonmukaisuus, ja piste on suomalainen muoto. Vain odotettu muoto
 * muunnetaan: tunnistamaton merkkijono menee läpi sellaisenaan, samalla
 * periaatteella kuin tuntemattomat koodit muualla tässä tiedostossa.
 */
function clockText(value: string): string {
  return /^\d{1,2}:\d{2}$/.test(value) ? value.replace(":", ".") : value;
}

/**
 * Merkinnän tyyppi. Mittaushetkellä nähtiin vain "PRESENT" = tavallinen
 * hoitoaika, joten muille ei ole käännöstä — tuntematon koodi näytetään
 * sellaisenaan, samoin kuin MARKING_LABELSissa. Tämä taulu on se paikka johon
 * käännös lisätään kun koodi joskus nähdään.
 */
const RANGE_TYPE_LABELS: Record<string, string> = {};

/**
 * Null = tavallinen hoitoaika, ei merkittävää. Muu arvo on merkintä joka EI
 * ole läsnäoloa: poissaolo voi tulla kellonaikojen kanssa, ja ilman tätä se
 * renderöityisi rivillä tavallisena hoitoaikana — eli varattuna hoitona
 * vaikka kyse on poissaolosta.
 */
function rangeTypeLabel(type: string): string | null {
  if (type === "PRESENT") return null;
  return RANGE_TYPE_LABELS[type] ?? type;
}

function rangeLabel(range: PaikkyTimeRange): string {
  // Ajat tulevat palvelimelta valmiiksi Suomen paikallisaikana, joten tässä
  // ei jäsennetä eikä muunneta mitään — vain yhdistetään luettavaksi.
  const times = range.to
    ? `${clockText(range.from)}–${clockText(range.to)}`
    : `${clockText(range.from)} alkaen`;
  const label = rangeTypeLabel(range.type);
  return label === null ? times : `${times} (${label})`;
}

function rangesLabel(ranges: PaikkyTimeRange[]): string {
  return ranges.map(rangeLabel).join(", ");
}

function markingLabel(marking: string): string {
  return MARKING_LABELS[marking] ?? marking;
}

/** Kaikki Päikystä saadut lapset — tyhjä lista tarkoittaa oikeasti tyhjää hakua. */
const allChildren = computed(() => props.snapshot?.data?.children ?? []);

/**
 * Näkyvät lapset. Ehto on kirjoitettu täsmälleen samaksi kuin
 * useScheduleDay.ts:n oppilassuodatus, jotta kortin molemmat välilehdet
 * tulkitsevat saman asetuksen samalla tavalla.
 *
 * `allChildren` säilyy erikseen, koska "Päikystä ei löytynyt lapsia" ja
 * suodatuksen jälkeinen tyhjä ovat eri tiloja (ks. state).
 */
const children = computed(() => {
  const allowed = props.visibleChildren;
  return allChildren.value.filter(
    (entry) => allowed === null || allowed === undefined || allowed.length === 0 || allowed.includes(entry.child.id),
  );
});

/**
 * Kello luetaan uudestaan jokaisella dashboard-pollauksella: `props.snapshot`
 * on joka vastauksessa uusi olio, mikä mitätöi tämän computedin. Muuten päivä
 * ja rollover jäisivät siihen mitä ne olivat sivun latautuessa, eikä kortti
 * vaihtuisi keskiyöllä lainkaan.
 */
const clock = computed(() => {
  void props.snapshot;
  return new Date();
});

/** Oikea kuluva päivä. Näyttö on Suomessa ja palvelin on jo tehnyt vyöhykemuunnoksen. */
const todayKey = computed(() => localDateKey(clock.value));

/**
 * Mistä päivästä lista alkaa kun kuluvasta päivästä ei ole omaa riviä:
 * tähän päivään ankkuroitu, rollover-ajan jälkeen huomiseen. Ei siis
 * useScheduleDayn hyppyä seuraavaan päivään jolla on oppitunteja.
 * Ks. prepared: kun kuluvalla päivällä on rivi, se pysyy listalla.
 */
const leadDay = computed(() => {
  const nowMinutes = clock.value.getHours() * 60 + clock.value.getMinutes();
  return nowMinutes >= minutesOfDay(props.rolloverTime)
    ? shiftKey(todayKey.value, 1)
    : todayKey.value;
});

/** Jokainen päivä nimetään eksplisiittisesti, koska välilehdet voivat näyttää eri päivää. */
function describe(key: string): string {
  const today = todayKey.value;
  if (key === today) return "Tänään";
  if (key === shiftKey(today, 1)) return "Huomenna";
  if (key === shiftKey(today, -1)) return "Eilen";
  return WEEKDAYS[weekdayIndex(key)] ?? "";
}

/**
 * `lockingAt` on ISO-8601 UTC-aikaleima, toisin kuin `from`/`to` jotka ovat
 * valmiiksi paikallisia "HH:MM"-merkkijonoja. Sitä EI saa näyttää sellaisenaan:
 * "2026-09-06T21:00:00Z" on Suomen aikaa maanantai 7.9. klo 00.00, ei
 * sunnuntai klo 21.
 *
 * Kellonaika näytetään päivän rinnalla nimenomaan siksi, että lukittuminen
 * osuu usein keskiyöhön: pelkkä "ma 7.9." antaisi ymmärtää että maanantaina
 * ehtii vielä varata, vaikka viimeinen hetki on sunnuntai-ilta.
 */
function lockingLabel(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString("fi-FI", {
    timeZone: "Europe/Helsinki",
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
  const time = at.toLocaleTimeString("fi-FI", {
    timeZone: "Europe/Helsinki",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} klo ${time}`;
}

/** Aikaisin vielä voimassa oleva lukittumishetki — se joka umpeutuu ensimmäisenä. */
function earliestLock(days: PaikkyDay[]): string | null {
  const now = clock.value.getTime();
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const day of days) {
    if (!day.lockingAt) continue;
    const at = new Date(day.lockingAt).getTime();
    // Mennyt määräaika ei ole toimenpide vaan historiaa.
    if (Number.isNaN(at) || at < now) continue;
    if (best === null || at < best) {
      best = at;
      bestIso = day.lockingAt;
    }
  }
  return bestIso;
}

const columns = computed(() => {
  if (props.layout === "single" || children.value.length <= 1) return 1;
  return Math.min(children.value.length, 2);
});

/**
 * Ehto katsoo NÄKYVIÄ lapsia, ei kaikkia. Sarakeotsikko ei siis puutu silloin
 * kun nimi olisi tarpeeton, vaan silloin kun se on jo kerrottu: ScheduleCardin
 * `cardTitle` tuottaa "Hoitoajat — Vilma" täsmälleen samalla ehdolla (yksi
 * näkyvä lapsi, sama suodatussääntö). Kaikkien lasten laskeminen näyttäisi
 * saman nimen kahdesti alle sadan pikselin päässä toisistaan.
 *
 * Nimetön sarake ei siis jää arvattavaksi — vastaus on kortin otsikossa. Jos
 * `cardTitle` joskus muuttuu, tämän on muututtava mukana.
 */
const showNames = computed(() => children.value.length > 1);

/** Yksi varausjakso aika-asteikolla, prosentteina palkin leveydestä. */
interface Segment {
  left: number;
  width: number;
  /** Loppuaika puuttuu (kesken oleva päivä) — palkki häivytetään reunaan. */
  open: boolean;
  /** Muu kuin PRESENT-merkintä: ei tavallista hoitoaikaa, joten ei myöskään umpinaista palkkia. */
  other: boolean;
}

/**
 * Neljä tilaa, ei kolmea. `open` (varaamatta) odottaa huoltajan toimenpidettä
 * ja `unknown` (ei tietoa) kertoo että rajapinta muuttui — ne näyttivät ennen
 * samalta, mutta korjaava toimenpide on eri: toiseen vastaa perhe, toiseen
 * se joka ylläpitää integraatiota.
 */
type DayTone = "times" | "off" | "open" | "unknown";

interface DayRow {
  date: string;
  label: string;
  shortDate: string;
  text: string;
  tone: DayTone;
  segments: Segment[];
  /**
   * Kuluva päivä: rivi saa korostuskehyksen. Ehto luetaan kellosta
   * (`date === todayKey`), ei payloadista, joten se ei voi osoittaa väärään
   * riviin silloinkaan kun vastaus on yöltä.
   */
  today: boolean;
}

/**
 * Ainoa toimintakehotus jonka tämä kortti voi antaa. Tämän päivän hoitoaika on
 * tietoa jonka perhe jo tietää — he veivät lapsen itse; varaamaton tuleva
 * viikko yhdessä lukittumisajan kanssa on se tieto jonka ohittaminen maksaa
 * hoitopaikan. Siksi se kootaan yhdeksi riviksi eikä hajoteta merkeiksi
 * päivälistaan.
 */
interface Unreserved {
  count: number;
  /** Aikaisin lukittumishetki Suomen aikaa, esim. "ma 7.9. klo 00.00". */
  deadline: string | null;
}

interface ChildView {
  id: string;
  name: string;
  days: DayRow[];
  /** Null kun varaamattomia päiviä ei ole — tyhjä tila on silloin oikea tila. */
  unreserved: Unreserved | null;
  /**
   * Null kun vastaus on tältä päivältä. Muuten lyhyt maininta siitä miltä
   * päivältä tiedot ovat — ks. staleNoteFor.
   */
  staleNote: string | null;
}

/**
 * Varaus ei ole läsnäolo, ja tämä kortti näyttää nyt vain varauksen:
 * `status`/`presentFrom` (toteuma) ei renderöidy missään. Se on samalla syy
 * siihen, ettei kuluvan päivän rivi voi enää valehdella yöllä — aiempi
 * kuluvan päivän lohko kertoi otsikossaan toteuman ("Paikalla klo 8.04
 * alkaen"), ja jos vastaus oli eiliseltä, se väitti eilisen leimauksen
 * tämänpäiväiseksi. Rivin sisältö tulee nyt päivän omasta kalenteririvistä
 * (`days`), jossa jokainen päivä kantaa oman varauksensa.
 *
 * Jäljelle jää yksi rehellisyysvelvoite: kertoa jos vastaus on eiliseltä.
 * Yöllä ei kysellä, joten klo 23–05 näin voi olla.
 */
function staleNoteFor(entry: PaikkyChildData): string | null {
  const today = entry.today;
  if (!today || today.date === todayKey.value) return null;
  return `Tiedot ovat päivältä ${shortDate(today.date)}`;
}

function isUnreserved(day: PaikkyDay): boolean {
  return day.planned.length === 0 && !day.markingType && (day.type === "plannable" || day.needsAttention);
}

/**
 * Kuluva päivä ja tulevat päivät eroteltuna, mutta ilman aika-asteikkoa:
 * asteikko lasketaan juuri näistä riveistä, joten se on pakko olla valmis
 * ennen kuin palkkeja voi sijoittaa (ks. axis).
 */
const prepared = computed(() =>
  children.value.map((entry) => {
    /*
     * Kuluva päivä pysyy listalla koko päivän kun sillä on oma rivinsä.
     * Rollover on jaettu asetus lukujärjestyksen kanssa ja sen oletus on
     * 12:00 — lukujärjestykselle se tarkoittaa "koulupäivä ohi, näytä
     * huominen", mutta hoitopäivä on klo 12 kesken ja hakuaika on juuri se
     * mitä kortilta silloin katsotaan. Rollover siirtää listan alkua siis
     * vain silloin kun kuluvasta päivästä ei ole riviä lainkaan (viikonloppu
     * tai päiväkoti kiinni: palvelin jättää päivän pois `days`-listasta).
     */
    const hasToday = entry.days.some((day) => day.date === todayKey.value);
    const from = hasToday ? todayKey.value : leadDay.value;

    const upcoming = [...entry.days]
      .filter((day) => day.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      entry,
      shown: upcoming.slice(0, MAX_DAYS),
      // Koko tuleva ikkuna, ei vain listalle mahtuvat rivit: huomautuksen koko
      // pointti on kertoa se mitä lista ei ehdi näyttää.
      unreservedDays: upcoming.filter(isUnreserved),
    };
  }),
);

/** Käytetään vain kun näkyvissä ei ole yhtään kellonaikaa — silloin asteikko on pelkkä kehys. */
const AXIS_FALLBACK_START = 6 * 60;
const AXIS_FALLBACK_END = 18 * 60;
/** Tunti ilmaa kummallekin reunalle, jotta palkit eivät kasva kiinni asteikon päihin. */
const AXIS_PAD = 60;
/** Yhden lyhyen päivän ei anneta venyä koko leveydelle: pituus olisi silloin merkityksetön. */
const AXIS_MIN_SPAN = 6 * 60;
const DAY_MINUTES = 24 * 60;

/**
 * Yksi yhteinen aika-asteikko koko kortille — sama periaate kuin
 * ElectricityCardin jaetussa hinta-asteikossa: samanlainen palkki tarkoittaa
 * samaa asiaa riippumatta siitä minkä lapsen tai päivän kohdalla se on.
 * Erikseen skaalatut rivit näyttäisivät neljän tunnin päivän yhtä pitkältä
 * kuin yhdeksän tunnin.
 */
const axis = computed(() => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const include = (range: PaikkyTimeRange): void => {
    const from = minutesOfDay(range.from);
    // Avoin jakso ei kerro loppuaan; tunnin varaus riittää pitämään sen mukana
    // asteikossa ilman että se venyttää sitä keksityllä loppuajalla.
    const to = range.to === null ? from + 60 : minutesOfDay(range.to);
    if (from < min) min = from;
    if (to > max) max = to;
  };

  for (const item of prepared.value) {
    for (const day of item.shown) for (const range of day.planned) include(range);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { start: AXIS_FALLBACK_START, end: AXIS_FALLBACK_END };
  }

  let start = Math.max(0, Math.floor((min - AXIS_PAD) / 60) * 60);
  let end = Math.min(DAY_MINUTES, Math.ceil((max + AXIS_PAD) / 60) * 60);

  if (end - start < AXIS_MIN_SPAN) {
    const missing = AXIS_MIN_SPAN - (end - start);
    start = Math.max(0, start - Math.ceil(missing / 2 / 60) * 60);
    end = Math.min(DAY_MINUTES, start + AXIS_MIN_SPAN);
    start = Math.max(0, end - AXIS_MIN_SPAN);
  }

  return { start, end };
});

/**
 * Apuviivat tasatunnein. Askel valitaan niin että viivoja on 3–5: tiheämpi
 * ruudukko olisi parin metrin päästä pelkkää tekstuuria, harvempi ei kertoisi
 * mihin kohtaan päivää palkki osuu.
 */
const axisTicks = computed(() => {
  const { start, end } = axis.value;
  const span = end - start || 1;
  const step = (span > 12 * 60 ? 4 : span > 8 * 60 ? 3 : 2) * 60;
  const first = Math.ceil(start / step) * step;
  const ticks: { minutes: number; pct: number; label: string }[] = [];
  for (let minutes = first; minutes <= end; minutes += step) {
    const pct = ((minutes - start) / span) * 100;
    // Aivan reunaan osuva lukema leikkautuisi sarakkeen ulkopuolelle.
    ticks.push({ minutes, pct, label: pct < 4 || pct > 96 ? "" : String(minutes / 60) });
  }
  return ticks;
});

function clampToAxis(minutes: number): number {
  const { start, end } = axis.value;
  return Math.min(Math.max(minutes, start), end);
}

function segmentsFor(ranges: PaikkyTimeRange[]): Segment[] {
  const { start, end } = axis.value;
  const span = end - start || 1;
  return ranges.map((range) => {
    const from = minutesOfDay(range.from);
    const to = range.to === null ? end : minutesOfDay(range.to);
    const open = range.to === null;
    const left = ((clampToAxis(from) - start) / span) * 100;
    const right = ((clampToAxis(to) - start) / span) * 100;
    return {
      left,
      // Lyhyt jakso ei saa kadota näkymättömiin — sama vähimmäisleveyden
      // perustelu kuin ElectricityCardin pylväissä.
      width: Math.max(right - left, 1.4),
      open,
      other: rangeTypeLabel(range.type) !== null,
    };
  });
}

/** Kuluvan hetken kohta asteikolla, tai null kun ollaan sen ulkopuolella (ilta, aamuyö). */
const nowMark = computed<number | null>(() => {
  const { start, end } = axis.value;
  const minutes = clock.value.getHours() * 60 + clock.value.getMinutes();
  if (minutes < start || minutes > end) return null;
  return ((minutes - start) / (end - start || 1)) * 100;
});

/**
 * Tyhjä `planned` ei ole yksi tila vaan kaksi. Suunniteltavissa oleva päivä
 * ilman varausta odottaa huoltajan toimenpidettä ("varaamatta"); päivä jota ei
 * voi suunnitella on kiinni tai viikonloppu ("ei hoitoa"). Niiden
 * niputtaminen samaksi hukkaisi juuri sen tiedon jota kortilta haetaan.
 */
function dayRow(day: PaikkyDay): DayRow {
  let text: string;
  let tone: DayTone;

  if (day.planned.length > 0) {
    text = rangesLabel(day.planned);
    tone = "times";
  } else if (day.markingType) {
    text = markingLabel(day.markingType);
    tone = "off";
  } else if (day.type === "plannable" || day.needsAttention) {
    // Rivi kertoo tilan, mutta lukittumisaika EI toistu joka rivillä — se on
    // koottu yhdeksi huomautukseksi listan otsikkoon (ks. views).
    text = "varaamatta";
    tone = "open";
  } else if (day.type === "unknown") {
    // Palvelin ei tunnistanut päivän tyyppiä. "Ei hoitoa" rauhoittaisi väärin
    // perustein: jos Päikky nimeää plannablen uudelleen, koko varaamattomien
    // huomautus katoaisi eikä ruudulla näkyisi siitä mitään merkkiä.
    text = "ei tietoa";
    tone = "unknown";
  } else {
    text = "ei hoitoa";
    tone = "off";
  }

  return {
    date: day.date,
    label: describe(day.date),
    shortDate: shortDate(day.date),
    text,
    tone,
    segments: segmentsFor(day.planned),
    today: day.date === todayKey.value,
  };
}

const views = computed<ChildView[]>(() =>
  prepared.value.map((item) => {
    const lock = earliestLock(item.unreservedDays);
    return {
      id: item.entry.child.id,
      name: item.entry.child.firstName,
      days: item.shown.map(dayRow),
      unreserved:
        item.unreservedDays.length === 0
          ? null
          : {
              count: item.unreservedDays.length,
              deadline: lock === null ? null : lockingLabel(lock),
            },
      staleNote: staleNoteFor(item.entry),
    };
  }),
);

function unreservedCount(unreserved: Unreserved): string {
  return unreserved.count === 1 ? "1 päivä varaamatta" : `${unreserved.count} päivää varaamatta`;
}

/**
 * Päikyn oma tila kerrotaan tässä eikä CardShellissä: kortin runko pitää
 * jäädä näkyviin, jotta välilehdet säilyvät ja toimivaan lähteeseen pääsee
 * takaisin. Sanamuodot vastaavat CardShellin omia.
 *
 * Huom: `messagesError` EI kuulu tänne. Se koskee viestihakua, ja hoitoajat
 * ovat silloin kunnossa — virheilmoitus toimivan datan päällä on oma virheensä.
 */
const state = computed<{ title: string | null; text: string } | null>(() => {
  const status = props.snapshot?.status;
  if (!props.snapshot || status === "idle") return { title: null, text: "Haetaan…" };
  if (status === "failed") {
    return { title: "Hoitoaikoja ei saatu", text: props.snapshot.error?.message ?? "Päikky ei vastaa" };
  }
  if (status === "hidden") {
    return {
      title: "Vain infonäytöllä",
      text: "Lasten hoitoajat näkyvät vain keittiön näytöllä, eivät kotiverkon muilla laitteilla.",
    };
  }
  if (allChildren.value.length === 0) {
    return { title: "Ei hoitoaikatietoja", text: "Päikystä ei löytynyt lapsia." };
  }
  // Puolustava haara: tyhjä valinta tarkoittaa "kaikki", joten suodatus ei
  // yksinään voi tyhjentää listaa. Jos se silti tyhjenee, kyse on käyttäjän
  // valinnasta eikä viasta — ei otsikkoa, ei kehotusta, vain toteamus.
  if (children.value.length === 0) {
    return { title: null, text: "Ei valittuja lapsia" };
  }
  return null;
});
</script>

<template>
  <div v-if="state" class="state">
    <span v-if="state.title" class="state__title">{{ state.title }}</span>
    <span>{{ state.text }}</span>
  </div>

  <div v-else class="care" :style="{ '--cols': columns }">
    <div v-for="view in views" :key="view.id" class="care__col">
      <h3 v-if="showNames" class="care__name">{{ view.name }}</h3>

      <!-- Vain kun vastaus on eiliseltä (yöllä ei kysellä). Rivit itse ovat
           päiväkohtaisia eivätkä valehtele, mutta se mistä ne on haettu
           kuuluu kertoa. -->
      <p v-if="view.staleNote" class="stale">{{ view.staleNote }}</p>

      <!-- Yksi koottu rivi, listan otsikkona: lukittumisaika ei toistu riveillä.
           Merkki on sama katkoviivakehys kuin varaamattomien päivien palkissa,
           joten rivi ja sen tarkoittamat päivät tunnistuvat toisikseen ilman
           erillistä selitettä. -->
      <p v-if="view.unreserved" class="alert">
        <span class="alert__mark" aria-hidden="true" />
        <span class="alert__count">{{ unreservedCount(view.unreserved) }}</span>
        <span v-if="view.unreserved.deadline" class="alert__lock">
          lukittuu {{ view.unreserved.deadline }}
        </span>
      </p>

      <p v-if="view.days.length === 0" class="care__empty">Ei tulevia hoitopäiviä</p>

      <div v-else class="sheet">
        <div class="sheet__body">
          <!-- Yhtenäiset tuntiviivat koko listan läpi: ne tekevät riveistä
               yhden asteikon eivätkä kuutta erillistä palkkia. -->
          <span class="sheet__rules" aria-hidden="true">
            <span
              v-for="tick in axisTicks"
              :key="`rule-${tick.minutes}`"
              class="rule"
              :style="{ left: `${tick.pct}%` }"
            />
          </span>

          <ul class="days">
            <li
              v-for="day in view.days"
              :key="day.date"
              class="day"
              :class="[`day--${day.tone}`, { 'day--today': day.today }]"
            >
              <span class="day__when">
                <span class="day__label">{{ day.label }}</span>
                <span class="day__date tnum">{{ day.shortDate }}</span>
              </span>

              <!-- Neljä tilaa, neljä eri pintaa: umpinainen = varattu,
                   katkoviiva = varaamatta, viiruitus = ei tietoa, tyhjä = ei
                   hoitoa. Ero on muodossa eikä pelkässä värissä, koska näyttö
                   himmennetään yöllä (ks. #app.night) ja sävyt latistuvat. -->
              <span class="day__rail" aria-hidden="true">
                <template v-if="day.segments.length > 0">
                  <span
                    v-for="(seg, i) in day.segments"
                    :key="`${day.date}-${i}`"
                    class="seg"
                    :class="{ 'seg--open': seg.open, 'seg--other': seg.other }"
                    :style="{ left: `${seg.left}%`, width: `${seg.width}%` }"
                  />
                </template>
                <span v-else-if="day.tone === 'open'" class="rail rail--open" />
                <span v-else-if="day.tone === 'unknown'" class="rail rail--unknown" />

                <!-- Nykyhetki vain kuluvan päivän rivillä: muilla riveillä
                     "nyt" ei ole mikään kohta. Absoluuttinen, joten se ei
                     muuta rivin korkeutta eikä sarakkeiden paikkaa. -->
                <span
                  v-if="day.today && nowMark !== null"
                  class="nowline"
                  :style="{ left: `${nowMark}%` }"
                />
              </span>

              <span class="day__text tnum">{{ day.text }}</span>
            </li>
          </ul>
        </div>

        <div class="axis" aria-hidden="true">
          <span class="axis__strip">
            <span
              v-for="tick in axisTicks"
              :key="`tick-${tick.minutes}`"
              class="axis__tick tnum"
              :style="{ left: `${tick.pct}%` }"
              >{{ tick.label }}</span
            >
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Päikylle oma tunnusväri, jotta hoitoaika ei sekoitu vilkaisulla Wilman
 * vihreään koulutietoon. Ei uutta globaalia muuttujaa: style.css ei kuulu
 * tähän muutokseen, joten väri elää tässä kortissa.
 */
.care {
  --care: var(--accent-calendar);
  /* Sarakemitat ovat kiinteät, koska palkit ovat vertailukelpoisia vain jos
     jokaisen rivin asteikko alkaa ja loppuu samasta kohdasta. */
  --col-day: 8.4rem;
  --col-time: 6.4rem;
  --col-gap: 0.7rem;
  --rail-h: 0.6rem;
  /* Kuinka paljon kuluvan päivän kehys levittäytyy rivin yli (ks.
     .day--today::after). Sama arvo on pakko olla alla olevassa täytteessä. */
  --frame-bleed: 0.5rem;

  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: 1.4rem;
  min-height: 0;
  overflow-y: auto;
  flex: 1;
  /*
   * Kehyksen ylitys mahtuu tämän elementin omaan täytteeseen, ja negatiivinen
   * marginaali palauttaa sisällön takaisin samaan kohtaan kortissa. Ilman tätä
   * viimeisen sarakkeen kehys ylittäisi vierityskehyksen oikean reunan ja
   * `overflow-y: auto` toisi kortin sisään vaakavierityspalkin — mitattu, ei
   * arvattu. Kortin oma täyte (1.35rem) nielee marginaalin.
   */
  margin-inline: calc(-1 * var(--frame-bleed));
  padding-inline: var(--frame-bleed);
}

.care__col {
  min-width: 0;
  /* Kysely koskee saraketta eikä koko korttia: jaetussa asettelussa kaksi
     lasta ahtautuu eri tahtiin kuin yksi. */
  container-type: inline-size;
  container-name: care-col;
}

/* Sama muotoilu kuin lukujärjestyksen oppilasotsikolla, eri värillä. */
.care__name {
  margin: 0 0 0.45rem;
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--care);
}

.care__empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 0.9rem;
}

/* ── Vanhentunut vastaus ───────────────────────────────────────────────── */

/* Näkyy vain yöllä, kun vastaus on edelliseltä päivältä. Vaimea rivi eikä
   varoitus: rivien sisältö on silti oikein, vain haun ajankohta on vanha. */
.stale {
  margin: 0 0 0.45rem;
  font-size: 0.78rem;
  line-height: 1.25;
  color: var(--text-faint);
}

/* ── Varaamatta-huomautus ───────────────────────────────────────────────── */

.alert {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.2rem 0.5rem;
  margin: 0 0 0.5rem;
  line-height: 1.25;
}

/* Sama katkoviivakehys kuin varaamattoman päivän palkissa — selite ilman
   selitettä. */
.alert__mark {
  align-self: center;
  width: 0.62rem;
  height: 0.62rem;
  flex-shrink: 0;
  border: 1px dashed var(--mid);
  border-radius: 3px;
}

.alert__count {
  font-size: 0.95rem;
  font-weight: 650;
  color: var(--mid);
}

.alert__lock {
  font-size: 0.78rem;
  color: var(--text-dim);
}

/* ── Päivälista ─────────────────────────────────────────────────────────── */

.sheet {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sheet__body {
  position: relative;
  min-width: 0;
}

/* Apuviivat ja tuntilukemat jakavat saman sisennyksen kuin rivien palkit,
   joten viiva ja sen lukema osuvat samaan kohtaan. */
.sheet__rules,
.axis__strip {
  position: absolute;
  inset-block: 0;
  left: calc(var(--col-day) + var(--col-gap));
  right: calc(var(--col-time) + var(--col-gap));
}

.rule {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  margin-left: -0.5px;
  background: var(--border);
}

/* `z-index: 0` tekee tästä pinoamiskontekstin, jotta kuluvan päivän kehys
   (.day--today::after, z-index -1) jää rivin tekstin alle mutta pysyy kortin
   oman taustan päällä. Ilman kontekstia negatiivinen kerros painuisi .cardin
   taustan alle ja katoaisi kokonaan. */
.days {
  position: relative;
  z-index: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

/* Kolme saraketta: nimetty päivä, aika-asteikko, kellonajat. Sama lukusuunta
   vasemmalta oikealle kuin lukujärjestyksen tunneilla. */
.day {
  position: relative;
  display: grid;
  grid-template-columns: var(--col-day) minmax(0, 1fr) var(--col-time);
  align-items: baseline;
  gap: var(--col-gap);
  padding: 0.42rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.day:last-child {
  border-bottom: none;
}

/* Päivämäärä sarakkeensa oikeaan reunaan: se muodostaa oman pystysuoran
   linjansa, ja pisin viikonpäivän nimi saa kaiken jäljelle jäävän tilan. */
.day__when {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.45rem;
  min-width: 0;
}

.day__label {
  font-size: 1.05rem;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.day__date {
  font-size: 0.8rem;
  color: var(--text-faint);
  flex-shrink: 0;
}

/* Päivä ilman hoitoa vaimenee kokonaan: se on rytmiä, ei tietoa jota
   luetaan. Varaamatta ja ei tietoa eivät vaimene. */
.day--off .day__label {
  color: var(--text-dim);
}

/*
 * Kuluva päivä on tavallinen rivi — sama sarakelinjaus, sama typografia, sama
 * rivikorkeus — ja erottuu vain korostuskehyksellä. Kehys on pseudoelementti
 * eikä rivin oma reunus juuri siksi: reunus kasvattaisi rivin korkeutta ja
 * siirtäisi sarakkeita, jolloin kuluvan päivän palkki asettuisi eri kohtaan
 * asteikkoa kuin muiden päivien. Vaakasuunnassa kehys levittäytyy rivin yli
 * kortin täytteeseen, joten sekään ei kavenna palkkisaraketta.
 *
 * Muoto on sama kuin kortin aktiivisella välilehdellä (ScheduleCard,
 * .tabs__btn--active): --surface-strong-pinta ja Päikyn violetti reunus.
 * Sama ele tarkoittaa samaa asiaa kortin molemmissa päissä.
 */
.day--today::after {
  content: "";
  position: absolute;
  inset: 0 calc(-1 * var(--frame-bleed));
  z-index: -1;
  border: 1px solid var(--care);
  border-radius: 10px;
  background: var(--surface-strong);
}

/* Kehyksen alareuna toimii erottimena, joten omaa viivaa ei tarvita. */
.day--today {
  border-bottom-color: transparent;
}

.day__rail {
  position: relative;
  align-self: center;
  height: var(--rail-h);
  min-width: 0;
}

/* Oikeaan reunaan tasattu numerosarake. Tasaus on myös turvaverkko: jos
   kellonaikapari joskus kasvaa saraketta leveämmäksi, se valuu palkin
   puolelle eikä kortin reunan yli piiloon. */
.day__text {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  text-align: right;
}

/* Sanat (ei kellonajat) saavat rivittyä: "suunniteltu vapaapäivä" ei mahdu
   kellonajoille mitoitettuun sarakkeeseen yhdelle riville, ja katkaisu
   jättäisi arvattavaksi minkä tyyppinen vapaa on kyseessä. */
.day--off .day__text,
.day--open .day__text,
.day--unknown .day__text {
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1.25;
  white-space: normal;
}

.day--off .day__text {
  color: var(--text-faint);
}

.day--open .day__text,
.day--unknown .day__text {
  color: var(--mid);
  font-weight: 600;
}

/* ── Neljä pintaa ───────────────────────────────────────────────────────── */

/* Varattu aika: umpinainen palkki. Ainoa täytetty muoto koko kortissa. */
.seg {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 3px;
  background: var(--care);
}

/* Loppuaika puuttuu — palkki häviää reunaan sen sijaan että päättyisi
   kellonaikaan jota ei ole. */
.seg--open {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  -webkit-mask-image: linear-gradient(to right, #000 60%, transparent 100%);
  mask-image: linear-gradient(to right, #000 60%, transparent 100%);
}

/* Muu kuin PRESENT-merkintä ei ole varattua hoitoaikaa, joten se ei myöskään
   saa varatun palkin umpinaista pintaa. */
.seg--other {
  background: none;
  border: 1px solid var(--text-faint);
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0,
    transparent 3px,
    var(--text-faint) 3px,
    var(--text-faint) 4px
  );
}

.rail {
  position: absolute;
  inset: 0;
  border-radius: 3px;
}

/* Varaamatta: tyhjä kehys koko päivän mitalta — paikka on olemassa, mutta
   siinä ei ole mitään. */
.rail--open {
  border: 1px dashed var(--mid);
  opacity: 0.8;
}

/* Ei tietoa: sama viiruitus jolla pörssisähkökortti merkitsee julkaisemattoman
   tunnin. Se ei rauhoita eikä hälytä — se kertoo ettei tietoa ole. */
.rail--unknown {
  opacity: 0.55;
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0,
    transparent 3px,
    var(--mid) 3px,
    var(--mid) 4px
  );
}

/* Kuluva hetki varatun ajan päällä: paljonko hoitopäivää on jäljellä.
   Vain kuluvan päivän rivillä — tulevilla riveillä "nyt" ei ole mikään
   kohta. Mitat pysyvät rivin oman täytteen sisällä, joten kärki ei osu
   yläpuoliseen riviin. */
.nowline {
  position: absolute;
  top: -0.14rem;
  bottom: -0.14rem;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--text);
}

/* Alaspäin osoittava kärki: pelkkä pystyviiva luetaan helposti kirjaimeksi
   tai piirtovirheeksi, kärki kertoo että se osoittaa kohtaa asteikolla. */
.nowline::before {
  content: "";
  position: absolute;
  top: -0.26rem;
  left: 50%;
  margin-left: -0.2rem;
  border-left: 0.2rem solid transparent;
  border-right: 0.2rem solid transparent;
  border-top: 0.22rem solid var(--text);
}

/* ── Tuntiasteikko ─────────────────────────────────────────────────────── */

.axis {
  position: relative;
  height: 1rem;
  margin-top: 0.15rem;
}

.axis__tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 0.62rem;
  color: var(--text-faint);
}

/* ── Kapea sarake ──────────────────────────────────────────────────────── */

/* Ensin kavennetaan reunasarakkeita, koska palkki on hyödyllinen vielä
   kapeanakin. Muuttujat asetetaan `.sheet`ille eikä `.care`lle: säiliökysely
   voi muotoilla vain säiliön jälkeläisiä, ja `.care` on säiliön (`.care__col`)
   yläpuolella. */
@container care-col (max-width: 460px) {
  .sheet {
    --col-day: 7.2rem;
    --col-time: 5.9rem;
    --col-gap: 0.5rem;
  }

  .day__label {
    font-size: 0.95rem;
  }

  .day__text {
    font-size: 0.86rem;
  }
}

/* Alle tämän leveyden asteikolle jää niin vähän tilaa, että palkin pituus
   lakkaa kertomasta mitään. Silloin se poistuu kokonaan ja jäljelle jää sama
   kaksisarakkeinen rivi kuin ennen — kellonajat ovat se tieto jota ei saa
   menettää. */
@container care-col (max-width: 300px) {
  .sheet__rules,
  .axis,
  .day__rail {
    display: none;
  }

  .day {
    grid-template-columns: minmax(0, 1fr) auto;
  }

}
</style>
