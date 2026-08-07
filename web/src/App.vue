<script setup lang="ts">
import { computed, provide, ref } from "vue";
import AlarmsPanel from "./components/AlarmsPanel.vue";
import CalendarCard, { type CalendarData } from "./components/CalendarCard.vue";
import ElectricityCard from "./components/ElectricityCard.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import MessagesCard from "./components/MessagesCard.vue";
import NotesCard from "./components/NotesCard.vue";
import ScheduleCard from "./components/ScheduleCard.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import WeatherCard, { type WeatherData } from "./components/WeatherCard.vue";
import { useClock } from "./composables/useClock";
import { useDashboard } from "./composables/useDashboard";
import { panelGridKey, usePanelLayout } from "./composables/usePanelLayout";
import { useScheduleDay } from "./composables/useScheduleDay";
import type { ElectricityData, PanelLayout, ProviderSnapshot, Settings, WilmaData } from "./types";

const { now } = useClock();
const { dashboard, connected, refresh } = useDashboard();

const settingsOpen = ref(false);
const alarmsOpen = ref(false);

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

// Kaikki tunnetut lapset, ei vain kortilla näytettävät — hälytys voi koskea
// lasta joka on piilotettu lukujärjestyskortilta, joten AlarmsPanel ei saa
// käyttää visibleStudents-suodatettua listaa.
const allStudents = computed(() => wilmaData.value?.students ?? []);
const activeAlarmCount = computed(() => settings.value?.alarms.filter((a) => a.enabled).length ?? 0);

// Koko composable annetaan kortille yhtenä oliona, jotta selauspainikkeet ja
// automaattinen päivänvaihto asuvat samassa paikassa eikä App.vue joudu
// välittämään jokaista nappia erikseen.
const schedule = useScheduleDay(wilmaData, now, rolloverTime, visibleStudents);
const { students } = schedule;

const currentHour = computed(() => now.value.getHours());
const canEdit = computed(() => dashboard.value?.localClient ?? false);

// Ruudukkoelementin viittaus jaetaan LayoutEditor-lapsille provide/injectillä,
// jotta jokainen paneeli ei mittaisi DOMia erikseen raahauksen aikana.
const gridEl = ref<HTMLElement | null>(null);
provide(panelGridKey, gridEl);

const panelLayoutSetting = computed<PanelLayout | null>(() => settings.value?.panelLayout ?? null);
const panelLayout = usePanelLayout(panelLayoutSetting, canEdit, refresh);

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
    <header v-if="panelLayout.editing.value" class="topbar topbar--editing">
      <span class="topbar__editing-label" :class="{ 'topbar__editing-label--notice': panelLayout.notice.value }">
        {{
          panelLayout.notice.value ??
          "Muokkaa asettelua — raahaa paneeleja, kahva oikeassa alakulmassa muuttaa kokoa"
        }}
      </span>
      <div class="topbar__editing-actions">
        <button
          type="button"
          class="edit-btn"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.cancelEditing()"
        >
          Peruuta
        </button>
        <button
          type="button"
          class="edit-btn"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.resetToDefault()"
        >
          Palauta oletusasettelu
        </button>
        <button
          type="button"
          class="edit-btn edit-btn--primary"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.finishEditing()"
        >
          {{ panelLayout.saving.value ? "Tallennetaan…" : "Valmis" }}
        </button>
      </div>
    </header>
    <header v-else class="topbar">
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
          title="Hälytykset"
          @click="alarmsOpen = true"
        >
          <!-- Kello, ei hammasratas eikä aurinko — muoto: kellon runko + kieli
               alaosassa, tunnistettava hälytyskellon ikoni. -->
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
            />
          </svg>
          <span v-if="activeAlarmCount > 0" class="topbar__badge" aria-hidden="true"></span>
          <span class="sr-only">Hälytykset{{ activeAlarmCount > 0 ? ` (${activeAlarmCount} päällä)` : "" }}</span>
        </button>
        <button
          v-if="canEdit"
          class="topbar__settings"
          type="button"
          title="Asetukset"
          @click="settingsOpen = true"
        >
          <!-- Oikea hammasratas: ympyrä ja säteittäiset viivat olisivat aurinko,
               ei ratas — hampaiden pitää olla kehällä, ei siitä ulos osoittavia. -->
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.48.48 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
            />
          </svg>
          <span class="sr-only">Asetukset</span>
        </button>
      </div>
    </header>

    <p v-if="panelLayout.error.value" class="layout-error">{{ panelLayout.error.value }}</p>

    <main ref="gridEl" class="grid" :class="{ 'grid--editing': panelLayout.editing.value }">
      <LayoutEditor
        class="grid__slot--schedule"
        panel-id="schedule"
        :placement="panelLayout.layout.value.schedule"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('schedule', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('schedule', colSpan, rowSpan)"
      >
        <ScheduleCard
          :snapshot="wilma"
          :schedule="schedule"
          :layout="settings?.scheduleLayout ?? 'split'"
          :rollover-time="rolloverTime"
        />
      </LayoutEditor>

      <LayoutEditor
        class="grid__slot--weather"
        panel-id="weather"
        :placement="panelLayout.layout.value.weather"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('weather', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('weather', colSpan, rowSpan)"
      >
        <WeatherCard :snapshot="weather" :place="dashboard?.place" />
      </LayoutEditor>

      <LayoutEditor
        class="grid__slot--messages"
        panel-id="messages"
        :placement="panelLayout.layout.value.messages"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('messages', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('messages', colSpan, rowSpan)"
      >
        <MessagesCard :snapshot="wilma" :hide-previews="settings?.hideMessagePreviews ?? false" />
      </LayoutEditor>

      <LayoutEditor
        class="grid__slot--power"
        panel-id="electricity"
        :placement="panelLayout.layout.value.electricity"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('electricity', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('electricity', colSpan, rowSpan)"
      >
        <ElectricityCard :snapshot="electricity" :current-hour="currentHour" />
      </LayoutEditor>

      <LayoutEditor
        class="grid__slot--calendar"
        panel-id="calendar"
        :placement="panelLayout.layout.value.calendar"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('calendar', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('calendar', colSpan, rowSpan)"
      >
        <CalendarCard :snapshot="calendar" />
      </LayoutEditor>

      <LayoutEditor
        class="grid__slot--notes"
        panel-id="notes"
        :placement="panelLayout.layout.value.notes"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('notes', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('notes', colSpan, rowSpan)"
      >
        <NotesCard :notes="dashboard?.notes ?? []" :can-edit="canEdit" @refresh="refresh" />
      </LayoutEditor>
    </main>

    <SettingsPanel
      v-if="settings"
      :settings="settings"
      :students="students"
      :open="settingsOpen"
      @close="settingsOpen = false"
      @saved="refresh"
      @edit-layout="panelLayout.startEditing()"
    />

    <!--
      Ei v-if="settings": hälytysmoottorin (useAlarms-composable AlarmsPanelin
      sisällä) pitää olla käynnissä heti sivun latauduttua, oletusarvoisesti
      tyhjillä hälytyksillä, eikä vasta kun ensimmäinen /api/dashboard on
      onnistunut. Muuten palvelimen hetkellinen tavoittamattomuus juuri
      aamulla (esim. uudelleenkäynnistyksen jälkeen) jättäisi koko
      hälytysjärjestelmän lataamatta sen sijaan että se vain odottaisi
      asetuksia. AlarmsPanel käsittelee settings === null itse.
    -->
    <AlarmsPanel
      :settings="settings"
      :students="allStudents"
      :wilma-data="wilmaData"
      :now="now"
      :open="alarmsOpen"
      @close="alarmsOpen = false"
      @saved="refresh"
    />
  </div>
</template>

<style scoped>
.app {
  /* Ks. style.css:n #app — `100vh` jättää sisällön puhelimen alapalkin alle. */
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  /* Alareunaan puhelimen turva-alue (iOS:n kotipalkki) päälle normaalin
     täytteen, jottei viimeinen kortti pääty aivan palkin rajaan kiinni. */
  padding: 1.1rem 1.3rem max(1.3rem, env(safe-area-inset-bottom));
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
  position: relative;
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

/* Hienovarainen merkki siitä että vähintään yksi hälytys on päällä. */
.topbar__badge {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--accent-school);
}

.topbar--editing {
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 1rem;
}

.topbar__editing-label {
  font-size: 0.9rem;
  color: var(--text-dim);
}

/* Hylätyn siirron/koon muutoksen selite — huomiota herättävämpi väri, mutta
   ei mikään hälytys: sama paikka, ei modaalia, katoaa itsestään. */
.topbar__editing-label--notice {
  color: var(--mid);
}

.topbar__editing-actions {
  display: flex;
  gap: 0.6rem;
  flex-shrink: 0;
}

.edit-btn {
  min-height: 44px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

.edit-btn--primary {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.edit-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.layout-error {
  margin: 0;
  padding: 0.6rem 1rem;
  border-radius: 12px;
  background: rgba(247, 155, 155, 0.1);
  border: 1px solid rgba(247, 155, 155, 0.35);
  color: #f79b9b;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

/*
 * Ruudukko noudattaa types.ts:n GRID_COLUMNS x GRID_ROWS -koordinaatistoa
 * (6x8). Jokainen paneeli asemoidaan LayoutEditorin omalla inline-tyylillä
 * (grid-column/grid-row lasketaan placementista), joten tässä riittää
 * ruudukon rungon määrittely.
 */
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--gap);
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-template-rows: repeat(8, minmax(0, 1fr));
}

.grid--editing {
  outline: 1px dashed var(--border);
  outline-offset: 0.4rem;
  border-radius: var(--radius);
}

/*
 * Puhelin saa yhden sarakkeen, muistilista ensin. Grid-sijoittelu ohitetaan
 * kokonaan (display: flex), joten LayoutEditorin inline-tyylit (grid-column/
 * grid-row) eivät vaikuta mihinkään täällä — asettelun muokkaus koskee vain
 * leveää näyttöä.
 */
@media (max-width: 900px) {
  .grid {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .grid :deep(.panel-frame) {
    flex: 0 0 auto;
    min-height: 9rem;
  }

  .grid__slot--notes {
    order: 1;
  }
  .grid__slot--calendar {
    order: 2;
  }
  .grid__slot--weather {
    order: 3;
  }
  .grid__slot--power {
    order: 4;
  }
  .grid__slot--schedule {
    order: 5;
  }
  .grid__slot--messages {
    order: 6;
  }
}
</style>
