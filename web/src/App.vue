<script setup lang="ts">
import { computed, ref } from "vue";
import CalendarCard, { type CalendarData } from "./components/CalendarCard.vue";
import ElectricityCard from "./components/ElectricityCard.vue";
import MessagesCard from "./components/MessagesCard.vue";
import NotesCard from "./components/NotesCard.vue";
import ScheduleCard from "./components/ScheduleCard.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import WeatherCard, { type WeatherData } from "./components/WeatherCard.vue";
import { useClock } from "./composables/useClock";
import { useDashboard } from "./composables/useDashboard";
import { useScheduleDay } from "./composables/useScheduleDay";
import type { ElectricityData, ProviderSnapshot, Settings, WilmaData } from "./types";

const { now } = useClock();
const { dashboard, connected, refresh } = useDashboard();

const settingsOpen = ref(false);

const timeLabel = computed(() =>
  now.value.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }),
);

const dateLabel = computed(() =>
  now.value.toLocaleDateString("fi-FI", { weekday: "long", day: "numeric", month: "long" }),
);

const provider = <T,>(id: string): ProviderSnapshot<T> | undefined =>
  dashboard.value?.providers[id] as ProviderSnapshot<T> | undefined;

const electricity = computed(() => provider<ElectricityData>("electricity"));
const weather = computed(() => provider<WeatherData>("weather"));
const calendar = computed(() => provider<CalendarData>("calendar"));
const wilma = computed(() => provider<WilmaData>("wilma"));

const settings = computed<Settings | null>(() => dashboard.value?.settings ?? null);
const wilmaData = computed(() => wilma.value?.data ?? null);

const rolloverTime = computed(() => settings.value?.rolloverTime ?? "12:00");
const visibleStudents = computed(() => settings.value?.visibleStudents ?? null);

const { day, students } = useScheduleDay(wilmaData, now, rolloverTime, visibleStudents);

const currentHour = computed(() => now.value.getHours());
const canEdit = computed(() => dashboard.value?.localClient ?? false);

function minutesOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Night mode brackets across midnight, so the comparison has to handle a start
 * that is later in the day than the end.
 */
const isNight = computed(() => {
  const current = settings.value;
  if (!current) return false;
  const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
  const start = minutesOfDay(current.nightModeStart);
  const end = minutesOfDay(current.nightModeEnd);
  return start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
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
        <button
          v-if="canEdit"
          class="topbar__settings"
          type="button"
          title="Asetukset"
          @click="settingsOpen = true"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path
              d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M18.2 5.8l-1.4 1.4M7.2 16.8l-1.4 1.4"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          <span class="sr-only">Asetukset</span>
        </button>
      </div>
    </header>

    <main class="grid">
      <ScheduleCard
        class="grid__slot--schedule"
        :snapshot="wilma"
        :day="day"
        :layout="settings?.scheduleLayout ?? 'split'"
        :rollover-time="rolloverTime"
      />

      <WeatherCard class="grid__slot--weather" :snapshot="weather" :place="dashboard?.place" />

      <MessagesCard
        class="grid__slot--messages"
        :snapshot="wilma"
        :hide-previews="settings?.hideMessagePreviews ?? false"
      />

      <ElectricityCard class="grid__slot--power" :snapshot="electricity" :current-hour="currentHour" />

      <CalendarCard class="grid__slot--calendar" :snapshot="calendar" />

      <NotesCard
        class="grid__slot--notes"
        :notes="dashboard?.notes ?? []"
        :can-edit="canEdit"
        @refresh="refresh"
      />
    </main>

    <SettingsPanel
      v-if="settings"
      :settings="settings"
      :students="students"
      :open="settingsOpen"
      @close="settingsOpen = false"
      @saved="refresh"
    />
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

.topbar__settings {
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0.5rem;
  display: flex;
  border-radius: 10px;
}

.topbar__settings:hover {
  color: var(--text);
  background: var(--surface);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--gap);
  grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1.5fr) minmax(0, 1.15fr) minmax(0, 1fr);
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

/* A phone checking the shopping list gets one column, notes first. */
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-auto-rows: minmax(9rem, auto);
    grid-template-areas:
      "notes"
      "calendar"
      "weather"
      "power"
      "schedule"
      "messages";
    overflow-y: auto;
  }
}
</style>
