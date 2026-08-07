<script setup lang="ts">
import { nextTick, watch } from "vue";
import { iconFor } from "./weatherIcons";
import type { WeatherHour } from "../types";

const props = defineProps<{
  open: boolean;
  /** Pre-formatted header, e.g. "Tänään · 7.8." — computed by the caller so this stays dumb. */
  title: string;
  hours: WeatherHour[];
  /** Whether the opened day is the current local day — controls the "now" highlight and dimmed past hours. */
  isToday: boolean;
  currentHour: number;
}>();

const emit = defineEmits<{ close: [] }>();

function formatTemp(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}°` : `${rounded}°`;
}

function isPast(hour: number): boolean {
  return props.isToday && hour < props.currentHour;
}

function isNow(hour: number): boolean {
  return props.isToday && hour === props.currentHour;
}

// Closing on Escape only while open, so the listener doesn't fight other
// keyboard handling elsewhere on the page when the dialog is not shown.
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener("keydown", onKeydown);
      // Wait for the row for the current hour to exist in the DOM before
      // scrolling to it.
      void nextTick(() => {
        const target = document.querySelector('[data-hourly-now="true"]');
        target?.scrollIntoView({ block: "center", behavior: "auto" });
      });
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  },
);
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="panel__head">
        <h2>{{ title }}</h2>
        <button class="panel__close" type="button" aria-label="Sulje tuntisää" @click="emit('close')">
          Sulje
        </button>
      </header>

      <div class="panel__body">
        <div v-if="hours.length === 0" class="empty">Tuntitiedot puuttuvat</div>
        <div v-else class="hours">
          <div
            v-for="h in hours"
            :key="h.time"
            class="hour"
            :class="{ 'hour--now': isNow(h.hour), 'hour--past': isPast(h.hour) }"
            :data-hourly-now="isNow(h.hour) ? 'true' : undefined"
          >
            <span class="hour__time tnum">{{ String(h.hour).padStart(2, "0") }}</span>
            <span class="hour__icon"><component :is="iconFor(h.condition.icon)" /></span>
            <div class="hour__main">
              <span class="hour__desc">{{ h.condition.description }}</span>
              <span class="hour__meta tnum">
                <span v-if="h.apparentTemperature !== null">tuntuu {{ formatTemp(h.apparentTemperature) }}</span>
                <span v-if="h.precipitationProbability !== null && h.precipitationProbability > 0">
                  {{ h.precipitationProbability }} % sadetta
                </span>
                <span>{{ Math.round(h.windSpeed) }} m/s</span>
              </span>
            </div>
            <span class="hour__temp tnum">{{ formatTemp(h.temperature) }}</span>
          </div>
        </div>
      </div>
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
  z-index: 60;
  padding: 1.5rem;
}

.panel {
  background: #141821;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(30rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.3rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.panel__head h2 {
  margin: 0;
  font-size: 1.15rem;
  text-transform: capitalize;
}

.panel__close {
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 0.6rem 0.8rem;
  min-height: 44px;
  border-radius: 10px;
}

.panel__close:hover,
.panel__close:focus-visible {
  color: var(--text);
  background: var(--surface);
}

.panel__body {
  padding: 0.4rem 0.6rem;
  overflow-y: auto;
}

.empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--text-faint);
}

.hours {
  display: flex;
  flex-direction: column;
}

.hour {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 44px;
  padding: 0.4rem 0.7rem;
  border-radius: 10px;
}

.hour--now {
  background: var(--surface-strong);
  outline: 1px solid rgba(108, 197, 240, 0.4);
}

.hour--past {
  opacity: 0.45;
}

.hour__time {
  font-size: 0.95rem;
  font-weight: 600;
  width: 1.8rem;
  flex-shrink: 0;
}

.hour__icon {
  display: inline-flex;
  width: 1.5rem;
  height: 1.5rem;
  color: var(--accent-weather);
  flex-shrink: 0;
}

.hour__icon svg {
  width: 100%;
  height: 100%;
}

.hour__main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.hour__desc {
  font-size: 0.82rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hour__meta {
  display: flex;
  flex-wrap: wrap;
  row-gap: 0.05rem;
  column-gap: 0.5rem;
  font-size: 0.72rem;
  color: var(--text-faint);
}

.hour__temp {
  font-size: 0.98rem;
  font-weight: 600;
  flex-shrink: 0;
  text-align: right;
}
</style>
