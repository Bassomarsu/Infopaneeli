import { ref, watch, type Ref } from "vue";
import { playAlarmSound, unlockAudio } from "../components/alarmSounds.ts";
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

const STORAGE_KEY = "infonaytto.alarms.rung.v1";

interface RungStore {
  dateKey: string;
  ids: string[];
}

function loadRungStore(): RungStore {
  if (typeof localStorage === "undefined") return { dateKey: "", ids: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { dateKey: "", ids: [] };
    const parsed = JSON.parse(raw) as Partial<RungStore>;
    if (typeof parsed.dateKey !== "string" || !Array.isArray(parsed.ids)) return { dateKey: "", ids: [] };
    return { dateKey: parsed.dateKey, ids: parsed.ids.filter((id): id is string => typeof id === "string") };
  } catch {
    return { dateKey: "", ids: [] };
  }
}

function saveRungStore(store: RungStore): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Esim. tallennustila täynnä — hälytys soi silti tämän istunnon ajan, se riittää.
  }
}

/**
 * Muistaa mitkä hälytykset ovat jo soineet tänään, selaimen `localStorage`iin
 * (näyttökohtainen tila, ei jaettu palvelimen kanssa). Säilyttää vain kuluvan
 * päivän merkinnät — päivän vaihtuessa vanhat pyyhkiytyvät automaattisesti
 * pois sen sijaan että kertyisivät loputtomiin.
 */
class RungTracker {
  private store: RungStore;

  constructor() {
    this.store = loadRungStore();
  }

  has(dateKey: string, alarmId: string): boolean {
    this.syncDate(dateKey);
    return this.store.ids.includes(alarmId);
  }

  mark(dateKey: string, alarmId: string): void {
    this.syncDate(dateKey);
    if (!this.store.ids.includes(alarmId)) {
      this.store.ids.push(alarmId);
      saveRungStore(this.store);
    }
  }

  private syncDate(dateKey: string): void {
    if (this.store.dateKey !== dateKey) {
      this.store = { dateKey, ids: [] };
      saveRungStore(this.store);
    }
  }
}

export interface UseAlarmsOptions {
  wilma: Ref<WilmaData | null>;
  now: Ref<Date>;
  alarms: Ref<Alarm[]>;
  students: Ref<WilmaStudent[]>;
}

/**
 * Ajaa laukaisulogiikan aina kun kello (`now`) tai lukujärjestys päivittyy, ja
 * pitää yhden kerrallaan näytettävän "aktiivinen hälytys" -tilan sekä jonon
 * mahdollisille samaan hetkeen osuville useammille hälytyksille. Ääni
 * soitetaan heti kun hälytys tulee aktiiviseksi; jos toisto epäonnistuu
 * (selaimen äänilukko), `soundError` kertoo siitä käyttöliittymälle sen
 * sijaan että laukeaminen jäisi hiljaa huomaamatta.
 */
export function useAlarms(options: UseAlarmsOptions) {
  const { wilma, now, alarms, students } = options;

  const tracker = new RungTracker();
  const queue = ref<DueAlarm[]>([]);
  const active = ref<DueAlarm | null>(null);
  const soundError = ref<string | null>(null);

  function playFor(entry: DueAlarm): void {
    soundError.value = null;
    playAlarmSound(entry.alarm.soundId, entry.alarm.volume, entry.alarm.repeatCount).catch((err: unknown) => {
      soundError.value = err instanceof Error ? err.message : "Ääntä ei voitu soittaa";
    });
  }

  function activateNext(): void {
    if (active.value !== null) return;
    const next = queue.value.shift();
    if (!next) return;
    active.value = next;
    playFor(next);
  }

  watch(
    [now, wilma, alarms, students],
    ([currentNow, currentWilma, currentAlarms, currentStudents]) => {
      const due = alarmsDueNow(currentAlarms, currentWilma, currentStudents, currentNow, (dateKey, id) =>
        tracker.has(dateKey, id),
      );
      if (due.length === 0) return;
      const todayKey = toDateKey(currentNow);
      const alreadyQueued = new Set([...queue.value, ...(active.value ? [active.value] : [])].map((e) => e.alarm.id));
      for (const entry of due) {
        // Merkitään soineeksi heti, ennen kuin ilmoitus on kuitattu — muuten
        // seuraava kellosykli (20 s) lisäisi saman hälytyksen jonoon uudestaan
        // sen ollessa vielä odottamassa kuittausta.
        tracker.mark(todayKey, entry.alarm.id);
        if (!alreadyQueued.has(entry.alarm.id)) queue.value.push(entry);
      }
      activateNext();
    },
    { immediate: true },
  );

  /** Kuittaa näkyvän hälytyksen ja näyttää seuraavan jonosta, jos sellainen on. */
  function acknowledge(): void {
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
    unlockAudio();
    if (active.value) playFor(active.value);
  }

  return { active, soundError, acknowledge, retrySound };
}

export type UseAlarms = ReturnType<typeof useAlarms>;
