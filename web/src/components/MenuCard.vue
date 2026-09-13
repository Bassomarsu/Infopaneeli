<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import { useClock } from "../composables/useClock";
import type { ProviderSnapshot } from "../types";
import type { MenuData } from "../publicWidgets.ts";
const props = defineProps<{ snapshot?: ProviderSnapshot<MenuData>; linkable?: boolean }>();
const { now } = useClock();
const today = computed(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now.value));
const upcoming = computed(() => (props.snapshot?.data?.days ?? []).filter(d => d.date >= today.value));
function label(date: string): string {
  return (date === today.value ? "Tänään · " : "") + new Intl.DateTimeFormat("fi-FI", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(date));
}
</script>
<template>
  <CardShell title="Ruokalista" accent="var(--accent-calendar)" :status="snapshot?.status" :fetched-at="snapshot?.fetchedAt" :error="snapshot?.error" note="Karstulan koulut">
    <div class="menu">
      <p class="hint">Koulujen lista. Päiväkodin kattavuutta ei ole varmistettu.</p>
      <p v-if="snapshot?.data && !upcoming.length" class="hint">Tulevien päivien ruokalistaa ei ole julkaistu.</p>
      <section v-for="day in upcoming" :key="day.date" class="day">
        <h3>{{ label(day.date) }}</h3>
        <p v-if="!day.meals.length" class="hint">Lähteessä ei ole ateriatietoja.</p>
        <p v-for="(meal, i) in day.meals" :key="i" class="meal"><span>{{ meal.type }}</span>{{ meal.name }}</p>
      </section>
      <a v-if="linkable" href="https://kouluruoka.fi/menu/karstula_koulut/" target="_blank" rel="noopener noreferrer">Lähde: kouluruoka.fi</a>
      <span v-else class="hint">Lähde: kouluruoka.fi</span>
    </div>
  </CardShell>
</template>
<style scoped>
.menu { overflow: auto; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: .7rem; }
.day { border-bottom: 1px solid var(--border); padding-bottom: .5rem; }
h3 { margin: 0 0 .4rem; font-size: .95rem; }
.meal { margin: .35rem 0; line-height: 1.4; font-size: .85rem; }
.meal span { display: block; color: var(--text-faint); font-size: .73rem; }
.hint, a { color: var(--text-faint); font-size: .74rem; margin: 0; line-height: 1.4; }
</style>
