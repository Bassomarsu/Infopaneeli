<script setup lang="ts">
import { computed, ref } from "vue";
import CardShell from "./CardShell.vue";
import WeatherHourlyDialog from "./WeatherHourlyDialog.vue";
import { iconFor, type WeatherIcon } from "./weatherIcons";
import { useClock } from "../composables/useClock";
import type { ProviderSnapshot, WeatherHour } from "../types";

export type { WeatherIcon };

export interface WeatherCondition {
  code: number;
  description: string;
  icon: WeatherIcon;
}

export interface WeatherDay {
  date: string;
  condition: WeatherCondition;
  min: number;
  max: number;
  precipitation: number;
  windMax: number;
  sunrise: string | null;
  sunset: string | null;
  /** Full 24h of that day, oldest first. Missing/empty on cache data written before this field existed. */
  hours: WeatherHour[];
}

export interface WeatherData {
  place: string;
  current: {
    temperature: number;
    apparentTemperature: number;
    condition: WeatherCondition;
    windSpeed: number;
    precipitation: number;
  };
  todayRemainingHours: WeatherHour[];
  days: WeatherDay[];
}

const props = defineProps<{
  snapshot?: ProviderSnapshot<WeatherData>;
  place?: string;
}>();

const data = computed(() => props.snapshot?.data ?? null);

const WEEKDAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"];
const WEEKDAYS_FULL = [
  "sunnuntai",
  "maanantai",
  "tiistai",
  "keskiviikko",
  "torstai",
  "perjantai",
  "lauantai",
];

// Dates are plain YYYY-MM-DD keys from Open-Meteo; parsing as UTC avoids the
// off-by-one-day trap a local-time parse would hit near midnight.
function weekdayIndex(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return utc.getUTCDay();
}

function weekdayLabel(dateKey: string): string {
  return WEEKDAYS[weekdayIndex(dateKey)] ?? "";
}

function formatTemp(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}°` : `${rounded}°`;
}

// Local YYYY-MM-DD, matching the server's dateKey format — same convention as
// CalendarCard — so "is this the day showing today" is a plain string check.
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// The dialog can stay open for a long time on a wall display, so "now" has
// to keep ticking rather than being read once at open time — otherwise the
// current-hour highlight and past-hour dimming go stale mid-visit, and the
// day would never notice it crossed midnight into a new "today".
const { now } = useClock();

const selectedDate = ref<string | null>(null);

const selectedDay = computed<WeatherDay | null>(
  () => data.value?.days.find((day) => day.date === selectedDate.value) ?? null,
);

const isSelectedToday = computed(() => selectedDay.value?.date === localDateKey(now.value));
const currentHour = computed(() => now.value.getHours());

const dialogTitle = computed(() => {
  const day = selectedDay.value;
  if (!day) return "";
  const [, m, d] = day.date.split("-").map(Number);
  const weekday = WEEKDAYS_FULL[weekdayIndex(day.date)] ?? "";
  const prefix = isSelectedToday.value
    ? "Tänään"
    : weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${prefix} · ${d}.${m}.`;
});

function openDay(date: string): void {
  selectedDate.value = date;
}

function closeDialog(): void {
  selectedDate.value = null;
}
</script>

<template>
  <CardShell
    title="Sää"
    accent="var(--accent-weather)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
    :note="place ?? data?.place"
  >
    <div v-if="data" class="weather">
      <div class="weather__now">
        <span class="weather__icon weather__icon--big"><component :is="iconFor(data.current.condition.icon)" /></span>
        <div class="weather__now-text">
          <span class="weather__temp tnum">{{ formatTemp(data.current.temperature) }}</span>
          <span class="weather__desc">{{ data.current.condition.description }}</span>
          <span class="weather__sub tnum">
            tuntuu kuin {{ formatTemp(data.current.apparentTemperature) }} · tuuli
            {{ Math.round(data.current.windSpeed) }} m/s
          </span>
        </div>
      </div>

      <div class="weather__days">
        <button
          v-for="day in data.days"
          :key="day.date"
          type="button"
          class="weather__day"
          :aria-label="`Tuntisää ${weekdayLabel(day.date)}`"
          @click="openDay(day.date)"
        >
          <span class="weather__day-label">{{ weekdayLabel(day.date) }}</span>
          <span class="weather__icon"><component :is="iconFor(day.condition.icon)" /></span>
          <span class="weather__day-range tnum">
            <span class="weather__day-max">{{ formatTemp(day.max) }}</span>
            <span class="weather__day-min">{{ formatTemp(day.min) }}</span>
          </span>
          <span v-if="day.precipitation > 0" class="weather__day-precip tnum">
            {{ day.precipitation.toFixed(1).replace(".", ",") }} mm
          </span>
        </button>
      </div>
    </div>
  </CardShell>

  <WeatherHourlyDialog
    :open="selectedDay !== null"
    :title="dialogTitle"
    :hours="selectedDay?.hours ?? []"
    :is-today="isSelectedToday"
    :current-hour="currentHour"
    @close="closeDialog"
  />
</template>

<style scoped>
/*
 * Sisältö vierittyy, kuten yhdeksällä muulla kortilla (`.messages`,
 * `.calendar__days`, `.schedule__cols` …): `flex: 1; min-height: 0;
 * overflow-y: auto`.
 *
 * Vieritys on TÄSSÄ eikä kortissa. Kortin oma `overflow: hidden` on se raja
 * joka piti otsikon ja "vanhentunut"-merkin paikallaan, ja sen muuttaminen
 * vierittäväksi vierittäisi nekin pois — ne ovat juuri se minkä
 * MIN_PANEL_SPAN lupaa säilyttää (ks. types.ts). Vain sisältö saa liikkua.
 *
 * Vieritys on vain TÄSSÄ eikä myös `.weather__days`issa: kaksi sisäkkäistä
 * vierityssäiliötä antaisi kaksi palkkia ja kaksi eri tapaa päästä samaan
 * sisältöön.
 *
 * `overflow-x` on erikseen `hidden`, koska pelkkä `overflow-y: auto` tekee
 * toisesta akselista automaattisesti `auto`n — ja päivänapit ovat
 * `justify-content: space-between` -rivissä, joka pyöristyy helposti
 * murto-osan yli leveäksi. Sama mitattu ansa kuin uutiskortissa.
 */
.weather {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.weather__now {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

/* Ei `color`-arvoa: ikonin osilla on omat värinsä (ks. weatherIcons.ts), joten
   periytyvä väri ei enää vaikuta mihinkään. Yötila ja menneiden tuntien
   himmennys toimivat elementtitason filter/opacity-arvoilla. */
.weather__icon {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
}

.weather__icon svg {
  width: 100%;
  height: 100%;
}

.weather__icon--big {
  width: 3.6rem;
  height: 3.6rem;
}

.weather__now-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.weather__temp {
  font-size: 2.7rem;
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.02em;
}

.weather__desc {
  font-size: 0.95rem;
  color: var(--text-dim);
}

.weather__sub {
  font-size: 0.78rem;
  color: var(--text-faint);
}

/*
 * EI `min-height: 0`, JA SE ON EHTO EIKÄ TYYLI.
 *
 * `min-height: 0` antoi tämän rivin kutistua sisältönsä alle, jolloin
 * ennustepäivät leikkautuivat rivin sisällä eikä `.weather` vuotanut yli
 * lainkaan — vierityspalkkia ei siis olisi tullut vaikka sisältöä oli
 * piilossa. Mitattu 1366 × 768 (kortti 2 × 2): 39 px päivistä pois näkyvistä,
 * `.weather`in ylivuoto 0 px.
 *
 * Ilman sitä flex-laatikon automaattinen vähimmäiskorkeus on sen sisällön
 * korkeus: rivi ei kutistu, `.weather` vuotaa yli, ja palkki ilmestyy.
 * `flex: 1` jää, joten isolla kortilla rivi täyttää tilan kuten ennenkin —
 * siellä ei ole kutistettavaa eikä ulkonäkö muutu.
 */
.weather__days {
  display: flex;
  /*
   * KÄÄRIYTYY, koska kuusi 44 px:n kosketuskohdetta ei mahdu kapean kortin
   * riville: 901 px:n näytöllä 2 x 2 -kortissa päivärivi on 75 px laatikkoaan
   * leveämpi, ja ilman kääriytymistä viimeinen päivä leikkautuu vaakasuunnassa
   * pois — eikä pystyvieritys tavoita sitä, koska ongelma on eri akselilla.
   *
   * Kääriytyminen siirtää ylivuodon sille akselille jolla kortissa ON
   * vieritys, eikä tuo toista vierityspalkkia. Kun päivät mahtuvat riville
   * (mitattu: 2736 x 1824 ja 1920 x 1080), sillä ei ole mitään vaikutusta.
   */
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.4rem;
  flex: 1;
}

.weather__day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  flex: 1;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  border-radius: 12px;
  padding: 0.3rem 0.1rem;
  color: inherit;
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.weather__day:hover,
.weather__day:focus-visible {
  background: var(--surface-strong);
}

.weather__day-label {
  font-size: 0.74rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.weather__day-range {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 0.85rem;
  line-height: 1.3;
}

.weather__day-max {
  color: var(--text);
  font-weight: 600;
}

.weather__day-min {
  color: var(--text-faint);
}

.weather__day-precip {
  font-size: 0.68rem;
  color: var(--accent-weather);
}
</style>
