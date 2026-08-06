<script setup lang="ts">
import { computed } from "vue";
import ElectricityCard from "./components/ElectricityCard.vue";
import { useClock } from "./composables/useClock";
import { useDashboard } from "./composables/useDashboard";
import type { ElectricityData, ProviderSnapshot } from "./types";

const { now } = useClock();
const { dashboard, connected } = useDashboard();

const timeLabel = computed(() =>
  now.value.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }),
);

const dateLabel = computed(() =>
  now.value.toLocaleDateString("fi-FI", { weekday: "long", day: "numeric", month: "long" }),
);

const electricity = computed(
  () => dashboard.value?.providers.electricity as ProviderSnapshot<ElectricityData> | undefined,
);

const currentHour = computed(() => now.value.getHours());

function minutesOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Night mode brackets across midnight, so the comparison has to handle a start
 * that is later in the day than the end.
 */
const isNight = computed(() => {
  const settings = dashboard.value?.settings;
  if (!settings) return false;
  const current = now.value.getHours() * 60 + now.value.getMinutes();
  const start = minutesOfDay(settings.nightModeStart);
  const end = minutesOfDay(settings.nightModeEnd);
  return start <= end ? current >= start && current < end : current >= start || current < end;
});
</script>

<template>
  <div class="app" :class="{ night: isNight }">
    <header class="topbar">
      <div class="topbar__time">
        <span class="topbar__clock tnum">{{ timeLabel }}</span>
        <span class="topbar__date">{{ dateLabel }}</span>
      </div>
      <div class="topbar__meta">
        <span v-if="dashboard?.place" class="topbar__place">{{ dashboard.place }}</span>
        <span v-if="!connected" class="badge badge--error">palvelin ei vastaa</span>
      </div>
    </header>

    <main class="grid">
      <section class="grid__slot grid__slot--schedule card card--placeholder">
        <h2 class="card__title">Lukujärjestys</h2>
        <p class="placeholder">Tulossa vaiheessa 3–4.</p>
      </section>

      <ElectricityCard class="grid__slot--power" :snapshot="electricity" :current-hour="currentHour" />

      <section class="grid__slot grid__slot--weather card card--placeholder">
        <h2 class="card__title">Sää</h2>
        <p class="placeholder">Tulossa vaiheessa 2.</p>
      </section>

      <section class="grid__slot grid__slot--messages card card--placeholder">
        <h2 class="card__title">Wilma-viestit</h2>
        <p class="placeholder">Tulossa vaiheessa 3.</p>
      </section>

      <section class="grid__slot grid__slot--calendar card card--placeholder">
        <h2 class="card__title">Kalenteri</h2>
        <p class="placeholder">Tulossa vaiheessa 5.</p>
      </section>

      <section class="grid__slot grid__slot--notes card card--placeholder">
        <h2 class="card__title">Muistilista</h2>
        <p class="placeholder">Tulossa vaiheessa 5.</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 1.1rem 1.3rem 1.3rem;
  gap: 0.9rem;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  flex-shrink: 0;
  padding: 0 0.3rem;
}

.topbar__time {
  display: flex;
  align-items: baseline;
  gap: 0.9rem;
}

.topbar__clock {
  font-size: 2.6rem;
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.01em;
}

.topbar__date {
  font-size: 1rem;
  color: var(--text-dim);
  text-transform: capitalize;
}

.topbar__meta {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.topbar__place {
  font-size: 0.85rem;
  color: var(--text-faint);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--gap);
  grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1.5fr) minmax(0, 1.1fr) minmax(0, 1fr);
  grid-template-areas:
    "schedule weather"
    "messages power"
    "calendar notes";
}

.grid__slot--schedule {
  grid-area: schedule;
}
.grid__slot--weather {
  grid-area: weather;
}
.grid__slot--messages {
  grid-area: messages;
}
.grid__slot--power {
  grid-area: power;
}
.grid__slot--calendar {
  grid-area: calendar;
}
.grid__slot--notes {
  grid-area: notes;
}

.card--placeholder {
  justify-content: flex-start;
  gap: 0.5rem;
}

.placeholder {
  margin: 0;
  color: var(--text-faint);
  font-size: 0.9rem;
}

/* Narrower screens (a phone checking the shopping list) fall back to one column. */
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-auto-rows: minmax(9rem, auto);
    grid-template-areas:
      "schedule"
      "messages"
      "power"
      "weather"
      "calendar"
      "notes";
    overflow-y: auto;
  }
}
</style>
