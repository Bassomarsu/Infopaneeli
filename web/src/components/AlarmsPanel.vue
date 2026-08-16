<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ALARM_SOUNDS,
  DEFAULT_SOUND_ID,
  fetchCustomSounds,
  playAlarmSound,
  stopAlarmSound,
  unlockAudio,
  type CustomSound,
} from "./alarmSounds.ts";
import { describeOccurrence, nextAlarmOccurrence, useAlarms } from "../composables/useAlarms.ts";
import { useEditAccess } from "../composables/useEditAccess.ts";
import type { Alarm, AlarmAnchor, AlarmWeekdayRule, Settings, WilmaData, WilmaStudent } from "../types.ts";

const props = defineProps<{
  /**
   * Null ennen kuin ensimmäinen /api/dashboard on onnistunut. Hälytysmoottori
   * (useAlarms alla) on silti käynnissä koko ajan, oletusarvoisesti tyhjällä
   * hälytyslistalla — se vain täyttyy heti kun asetukset saapuvat. Ks. App.vuen
   * kommentti AlarmsPanelin mount-kohdassa.
   */
  settings: Settings | null;
  students: WilmaStudent[];
  wilmaData: WilmaData | null;
  /**
   * Vain näyttölaite ja luotetut laitteet saavat Wilma-datan palvelimelta
   * (ks. server/src/routes/api.ts, SENSITIVE_PROVIDERS) — PIN:llä muokkausta
   * käyttävä puhelin ei koskaan. `wilmaData` on siis aina null tällaisella
   * laitteella, mutta se johtuu eri syystä kuin "lukujärjestystä ei ole vielä
   * haettu": tämä lippu erottaa ne, jotta esikatselu ei väitä lukujärjestystä
   * tyhjäksi kun se vain on piilotettu tältä laitteelta.
   */
  canPreviewSchedule: boolean;
  /** Hallintamodaalin (lista/muokkaus) auki-tila — hälytyksen soiminen ei riipu tästä. */
  open: boolean;
  now: Date;
}>();

const editAccess = useEditAccess();

const emit = defineEmits<{ close: []; saved: [Settings] }>();

// Pidettävä samana kuin server/src/core/settings.ts:n vastaavat rajat.
const MAX_ALARMS = 20;
const MINUTES_MIN = 1;
const MINUTES_MAX = 240;
const REPEAT_MIN = 1;
const REPEAT_MAX = 8;
const LABEL_MAX_LENGTH = 60;

// Viikonpäivät Date.getDayn numeroinnilla (0 = sunnuntai), mutta
// esitysjärjestys alkaa maanantaista — sama järjestys jossa suomalainen
// katsoo viikkoa, vaikka data on indeksoitu sunnuntaista.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_ABBR: Record<number, string> = { 0: "Su", 1: "Ma", 2: "Ti", 3: "Ke", 4: "To", 5: "Pe", 6: "La" };
const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5];

const alarms = computed(() => props.settings?.alarms ?? []);
// Yksi globaali asetus (ks. server/src/core/settings.ts:n kommentti) —
// oletusarvo tässä kattaa vain sen hetken ennen kuin ensimmäinen asetusvastaus
// on ehtinyt saapua, sama tila jossa breakfastTime puuttuu vielä settingsistä.
const breakfastTime = computed(() => props.settings?.breakfastTime ?? "08:00");

// useAlarms tarvitsee Refit, mutta computed() kelpaa (ks. samaa mallia
// App.vuessa: useScheduleDay saa suoraan computed-arvoja Ref-parametreina).
const nowRef = computed(() => props.now);
const wilmaRef = computed(() => props.wilmaData);
const alarmsRef = computed(() => alarms.value);
const studentsRef = computed(() => props.students);

const { active, soundError, acknowledge, retrySound } = useAlarms({
  wilma: wilmaRef,
  now: nowRef,
  alarms: alarmsRef,
  students: studentsRef,
  breakfastTime,
});

function clockLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Kummankin trigger-tilan viikonpäivät pelkkinä numeroina, esityskäyttöön. */
function weekdaysOf(alarm: Alarm): number[] {
  return alarm.trigger.mode === "fixed" ? alarm.trigger.weekdays : alarm.trigger.weekdays.map((r) => r.weekday);
}

/** "ma–pe", "joka päivä", "ei päiviä valittu" tai pilkuin eroteltu lyhennelista, aina Ma..Su-järjestyksessä. */
function formatWeekdays(weekdays: number[]): string {
  if (weekdays.length === 0) return "ei päiviä valittu";
  if (weekdays.length === 7) return "joka päivä";
  const set = new Set(weekdays);
  if (WEEKDAYS_MON_FRI.length === set.size && WEEKDAYS_MON_FRI.every((d) => set.has(d))) return "ma–pe";
  return WEEKDAY_ORDER.filter((d) => set.has(d))
    .map((d) => WEEKDAY_ABBR[d])
    .join(", ");
}

/**
 * Hälytys voi jäädä osoittamaan oppilasta joka on sittemmin kadonnut
 * Wilmasta (poistunut, tunnus vaihtunut). Silloin alarmTargetForDate
 * palauttaa aina null ja paneeli näyttäisi tekstin "Ei tunteja lähipäivinä"
 * — täsmälleen samalta kuin aito loma. Tämä erotetaan omaksi tarkistukseksi
 * ettei rikkinäinen viittaus jää huomaamatta lomana. Fixed-tila ei koskaan
 * osoita oppilaaseen (ks. AlarmTrigger-tyyppi), joten se ei voi olla tässä.
 */
function isOrphanedStudent(alarm: Alarm): boolean {
  // Ilman lukujärjestystietoa (ks. canPreviewSchedule) ei voida päätellä
  // löytyykö oppilas Wilmasta vai ei — tyhjä props.students tällä laitteella
  // tarkoittaa "piilotettu", ei "oppilasta ei ole".
  if (!props.canPreviewSchedule) return false;
  if (alarm.trigger.mode !== "relative" || alarm.trigger.studentNumber === null) return false;
  return !props.students.some((s) => s.studentNumber === (alarm.trigger as { studentNumber: string }).studentNumber);
}

function occurrenceText(alarm: Alarm): string {
  if (weekdaysOf(alarm).length === 0) return "Ei valittuja viikonpäiviä — hälytys ei koskaan laukea";
  if (isOrphanedStudent(alarm)) return "Oppilasta ei löydy Wilmasta — tarkista hälytyksen kohde";
  if (!props.canPreviewSchedule) return "Esikatselu näkyy vain näyttölaitteella";
  if (!props.wilmaData) return "Lukujärjestystä ei tunneta";
  const occurrence = nextAlarmOccurrence(alarm, props.wilmaData, props.students, props.now, breakfastTime.value);
  if (!occurrence) return "Ei tunteja lähipäivinä";
  return `soi ${describeOccurrence(occurrence, props.now)}`;
}

/** Ankkurin yhteinen kuvaus valituille päiville, tai null jos päiviä ei ole tai ankkuri vaihtelee. */
function uniformAnchorOf(weekdays: AlarmWeekdayRule[]): AlarmAnchor | null {
  if (weekdays.length === 0) return null;
  const first = weekdays[0]!.anchor;
  return weekdays.every((r) => r.anchor === first) ? first : null;
}

function anchorLabel(anchor: AlarmAnchor): string {
  return anchor === "breakfast" ? "aamupalaa" : "koulun alkua";
}

/** Rivin/esikatselun yhteenveto: "30 min ennen koulun alkua · ma–pe" tai "klo 07:30 · ma–pe". */
function triggerSummaryText(alarm: Alarm): string {
  const days = formatWeekdays(weekdaysOf(alarm));
  if (alarm.trigger.mode === "fixed") return `klo ${alarm.trigger.time} · ${days}`;
  const uniform = uniformAnchorOf(alarm.trigger.weekdays);
  const anchorText = uniform !== null ? anchorLabel(uniform) : "eri ankkuria eri päivinä";
  return `${alarm.trigger.minutesBefore} min ennen ${anchorText} · ${days}`;
}

// Mikä tahansa kosketus näytöllä avaa selaimen äänilukon mahdollisimman
// aikaisin — aamuyöllä kukaan ei ole vielä koskenut ruutuun, joten tähän ei
// voi luottaa juuri hälytyshetkellä. "Kuuntele"-painike (alla) hoitaa saman
// asian toisen kerran varmuuden vuoksi.
function unlockOnFirstTouch(): void {
  unlockAudio();
  document.removeEventListener("pointerdown", unlockOnFirstTouch);
}
onMounted(() => document.addEventListener("pointerdown", unlockOnFirstTouch, { once: true }));
onUnmounted(() => document.removeEventListener("pointerdown", unlockOnFirstTouch));

// --- Hallintamodaali: lista, muokkaus, poisto ---

const editingDraft = ref<Alarm | null>(null);
const isNewAlarm = ref(false);
const formError = ref<string | null>(null);
const formSaving = ref(false);
const previewError = ref<string | null>(null);
const listError = ref<string | null>(null);

// --- Perheen omat äänitiedostot (ks. server/src/core/alarm-sounds.ts) ---

const customSounds = ref<CustomSound[]>([]);
const soundListError = ref<string | null>(null);

/**
 * Haetaan vain kun paneeli avataan (ks. watch(open) alla), ei hälytyskellon
 * jokaisella 20 sekunnin syklillä — palvelinkin välimuistittaa listauksen,
 * mutta turha verkkokutsu on syytä välttää tästäkin päästä.
 */
async function loadCustomSounds(): Promise<void> {
  try {
    customSounds.value = await fetchCustomSounds();
    soundListError.value = null;
  } catch (err) {
    // Ei estä paneelin käyttöä — sisäänrakennetut äänet toimivat silti, ja jo
    // valitut omat äänet toistuvat edelleen soittohetkellä (palvelin
    // ratkaisee ne uudestaan silloin). Kerrotaan silti ettei listaus onnistunut.
    customSounds.value = [];
    soundListError.value = err instanceof Error ? err.message : "Omien äänitiedostojen listaus epäonnistui";
  }
}

/**
 * True jos hälytyksen ääni ei löydy kummastakaan listasta — sisäänrakennettu
 * ääni ei koskaan katoa, joten tämä tarkoittaa aina omaa äänitiedostoa joka
 * on poistettu tai nimetty uudelleen. Ei vaienna hälytystä (ks.
 * alarmSounds.ts:n playAlarmSound), mutta näytetään silti selvänä
 * varoituksena — sama periaate kuin isOrphanedStudentissa.
 */
function isUnknownSound(soundId: string): boolean {
  return !ALARM_SOUNDS.some((s) => s.id === soundId) && !customSounds.value.some((s) => s.id === soundId);
}

function generateAlarmId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Uuden hälytyksen oletus: yleisin tapaus eli ma–pe, koulun alusta. */
function blankAlarm(): Alarm {
  return {
    id: generateAlarmId(),
    label: "",
    trigger: {
      mode: "relative",
      minutesBefore: 30,
      studentNumber: null,
      weekdays: WEEKDAYS_MON_FRI.map((weekday) => ({ weekday, anchor: "schoolStart" })),
    },
    enabled: true,
    soundId: DEFAULT_SOUND_ID,
    volume: 0.8,
    repeatCount: 3,
  };
}

function startNew(): void {
  if (alarms.value.length >= MAX_ALARMS) {
    listError.value = `Enintään ${MAX_ALARMS} hälytystä`;
    return;
  }
  stopPreviewIfPlaying(); // edellisen hälytyksen esikuuntelu ei saa jäädä soimaan taustalle
  editingDraft.value = blankAlarm();
  isNewAlarm.value = true;
  formError.value = null;
  previewError.value = null;
  showAdvancedAnchor.value = false;
}

/**
 * Syvempi kuin `{ ...alarm }`: trigger (ja relative-tilan weekdays-lista) on
 * sisäkkäinen olio/taulukko, joten pelkkä pintakopio jakaisi saman viitteen
 * tallennetun hälytyksen kanssa. Ilman tätä viikonpäivän napauttaminen
 * lomakkeessa muuttaisi listassa näkyvää hälytystä JO ENNEN tallennusta —
 * ja "Peruuta" ei palauttaisi mitään, koska muutos olisi jo tehty samaan
 * olioon.
 */
function cloneAlarm(alarm: Alarm): Alarm {
  return {
    ...alarm,
    trigger:
      alarm.trigger.mode === "fixed"
        ? { ...alarm.trigger, weekdays: [...alarm.trigger.weekdays] }
        : { ...alarm.trigger, weekdays: alarm.trigger.weekdays.map((rule) => ({ ...rule })) },
  };
}

function startEdit(alarm: Alarm): void {
  stopPreviewIfPlaying(); // sama peruste kuin startNew: rivin vaihto ei saa jättää vanhaa esikuuntelua soimaan
  editingDraft.value = cloneAlarm(alarm);
  isNewAlarm.value = false;
  formError.value = null;
  previewError.value = null;
  showAdvancedAnchor.value = false;
}

function cancelEdit(): void {
  stopPreviewIfPlaying();
  editingDraft.value = null;
  formError.value = null;
  previewError.value = null;
}

const draftStudentValue = computed<string>({
  get: () => (editingDraft.value?.trigger.mode === "relative" ? (editingDraft.value.trigger.studentNumber ?? "") : ""),
  set: (value: string) => {
    if (editingDraft.value?.trigger.mode === "relative") {
      editingDraft.value.trigger.studentNumber = value === "" ? null : value;
    }
  },
});

const formPreviewText = computed(() => (editingDraft.value ? occurrenceText(editingDraft.value) : ""));
const editingIsOrphaned = computed(() => (editingDraft.value ? isOrphanedStudent(editingDraft.value) : false));
const editingHasNoWeekdays = computed(() => (editingDraft.value ? weekdaysOf(editingDraft.value).length === 0 : false));
/** Vain näyttötekstiä varten (ks. editingIsOrphaned) — vältetään tyyppimuunnos templatessa. */
const editingOrphanedStudentNumber = computed(() =>
  editingDraft.value?.trigger.mode === "relative" ? editingDraft.value.trigger.studentNumber : null,
);

// Oppilaskenttä näytetään aina kun nykyinen arvo ei ole null — myös
// yhden (tunnetun) lapsen perheessä, jos hälytys silti osoittaa johonkin
// tunnisteeseen (esim. kadonneeseen). Ilman tätä käyttäjä ei pääsisi edes
// näkemään saati korjaamaan roikkuvaa viittausta, koska rivi "Kuka tahansa"
// -oletuksen taakse piiloutuisi kokonaan.
//
// canPreviewSchedule false: props.students on aina tyhjä (ks. yllä), joten
// valinta näyttäisi tyhjän pudotusvalikon "Kuka tahansa" -vaihtoehdon
// kanssa — käyttäjä voisi vahingossa nollata olemassa olevan kohdistuksen
// tietämättä mitä on menettämässä. Kenttä piilotetaan kokonaan tällä
// laitteella, jolloin editingDraft.trigger.studentNumber säilyy
// koskemattomana. Fixed-tilassa kenttä piilotetaan aina — se ei seuraa
// mitään oppilasta (ks. AlarmTrigger-tyyppi).
const showStudentField = computed(() => {
  const trigger = editingDraft.value?.trigger;
  if (!trigger || trigger.mode !== "relative") return false;
  return props.canPreviewSchedule && (props.students.length > 1 || trigger.studentNumber !== null);
});

// --- Tyyppi (relative/fixed), viikonpäivät ja ankkuri muokkauslomakkeessa ---

/**
 * Vaihtaa laukaisutyypin. Uudelle triggerille lasketaan järkevä oletus
 * edellisestä (viikonpäivät säilyvät, minuutit/kellonaika alkavat uudesta
 * oletuksesta) sen sijaan että lomake tyhjenisi kokonaan — käyttäjä on jo
 * ehkä säätänyt viikonpäivät kohdalleen ennen tyypin vaihtoa.
 */
function setMode(mode: "relative" | "fixed"): void {
  const draft = editingDraft.value;
  if (!draft || draft.trigger.mode === mode) return;
  const days = weekdaysOf(draft);
  draft.trigger =
    mode === "fixed"
      ? { mode: "fixed", time: "07:30", weekdays: days }
      : { mode: "relative", minutesBefore: 30, studentNumber: null, weekdays: days.map((weekday) => ({ weekday, anchor: "schoolStart" })) };
}

function isWeekdaySelected(weekday: number): boolean {
  return editingDraft.value ? weekdaysOf(editingDraft.value).includes(weekday) : false;
}

/** Ankkuri jota uusi viikonpäivä saa kun se lisätään relative-tilassa: sama kuin muilla valituilla, tai koulun alku. */
function anchorForNewDay(weekdays: AlarmWeekdayRule[]): AlarmAnchor {
  return uniformAnchorOf(weekdays) ?? "schoolStart";
}

function toggleWeekday(weekday: number): void {
  const trigger = editingDraft.value?.trigger;
  if (!trigger) return;
  if (trigger.mode === "fixed") {
    const idx = trigger.weekdays.indexOf(weekday);
    if (idx >= 0) trigger.weekdays.splice(idx, 1);
    else trigger.weekdays.push(weekday);
    return;
  }
  const idx = trigger.weekdays.findIndex((r) => r.weekday === weekday);
  if (idx >= 0) trigger.weekdays.splice(idx, 1);
  else trigger.weekdays.push({ weekday, anchor: anchorForNewDay(trigger.weekdays) });
}

/** "Ma–Pe"-pikavalinta: korvaa koko viikonpäivävalinnan, säilyttäen nykyisen (yhteisen) ankkurin relative-tilassa. */
function applyWeekdayPreset(days: number[]): void {
  const trigger = editingDraft.value?.trigger;
  if (!trigger) return;
  if (trigger.mode === "fixed") {
    trigger.weekdays = [...days];
    return;
  }
  const anchor = anchorForNewDay(trigger.weekdays);
  trigger.weekdays = days.map((weekday) => ({ weekday, anchor }));
}

/** Ankkuri kaikille tällä hetkellä valituille päiville yhtä aikaa — nopea polku yleisimpään tapaukseen. */
const editingUniformAnchor = computed<AlarmAnchor | null>(() => {
  const trigger = editingDraft.value?.trigger;
  if (!trigger || trigger.mode !== "relative") return null;
  return uniformAnchorOf(trigger.weekdays);
});

function setUniformAnchor(anchor: AlarmAnchor): void {
  const trigger = editingDraft.value?.trigger;
  if (!trigger || trigger.mode !== "relative") return;
  trigger.weekdays = trigger.weekdays.map((r) => ({ ...r, anchor }));
}

// Päiväkohtainen ankkuri on oletuksena piilossa — yleisin tapaus on sama
// ankkuri kaikille päiville (yllä oleva pikavalinta), eikä paneelin pidä
// paisua ruudukoksi jota ei useimmiten tarvita.
const showAdvancedAnchor = ref(false);

function setDayAnchor(weekday: number, anchor: AlarmAnchor): void {
  const trigger = editingDraft.value?.trigger;
  if (!trigger || trigger.mode !== "relative") return;
  const rule = trigger.weekdays.find((r) => r.weekday === weekday);
  if (rule) rule.anchor = anchor;
}

// Esikuuntelun soiminen tallennetaan omaan reaktiiviseen tilaan (eikä
// esim. pääteltynä playAlarmSoundin Promisesta) jotta "Kuuntele"-painike
// tietää milloin sen pitää näyttäytyä "Pysäytä"-painikkeena — ks. template.
const previewPlaying = ref(false);

/**
 * Pysäyttää esikuuntelun JOS se on juuri nyt käynnissä. Ei koske hälytyksen
 * omaan ääneen (ring), vaikka molemmat käyttävät samaa
 * stopAlarmSound()-mekanismia globaalisti "vain yksi ääni kerrallaan"
 * -säännön takia — tämä funktio tarkistaa ensin previewPlaying-lipun, joten
 * se ei koskaan sammuta ääntä joka kuuluu johonkin muuhun (esim. samaan
 * aikaan sattuvaan oikeaan hälytykseen, joka on jo ehtinyt ottaa äänen
 * haltuunsa esikuuntelulta yhden-äänen-kerrallaan -säännön mukaisesti).
 * Kutsutaan aina kun esikuuntelun konteksti katoaa: muokkaus perutaan tai
 * tallennetaan, toiseen hälytykseen vaihdetaan, paneeli suljetaan, tai koko
 * komponentti puretaan (ks. cancelEdit, saveEdit, startNew, startEdit,
 * onUnmounted alla).
 */
function stopPreviewIfPlaying(): void {
  if (previewPlaying.value) {
    stopAlarmSound();
    previewPlaying.value = false;
  }
}

async function previewSound(): Promise<void> {
  if (previewPlaying.value) {
    stopPreviewIfPlaying();
    return;
  }
  if (!editingDraft.value) return;
  previewError.value = null;
  previewPlaying.value = true;
  try {
    // Esikuuntelu soittaa aina yhden kierroksen riippumatta toistoasetuksesta
    // — äänen luonnetta testataan, ei koko hälytyksen kestoa. Pitkälläkin
    // äänitiedostolla toisto on silti pysäytettävissä kesken kaiken tästä
    // samasta painikkeesta (ks. template: "Kuuntele" -> "Pysäytä").
    await playAlarmSound(editingDraft.value.soundId, editingDraft.value.volume, 1);
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : "Ääntä ei voitu soittaa";
  } finally {
    previewPlaying.value = false;
  }
}

function validateDraft(draft: Alarm): string | null {
  if (draft.label.trim().length === 0) return "Selite ei voi olla tyhjä";
  if (draft.label.length > LABEL_MAX_LENGTH) return `Selite on liian pitkä (max ${LABEL_MAX_LENGTH} merkkiä)`;
  if (draft.trigger.mode === "relative") {
    const minutesBefore = draft.trigger.minutesBefore;
    if (!Number.isInteger(minutesBefore) || minutesBefore < MINUTES_MIN || minutesBefore > MINUTES_MAX) {
      return `Minuuttien on oltava kokonaisluku väliltä ${MINUTES_MIN}–${MINUTES_MAX}`;
    }
  } else {
    // <input type="time"> pitää muodon HH:MM:ssä jo selaimen puolesta; tyhjä arvo on ainoa oikeasti mahdollinen virhe tästä kentästä.
    if (draft.trigger.time.trim().length === 0) return "Kellonaika puuttuu";
  }
  if (!Number.isInteger(draft.repeatCount) || draft.repeatCount < REPEAT_MIN || draft.repeatCount > REPEAT_MAX) {
    return `Toistojen on oltava kokonaisluku väliltä ${REPEAT_MIN}–${REPEAT_MAX}`;
  }
  if (typeof draft.volume !== "number" || draft.volume < 0 || draft.volume > 1) {
    return "Äänenvoimakkuuden on oltava väliltä 0–1";
  }
  return null;
}

async function persistAlarms(next: Alarm[]): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await editAccess.editFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alarms: next }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Tallennus epäonnistui (HTTP ${response.status})`);
    }
    emit("saved", (await response.json()) as Settings);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Tallennus epäonnistui" };
  }
}

async function saveEdit(): Promise<void> {
  const draft = editingDraft.value;
  if (!draft) return;
  const validation = validateDraft(draft);
  if (validation) {
    formError.value = validation;
    return;
  }
  const trimmed: Alarm = { ...draft, label: draft.label.trim() };
  if (isNewAlarm.value && alarms.value.length >= MAX_ALARMS) {
    formError.value = `Enintään ${MAX_ALARMS} hälytystä`;
    return;
  }
  const next = isNewAlarm.value
    ? [...alarms.value, trimmed]
    : alarms.value.map((a) => (a.id === trimmed.id ? trimmed : a));

  formSaving.value = true;
  formError.value = null;
  const result = await persistAlarms(next);
  formSaving.value = false;
  if (result.ok) {
    stopPreviewIfPlaying(); // tallennus sulkee muokkauslomakkeen, ei saa jäädä soimaan taustalle
    editingDraft.value = null;
  } else {
    formError.value = result.error;
  }
}

async function toggleEnabled(alarm: Alarm): Promise<void> {
  listError.value = null;
  const next = alarms.value.map((a) => (a.id === alarm.id ? { ...a, enabled: !a.enabled } : a));
  const result = await persistAlarms(next);
  if (!result.ok) listError.value = result.error;
}

// Poisto kysyy vahvistuksen rivillä, samaan tapaan kuin muistilistassa
// (NotesCard.vue) — hälytyksen poisto vahingossa huomataan vasta kun se jää
// soimatta, joten sen ei pidä onnistua yhdellä napautuksella.
const PENDING_DELETE_TIMEOUT_MS = 8_000;
const pendingDeleteId = ref<string | null>(null);
let pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingDeleteTimer(): void {
  if (pendingDeleteTimer !== null) {
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = null;
  }
}

function askDelete(alarm: Alarm): void {
  listError.value = null;
  pendingDeleteId.value = alarm.id;
  clearPendingDeleteTimer();
  pendingDeleteTimer = setTimeout(() => {
    pendingDeleteId.value = null;
    pendingDeleteTimer = null;
  }, PENDING_DELETE_TIMEOUT_MS);
}

function cancelPendingDelete(): void {
  pendingDeleteId.value = null;
  clearPendingDeleteTimer();
}

async function confirmDelete(alarm: Alarm): Promise<void> {
  listError.value = null;
  cancelPendingDelete();
  const next = alarms.value.filter((a) => a.id !== alarm.id);
  const result = await persistAlarms(next);
  if (!result.ok) listError.value = result.error;
}

onUnmounted(clearPendingDeleteTimer);
// Varmuuden vuoksi: jos komponentti puretaan ilman että closePanel/cancelEdit
// ehtii ajaa (esim. vanhempi poistaisi tämän suoraan DOM:ista), esikuuntelu
// ei silti saa jäädä soimaan taustalle näkymän vaihtuessa.
onUnmounted(stopPreviewIfPlaying);

function closePanel(): void {
  cancelEdit();
  cancelPendingDelete();
  listError.value = null;
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closePanel();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener("keydown", onKeydown);
      void loadCustomSounds();
    } else {
      window.removeEventListener("keydown", onKeydown);
      cancelEdit();
      cancelPendingDelete();
      listError.value = null;
    }
  },
);
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!-- Teleportattu <body>:n alle, jotta App.vuen yötila (filter #app.night)
       ei koskaan himmennä hälytysilmoitusta — aamu on juuri se hetki jolloin
       ilmoituksen pitää näkyä kirkkaana. -->
  <Teleport to="body">
    <div v-if="active" class="ring" role="alertdialog" aria-live="assertive">
      <div class="ring__box">
        <span class="ring__eyebrow">Hälytys</span>
        <h2 class="ring__label">{{ active.alarm.label }}</h2>
        <span class="ring__time tnum">{{ clockLabel(active.time) }}</span>
        <p v-if="soundError" class="ring__sound-error">
          {{ soundError }}
          <button type="button" class="ring__retry" @click="retrySound">Toista ääni</button>
        </p>
        <button type="button" class="ring__ack" @click="acknowledge">Kuittaa</button>
      </div>
    </div>
  </Teleport>

  <div v-if="open" class="overlay" @click.self="closePanel">
    <section class="panel">
      <header class="panel__head">
        <h2>Hälytykset</h2>
        <button class="panel__close" type="button" @click="closePanel">Sulje</button>
      </header>

      <div class="panel__body">
        <p v-if="listError" class="panel__error">{{ listError }}</p>

        <ul v-if="alarms.length > 0" class="alarms">
          <li v-for="alarm in alarms" :key="alarm.id" class="alarm" :class="{ 'alarm--disabled': !alarm.enabled }">
            <label class="alarm__toggle">
              <input type="checkbox" :checked="alarm.enabled" @change="toggleEnabled(alarm)" />
              <span class="sr-only">Päällä</span>
            </label>

            <button type="button" class="alarm__info" @click="startEdit(alarm)">
              <span class="alarm__label">{{ alarm.label }}</span>
              <span
                class="alarm__meta"
                :class="{
                  'alarm__meta--warn':
                    isOrphanedStudent(alarm) || isUnknownSound(alarm.soundId) || weekdaysOf(alarm).length === 0,
                }"
              >
                {{ triggerSummaryText(alarm) }} · {{ occurrenceText(alarm) }}
                <template v-if="isUnknownSound(alarm.soundId)"> · äänitiedosto puuttuu</template>
              </span>
            </button>

            <button type="button" class="alarm__edit-btn" aria-label="Muokkaa" @click="startEdit(alarm)">✎</button>

            <span v-if="pendingDeleteId === alarm.id" class="alarm__confirm">
              <button type="button" class="alarm__confirm-btn alarm__confirm-btn--danger" @click="confirmDelete(alarm)">
                Poista
              </button>
              <button type="button" class="alarm__confirm-btn" @click="cancelPendingDelete">Peruuta</button>
            </span>
            <button v-else type="button" class="alarm__delete" aria-label="Poista" @click="askDelete(alarm)">✕</button>
          </li>
        </ul>
        <p v-else class="group__hint">Ei hälytyksiä vielä.</p>

        <button type="button" class="btn" :disabled="alarms.length >= MAX_ALARMS" @click="startNew">
          + Uusi hälytys
        </button>
        <p v-if="alarms.length >= MAX_ALARMS" class="group__hint">Enintään {{ MAX_ALARMS }} hälytystä.</p>

        <section v-if="editingDraft" class="edit">
          <h3 class="edit__title">{{ isNewAlarm ? "Uusi hälytys" : "Muokkaa hälytystä" }}</h3>

          <label class="field">
            <span>Selite</span>
            <input v-model="editingDraft.label" type="text" maxlength="60" placeholder="esim. Herätys" />
          </label>

          <div class="field">
            <span>Tyyppi</span>
            <div class="segmented">
              <button
                type="button"
                class="segmented__btn"
                :class="{ 'segmented__btn--active': editingDraft.trigger.mode === 'relative' }"
                @click="setMode('relative')"
              >
                Ennen tapahtumaa
              </button>
              <button
                type="button"
                class="segmented__btn"
                :class="{ 'segmented__btn--active': editingDraft.trigger.mode === 'fixed' }"
                @click="setMode('fixed')"
              >
                Kiinteä kellonaika
              </button>
            </div>
          </div>

          <label v-if="editingDraft.trigger.mode === 'relative'" class="field">
            <span>Minuuttia ennen</span>
            <input
              v-model.number="editingDraft.trigger.minutesBefore"
              type="number"
              :min="MINUTES_MIN"
              :max="MINUTES_MAX"
              step="1"
            />
          </label>
          <label v-else class="field">
            <span>Kellonaika</span>
            <input v-model="editingDraft.trigger.time" type="time" />
          </label>

          <div class="field">
            <span>Viikonpäivät</span>
            <div class="weekdays">
              <button
                v-for="d in WEEKDAY_ORDER"
                :key="d"
                type="button"
                class="weekday-chip"
                :class="{ 'weekday-chip--active': isWeekdaySelected(d) }"
                @click="toggleWeekday(d)"
              >
                {{ WEEKDAY_ABBR[d] }}
              </button>
              <button type="button" class="btn btn--small" @click="applyWeekdayPreset(WEEKDAYS_MON_FRI)">Ma–Pe</button>
            </div>
            <p v-if="editingHasNoWeekdays" class="panel__warning">
              Ei valittuja viikonpäiviä — hälytys ei koskaan laukea.
            </p>
          </div>

          <template v-if="editingDraft.trigger.mode === 'relative'">
            <label class="field">
              <span>Ankkuri</span>
              <select
                :value="editingUniformAnchor ?? ''"
                @change="setUniformAnchor(($event.target as HTMLSelectElement).value as AlarmAnchor)"
              >
                <option v-if="editingUniformAnchor === null" value="" disabled>Vaihtelee päivittäin</option>
                <option value="schoolStart">Koulun alku</option>
                <option value="breakfast">Aamupala</option>
              </select>
            </label>
            <button
              v-if="editingDraft.trigger.weekdays.length > 1"
              type="button"
              class="btn btn--small"
              @click="showAdvancedAnchor = !showAdvancedAnchor"
            >
              {{ showAdvancedAnchor ? "Piilota päiväkohtainen ankkuri" : "Aseta ankkuri päivittäin" }}
            </button>
            <div v-if="showAdvancedAnchor" class="weekday-anchors">
              <div v-for="rule in editingDraft.trigger.weekdays" :key="rule.weekday" class="weekday-anchor-row">
                <span class="weekday-anchor-row__label">{{ WEEKDAY_ABBR[rule.weekday] }}</span>
                <div class="segmented segmented--small">
                  <button
                    type="button"
                    class="segmented__btn"
                    :class="{ 'segmented__btn--active': rule.anchor === 'schoolStart' }"
                    @click="setDayAnchor(rule.weekday, 'schoolStart')"
                  >
                    Koulu
                  </button>
                  <button
                    type="button"
                    class="segmented__btn"
                    :class="{ 'segmented__btn--active': rule.anchor === 'breakfast' }"
                    @click="setDayAnchor(rule.weekday, 'breakfast')"
                  >
                    Aamupala
                  </button>
                </div>
              </div>
            </div>
          </template>

          <p v-if="editingIsOrphaned" class="panel__warning">
            Oppilasta ({{ editingOrphanedStudentNumber }}) ei löydy Wilmasta — hälytys ei voi laueta ennen kuin
            valitset kelvollisen oppilaan tai "Kuka tahansa".
          </p>
          <p v-if="!canPreviewSchedule && editingDraft.trigger.mode === 'relative'" class="group__hint">
            Oppilaskohtainen kohdistus ja esikatselu näkyvät vain näyttölaitteella. Nykyinen kohdistus säilyy
            ennallaan.
          </p>

          <label v-if="showStudentField" class="field">
            <span>Oppilas</span>
            <select v-model="draftStudentValue">
              <option value="">Kuka tahansa</option>
              <option v-for="s in students" :key="s.studentNumber" :value="s.studentNumber">{{ s.name }}</option>
            </select>
          </label>

          <p v-if="isUnknownSound(editingDraft.soundId)" class="panel__warning">
            Valittua äänitiedostoa ei löydy palvelimen data/sounds-kansiosta — se on ehkä poistettu tai nimetty
            uudelleen. Hälytys soittaa silti oletusäänen sen sijaan, ei jää hiljaiseksi.
          </p>

          <label class="field">
            <span>Ääni</span>
            <div class="field-row field-row--sound">
              <select v-model="editingDraft.soundId">
                <optgroup label="Sisäänrakennetut">
                  <option v-for="sound in ALARM_SOUNDS" :key="sound.id" :value="sound.id">{{ sound.label }}</option>
                </optgroup>
                <optgroup v-if="customSounds.length > 0" label="Omat äänitiedostot">
                  <option v-for="sound in customSounds" :key="sound.id" :value="sound.id">{{ sound.label }}</option>
                </optgroup>
                <!-- Säilyttää valinnan näkyvissä (muttei valittavissa) jos se osoittaa
                     äänitiedostoon jota ei enää löydy — sama periaate kuin
                     showStudentFieldin roikkuvan oppilasviittauksen kanssa: arvoa ei
                     saa vaihtaa vahingossa vain koska pudotusvalikko ei näytä sitä. -->
                <option v-if="isUnknownSound(editingDraft.soundId)" :value="editingDraft.soundId" disabled>
                  (puuttuva ääni: {{ editingDraft.soundId }})
                </option>
              </select>
              <button
                type="button"
                class="btn"
                :class="{ 'btn--playing': previewPlaying }"
                @click="previewSound"
              >
                {{ previewPlaying ? "◼ Pysäytä" : "▶ Kuuntele" }}
              </button>
            </div>
            <p v-if="soundListError" class="group__hint">{{ soundListError }}</p>
          </label>
          <p v-if="previewError" class="panel__error">{{ previewError }}</p>

          <label class="field">
            <span>Äänenvoimakkuus</span>
            <input v-model.number="editingDraft.volume" type="range" min="0" max="1" step="0.05" />
          </label>

          <label class="field">
            <span>Toistoja</span>
            <input v-model.number="editingDraft.repeatCount" type="number" :min="REPEAT_MIN" :max="REPEAT_MAX" step="1" />
          </label>

          <label class="check">
            <input v-model="editingDraft.enabled" type="checkbox" />
            <span>Päällä</span>
          </label>

          <p class="edit__preview">{{ formPreviewText }}</p>
          <p v-if="formError" class="panel__error">{{ formError }}</p>

          <div class="edit__actions">
            <button type="button" class="btn" @click="cancelEdit">Peruuta</button>
            <button type="button" class="btn btn--primary" :disabled="formSaving" @click="saveEdit">
              {{ formSaving ? "Tallennetaan…" : "Tallenna" }}
            </button>
          </div>
        </section>
      </div>

      <footer class="panel__foot">
        <button type="button" class="btn" @click="closePanel">Sulje</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 6, 10, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 55;
  padding: 1.5rem;
}

.panel {
  background: #141821;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(38rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.panel__head,
.panel__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.3rem;
  flex-shrink: 0;
}

.panel__head h2 {
  margin: 0;
  font-size: 1.2rem;
}

.panel__foot {
  justify-content: flex-end;
  border-top: 1px solid var(--border);
}

.panel__body {
  padding: 0 1.3rem 1.2rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.panel__close {
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 0.5rem;
  min-height: 44px;
}

.panel__error {
  margin: 0;
  color: #f79b9b;
  font-size: 0.88rem;
}

.panel__warning {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 10px;
  background: rgba(243, 194, 107, 0.1);
  border: 1px solid rgba(243, 194, 107, 0.35);
  color: #f3c26b;
  font-size: 0.85rem;
}

.group__hint {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-faint);
}

.alarms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.alarm {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding: 0.3rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.alarm:last-child {
  border-bottom: none;
}

.alarm--disabled .alarm__label,
.alarm--disabled .alarm__meta {
  opacity: 0.5;
}

.alarm__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}

.alarm__toggle input {
  width: 1.25rem;
  height: 1.25rem;
  accent-color: var(--accent-school);
}

.alarm__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0.3rem 0.2rem;
  min-height: 44px;
  justify-content: center;
}

.alarm__label {
  font-size: 0.98rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.alarm__meta {
  font-size: 0.78rem;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.alarm__meta--warn {
  color: #f3c26b;
}

.alarm__edit-btn,
.alarm__delete {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 1.05rem;
  cursor: pointer;
}

.alarm__edit-btn:hover,
.alarm__delete:hover {
  color: var(--text);
}

.alarm__delete:hover {
  color: #f79b9b;
}

.alarm__confirm {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

.alarm__confirm-btn {
  min-height: 44px;
  padding: 0 0.6rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
}

.alarm__confirm-btn--danger {
  border-color: rgba(247, 155, 155, 0.55);
  color: #f79b9b;
  font-weight: 600;
}

.btn {
  min-height: 44px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Esikuuntelun "soi nyt" -tila: painike korostuu selvästi jotta pysäytys
   löytyy, sen sijaan että sama neutraali "Kuuntele"-nappi jäisi harhaanjohtavasti
   näkyviin ääni soidessa taustalla. */
.btn--playing {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.edit {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  border-top: 1px solid var(--border);
  padding-top: 0.9rem;
}

.edit__title {
  margin: 0;
  font-size: 0.95rem;
  color: var(--text-dim);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.82rem;
  color: var(--text-dim);
}

.field input[type="text"],
.field input[type="number"],
.field select {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 1rem;
  padding: 0.55rem 0.7rem;
  min-height: 44px;
}

/**
 * Avatun pudotusvalikon piirtää käyttöjärjestelmä, ja Chromium käyttää sen
 * pohjana `select`-elementin omaa taustaa. Yllä oleva `rgba(255,255,255,0.06)`
 * on lähes läpinäkyvä valkoinen, joten valikko piirtyi valkoisena — ja koska
 * vaihtoehdot perivät vaalean `--text`-värin, ne olivat käytännössä
 * näkymättömiä. Vain valittu rivi erottui, sen taakse piirtyvän korostuksen
 * ansiosta. Läpinäkymätön tausta ja eksplisiittinen väri korjaavat sen.
 * `optgroup` (hälytysäänivalikon "Sisäänrakennetut"/"Omat äänitiedostot"
 * -otsikot) kärsisi täsmälleen samasta ongelmasta samasta syystä.
 */
.field select option,
.field select optgroup {
  background-color: #161b24;
  color: var(--text);
}

.field input[type="range"] {
  width: 100%;
  accent-color: var(--accent-school);
  min-height: 44px;
}

.field-row {
  display: flex;
  gap: 0.6rem;
}

.field-row--sound select {
  flex: 1;
  min-width: 0;
}

/* Kaksi- tai kolmivaihtoehtoinen segmentoitu valitsin (tyyppi, päiväkohtainen
   ankkuri) — jokainen vaihtoehto on oma painikkeensa yhtenäisen taustan
   sisällä, sama kosketuskohteiden 44 px -vaatimus kuin muuallakin paneelissa. */
.segmented {
  display: flex;
  gap: 0.3rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.2rem;
}

.segmented__btn {
  flex: 1;
  min-height: 44px;
  background: none;
  border: none;
  border-radius: 8px;
  color: var(--text-dim);
  font-size: 0.85rem;
  cursor: pointer;
}

.segmented__btn--active {
  background: var(--accent-school);
  color: #0b0d12;
  font-weight: 600;
}

/* Päiväkohtaisen ankkurin rivit (showAdvancedAnchor) ovat pienempiä koska
   niitä voi olla seitsemän allekkain — silti 44 px korkeita, ei kapeampia. */
.segmented--small .segmented__btn {
  font-size: 0.78rem;
  padding: 0 0.4rem;
}

/* Viikonpäivävalinta: seitsemän 44×44 px -kosketuskohdetta rivissä, joka
   rullaa tarvittaessa sen sijaan että ahtaisi itsensä liian pieneksi
   kapealla näytöllä — sama periaate kuin taulukoiden overflow-x muualla. */
.weekdays {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.weekday-chip {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 0.85rem;
  cursor: pointer;
}

.weekday-chip--active {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.btn--small {
  min-height: 44px;
  padding: 0.4rem 0.8rem;
  font-size: 0.82rem;
}

.weekday-anchors {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.weekday-anchor-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.weekday-anchor-row__label {
  width: 2rem;
  flex-shrink: 0;
  font-size: 0.85rem;
  color: var(--text-dim);
}

.weekday-anchor-row .segmented {
  flex: 1;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 2.6rem;
  cursor: pointer;
  font-size: 0.95rem;
}

.check input {
  width: 1.15rem;
  height: 1.15rem;
  accent-color: var(--accent-school);
}

.edit__preview {
  margin: 0;
  font-size: 0.82rem;
  color: var(--accent-school);
}

.edit__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

/*
 * Hälytysilmoitus: koko ruudun peittävä, mahdollisimman huomiota herättävä,
 * eikä koskaan #app.night-luokan filter-himmennyksen alainen (ks. Teleport
 * yllä). z-index on korkea, koska tämä on <body>:n suora lapsi eikä muiden
 * modaalien tavoin App.vuen sisällä.
 */
.ring {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: radial-gradient(120% 90% at 50% 0%, #1c3324 0%, #0b0d12 70%);
  animation: ring-pulse 1.4s ease-in-out infinite;
}

@keyframes ring-pulse {
  0%,
  100% {
    background-color: #0b0d12;
  }
  50% {
    background-color: #12271a;
  }
}

.ring__box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
  text-align: center;
  max-width: 32rem;
}

.ring__eyebrow {
  font-size: 1rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent-school);
  font-weight: 600;
}

.ring__label {
  margin: 0;
  font-size: 2.4rem;
  line-height: 1.15;
  color: var(--text);
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ring__time {
  font-size: 3.4rem;
  font-weight: 300;
  color: var(--text);
}

.ring__sound-error {
  margin: 0;
  color: #f3c26b;
  font-size: 0.95rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.ring__retry {
  min-height: 44px;
  padding: 0.4rem 1rem;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  cursor: pointer;
}

.ring__ack {
  margin-top: 0.6rem;
  min-height: 5rem;
  min-width: 14rem;
  padding: 1rem 2.4rem;
  background: var(--accent-school);
  border: none;
  border-radius: 20px;
  color: #0b0d12;
  font-size: 1.6rem;
  font-weight: 700;
  cursor: pointer;
}
</style>
