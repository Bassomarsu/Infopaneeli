<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import type { ScheduleDay, UseScheduleDay } from "../composables/useScheduleDay";
import type { HomeworkItem, ProviderSnapshot, WilmaData } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<WilmaData>;
  /** Koko useScheduleDay-composable, jotta selaus voidaan hoitaa kortin sisällä. */
  schedule: UseScheduleDay;
  layout: "single" | "split";
  rolloverTime: string;
}>();

const day = computed<ScheduleDay | null>(() => props.schedule.day.value);
const browsing = computed(() => props.schedule.browsing.value);
const canGoBack = computed(() => props.schedule.canGoBack.value);
const canGoForward = computed(() => props.schedule.canGoForward.value);

/**
 * With `single` the children share the same column and are listed one after
 * the other; with `split` they get a column each. Anything above two children
 * would make the columns unreadable from across the room, so the split is
 * capped and the rest fall below.
 */
const columns = computed(() => {
  const groups = day.value?.lessonsByStudent ?? [];
  if (props.layout === "single" || groups.length <= 1) return 1;
  return Math.min(groups.length, 2);
});

const showStudentNames = computed(() => (day.value?.lessonsByStudent.length ?? 0) > 1);

/**
 * Yhden lapsen näkymässä nimi kuuluu otsikkoon: muuten ruudulla on
 * lukujärjestys ilman mitään merkkiä siitä, kenen se on. Useamman lapsen
 * näkymässä nimet ovat jo sarakkeiden yllä, joten otsikkoon ne vain
 * toistuisivat.
 */
const cardTitle = computed(() => {
  const groups = day.value?.lessonsByStudent ?? [];
  const only = groups.length === 1 ? groups[0] : undefined;
  return only ? `Lukujärjestys — ${only.name}` : "Lukujärjestys";
});

function homeworkFor(student: string, subjectCode: string): HomeworkItem | undefined {
  const data = props.snapshot?.data;
  const current = day.value;
  if (!data || !current) return undefined;
  return data.byStudent[student]?.homework.find(
    (item) => item.date === current.date && item.subjectCode === subjectCode,
  );
}

/**
 * Vaakasuoran pyyhkäisyn pitää erottua napautuksesta ja pystysuorasta
 * vierityksestä, joten liikkeen on ylitettävä tämä kynnys ja oltava
 * selvemmin vaaka- kuin pystysuuntainen ennen kuin se vaihtaa päivää.
 */
const SWIPE_THRESHOLD_PX = 50;

let swipePointerId: number | null = null;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeLastX = 0;

function onSwipeStart(event: PointerEvent): void {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  swipePointerId = event.pointerId;
  swipeStartX = event.clientX;
  swipeStartY = event.clientY;
  swipeLastX = event.clientX;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onSwipeMove(event: PointerEvent): void {
  if (event.pointerId !== swipePointerId) return;
  swipeLastX = event.clientX;
}

function onSwipeEnd(event: PointerEvent): void {
  if (event.pointerId !== swipePointerId) return;
  const dx = swipeLastX - swipeStartX;
  const dy = event.clientY - swipeStartY;
  swipePointerId = null;
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
  if (dx < 0) props.schedule.goToNextDay();
  else props.schedule.goToPreviousDay();
}

function onSwipeCancel(event: PointerEvent): void {
  if (event.pointerId === swipePointerId) swipePointerId = null;
}
</script>

<template>
  <CardShell
    :title="cardTitle"
    accent="var(--accent-school)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
  >
    <div v-if="day" class="schedule">
      <header class="schedule__head">
        <div class="schedule__title">
          <span class="schedule__day">{{ day.label }}</span>
          <span v-if="day.rolledOver" class="schedule__hint">vaihtui klo {{ rolloverTime }}</span>
        </div>
        <div class="schedule__nav">
          <button
            v-if="browsing"
            type="button"
            class="schedule__today-btn"
            @click="schedule.returnToToday()"
          >
            Tänään
          </button>
          <button
            type="button"
            class="schedule__nav-btn"
            aria-label="Edellinen päivä"
            :disabled="!canGoBack"
            @click="schedule.goToPreviousDay()"
          >
            ‹
          </button>
          <button
            type="button"
            class="schedule__nav-btn"
            aria-label="Seuraava päivä"
            :disabled="!canGoForward"
            @click="schedule.goToNextDay()"
          >
            ›
          </button>
        </div>
      </header>

      <div
        class="schedule__body"
        @pointerdown="onSwipeStart"
        @pointermove="onSwipeMove"
        @pointerup="onSwipeEnd"
        @pointercancel="onSwipeCancel"
      >
        <div v-if="day.totalLessons === 0" class="state">
          <span class="state__title">Ei tunteja</span>
          <span>Lukujärjestyksessä ei ole merkintöjä.</span>
        </div>

        <div v-else class="schedule__cols" :style="{ '--cols': columns }">
          <div v-for="group in day.lessonsByStudent" :key="group.studentNumber" class="schedule__col">
            <h3 v-if="showStudentNames" class="schedule__name">{{ group.name }}</h3>

            <p v-if="group.lessons.length === 0" class="schedule__empty">Ei tunteja</p>

            <ol v-else class="lessons">
              <li v-for="lesson in group.lessons" :key="`${lesson.start}-${lesson.groupId}`" class="lesson">
                <span class="lesson__time tnum">
                  {{ lesson.start }}<span class="lesson__end">–{{ lesson.end }}</span>
                </span>
                <span class="lesson__main">
                  <span class="lesson__subject">{{ lesson.subject || lesson.subjectCode }}</span>
                  <span v-if="lesson.teacher" class="lesson__teacher">{{ lesson.teacher }}</span>
                  <span
                    v-if="homeworkFor(group.studentNumber, lesson.subjectCode)"
                    class="lesson__homework"
                  >
                    {{ homeworkFor(group.studentNumber, lesson.subjectCode)?.homework }}
                  </span>
                </span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="state">
      <span class="state__title">Ei lukujärjestystietoja</span>
      <span>Wilma-tunnukset puuttuvat tai oppilaita ei löytynyt.</span>
    </div>
  </CardShell>
</template>

<style scoped>
.schedule {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
  flex: 1;
}

.schedule__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  flex-shrink: 0;
}

.schedule__title {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  min-width: 0;
}

.schedule__day {
  font-size: 1.45rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.schedule__hint {
  font-size: 0.72rem;
  color: var(--text-faint);
}

.schedule__nav {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.schedule__today-btn {
  min-height: 44px;
  padding: 0 0.9rem;
  background: var(--accent-school);
  border: none;
  border-radius: 10px;
  color: #0b0d12;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
}

.schedule__nav-btn {
  min-height: 44px;
  min-width: 44px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 1.3rem;
  line-height: 1;
  cursor: pointer;
}

.schedule__nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.schedule__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  /* Pyyhkäisy vaihtaa päivää pystysuunnassa vieritettävälläkin alueella, joten
     kosketuksen oletustoiminnot (mm. selaimen omat eleet) on rajattava pois. */
  touch-action: pan-y;
}

.schedule__cols {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: 1.4rem;
  min-height: 0;
  overflow-y: auto;
  flex: 1;
}

.schedule__col {
  min-width: 0;
}

.schedule__name {
  margin: 0 0 0.45rem;
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent-school);
}

.schedule__empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 0.9rem;
}

.lessons {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

/* Loppuaika oli aiemmin rivin oikeassa laidassa, erillään alkuajasta. Se jäi
   helposti huomaamatta, koska katse hakee ajan rivin alusta eikä sen toisesta
   päästä. Nyt ne luetaan yhtenä lukuna "08:30–09:15", ja rivi tarvitsee vain
   kaksi saraketta. */
.lesson {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.42rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.lesson:last-child {
  border-bottom: none;
}

/* Kellonajat hieman aineen nimeä pienempinä: aine on rivin varsinainen
   sisältö, aika sen tarkenne. Alku- ja loppuaika ovat keskenään samanlaiset —
   ne luetaan yhtenä lukuna, eikä kumpaakaan pidä painottaa toisen yli. */
.lesson__time {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.lesson__end {
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
}

.lesson__main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.lesson__subject {
  font-size: 1.05rem;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lesson__teacher {
  font-size: 0.76rem;
  color: var(--text-faint);
}

.lesson__homework {
  font-size: 0.78rem;
  color: var(--accent-school);
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
