<script setup lang="ts">
import { computed, h, type VNode } from "vue";
import CardShell from "./CardShell.vue";
import type { ProviderSnapshot } from "../types";

export type WeatherIcon = "clear" | "partly" | "cloudy" | "rain" | "snow" | "thunder" | "fog";

export interface WeatherCondition {
  code: number;
  description: string;
  icon: WeatherIcon;
}

export interface WeatherHour {
  time: string;
  hour: number;
  temperature: number;
  precipitationProbability: number | null;
  condition: WeatherCondition;
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

// Dates are plain YYYY-MM-DD keys from Open-Meteo; parsing as UTC avoids the
// off-by-one-day trap a local-time parse would hit near midnight.
function weekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return WEEKDAYS[utc.getUTCDay()] ?? "";
}

function formatTemp(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}°` : `${rounded}°`;
}

// Icons are drawn as plain 24x24 SVGs from a couple of shared shapes, kept
// simple and high-contrast so they still read at a glance from across a room.
function svgIcon(children: VNode[]): VNode {
  return h(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children,
  );
}

const CLOUD_PATH = "M6.5 18.5a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 16.9 8.6 4.5 4.5 0 0 1 16.5 18.5h-10Z";

function cloud(offsetY = 0): VNode {
  return h("path", {
    d: CLOUD_PATH,
    transform: offsetY ? `translate(0 ${offsetY})` : undefined,
    stroke: "currentColor",
    "stroke-width": 1.6,
    fill: "none",
  });
}

function sunRays(): VNode[] {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    return h("line", {
      x1: 12 + Math.cos(angle) * 8.5,
      y1: 12 + Math.sin(angle) * 8.5,
      x2: 12 + Math.cos(angle) * 11,
      y2: 12 + Math.sin(angle) * 11,
      stroke: "currentColor",
      "stroke-width": 1.6,
    });
  });
}

function rainDrops(y: number): VNode[] {
  return [7, 12, 17].map((x) =>
    h("line", { x1: x, y1: y, x2: x - 1.4, y2: y + 3.4, stroke: "currentColor", "stroke-width": 1.6 }),
  );
}

function snowDots(y: number): VNode[] {
  return [7, 12, 17].map((x) => h("circle", { cx: x, cy: y, r: 1.05, fill: "currentColor", stroke: "none" }));
}

const ICON_BUILDERS: Record<WeatherIcon, () => VNode> = {
  clear: () => svgIcon([h("circle", { cx: 12, cy: 12, r: 5.2, fill: "currentColor", stroke: "none" }), ...sunRays()]),
  partly: () =>
    svgIcon([h("circle", { cx: 8, cy: 7.5, r: 3.4, fill: "currentColor", stroke: "none" }), cloud(1.5)]),
  cloudy: () => svgIcon([cloud()]),
  fog: () => svgIcon([h("path", { d: "M5 9.5h14M4 13h16M6 16.5h12", stroke: "currentColor", "stroke-width": 1.6 })]),
  rain: () => svgIcon([cloud(-2), ...rainDrops(16.5)]),
  snow: () => svgIcon([cloud(-2), ...snowDots(17.5)]),
  thunder: () =>
    svgIcon([
      cloud(-3),
      h("path", { d: "M13 14.5 9.5 19h3l-1 3.5 4.5-5.5h-3z", fill: "currentColor", stroke: "none" }),
    ]),
};

function iconFor(icon: WeatherIcon): VNode {
  return (ICON_BUILDERS[icon] ?? ICON_BUILDERS.cloudy)();
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
        <div v-for="day in data.days" :key="day.date" class="weather__day">
          <span class="weather__day-label">{{ weekdayLabel(day.date) }}</span>
          <span class="weather__icon"><component :is="iconFor(day.condition.icon)" /></span>
          <span class="weather__day-range tnum">
            <span class="weather__day-max">{{ formatTemp(day.max) }}</span>
            <span class="weather__day-min">{{ formatTemp(day.min) }}</span>
          </span>
          <span v-if="day.precipitation > 0" class="weather__day-precip tnum">
            {{ day.precipitation.toFixed(1).replace(".", ",") }} mm
          </span>
        </div>
      </div>
    </div>
  </CardShell>
</template>

<style scoped>
.weather {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  height: 100%;
  min-height: 0;
}

.weather__now {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

.weather__icon {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  color: var(--accent-weather);
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

.weather__days {
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
  flex: 1;
  min-height: 0;
}

.weather__day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  flex: 1;
  min-width: 0;
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
