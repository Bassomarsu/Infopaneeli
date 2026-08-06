<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import type { ScheduleDay } from "../composables/useScheduleDay";
import type { HomeworkItem, ProviderSnapshot, WilmaData } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<WilmaData>;
  day: ScheduleDay | null;
  layout: "single" | "split";
  rolloverTime: string;
}>();

/**
 * With `single` the children share the same column and are listed one after
 * the other; with `split` they get a column each. Anything above two children
 * would make the columns unreadable from across the room, so the split is
 * capped and the rest fall below.
 */
const columns = computed(() => {
  const groups = props.day?.lessonsByStudent ?? [];
  if (props.layout === "single" || groups.length <= 1) return 1;
  return Math.min(groups.length, 2);
});

const showStudentNames = computed(() => (props.day?.lessonsByStudent.length ?? 0) > 1);

function homeworkFor(student: string, subjectCode: string): HomeworkItem | undefined {
  const data = props.snapshot?.data;
  if (!data || !props.day) return undefined;
  return data.byStudent[student]?.homework.find(
    (item) => item.date === props.day?.date && item.subjectCode === subjectCode,
  );
}
</script>

<template>
  <CardShell
    title="Lukujärjestys"
    accent="var(--accent-school)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
  >
    <div v-if="day" class="schedule">
      <header class="schedule__head">
        <span class="schedule__day">{{ day.label }}</span>
        <span v-if="day.rolledOver" class="schedule__hint">vaihtui klo {{ rolloverTime }}</span>
      </header>

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
              <span class="lesson__time tnum">{{ lesson.start }}</span>
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
              <span class="lesson__end tnum">{{ lesson.end }}</span>
            </li>
          </ol>
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
  align-items: baseline;
  gap: 0.7rem;
  flex-shrink: 0;
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

.lesson {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.42rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.lesson:last-child {
  border-bottom: none;
}

.lesson__time {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.lesson__end {
  font-size: 0.8rem;
  color: var(--text-faint);
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
