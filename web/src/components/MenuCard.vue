<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import { useClock } from "../composables/useClock";
import type { ProviderSnapshot } from "../types";
import type { MenuCollection } from "../publicWidgets.ts";
const props = defineProps<{ snapshot?: ProviderSnapshot<MenuCollection>; selectedIds: string[]; linkable?: boolean }>();
const { now } = useClock();
const today = computed(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now.value));
const schools = computed(() => props.selectedIds.map(id => {
  const school = props.snapshot?.data?.schools?.find(s => s.locationId === id);
  return school ?? { locationId: id, locationName: id === "karstula_koulut" ? "Karstulan koulut" : id, sourceUrl: "", days: [], status: "loading" as const, error: null, fetchedAt: null };
}));
function label(date: string): string {
  return (date === today.value ? "Tänään · " : "") + new Intl.DateTimeFormat("fi-FI", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(date));
}
</script>
<template>
  <CardShell title="Ruokalista" accent="var(--accent-calendar)" status="ok" note="kouluruoka.fi">
    <div class="menu">
      <p v-if="!selectedIds.length" class="hint">Valitse lasten koulut asetusten kohdasta Ruokalistan koulut.</p>
      <section v-for="school in schools" :key="school.locationId" class="school">
        <h3>{{ school.locationName }}</h3>
        <p v-if="school.status === 'loading'" class="hint">Haetaan ruokalistaa…</p>
        <p v-if="school.error" class="hint warning">{{ school.error }}</p>
        <p v-if="school.status === 'stale'" class="hint warning">Näytetään aiemmin haettu ruokalista.</p>
        <p v-if="school.status === 'ok' && !school.days.some(d => d.date >= today)" class="hint">Tulevien päivien ruokalistaa ei ole julkaistu.</p>
        <section v-for="day in school.days.filter(d => d.date >= today)" :key="day.date" class="day">
          <h4>{{ label(day.date) }}</h4>
          <p v-if="!day.meals.length" class="hint">Lähteessä ei ole ateriatietoja.</p>
          <p v-for="(meal, i) in day.meals" :key="i" class="meal"><span>{{ meal.type }}</span>{{ meal.name }}</p>
        </section>
        <a v-if="linkable && school.sourceUrl" :href="school.sourceUrl" target="_blank" rel="noopener noreferrer">Lähde: kouluruoka.fi</a>
        <span v-else class="hint">Lähde: kouluruoka.fi</span>
      </section>
    </div>
  </CardShell>
</template>
<style scoped>
.menu { overflow: auto; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 1rem; }
.school + .school { border-top: 2px solid var(--border); padding-top: .8rem; }
.day { border-bottom: 1px solid var(--border); padding: .6rem 0; }
h3 { margin: 0 0 .4rem; font-size: 1rem; }
h4 { margin: 0 0 .4rem; font-size: .9rem; }
.meal { margin: .35rem 0; line-height: 1.4; font-size: .85rem; }
.meal span { display: block; color: var(--text-faint); font-size: .73rem; }
.hint, a { color: var(--text-faint); font-size: .74rem; margin: 0; line-height: 1.4; }
.warning { color: var(--text); }
</style>
