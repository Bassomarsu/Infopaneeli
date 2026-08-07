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

/** Null studentNumber = "mikä tahansa oppilas" — kaikki tunnetut lapset. */
function relevantStudentIds(alarm: Alarm, allStudents: WilmaStudent[]): string[] {
  if (alarm.studentNumber !== null) return [alarm.studentNumber];
  return allStudents.map((s) => s.studentNumber);
}

/**
 * Aikaisin tunti annetulle kalenteripäivälle hälytyksen kannalta relevanteille
 * oppilaille, tai null jos kellekään heistä ei ole tunteja sinä päivänä
 * (viikonloppu, loma) — silloin hälytys ei voi laueta lainkaan.
 */
function earliestStartForAlarm(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  dateKey: string,
): string | null {
  if (!wilma) return null;
  let earliest: string | null = null;
  for (const id of relevantStudentIds(alarm, allStudents)) {
    const lessons = wilma.byStudent[id]?.lessons ?? [];
    const start = earliestLessonStart(lessons, dateKey);
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
  }
  return earliest;
}

/**
 * Hälytyksen tavoiteajankohta annetulle kalenteripäivälle: päivän ensimmäisen
 * tunnin alku miinus `minutesBefore`, paikallisessa ajassa. Null jos päivänä
 * ei ole tunteja relevanteille oppilaille.
 */
export function alarmTargetForDate(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  dateKey: string,
): Date | null {
  const start = earliestStartForAlarm(alarm, wilma, allStudents, dateKey);
  if (start === null) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const [h, min] = start.split(":").map(Number);
  const target = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, h ?? 0, min ?? 0, 0, 0);
  target.setMinutes(target.getMinutes() - alarm.minutesBefore);
  return target;
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
  alreadyRung: (dateKey: string, alarmId: string) => boolean,
): DueAlarm[] {
  const todayKey = toDateKey(now);
  const due: DueAlarm[] = [];
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (alreadyRung(todayKey, alarm.id)) continue;
    const target = alarmTargetForDate(alarm, wilma, allStudents, todayKey);
    if (target === null) continue;
    const diff = now.getTime() - target.getTime();
    if (diff >= 0 && diff < FIRE_WINDOW_MS) due.push({ alarm, time: target });
  }
  return due;
}

const MAX_LOOKAHEAD_DAYS = 10;

export interface AlarmOccurrence {
  dateKey: string;
  time: Date;
  /** True kun kyseessä on tämän kalenteripäivän hetki, false jos tuleva koulupäivä. */
  isToday: boolean;
}

/**
 * Seuraava hetki jolloin hälytys oikeasti soi: tänään jos tavoiteaika ei ole
 * vielä mennyt, muuten seuraava koulupäivä jolla relevanteilla oppilailla on
 * tunteja. Käytetään hälytyspaneelissa esikatseluun ("soi tänään klo 7.55"),
 * ei itse laukaisuun.
 */
export function nextAlarmOccurrence(
  alarm: Alarm,
  wilma: WilmaData | null,
  allStudents: WilmaStudent[],
  now: Date,
): AlarmOccurrence | null {
  const todayKey = toDateKey(now);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const dateKey = shiftDateKey(todayKey, offset);
    const target = alarmTargetForDate(alarm, wilma, allStudents, dateKey);
    if (target === null) continue;
    if (offset === 0 && target.getTime() <= now.getTime()) continue;
    return { dateKey, time: target, isToday: offset === 0 };
  }
  return null;
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

function formatClock(date: Date): string {
  return `${date.getHours()}.${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "tänään klo 7.55", "huomenna klo 7.55" tai "keskiviikkona klo 7.55". */
export function describeOccurrence(occurrence: AlarmOccurrence, now: Date): string {
  const time = formatClock(occurrence.time);
  const todayKey = toDateKey(now);
  if (occurrence.dateKey === todayKey) return `tänään klo ${time}`;
  if (occurrence.dateKey === shiftDateKey(todayKey, 1)) return `huomenna klo ${time}`;
  const weekday = WEEKDAYS[occurrence.time.getDay()] ?? "";
  return `${weekday} klo ${time}`;
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
  const { wilma, now, alarms, students } = options;
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
    [now, wilma, alarms, students],
    ([currentNow, currentWilma, currentAlarms, currentStudents]) => {
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

      const due = alarmsDueNow(currentAlarms, currentWilma, currentStudents, currentNow, (dateKey, id) =>
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
