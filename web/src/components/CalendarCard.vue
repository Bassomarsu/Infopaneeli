<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import type { ProviderSnapshot } from "../types";

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  allDay: boolean;
  location: string | null;
  /** Local day this row falls on — a multi-day event contributes one row per day. */
  dateKey: string;
  /** Present only for multi-day events: which day of the span this row is, and the span length. */
  span?: { day: number; totalDays: number };
}

export interface CalendarData {
  events: CalendarEvent[];
}

const props = defineProps<{
  snapshot?: ProviderSnapshot<CalendarData>;
}>();

interface DayGroup {
  dateKey: string;
  label: string;
  events: CalendarEvent[];
}

const WEEKDAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"];

// Local YYYY-MM-DD, matching the server's dateKey format so the comparison
// below is a plain string equality rather than a timezone-sensitive parse.
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayLabel(dateKey: string, todayKey: string, tomorrowKey: string): string {
  if (dateKey === todayKey) return "Tänään";
  if (dateKey === tomorrowKey) return "Huomenna";
  // Constructed as UTC purely to read back the weekday of the date the key
  // names, mirroring WeatherCard's approach to the same off-by-one trap.
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const weekday = WEEKDAYS[utc.getUTCDay()] ?? "";
  const label = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${label} ${d}.${m}.`;
}

// Events arrive pre-sorted chronologically, so grouping into a Map and
// reading it back in insertion order keeps the days in the right sequence
// without a second sort here.
const groups = computed<DayGroup[]>(() => {
  const events = props.snapshot?.data?.events ?? [];
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayKey = localDateKey(today);
  const tomorrowKey = localDateKey(tomorrow);

  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = byDay.get(event.dateKey);
    if (list) list.push(event);
    else byDay.set(event.dateKey, [event]);
  }

  return [...byDay.entries()].map(([dateKey, dayEvents]) => ({
    dateKey,
    label: dayLabel(dateKey, todayKey, tomorrowKey),
    events: dayEvents,
  }));
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
}

// Monipäiväisen kellonaikaan sidotun tapahtuman start/end-hetki on sama
// jokaisella rivillä (koko instanssin hetki), joten kellonaikaa näytetään
// vain alku- ja loppupäivänä — välipäivinä se harhaanjohtaisi, koska
// tapahtuma ei ala eikä pääty silloin.
function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return "koko päivä";
  if (!event.span) return formatTime(event.start);
  if (event.span.day === 1) return formatTime(event.start);
  if (event.span.day === event.span.totalDays) return formatTime(event.end);
  return "koko päivä";
}
</script>

<template>
  <CardShell
    title="Kalenteri"
    accent="var(--accent-calendar)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
  >
    <div v-if="groups.length === 0" class="state">
      <span>Ei tulevia tapahtumia</span>
    </div>

    <div v-else class="calendar__days">
      <div v-for="group in groups" :key="group.dateKey" class="calendar__day">
        <h3 class="calendar__day-label">{{ group.label }}</h3>
        <ul class="calendar__events">
          <li v-for="event in group.events" :key="event.id" class="event">
            <span class="event__time tnum">{{ timeLabel(event) }}</span>
            <span class="event__main">
              <span class="event__title-row">
                <span class="event__title">{{ event.title }}</span>
                <span
                  v-if="event.span"
                  class="event__span tnum"
                  :title="`${event.span.day}. päivä ${event.span.totalDays}:sta`"
                >{{ event.span.day }}/{{ event.span.totalDays }}</span>
              </span>
              <span v-if="event.location" class="event__location">{{ event.location }}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </CardShell>
</template>

<style scoped>
.calendar__days {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}

.calendar__day-label {
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent-calendar);
}

.calendar__events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.event {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.event:last-child {
  border-bottom: none;
}

.event__time {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.event__main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.event__title-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}

.event__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1rem;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event__span {
  flex: 0 0 auto;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  color: var(--accent-calendar);
  background: rgba(196, 163, 245, 0.18);
  white-space: nowrap;
}

.event__location {
  font-size: 0.76rem;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
