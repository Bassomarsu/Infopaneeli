<script setup lang="ts">
/**
 * Kalenterin kuukausi- ja päivänäkymä.
 *
 * EI teleportattu `<body>`:n alle vaan elää `.app`:n sisällä, toisin kuin
 * AlarmsPanel. Ero on tarkoituksellinen: hälytyksen ON näyttävä yölläkin,
 * mutta kalenteri on käyttäjän itse avaama näkymä ja sen kuuluu himmentyä
 * muun näytön mukana (ks. `.app.night` style.css:ssä). Sama ratkaisu kuin
 * WeatherHourlyDialog.
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  GRID_WEEKS,
  WEEKDAY_SHORT,
  buildMonthGrid,
  chipCapacity,
  chipTime,
  dayHeading,
  dayKind,
  dayViewTime,
  localDateKey,
  localMonthKey,
  monthLabel,
  planChips,
  shiftMonth,
  splitDayEvents,
  type DayKind,
  type GridDay,
} from "./calendarMonth";
import { useClock } from "../composables/useClock";
import { useEditAccess } from "../composables/useEditAccess";
import type { CalendarEvent, CalendarMonth } from "../types";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ close: [] }>();

const editAccess = useEditAccess();

// Näyttö on auki päiväkausia, joten "tänään" on luettava kellosta eikä
// kerran avaushetkellä — muuten kuluvan päivän korostus jäisi eiliseen.
const { now } = useClock();

const todayKey = computed(() => localDateKey(now.value));
const currentMonthKey = computed(() => localMonthKey(now.value));

const viewMonth = ref(localMonthKey(new Date()));
const selectedDay = ref<string | null>(null);

// ── Kuukausien haku ja välimuisti ────────────────────────────────────────────

interface MonthEntry {
  data: CalendarMonth | null;
  error: string | null;
  pending: boolean;
  /** epoch ms; 0 = ei koskaan saatu onnistunutta vastausta. */
  fetchedAt: number;
}

const entries = ref<Record<string, MonthEntry>>({});

/** Kuinka vanha välimuistiarvo kelpaa sellaisenaan. */
const MAX_AGE_MS = 5 * 60 * 1000;

function entryFor(key: string): MonthEntry {
  return entries.value[key] ?? { data: null, error: null, pending: false, fetchedAt: 0 };
}

async function load(key: string, force: boolean): Promise<void> {
  const existing = entryFor(key);
  if (existing.pending) return;
  const fresh = existing.data !== null && Date.now() - existing.fetchedAt < MAX_AGE_MS;
  if (!force && fresh) return;

  // Vanha sisältö jää näkyviin haun ajaksi: näkymä ei tyhjene eikä välky
  // kuukautta vaihdettaessa, vaan päivittyy paikallaan.
  entries.value[key] = { ...existing, pending: true };
  try {
    const response = await editAccess.editFetch(
      `/api/calendar/month?month=${encodeURIComponent(key)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as CalendarMonth;
    entries.value[key] = { data: body, error: null, pending: false, fetchedAt: Date.now() };
  } catch {
    // Aiempi onnistunut vastaus säilytetään: se on vanha mutta tosi, ja
    // tyhjä ruudukko olisi vale.
    entries.value[key] = {
      ...entryFor(key),
      error: "Kuukauden tapahtumia ei saatu",
      pending: false,
    };
  }
}

/**
 * Naapurikuukaudet haetaan taustalla, jotta nuolen painallus vaihtaa näkymän
 * heti. Haku on vaimea: se ei koskaan näytä latausta eikä virhettä, koska
 * käyttäjä ei sitä pyytänyt.
 */
function prefetchNeighbours(key: string): void {
  void load(shiftMonth(key, -1), false);
  void load(shiftMonth(key, 1), false);
}

const entry = computed(() => entryFor(viewMonth.value));
const month = computed(() => entry.value.data);

/** Näytettävää tietoa ei ole: haku on kesken tai epäonnistui. */
const indeterminate = computed(() => month.value === null);

// ── Ruudukko ─────────────────────────────────────────────────────────────────

interface CellView {
  day: GridDay;
  kind: DayKind;
  heading: string;
  isToday: boolean;
  shown: CalendarEvent[];
  hidden: number;
  spanning: boolean[];
}

/**
 * Sen kuukauden vastaus johon annettu päivä kuuluu. Ruudukon reunoilla on
 * 4–6 viereisen kuukauden solua, ja `prefetchNeighbours` on jo hakenut nekin
 * kuukaudet — ne olisivat systemaattisesti tyhjiä vain siksi ettei niitä
 * katsota oikeasta paikasta.
 */
function monthOf(dateKey: string): MonthEntry {
  return entryFor(dateKey.slice(0, 7));
}

const weeks = computed<CellView[][]>(() => {
  const cells = buildMonthGrid(viewMonth.value).map<CellView>((day) => {
    const source = day.inMonth ? entry.value : monthOf(day.dateKey);
    const plan = planChips(source.data?.days[day.dateKey] ?? [], capacity.value);
    return {
      day,
      kind: dayKind(day.dateKey, source.data, source.data === null),
      heading: dayHeading(day.dateKey),
      isToday: day.dateKey === todayKey.value,
      shown: plan.shown,
      hidden: plan.hidden,
      // Kestollinen rivi piirtyy umpinaisena, hetkellinen reunaviivana.
      spanning: plan.shown.map((event) => chipTime(event) === null),
    };
  });
  const rows: CellView[][] = [];
  for (let i = 0; i < GRID_WEEKS; i += 1) rows.push(cells.slice(i * 7, i * 7 + 7));
  return rows;
});

// ── Mahtuvuus ────────────────────────────────────────────────────────────────
//
// Montako tapahtumariviä päiväsoluun mahtuu MITATAAN, ei arvata: dialogin koko
// riippuu ruudusta ja sama koodi ajetaan sekä seinänäytöllä että puhelimessa.
// `probeArea` on ensimmäisen solun tapahtumaosa (solun korkeus tulee
// ruudukolta eikä sisällöstä, joten kaikki solut ovat samanmittaisia) ja
// `probeChip` näkymätön mallirivi, joka saa tarkalleen samat mitat kuin
// oikeat rivit — myös kun media query muuttaa niitä kapealla ruudulla.

const probeArea = ref<HTMLElement | null>(null);
const probeChip = ref<HTMLElement | null>(null);
const capacity = ref(3);

function captureProbeArea(el: unknown, isFirstCell: boolean): void {
  if (isFirstCell) probeArea.value = (el as HTMLElement | null) ?? null;
}

function measure(): void {
  const area = probeArea.value;
  const chip = probeChip.value;
  if (!area || !chip) return;
  const available = area.clientHeight;
  const chipHeight = chip.offsetHeight;
  // Piilotettu tai vielä mittaamaton näkymä antaa nollia, eikä niistä saa
  // päätellä että soluun mahtuu yksi rivi.
  if (available <= 0 || chipHeight <= 0) return;
  const gap = Number.parseFloat(getComputedStyle(area).rowGap) || 0;
  // N riviä vie N*(korkeus+väli) - väli, joten väli lisätään molempiin puoliin.
  capacity.value = chipCapacity(available + gap, chipHeight + gap);
}

let observer: ResizeObserver | null = null;

function startMeasuring(): void {
  observer?.disconnect();
  observer = new ResizeObserver(() => measure());
  if (probeArea.value) observer.observe(probeArea.value);
  measure();
}

function stopMeasuring(): void {
  observer?.disconnect();
  observer = null;
}

// ── Selaus ───────────────────────────────────────────────────────────────────

function goToMonth(key: string): void {
  viewMonth.value = key;
  // Valittu päivä kuuluu siihen kuukauteen josta selattiin pois.
  selectedDay.value = null;
  void load(key, false);
  prefetchNeighbours(key);
}

function previousMonth(): void {
  goToMonth(shiftMonth(viewMonth.value, -1));
}

function nextMonth(): void {
  goToMonth(shiftMonth(viewMonth.value, 1));
}

function goToToday(): void {
  goToMonth(currentMonthKey.value);
}

const onCurrentMonth = computed(() => viewMonth.value === currentMonthKey.value);

/**
 * Viereisen kuukauden solu ei ole umpikuja: se vaihtaa ruudukon siihen
 * kuukauteen ja avaa päivän. Muuten päivänäkymä näyttäisi yhtä kuukautta ja
 * otsikko toista.
 */
function openDay(cell: CellView): void {
  const key = cell.day.dateKey.slice(0, 7);
  if (key !== viewMonth.value) {
    viewMonth.value = key;
    void load(key, false);
    prefetchNeighbours(key);
  }
  selectedDay.value = cell.day.dateKey;
}

function backToMonth(): void {
  selectedDay.value = null;
}

function retry(): void {
  void load(viewMonth.value, true);
}

// ── Päivänäkymä ──────────────────────────────────────────────────────────────

const dayGroups = computed<{ allDay: CalendarEvent[]; timed: CalendarEvent[] }>(() => {
  const key = selectedDay.value;
  if (key === null) return { allDay: [], timed: [] };
  return splitDayEvents(month.value?.days[key] ?? []);
});

const dayHasEvents = computed(
  () => dayGroups.value.allDay.length > 0 || dayGroups.value.timed.length > 0,
);

/**
 * Päivänäkymän tyhjä tila. "Ei tapahtumia" saa sanoa VAIN kun kuukausi on
 * haettu ja se kattoi päivän; muuten emme tiedä, ja niin on sanottava.
 */
const dayEmptyState = computed<{ title: string; text: string } | null>(() => {
  if (dayHasEvents.value) return null;
  if (month.value === null) {
    return entry.value.error !== null
      ? { title: "Tapahtumia ei saatu", text: "Kalenterilähde ei vastannut." }
      : { title: "Haetaan…", text: "Päivän tapahtumat eivät ole vielä tulleet." };
  }
  if (!month.value.covered) {
    return {
      title: "Ei tietoa",
      text: "Tämän päivän tapahtumia ei ole haettu, joten emme tiedä onko niitä.",
    };
  }
  return { title: "Ei tapahtumia", text: "Päivä on vapaa." };
});

const dayTitle = computed(() => (selectedDay.value === null ? "" : dayHeading(selectedDay.value)));

// ── Ruudukon tilarivi ────────────────────────────────────────────────────────

type StatusLine = { tone: "info" | "error" | "gap"; text: string };

/**
 * Rivi ruudukon yläpuolella kertoo mitä ruudukko EI kerro. Tärkein tapaus on
 * `covered: false`: silloin tyhjä solu ei tarkoita tapahtumatonta päivää, ja
 * pelkkä viivoitus jäisi arvoitukseksi ilman tätä lausetta.
 */
const status = computed<StatusLine | null>(() => {
  const e = entry.value;
  if (e.data === null) {
    if (e.error !== null) return { tone: "error", text: e.error };
    return { tone: "info", text: "Haetaan kuukauden tapahtumia…" };
  }
  if (e.error !== null) {
    return { tone: "error", text: `${e.error} — näytetään viimeksi saadut tiedot` };
  }
  if (!e.data.covered) {
    return {
      tone: "gap",
      text: "Kalenteri ei kattanut koko kuukautta. Viivoitetuista päivistä ei ole tietoa — ne eivät ole tyhjiä päiviä.",
    };
  }
  return null;
});

// ── Avaus ja näppäimistö ─────────────────────────────────────────────────────

const closeButton = ref<HTMLElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  // Sisin näkymä sulkeutuu ensin: päivänäkymästä palataan kuukauteen, ei ulos.
  if (selectedDay.value !== null) selectedDay.value = null;
  else emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown);
      stopMeasuring();
      return;
    }
    window.addEventListener("keydown", onKeydown);
    // Avattaessa aina tuore haku: kuukausinäkymä on juuri se paikka jossa
    // vanhentunut vastaus näyttäisi tosiasialta.
    selectedDay.value = null;
    viewMonth.value = currentMonthKey.value;
    void load(viewMonth.value, true);
    prefetchNeighbours(viewMonth.value);
    void nextTick(() => {
      startMeasuring();
      closeButton.value?.focus();
    });
  },
);

// Päivänäkymästä palatessa ruudukko tulee takaisin näkyviin; mitta otetaan
// silloin uusiksi, koska piilossa ollessa se oli nolla.
watch(selectedDay, (day) => {
  if (day === null && props.open) void nextTick(() => measure());
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  stopMeasuring();
});
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <section class="panel" role="dialog" aria-modal="true" aria-label="Kalenteri">
      <header class="panel__head">
        <div class="nav">
          <button
            v-if="selectedDay === null"
            type="button"
            class="nav__arrow"
            aria-label="Edellinen kuukausi"
            @click="previousMonth"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button v-else type="button" class="nav__back" @click="backToMonth">
            <span aria-hidden="true">‹</span> Kuukausi
          </button>

          <h2 class="nav__title">{{ selectedDay === null ? monthLabel(viewMonth) : dayTitle }}</h2>

          <button
            v-if="selectedDay === null"
            type="button"
            class="nav__arrow"
            aria-label="Seuraava kuukausi"
            @click="nextMonth"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>

        <div class="panel__actions">
          <button
            v-if="!onCurrentMonth && selectedDay === null"
            type="button"
            class="pill"
            @click="goToToday"
          >
            Tänään
          </button>
          <button
            ref="closeButton"
            type="button"
            class="pill"
            aria-label="Sulje kalenteri"
            @click="emit('close')"
          >
            Sulje
          </button>
        </div>
      </header>

      <!-- Kuukausinäkymä. v-show eikä v-if: ruudukko pysyy pystyssä myös
           päivänäkymän ajan, joten paluu ei rakenna sitä uudestaan. -->
      <div v-show="selectedDay === null" class="month">
        <p v-if="status" class="status" :class="`status--${status.tone}`">
          <span>{{ status.text }}</span>
          <button v-if="status.tone === 'error'" type="button" class="status__retry" @click="retry">
            Yritä uudelleen
          </button>
        </p>

        <div class="weekdays" aria-hidden="true">
          <span v-for="(name, i) in WEEKDAY_SHORT" :key="name" :class="{ weekdays__end: i >= 5 }">
            {{ name }}
          </span>
        </div>

        <div class="grid" :aria-busy="entry.pending && month === null">
          <template v-for="(week, wi) in weeks" :key="wi">
            <button
              v-for="(cell, di) in week"
              :key="cell.day.dateKey"
              type="button"
              class="cell"
              :class="[
                `cell--${cell.kind}`,
                { 'cell--today': cell.isToday, 'cell--outside': !cell.day.inMonth },
              ]"
              :aria-label="cell.heading"
              @click="openDay(cell)"
            >
              <span
                class="cell__num tnum"
                :class="{ 'cell__num--sunday': cell.day.weekday === 6 }"
                >{{ cell.day.dayOfMonth }}</span
              >

              <span :ref="(el) => captureProbeArea(el, wi === 0 && di === 0)" class="cell__chips">
                <span
                  v-for="(event, ei) in cell.shown"
                  :key="event.id"
                  class="chip"
                  :class="{ 'chip--span': cell.spanning[ei] }"
                >{{ event.title }}</span>

                <span v-if="cell.hidden > 0" class="chip chip--more">
                  {{ cell.shown.length === 0 ? `${cell.hidden} tapahtumaa` : `+${cell.hidden} lisää` }}
                </span>
              </span>
            </button>
          </template>

          <!-- Näkymätön mallirivi: mittaa rivin korkeuden sellaisena kuin CSS
               sen kulloinkin antaa. Ei vie tilaa eikä näy ruudunlukijalle. -->
          <span ref="probeChip" class="chip chip--measure" aria-hidden="true">Mitta</span>
        </div>
      </div>

      <!-- Päivänäkymä -->
      <div v-show="selectedDay !== null" class="day">
        <div v-if="dayEmptyState" class="day__empty">
          <span class="day__empty-title">{{ dayEmptyState.title }}</span>
          <span>{{ dayEmptyState.text }}</span>
        </div>

        <template v-else>
          <!-- Koko päivän kestävät omana ryhmänään ennen kellonaikoja: ne
               eivät kuulu mihinkään kohtaan päivän aikajanalla. -->
          <ul v-if="dayGroups.allDay.length > 0" class="day__list">
            <li v-for="event in dayGroups.allDay" :key="event.id" class="entry entry--span">
              <span class="entry__time">{{ dayViewTime(event) }}</span>
              <span class="entry__main">
                <span class="entry__title">{{ event.title }}</span>
                <span v-if="event.location || event.span" class="entry__meta">
                  <span v-if="event.span" class="entry__span"
                    >päivä {{ event.span.day }}/{{ event.span.totalDays }}</span
                  >
                  <span v-if="event.location">{{ event.location }}</span>
                </span>
              </span>
            </li>
          </ul>

          <hr
            v-if="dayGroups.allDay.length > 0 && dayGroups.timed.length > 0"
            class="day__rule"
            aria-hidden="true"
          />

          <ul v-if="dayGroups.timed.length > 0" class="day__list">
            <li v-for="event in dayGroups.timed" :key="event.id" class="entry">
              <span class="entry__time tnum">{{ dayViewTime(event) }}</span>
              <span class="entry__main">
                <span class="entry__title">{{ event.title }}</span>
                <span v-if="event.location || event.span" class="entry__meta">
                  <span v-if="event.span" class="entry__span"
                    >päivä {{ event.span.day }}/{{ event.span.totalDays }}</span
                  >
                  <span v-if="event.location">{{ event.location }}</span>
                </span>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
/*
 * HUOM kirjasinkoot: `rem` on tässä projektissa 16 px, EI 18 px.
 * style.css asettaa `font-size: 18px` `body`-elementille, mutta `rem` on aina
 * suhteessa `html`:ään, jolle ei ole asetettu mitään. Jokainen alla oleva
 * rem-arvo on siis valittu 16 pikselin perustaa vasten — 0.8rem olisi 12,8 px
 * eikä 14,4 px. Älä korjaa tätä `html`-perusarvoa muuttamalla: se skaalaisi
 * koko käyttöliittymän uusiksi.
 *
 * Toinen rajoite, joka nostaa kokoja: yötilassa `.app.night` ajaa
 * `brightness(0.42)` koko näytön yli. Lähes valkoinen teksti vaimenee silloin
 * arvoon ~#646668 solun taustaa (~#0a0b10) vasten, eli noin 3,4:1 — eikä
 * mikään värivalinta suodattimen SISÄLLÄ auta, koska himmennys puristaa
 * kaikkia kontrastisuhteita samalla tavalla. Jäljellä olevat keinot ovat koko
 * ja paino, ja siksi niitä on käytetty. Ks. myös `--text-faint`: se katoaa
 * yöllä käytännössä kokonaan, joten sitä ei käytetä tässä dialogissa.
 */

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 6, 10, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  padding: 1.5rem;
}

.panel {
  --grid-line: rgba(255, 255, 255, 0.075);
  --cell-bg: #171b25;
  --cal: var(--accent-calendar);

  background: #141821;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  /* Korkeus mitoitettu niin että päiväsoluun mahtuu kolme luettavaa riviä
     1080p-seinänäytöllä (864 px + 2 × 24 px täyte = 912 px < 1080 px). */
  width: min(80rem, 100%);
  height: min(54rem, 100%);
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* ── Otsikkopalkki ───────────────────────────────────────────────────────── */

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1.1rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.nav {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

/* Kuukauden nimi on näkymän ainoa äänekäs asia; kaikki muu on hiusviivaa ja
   vaimeaa tekstiä, jotta ruudukko itse pysyy luettavana. */
.nav__title {
  margin: 0;
  font-size: 1.7rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  padding-inline: 0.35rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav__arrow,
.nav__back,
.pill,
.status__retry {
  font: inherit;
  color: var(--text-dim);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}

/* Kosketuskohteet ovat vähintään sormen kokoisia: kioskissa ei ole hiirtä. */
.nav__arrow {
  width: 2.8rem;
  height: 2.8rem;
  flex-shrink: 0;
  font-size: 1.7rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav__back,
.pill {
  min-height: 2.8rem;
  padding: 0 1.1rem;
  font-size: 1rem;
  white-space: nowrap;
}

.nav__back {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.nav__arrow:hover,
.nav__arrow:focus-visible,
.nav__back:hover,
.nav__back:focus-visible,
.pill:hover,
.pill:focus-visible,
.status__retry:hover,
.status__retry:focus-visible {
  color: var(--text);
  background: var(--surface-strong);
}

/* ── Tilarivi ────────────────────────────────────────────────────────────── */

.status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 0.8rem;
  margin: 0;
  padding: 0.55rem 1.1rem;
  font-size: 0.95rem;
  line-height: 1.35;
  border-bottom: 1px solid var(--border);
}

.status--info {
  color: var(--text-dim);
}

.status--error {
  color: #f3c26b;
  background: rgba(243, 194, 107, 0.07);
}

.status--gap {
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.025);
}

.status__retry {
  min-height: 2.3rem;
  padding: 0 0.9rem;
  font-size: 0.9rem;
}

/* ── Kuukausiruudukko ────────────────────────────────────────────────────── */

.month {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1px;
  padding: 0.5rem 1.1rem 0.35rem;
  font-size: 0.9rem;
  color: var(--text-dim);
  flex-shrink: 0;
}

.weekdays span {
  padding-inline: 0.45rem;
}

.weekdays__end {
  color: var(--text);
}

/*
 * Ruudukon viivat ovat taustaväri joka näkyy solujen väleistä: yksi
 * hiusviivaverkko ilman että viereisten solujen omat reunat kaksinkertaistuvat.
 * Rivimäärä on sama vakio kuin GRID_WEEKS calendarMonth.ts:ssä.
 */
.grid {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-template-rows: repeat(6, minmax(0, 1fr));
  gap: 1px;
  background: var(--grid-line);
  border-top: 1px solid var(--grid-line);
  margin: 0 1.1rem 1.1rem;
  border-radius: 12px;
  overflow: hidden;
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  align-items: stretch;
  min-width: 0;
  min-height: 0;
  padding: 0.35rem 0.4rem 0.3rem;
  background: var(--cell-bg);
  border: none;
  border-radius: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* Kuukauden ulkopuoliset solut ovat painettuja ja passiivisia: niiden
   tapahtumia ei ole haettu, joten tyhjinä päivinä ne valehtelisivat samalla
   tavalla kuin kattamaton kuukausi. */
/*
 * Viereisen kuukauden solu on upotettu ja vaimennettu, mutta EI tyhjä: sen
 * kuukausi on jo haettu (prefetchNeighbours), joten sen tapahtumat näytetään.
 * Ero näytettävään kuukauteen pysyy silti selvänä — tummempi pinta ja
 * vaimeampi sisältö erottavat rivit ilman että ne katoavat.
 */
.cell--outside {
  background: rgba(0, 0, 0, 0.34);
}

.cell--outside .cell__num {
  color: var(--text-dim);
  opacity: 0.5;
}

/*
 * Vaimennus kohdistuu RIVEIHIN eikä koko tapahtumaosaan. Ero on olennainen:
 * `.cell__chips` kantaa myös "ei tietoa" -viivoituksen, ja jos se vaimenisi,
 * viereisen kuukauden hakematon päivä näyttäisi samalta kuin tyhjä päivä —
 * juuri se sekaannus jonka viivoitus on olemassa estämään.
 *
 * Vaimennus on sen verran voimakas, että katse erottaa näytettävän kuukauden
 * yhtenä alueena ja naapurit reunuksena, muttei niin voimakas että rivit
 * muuttuisivat lukukelvottomiksi.
 */
.cell--outside .chip {
  opacity: 0.42;
}

.cell:hover,
.cell:focus-visible {
  background: #1c2130;
}

.cell__num {
  font-size: 1.1rem;
  font-weight: 600;
  line-height: 1.55rem;
  color: var(--text);
  flex-shrink: 0;
  align-self: flex-start;
  min-width: 1.5rem;
  padding-inline: 0.25rem;
  border-radius: 999px;
}

/* Sunnuntai punaisella on suomalaisen seinäkalenterin tapa, ei koriste. */
.cell__num--sunday {
  color: #e0949a;
}

/* Kuluva päivä erottuu sekä täytetystä numerosta että kehyksestä. Kehys on
   oma kerroksensa, ettei se muuta solun mittoja — ja koska ero on muoto eikä
   sävy, se selviää yötilan himmennyksestä. */
.cell--today {
  position: relative;
}

.cell--today .cell__num {
  background: var(--cal);
  color: #14101f;
}

.cell--today::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 2px solid var(--cal);
  pointer-events: none;
}

.cell__chips {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/*
 * "Ei tietoa" ≠ "ei tapahtumia". Viivoitus on muoto eikä sävy, joten se
 * erottuu myös kun `.app.night` himmentää koko näytön. Ks. `dayKind`.
 */
.cell--unknown .cell__chips {
  background-image: repeating-linear-gradient(
    -45deg,
    transparent 0 4px,
    rgba(255, 255, 255, 0.09) 4px 5.5px
  );
  border-radius: 4px;
}

/*
 * Rivillä on vain tapahtuman nimi. Kellonaika söi solun ~173 pikselin
 * leveydestä kolmanneksen, jolloin nimelle jäi noin viisitoista merkkiä
 * ("Kerttu hammaslääkäri" → "Kerttu hamma…"); kellonaika on päivänäkymän
 * asia, joka avataan juuri sitä varten. Vapautunut leveys ja 16 px:n koko
 * yhdessä tekevät rivistä luettavan myös yötilan himmennyksen alla — ks.
 * tiedoston alun huomautus kontrastista.
 */
.chip {
  min-width: 0;
  flex-shrink: 0;
  padding: 0.1rem 0.35rem 0.1rem 0.4rem;
  font-size: 1rem;
  font-weight: 500;
  line-height: 1.25;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-left: 3px solid var(--cal);
  border-radius: 0 3px 3px 0;
}

/* Kestollinen tapahtuma (koko päivä tai monipäiväisen välipäivä) saa
   umpinaisen pinnan, hetkellinen pelkän reunaviivan. Ero on muodossa, joten
   puuttuva kellonaika ei näytä puuttuvalta tiedolta. */
.chip--span {
  background: rgba(196, 163, 245, 0.22);
  border-radius: 3px;
  border-left-color: transparent;
  padding-left: 0.35rem;
}

.chip--more {
  border-left-color: transparent;
  color: var(--text-dim);
  font-weight: 600;
  font-size: 0.9rem;
  padding-left: 0.4rem;
}

.chip--measure {
  position: absolute;
  left: 0;
  top: 0;
  width: 8rem;
  visibility: hidden;
  pointer-events: none;
}

/* ── Päivänäkymä ─────────────────────────────────────────────────────────── */

.day {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.9rem 1.1rem 1.2rem;
}

/* Rivit eivät veny dialogin koko leveydelle: tapahtuman nimi ja paikka ovat
   lyhyitä, ja parin metrin päästä pitkä rivi hajottaa katseen. */
.day__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-width: 46rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.day__rule {
  border: none;
  border-top: 1px solid var(--border);
  max-width: 46rem;
  margin: 0.9rem 0;
}

.entry {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 0.9rem;
  align-items: baseline;
  padding: 0.7rem 0.9rem;
  border-radius: 10px;
  border-left: 3px solid var(--cal);
  background: rgba(255, 255, 255, 0.03);
}

/* Sama muotokieli kuin ruudukossa: kesto on umpinainen, hetki on viiva. */
.entry--span {
  background: rgba(196, 163, 245, 0.14);
  border-left-color: transparent;
}

.entry__time {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--cal);
}

.entry__main {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.entry__title {
  font-size: 1.2rem;
  line-height: 1.3;
}

.entry__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.7rem;
  font-size: 0.95rem;
  color: var(--text-dim);
}

.entry__span {
  color: var(--text-dim);
}

.day__empty {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: center;
  justify-content: center;
  text-align: center;
  height: 100%;
  color: var(--text-dim);
}

.day__empty-title {
  color: var(--text);
  font-weight: 600;
  font-size: 1.2rem;
}

/* ── Kapea ruutu ─────────────────────────────────────────────────────────── */

/*
 * Puhelimessa sarake on noin 50 px leveä eikä tapahtuman nimi mahdu sinne
 * luettavana. Rivi kutistuu palkiksi, joka kertoo sen minkä kapea ruutu voi
 * kertoa: montako tapahtumaa ja minkä muotoisia. Mittaus seuraa muutosta
 * itsestään, koska mallirivi noudattaa samoja sääntöjä.
 */
@media (max-width: 44rem) {
  .overlay {
    padding: 0.6rem;
  }

  .panel {
    height: 100%;
  }

  .panel__head {
    padding: 0.7rem;
    gap: 0.5rem;
    /* Otsikko voi kietoutua kahdelle riville; sulkupainike pysyy silti
       ylärivissä eikä jää kellumaan rivien väliin. */
    align-items: flex-start;
  }

  /* Päivän otsikko ("Keskiviikko 9. syyskuuta") ei mahdu kapealle riville
     yhtenä pätkänä. Se saa kietoutua kahdelle riville eikä katketa
     kolmeen pisteeseen: viikonpäivä on se osa jonka takia otsikko luetaan. */
  .nav {
    flex-wrap: wrap;
  }

  .nav__title {
    font-size: 1.1rem;
    white-space: normal;
    line-height: 1.2;
  }

  .nav__arrow {
    width: 2.4rem;
    height: 2.4rem;
  }

  .weekdays,
  .status {
    padding-inline: 0.7rem;
  }

  .weekdays span {
    padding-inline: 0;
    text-align: center;
  }

  .grid {
    margin: 0 0.7rem 0.7rem;
  }

  .cell {
    padding: 0.25rem 0.2rem;
    align-items: center;
  }

  .cell__num {
    font-size: 0.88rem;
    line-height: 1.3rem;
    align-self: center;
    padding-inline: 0.2rem;
    min-width: 1.3rem;
    text-align: center;
  }

  .cell__chips {
    width: 100%;
    gap: 0.14rem;
  }

  .chip {
    height: 0.3rem;
    padding: 0;
    /* Teksti ei mahdu 50 px:n sarakkeeseen, joten rivi kutistuu palkiksi.
       `font-size: 0` piilottaa nimen mutta jättää elementin paikalleen —
       mallirivi noudattaa samaa sääntöä, joten mittaus seuraa mukana. */
    font-size: 0;
    border-left: none;
    border-radius: 2px;
    background: var(--cal);
    overflow: hidden;
  }

  .chip--span {
    background: rgba(196, 163, 245, 0.45);
  }

  .chip--more {
    height: auto;
    background: none;
    font-size: 0.72rem;
    line-height: 1;
    color: var(--text-dim);
  }

  .entry {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
}
</style>
