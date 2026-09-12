import { ref, watch, type Ref } from "vue";
import { playAlarmSound, stopAlarmSound, unlockAudio } from "../components/alarmSounds.ts";
import type { Alarm, ScheduleLesson, WilmaData, WilmaStudent } from "../types.ts";

/**
 * Puhdas laukaisulogiikka erotettuna Vue-reaktiivisuudesta ja selaimen
 * sivuvaikutuksista (localStorage, Web Audio), jotta se on testattavissa
 * suoraan Nodesta ilman DOMia — ks. web/test/alarms.ts.
 */

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function earliestLessonStart(lessons: ScheduleLesson[], dateKey: string): string | null {
  let earliest: string | null = null;
  for (const lesson of lessons) {
    if (lesson.date !== dateKey) continue;
    if (earliest === null || lesson.start < earliest) earliest = lesson.start;
  }
  return earliest;
}

function hasAnyLesson(lessons: ScheduleLesson[], dateKey: string): boolean {
  return lessons.some((l) => l.date === dateKey);
}

/** Null studentNumber = "mikä tahansa oppilas" — kaikki tunnetut lapset. */
function relevantStudentIds(studentNumber: string | null, allStudents: WilmaStudent[]): string[] {
  if (studentNumber !== null) return [studentNumber];
  return allStudents.map((s) => s.studentNumber);
}

/**
 * Aikaisin tunti annetulle kalenteripäivälle relevanteille oppilaille, tai
 * null jos kellekään heistä ei ole tunteja sinä päivänä (viikonloppu, loma).
 */
function earliestStart(studentIds: string[], wilma: WilmaData | null, dateKey: string): string | null {
  if (!wilma) return null;
  let earliest: string | null = null;
  for (const id of studentIds) {
    const lessons = wilma.byStudent[id]?.lessons ?? [];
    const start = earliestLessonStart(lessons, dateKey);
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
  }
  return earliest;
}

/** True jos jollain relevantilla oppilaalla on ylipäätään tunteja sinä päivänä. */
function isSchoolDay(studentIds: string[], wilma: WilmaData | null, dateKey: string): boolean {
  if (!wilma) return false;
  return studentIds.some((id) => hasAnyLesson(wilma.byStudent[id]?.lessons ?? [], dateKey));
}

/** Date.getDayn numerointi (0 = sunnuntai … 6 = lauantai) annetulle "YYYY-MM-DD"-avaimelle. */
function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay();
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Paikallisen ajan siirtymä UTC:stä (ms) annetulla hetkellä — kesäaikana eri kuin talvella. */
function offsetMsAt(utcMs: number): number {
  return -new Date(utcMs).getTimezoneOffset() * MINUTE_MS;
}

function isWallClock(utcMs: number, year: number, month0: number, day: number, hour: number, minute: number): boolean {
  const date = new Date(utcMs);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month0 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
}

/**
 * Kaikki hetket joiden paikallinen seinäkello on TÄSMÄLLEEN annettu, aikaisin
 * ensin. Tavallisena päivänä täsmälleen yksi — mutta kesäajan siirtopäivinä ei
 * välttämättä:
 *
 *  - kevät (Suomessa maaliskuun viimeinen sunnuntai): kello hyppää 03.00 →
 *    04.00, joten kellonaikoja 03.00–03.59 EI OLE OLEMASSA → tyhjä lista.
 *  - syksy (lokakuun viimeinen sunnuntai): kello palaa 04.00 → 03.00, joten
 *    kellonajat 03.00–03.59 esiintyvät KAHDESTI → kaksi hetkeä.
 *
 * `new Date(y, m, d, h, min)` ei kerro kummastakaan mitään: se normalisoi
 * olemattoman ajan äänettömästi eteenpäin (03.30 → 04.30) ja valitsee
 * toistuvasta ajasta yhden esiintymän ilmoittamatta siitä. Siksi ehdokkaat
 * lasketaan tässä itse molemmilla siirtymillä (vuorokausi ennen ja jälkeen) ja
 * jokainen tarkistetaan lukemalla paikallinen kello takaisin.
 */
function instantsForWallClock(year: number, month0: number, day: number, hour: number, minute: number): number[] {
  const asUtc = Date.UTC(year, month0, day, hour, minute, 0, 0);
  const found: number[] = [];
  for (const offset of [offsetMsAt(asUtc - DAY_MS), offsetMsAt(asUtc + DAY_MS)]) {
    const candidate = asUtc - offset;
    if (!found.includes(candidate) && isWallClock(candidate, year, month0, day, hour, minute)) found.push(candidate);
  }
  return found.sort((a, b) => a - b);
}

/**
 * Paikallinen hetki annetulle päivälle ja kellonajalle, kesäajan siirrot
 * nimenomaisesti ratkaisten (vrt. `instantsForWallClock` yllä):
 *
 *  - Toistuva aika (syksy): ENSIMMÄINEN esiintymä. Hälytys on "herätä
 *    viimeistään" -väline, joten aikaisempi esiintymä on oikea — ja koska
 *    tavoiteaika on yksi hetki eikä kellonaika, jälkimmäinen esiintymä on
 *    tunnin myöhässä laukeamisikkunasta eikä voi laukaista samaa hälytystä
 *    toiseen kertaan.
 *
 * TÄMÄ SÄÄNTÖ KOSKEE VAIN KELLONAIKOJA, ei kaikkia hälytyksiä — ks. tarkempi
 * perustelu `alarmPlanForDate`ssa. Lyhyesti: sääntö on olemassa siksi että
 * seinäkello on syksyn yönä MONITULKINTAINEN ("03.30" tarkoittaa kahta eri
 * hetkeä, ja jonkun on valittava). Lukujärjestykseen sidottu hälytys ei anna
 * kellonaikaa vaan keston ("166 min ennen koulun alkua"), eikä kesto ole
 * monitulkintainen — se lasketaan siis suoraan ankkurihetkestä, ja tulos voi
 * osua toistuvan tunnin JÄLKIMMÄISEEN esiintymään. Se ei ole poikkeaminen
 * säännöstä vaan merkki siitä ettei sääntö päde: tulkittavaa kellonaikaa ei
 * ole. Älä "yhtenäistä" näitä pakottamalla relative-tilan tulosta tähän
 * funktioon — se rikkoisi ainoan lupauksen jonka relative-tila antaa.
 *  - Olematon aika (kevät): ENSIMMÄINEN OLEMASSA OLEVA hetki, eli siirtymän
 *    hetki (03.30 → 04.00, ei 04.30). Kokonaisen tunnin viive on huonompi kuin
 *    puolen tunnin, eikä JS:n normalisointi ole valinta vaan sivuvaikutus.
 *    Haku etenee minuutti kerrallaan, koska aukon pituutta ei voi tietää
 *    etukäteen; tavallisena päivänä silmukka ei kierrä kertaakaan. Pahin
 *    mahdollinen tapaus on kokonaan kalenterista kadonnut vuorokausi (Samoa
 *    30.12.2011), jolloin silmukka käy koko vuorokauden läpi ja putoaa lopun
 *    varasääntöön — mitattuna 1230 kierrosta ja 1 ms, eli ei este.
 *
 *    TIETOINEN SEURAUS: koko aukko romahtaa yhteen hetkeen. Hälytykset 03.00,
 *    03.30 ja 03.59 soivat kaikki 04.00, ja jos käyttäjällä on niistä kaksi,
 *    ne soivat sinä yhtenä yönä samanaikaisesti (jonon kautta peräkkäin, ei
 *    kumpikaan katoa). Ainoa vaihtoehto olisi säilyttää järjestys aukon
 *    sisällä (04.00, 04.30, 04.59) — mutta se on täsmälleen se JS:n
 *    normalisointikäytös joka tässä hylättiin, ja se veisi 03.59:n hälytyksen
 *    tuntia myöhemmäksi. Päällekkäinen hälytys kerran vuodessa on parempi
 *    kuin myöhästynyt. Älä siis "korjaa" tätä.
 */
function dateAt(dateKey: string, clockTime: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [h, min] = clockTime.split(":").map(Number);
  const year = y ?? 1970;
  const month0 = (m ?? 1) - 1;
  const day = d ?? 1;
  let hour = h ?? 0;
  let minute = min ?? 0;
  while (hour < 24) {
    const instants = instantsForWallClock(year, month0, day, hour, minute);
    if (instants.length > 0) return new Date(instants[0]!);
    minute += 1;
    if (minute === 60) {
      minute = 0;
      hour += 1;
    }
  }
  // Vuorokauden loppuun asti olematon kellonaika ei ole mahdollinen missään
  // oikeassa aikavyöhykkeessä; palataan JS:n omaan normalisointiin ettei
  // funktio voi missään oloissa palauttaa epäkelpoa Datea.
  return new Date(year, month0, day, h ?? 0, min ?? 0, 0, 0);
}

function clockToMinutes(clockTime: string): number {
  const [h, min] = clockTime.split(":").map(Number);
  return (h ?? 0) * 60 + (min ?? 0);
}

export interface AlarmPlan {
  /** Hetki jona hälytys oikeasti soi. */
  time: Date;
  /**
   * Kellonaika jonka käyttäjä odottaa näkevänsä — `fixed`-tilassa hänen
   * asettamansa aika, `relative`-tilassa kellotaulua taaksepäin laskettu aika
   * (ankkuri miinus minuutit) — muotoiltuna samoin kuin näytöllä. Null silloin
   * kun hälytys soi täsmälleen sillä kellonajalla, eli kaikkina muina päivinä
   * kuin kesäajan siirtopäivinä. Ei-null siis tarkoittaa aina "tässä on
   * poikkeus jonka näytön on kerrottava", ks. `describeOccurrence`.
   */
  plannedClock: string | null;
}

function planAt(time: Date, plannedMinutes: number): AlarmPlan {
  const planned = formatClockMinutes(((plannedMinutes % 1440) + 1440) % 1440);
  return { time, plannedClock: planned === formatClock(time) ? null : planned };
}

/**
 * Hälytyksen tavoiteajankohta annetulle kalenteripäivälle, paikallisessa
 * ajassa, yhdessä sen kanssa mitä käyttäjälle pitää kellonaikana näyttää.
 * Null jos hälytys ei ole aktiivinen sinä viikonpäivänä, tai (relative-
 * tilassa) jos relevanteilla oppilailla ei ole tunteja sinä päivänä — sekä
 * `schoolStart`- että `breakfast`-ankkuri seuraavat siis samaa "ei tunteja =
 * ei koulupäivä = ei hälytystä" -sääntöä, koska aamupalakin on koulupäivän
 * osa. `fixed`-tila on tästä tahallisesti riippumaton: se ei seuraa mitään,
 * joten pelkkä viikonpäivävalinta ratkaisee.
 *
 * `minutesBefore` vähennetään TODELLISENA kuluvana aikana, ei kellotaulua
 * pyörittäen. Ero näkyy vain kesäajan siirtopäivinä, mutta silloin rajusti:
 * kellotauluaritmetiikalla (`target.setMinutes(getMinutes() - n)`) "60 min
 * ennen koulun alkua" tarkoitti keväällä nollaa minuuttia ennen — kello 03.30
 * ei ole olemassa, joten se normalisoitui takaisin ankkurihetkeen 04.30 — ja
 * syksyllä 120 minuuttia ennen, koska kello 03.30 tuli sinä yönä kahdesti ja
 * aikaisempi esiintymä oli kaksi tuntia ennen ankkuria. Ankkuri (koulun alku,
 * aamupala) on oikea hetki; luvattu etuaika on oikea kesto; niiden erotus on
 * siis laskettava hetkinä.
 *
 * SEURAUS, JOKA NÄYTTÄÄ EPÄJOHDONMUKAISUUDELTA MUTTA EI OLE: syksyn
 * siirtopäivänä relative-hälytys voi soida toistuvan tunnin JÄLKIMMÄISELLÄ
 * esiintymällä, vaikka `dateAt` valitsee kellonajoille aina ensimmäisen.
 * Esimerkiksi ankkurilla 06.45 ja etuajalla 166–225 min tulos osuu
 * jälkimmäiseen 03.00–03.59:ään. Tämä on tahallista:
 *
 *  - `dateAt`n sääntö on KELLONAJAN TULKINTASÄÄNTÖ. Se on olemassa vain siksi
 *    että käyttäjän kirjoittama "03.30" osoittaa syksyn yönä kahteen eri
 *    hetkeen, ja jonkun on valittava kumpi. Se on syötteen tulkintaa.
 *  - Relative-tilassa ei ole kellonaikaa tulkittavana. Syöte on ankkuri
 *    (yksikäsitteinen hetki) ja kesto (yksikäsitteinen). Niiden erotus on
 *    yksikäsitteinen hetki. Sillä hetkellä sattuu olemaan jokin seinäkellon
 *    lukema, mutta se on TULOS eikä syöte, eikä tuloksen "tulkitseminen"
 *    jälkikäteen ensimmäiseksi esiintymäksi tarkoittaisi muuta kuin että
 *    hälytys soisi tunnin luvattua aikaisemmin.
 *
 * Samasta syystä `plannedClock` on näissä tapauksissa null: ei ole mitään
 * "normaalia" kellonaikaa josta poikettaisiin, koska käyttäjä ei ole asettanut
 * kellonaikaa. Näyttö ei siis vaikene mistään — kerrottavaa ei ole.
 * Ks. testi "syksy: relative-hälytys pitää luvatun etuajan myös toistuvan
 * tunnin jälkimmäisellä esiintymällä", joka lukitsee tämän.
 */
export function alarmPlanForDate(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  dateKey: string,
  breakfastTime: string,
): AlarmPlan | null {
  const weekday = weekdayOf(dateKey);
  const trigger = alarm.trigger;

  if (trigger.mode === "fixed") {
    if (!trigger.weekdays.includes(weekday)) return null;
    return planAt(dateAt(dateKey, trigger.time), clockToMinutes(trigger.time));
  }

  const rule = trigger.weekdays.find((r) => r.weekday === weekday);
  if (!rule) return null;

  const studentIds = relevantStudentIds(trigger.studentNumber, allStudents);
  let anchorTime: string | null;
  if (rule.anchor === "schoolStart") {
    anchorTime = earliestStart(studentIds, wilma, dateKey);
  } else {
    anchorTime = isSchoolDay(studentIds, wilma, dateKey) ? breakfastTime : null;
  }
  if (anchorTime === null) return null;

  const anchor = dateAt(dateKey, anchorTime);
  const target = new Date(anchor.getTime() - trigger.minutesBefore * MINUTE_MS);
  return planAt(target, clockToMinutes(anchorTime) - trigger.minutesBefore);
}

/** Pelkkä laukeamishetki — ks. `alarmPlanForDate`, jolta tämä saa sen. */
export function alarmTargetForDate(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  dateKey: string,
  breakfastTime: string,
): Date | null {
  return alarmPlanForDate(alarm, wilma, allStudents, dateKey, breakfastTime)?.time ?? null;
}

/**
 * Ikkuna, jonka sisällä laukeaminen sallitaan — enintään tämän verran
 * tavoiteajan jälkeen. Estää kahta väärää tapausta: sivun lataus keskellä
 * päivää ei saa laukaista aamun hälytyksiä (aika jo kauan sitten mennyt), eikä
 * kello saa jäädä odottamaan hetkeä joka jo ehti mennä ohi kellosyklin aikana.
 */
export const FIRE_WINDOW_MS = 60_000;

export interface DueAlarm {
  alarm: Alarm;
  time: Date;
}

/**
 * Kaikki juuri nyt laukeavat hälytykset: päällä, tunteja tänään relevanteille
 * oppilaille, ja tavoiteaika enintään FIRE_WINDOW_MS sitten. `alreadyRung` on
 * kutsujan vastuulla (localStorage useAlarms-composablessa) — funktio itse on
 * muuten puhdas.
 */
export function alarmsDueNow(
  alarms: Alarm[],
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  now: Date,
  breakfastTime: string,
  alreadyRung: (dateKey: string, alarmId: string) => boolean,
): DueAlarm[] {
  const todayKey = toDateKey(now);
  const due: DueAlarm[] = [];
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (alreadyRung(todayKey, alarm.id)) continue;
    const target = alarmTargetForDate(alarm, wilma, allStudents, todayKey, breakfastTime);
    if (target === null) continue;
    const diff = now.getTime() - target.getTime();
    if (diff >= 0 && diff < FIRE_WINDOW_MS) due.push({ alarm, time: target });
  }
  return due;
}

/**
 * Kuinka monta päivää eteenpäin seuraavaa soittoa etsitään.
 *
 * ÄLÄ NOSTA TÄTÄ saadaksesi hälytyksen näkymään pitkien lomien yli. Raja ei
 * ole se mikä siellä loppuu: lukujärjestykseen sidottu hälytys nojaa Wilman
 * tuntitietoihin, eikä Wilma tiedä tammikuun tunteja joulukuussa. Suuremmalla
 * luvulla haku vain kävisi läpi enemmän päiviä joista yhdelläkään ei ole
 * tunteja ja palauttaisi silti nullin — tai, jos jostain löytyisi yksittäinen
 * tunti, näyttäisi arvatun ajan varmana. Piilossa oleva banneri on rehellinen;
 * arvattu aika ei olisi.
 */
const MAX_LOOKAHEAD_DAYS = 10;

export interface AlarmOccurrence {
  dateKey: string;
  time: Date;
  /** True kun kyseessä on tämän kalenteripäivän hetki, false jos tuleva koulupäivä. */
  isToday: boolean;
  /** Ks. `AlarmPlan.plannedClock` — ei-null vain kesäajan siirtopäivänä. */
  plannedClock: string | null;
}

/**
 * Seuraava hetki jolloin hälytys oikeasti soi: tänään jos tavoiteaika ei ole
 * vielä mennyt, muuten seuraava päivä jona hälytys on aktiivinen (viikonpäivä
 * valittu, ja relative-tilassa relevanteilla oppilailla tunteja). Käytetään
 * hälytyspaneelissa esikatseluun ("soi tänään klo 7.55"), ei itse laukaisuun.
 */
export function nextAlarmOccurrence(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  now: Date,
  breakfastTime: string,
): AlarmOccurrence | null {
  const todayKey = toDateKey(now);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const dateKey = shiftDateKey(todayKey, offset);
    const plan = alarmPlanForDate(alarm, wilma, allStudents, dateKey, breakfastTime);
    if (plan === null) continue;
    if (offset === 0 && plan.time.getTime() <= now.getTime()) continue;
    return { dateKey, time: plan.time, isToday: offset === 0, plannedClock: plan.plannedClock };
  }
  return null;
}

export interface UpcomingAlarm {
  alarm: Alarm;
  occurrence: AlarmOccurrence;
}

/**
 * Aikaisin seuraava soitto KAIKKIEN hälytysten joukosta, tai null jos yksikään
 * ei soi lähipäivinä. Yläpalkin "seuraava hälytys" -banneri lukee tämän, jotta
 * hälytysaikoja ei laskettaisi kahdessa paikassa eri tavoin — sama peruste
 * jolla `nextAlarmOccurrence` on jo hälytyspaneelin esikatselun ainoa lähde.
 *
 * Kolme tapausta joissa hälytystä EI oteta mukaan, ja ne kaikki päätyvät
 * samaan lopputulokseen (null = ei banneria lainkaan):
 *  - käytöstä poistettu (`enabled === false`) — sama sääntö kuin
 *    `alarmsDueNow`illa, hälytys joka ei soi ei myöskään lupaa soittoa;
 *  - `nextAlarmOccurrence` palauttaa nullin — esim. lukujärjestykseen sidottu
 *    hälytys kun edessä ei ole yhtään koulupäivää (loma), tai kun viikonpäiviä
 *    ei ole valittu ollenkaan;
 *  - Wilma-data puuttuu (`wilma === null`): puhelin ei saa lukujärjestystä
 *    palvelimelta (ks. server/src/routes/api.ts), jolloin relative-hälytysten
 *    ankkuriaikaa ei voi laskea eikä banneri siis voi vahingossa paljastaa
 *    koulun alkamisaikaa kotiverkon laitteelle. Tämä seuraa suoraan
 *    `alarmTargetForDate`n olemassa olevasta logiikasta — sitä ei tarvitse
 *    erikseen estää täällä. Kiinteä kellonaika (`fixed`) ei ole koulutietoa ja
 *    näkyy myös puhelimessa.
 *
 * Tasatilanteessa (kaksi hälytystä samalle hetkelle) listan ensimmäinen
 * voittaa — vain toinen mahtuu palkkiin, ja kumpi tahansa kertoo saman ajan.
 */
export function nextUpcomingAlarm(
  alarms: Alarm[],
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  now: Date,
  breakfastTime: string,
): UpcomingAlarm | null {
  let best: UpcomingAlarm | null = null;
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    const occurrence = nextAlarmOccurrence(alarm, wilma, allStudents, now, breakfastTime);
    if (occurrence === null) continue;
    if (best === null || occurrence.time.getTime() < best.occurrence.time.getTime()) {
      best = { alarm, occurrence };
    }
  }
  return best;
}

const WEEKDAYS = [
  "sunnuntaina",
  "maanantaina",
  "tiistaina",
  "keskiviikkona",
  "torstaina",
  "perjantaina",
  "lauantaina",
];

function formatClockMinutes(minutesOfDay: number): string {
  return `${Math.floor(minutesOfDay / 60)}.${String(minutesOfDay % 60).padStart(2, "0")}`;
}

function formatClock(date: Date): string {
  return `${date.getHours()}.${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Kesäajan siirtopäivän lisäys kellonajan perään, muuten tyhjä.
 *
 * Kerran vuodessa hälytys soi eri kellonajalla kuin millä se muulloin soisi:
 * keväällä asetettua kellonaikaa ei ole olemassa (03.30 → soi 04.00), ja sekä
 * keväällä että syksyllä lukujärjestykseen sidotun hälytyksen etuaika osuu
 * siirtymän yli. Kumpaakaan ei saa näyttää hiljaa: pelkkä "4.00" olisi aika
 * jota käyttäjä ei ole asettanut, ja pelkkä "3.30" olisi aika jolloin mitään ei
 * tapahdu. Siksi molemmat luvut näkyvät, laukeamishetki otsikkona ja tavallinen
 * kellonaika perusteluineen sulkeissa. `plannedClock` on ei-null vain näissä
 * tapauksissa, joten tavallisena päivänä teksti ei muutu lainkaan.
 */
function dstSuffix(occurrence: AlarmOccurrence): string {
  if (occurrence.plannedClock === null) return "";
  return ` (kellonsiirto, normaalisti ${occurrence.plannedClock})`;
}

/** "tänään klo 7.55", "huomenna klo 7.55" tai "keskiviikkona klo 7.55". */
export function describeOccurrence(occurrence: AlarmOccurrence, now: Date): string {
  const time = `${formatClock(occurrence.time)}${dstSuffix(occurrence)}`;
  const todayKey = toDateKey(now);
  if (occurrence.dateKey === todayKey) return `tänään klo ${time}`;
  if (occurrence.dateKey === shiftDateKey(todayKey, 1)) return `huomenna klo ${time}`;
  const weekday = WEEKDAYS[occurrence.time.getDay()] ?? "";
  return `${weekday} klo ${time}`;
}

const WEEKDAYS_SHORT = ["su", "ma", "ti", "ke", "to", "pe", "la"];

/**
 * Kuinka kauas pelkkä viikonpäivän lyhenne riittää yksilöimään päivän.
 *
 * Tästä eteenpäin lyhenne alkaa toistua (offset 7 on sama viikonpäivä kuin
 * tänään), joten "ma" tarkoittaisi yhtä hyvin kolmen kuin kymmenen päivän
 * päässä olevaa soittoa. Juuri niin käy syys- ja talviloman aattona:
 * perjantaina ennen lomaviikkoa seuraava tunti on vasta 10 päivän päässä,
 * mutta banneri näyttäisi täsmälleen saman "ma 8.45" -tekstin kuin tavallisena
 * perjantaina jolloin soitto on kolmen päivän päässä. Sitä pidemmälle
 * menevään soittoon otetaan siis päiväys mukaan.
 */
const SHORT_WEEKDAY_HORIZON_DAYS = 6;

/** "19.10." — päiväys ilman vuotta, sama muoto kuin korteilla. */
function formatShortDate(date: Date): string {
  return `${date.getDate()}.${date.getMonth() + 1}.`;
}

/**
 * `describeOccurrence`n tiivis muoto: "7.55", "huomenna 7.55", "ke 7.55" tai
 * — yli viikon päässä — "ma 19.10. klo 8.45".
 *
 * Yläpalkissa on tilaa vain muutamalle sanalle, ja "tänään klo" on siellä
 * pelkkää täytettä: banneri näkyy vain kun soitto on tulossa, joten päiväys
 * kannattaa mainita vasta kun se EI ole tämä päivä. Lyhyt muoto on kuitenkin
 * oikea vain niin kauan kuin viikonpäivä on yksiselitteinen, ks.
 * SHORT_WEEKDAY_HORIZON_DAYS. Sama `formatClock`, sama päiväraja
 * (`shiftDateKey`) ja sama `occurrence.time.getDay()` kuin pitkässä muodossa,
 * jottei kaksi esitystapaa voi antaa eri kellonaikaa tai eri päivää.
 *
 * Kesäajan siirtopäivänä kellonajan tilalle tulee "3.30→4.00": samat kaksi
 * lukua kuin pitkässä muodossa (`dstSuffix`), mutta nuolena eikä sanoina —
 * palkkiin ei mahtuisi "(kellonsiirto, normaalisti 3.30)" ilman että banneri
 * kasvaisi kerran vuodessa yli koko yläpalkin leveyden. Nuoli lukee samaan
 * suuntaan kuin sanallinen muoto ("normaalisti näin, nyt näin"), joten
 * kumpikaan muoto ei kerro kellonaikaa jota toinen ei kertoisi; vain
 * sanallinen perustelu jää lyhyestä pois, ja se löytyy hälytyspaneelin
 * esikatselusta.
 */
export function describeOccurrenceShort(occurrence: AlarmOccurrence, now: Date): string {
  const actual = formatClock(occurrence.time);
  const time = occurrence.plannedClock === null ? actual : `${occurrence.plannedClock}→${actual}`;
  const todayKey = toDateKey(now);
  if (occurrence.dateKey === todayKey) return time;
  if (occurrence.dateKey === shiftDateKey(todayKey, 1)) return `huomenna ${time}`;
  const weekday = WEEKDAYS_SHORT[occurrence.time.getDay()] ?? "";
  for (let offset = 2; offset <= SHORT_WEEKDAY_HORIZON_DAYS; offset += 1) {
    if (occurrence.dateKey === shiftDateKey(todayKey, offset)) return `${weekday} ${time}`;
  }
  return `${weekday} ${formatShortDate(occurrence.time)} klo ${time}`;
}

// --- Vue-composable: reaktiivinen laukaisu, localStorage-kirjanpito ja ääni ---

/**
 * Pienin mahdollinen `localStorage`-yhteensopiva rajapinta. Composable ottaa
 * tämän valinnaisena parametrina (`UseAlarmsOptions.storage`) jotta testit
 * voivat antaa muistinvaraisen toteutuksen — Node ei tarjoa globaalia
 * `localStorage`ia, eikä laukaisulogiikan tärkeintä reunatapausta
 * (uudelleenlataus kesken kuittaamattoman hälytyksen) muuten voisi todentaa
 * automaattisesti. Tuotannossa oletusarvo on selaimen oma `localStorage`.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function defaultStorage(): StorageLike {
  return typeof localStorage !== "undefined" ? localStorage : memoryStorage();
}

const RUNG_STORAGE_KEY = "infonaytto.alarms.rung.v1";
const PENDING_STORAGE_KEY = "infonaytto.alarms.pending.v1";

interface RungStore {
  dateKey: string;
  ids: string[];
}

function loadRungStore(storage: StorageLike): RungStore {
  try {
    const raw = storage.getItem(RUNG_STORAGE_KEY);
    if (!raw) return { dateKey: "", ids: [] };
    const parsed = JSON.parse(raw) as Partial<RungStore>;
    if (typeof parsed.dateKey !== "string" || !Array.isArray(parsed.ids)) return { dateKey: "", ids: [] };
    return { dateKey: parsed.dateKey, ids: parsed.ids.filter((id): id is string => typeof id === "string") };
  } catch {
    return { dateKey: "", ids: [] };
  }
}

function saveRungStore(storage: StorageLike, store: RungStore): void {
  try {
    storage.setItem(RUNG_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Esim. tallennustila täynnä — hälytys soi silti tämän istunnon ajan, se riittää.
  }
}

/**
 * Muistaa mitkä hälytykset on KUITATTU tänään (ei "tullut näkyviin", vaan
 * käyttäjä on nähnyt/kuullut ne) — ks. perustelu `acknowledge()`:n kommentissa
 * alla. Säilyttää vain kuluvan päivän merkinnät — päivän vaihtuessa vanhat
 * pyyhkiytyvät automaattisesti pois sen sijaan että kertyisivät loputtomiin.
 */
class RungTracker {
  private store: RungStore;
  private readonly storage: StorageLike;

  // Ei TS:n parametrimuotoista kenttien lyhennettä (`constructor(private x)`):
  // Node suorittaa lähdekoodin natiivilla tyyppienpoistolla ilman
  // käännösvaihetta, eikä se osaa muuntaa sitä — vain tavallinen
  // konstruktoriparametri + kenttäsijoitus toimii ajonaikaisesti.
  constructor(storage: StorageLike) {
    this.storage = storage;
    this.store = loadRungStore(storage);
  }

  has(dateKey: string, alarmId: string): boolean {
    this.syncDate(dateKey);
    return this.store.ids.includes(alarmId);
  }

  mark(dateKey: string, alarmId: string): void {
    this.syncDate(dateKey);
    if (!this.store.ids.includes(alarmId)) {
      this.store.ids.push(alarmId);
      saveRungStore(this.storage, this.store);
    }
  }

  private syncDate(dateKey: string): void {
    if (this.store.dateKey !== dateKey) {
      this.store = { dateKey, ids: [] };
      saveRungStore(this.storage, this.store);
    }
  }
}

interface PendingAck {
  dateKey: string;
  alarmId: string;
  targetIso: string;
}

/**
 * Näkyvillä oleva, vielä kuittaamaton hälytys tallennetaan tähän heti kun se
 * tulee aktiiviseksi. Ilman tätä sivun uudelleenlataus kesken hälytyksen
 * (kioskiselain voi käynnistyä uudelleen milloin tahansa) hukkaisi
 * ilmoituksen jäljettömiin — kukaan ei näkisi eikä kuulisi mitään, vaikka
 * hälytys "soi" muistin mukaan. Vain yksi kerrallaan tallennetaan (ei koko
 * jonoa): jos useampi hälytys on samaan aikaan jonossa ja sivu latautuu
 * uudelleen ennen ensimmäisen kuittausta, jonossa olleet muut häviävät —
 * hyväksytty yksinkertaistus.
 */
function loadPendingAck(storage: StorageLike, dateKey: string): { alarmId: string; time: Date } | null {
  try {
    const raw = storage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAck>;
    if (parsed.dateKey !== dateKey || typeof parsed.alarmId !== "string" || typeof parsed.targetIso !== "string") {
      return null;
    }
    const time = new Date(parsed.targetIso);
    if (Number.isNaN(time.getTime())) return null;
    return { alarmId: parsed.alarmId, time };
  } catch {
    return null;
  }
}

function savePendingAck(storage: StorageLike, dateKey: string, alarmId: string, time: Date): void {
  try {
    const record: PendingAck = { dateKey, alarmId, targetIso: time.toISOString() };
    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ei kriittinen — sama peruste kuin saveRungStoressa.
  }
}

function clearPendingAck(storage: StorageLike): void {
  try {
    storage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    // Ei kriittinen.
  }
}

/**
 * Äänen soitto on eristetty tämän pienen rajapinnan taakse kahdesta syystä:
 * testit voivat antaa vakoilevan/muistinvaraisen toteutuksen — Node ei
 * tarjoa Web Audiota eikä <audio>-elementtiä, sama peruste kuin
 * `StorageLike`llä yllä — eikä composablen itsensä tarvitse tietää
 * SOITTOTAVASTA, vain että `play` palauttaa Promisen joka hylätään jos
 * toisto epäonnistuu, ja että `stop` vaientaa käynnissä olevan äänen HETI.
 */
export interface AlarmSoundPlayer {
  play(soundId: string, volume: number, repeatCount: number): Promise<void>;
  stop(): void;
  unlock(): void;
}

function defaultSoundPlayer(): AlarmSoundPlayer {
  return { play: playAlarmSound, stop: stopAlarmSound, unlock: unlockAudio };
}

export interface UseAlarmsOptions {
  wilma: Ref<WilmaData | null>;
  now: Ref<Date>;
  alarms: Ref<Alarm[]>;
  students: Ref<WilmaStudent[]>;
  /** Aamupalan alkuaika ("HH:MM"), ks. Settings.breakfastTime — käytetään breakfast-ankkurin hälytyksissä. */
  breakfastTime: Ref<string>;
  /** Vain testejä varten — tuotannossa jätetään pois, jolloin käytetään selaimen localStoragea. */
  storage?: StorageLike;
  /** Vain testejä varten — tuotannossa jätetään pois, jolloin käytetään oikeaa ääntä (ks. alarmSounds.ts). */
  soundPlayer?: AlarmSoundPlayer;
}

/**
 * Ajaa laukaisulogiikan aina kun kello (`now`) tai lukujärjestys päivittyy, ja
 * pitää yhden kerrallaan näytettävän "aktiivinen hälytys" -tilan sekä jonon
 * mahdollisille samaan hetkeen osuville useammille hälytyksille. Ääni
 * soitetaan heti kun hälytys tulee aktiiviseksi; jos toisto epäonnistuu
 * (selaimen äänilukko), `soundError` kertoo siitä käyttöliittymälle sen
 * sijaan että laukeaminen jäisi hiljaa huomaamatta.
 *
 * Turvallista kutsua ennen kuin oikeat hälytysasetukset ovat edes latautuneet
 * — `alarms` voi alkaa tyhjänä listana ja täyttyä myöhemmin, watch reagoi
 * siihen normaalisti. Tämä on tahallista: moottorin pitää olla käynnissä heti
 * eikä vasta kun palvelimelta on saatu ensimmäinen vastaus (ks. App.vuen
 * kommentti AlarmsPanelin mount-kohdassa).
 */
export function useAlarms(options: UseAlarmsOptions) {
  const { wilma, now, alarms, students, breakfastTime } = options;
  const storage = options.storage ?? defaultStorage();
  const soundPlayer = options.soundPlayer ?? defaultSoundPlayer();

  const tracker = new RungTracker(storage);
  const queue = ref<DueAlarm[]>([]);
  const active = ref<DueAlarm | null>(null);
  const soundError = ref<string | null>(null);

  function playFor(entry: DueAlarm): void {
    soundError.value = null;
    soundPlayer.play(entry.alarm.soundId, entry.alarm.volume, entry.alarm.repeatCount).catch((err: unknown) => {
      soundError.value = err instanceof Error ? err.message : "Ääntä ei voitu soittaa";
    });
  }

  function activateNext(): void {
    if (active.value !== null) return;
    const next = queue.value.shift();
    if (!next) return;
    active.value = next;
    savePendingAck(storage, toDateKey(now.value), next.alarm.id, next.time);
    playFor(next);
  }

  watch(
    [now, wilma, alarms, students, breakfastTime],
    ([currentNow, currentWilma, currentAlarms, currentStudents, currentBreakfastTime]) => {
      const todayKey = toDateKey(currentNow);

      // Uudelleenlatauksen palautus: jos edelliseltä kerralta jäi hälytys
      // kuittaamatta juuri ennen sivun sulkeutumista, näytetään se uudestaan
      // sen sijaan että se katoaisi huomaamatta. Odotetaan että hälytykset on
      // ladattu (epätyhjä lista), koska tyhjä lista voi tarkoittaa joko "ei
      // hälytyksiä" tai "asetuksia ei ole vielä haettu" — näitä ei voi erottaa
      // toisistaan, joten palautusyritys vain siirtyy myöhemmäksi eikä koskaan
      // tulkitse listan tyhjyyttä vahingossa poistoksi.
      if (active.value === null && queue.value.length === 0 && currentAlarms.length > 0) {
        const pending = loadPendingAck(storage, todayKey);
        if (pending) {
          const alarm = currentAlarms.find((a) => a.id === pending.alarmId);
          if (alarm) {
            active.value = { alarm, time: pending.time };
            playFor(active.value);
          }
        }
      }

      const due = alarmsDueNow(currentAlarms, currentWilma, currentStudents, currentNow, currentBreakfastTime, (dateKey, id) =>
        tracker.has(dateKey, id),
      );
      if (due.length === 0) return;
      const alreadyQueued = new Set([...queue.value, ...(active.value ? [active.value] : [])].map((e) => e.alarm.id));
      for (const entry of due) {
        if (!alreadyQueued.has(entry.alarm.id)) queue.value.push(entry);
      }
      activateNext();
    },
    { immediate: true },
  );

  /**
   * Kuittaa näkyvän hälytyksen ja näyttää seuraavan jonosta, jos sellainen on.
   *
   * Vasta tässä merkitään hälytys soineeksi (`tracker.mark`) — ei heti kun se
   * tulee jonoon. Jos merkintä tehtäisiin jo silloin, nopea kuittaus (ennen
   * kuin 60 s:n laukeamisikkuna on ehtinyt sulkeutua) johtaisi siihen että
   * seuraava kellosykli tulkitsisi saman hälytyksen taas laukeavaksi eikä enää
   * "jo soineeksi" — `alarmsDueNow` ei nimittäin tiedä että se juuri
   * kuitattiin, vain että kukaan ei ole merkinnyt sitä soineeksi. Yllä oleva
   * `alreadyQueued`-tarkistus riittää yksinään estämään tuplauksen SILLÄ
   * AIKAA kun hälytys on aktiivinen/jonossa; tämä merkintä on se mikä estää
   * sen ilmestymisen takaisin sen JÄLKEEN kun käyttäjä on jo nähnyt sen.
   *
   * `soundPlayer.stop()` on ensimmäinen rivi: kuittaus tarkoittaa "huomasin",
   * joten äänen on loputtava VÄLITTÖMÄSTI, oli se sisäänrakennettu tai pitkä
   * oma äänitiedosto joka olisi muuten jatkanut soimista minuutteja kuittauksen
   * jälkeen (ks. alarmSounds.ts:n playAlarmSound/registerSession). Jos jono
   * sisältää seuraavan hälytyksen, activateNext() käynnistää sen oman äänensä
   * heti perään — se pysäyttää tämän saman kutsun jo automaattisesti, mutta
   * emme voi luottaa siihen: jos jonossa ei ole mitään, mikään ei muuten
   * pysäyttäisi ääntä ollenkaan.
   */
  function acknowledge(): void {
    soundPlayer.stop();
    if (active.value) {
      tracker.mark(toDateKey(now.value), active.value.alarm.id);
    }
    clearPendingAck(storage);
    active.value = null;
    soundError.value = null;
    activateNext();
  }

  /**
   * Uudelleenyritys äänen toistolle. Kutsutaan esim. ilmoituksen omasta
   * napista — kosketus toimii samalla selaimen äänilukon avaavana eleenä,
   * joten tämä usein myös korjaa ongelman eikä vain yritä uudelleen turhaan.
   */
  function retrySound(): void {
    soundPlayer.unlock();
    if (active.value) playFor(active.value);
  }

  return { active, soundError, acknowledge, retrySound };
}

export type UseAlarms = ReturnType<typeof useAlarms>;
