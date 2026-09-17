<script setup lang="ts">
import { computed } from 'vue';
import { useClock } from '../composables/useClock';
import CardShell from './CardShell.vue';
import HouseholdList from './HouseholdList.vue';
import type { HouseholdData } from '../household.ts';
import type { ProviderSnapshot } from '../types.ts';
import { safeWasteUrl, type WasteData } from '../waste.ts';
const props = defineProps<{ household: HouseholdData; canEdit: boolean; snapshot?: ProviderSnapshot<WasteData>; linkable?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const automatic = computed(() => props.snapshot?.status === 'hidden' ? undefined : props.snapshot?.data);
const { now } = useClock();
const today = computed(() => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Helsinki'}).format(now.value));
const upcoming = computed(() => (automatic.value?.events ?? []).filter(e => e.date >= today.value));
const sourceUrl = computed(() => safeWasteUrl(automatic.value?.sourceUrl));
function dateLabel(date: string) {
  const parsed = new Date(date + 'T12:00:00Z');
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', weekday: 'short', day: 'numeric', month: 'numeric' }).format(parsed);
}
</script>
<template>
  <CardShell title="Roskien nouto" status="ok" accent="var(--accent-calendar)">
    <div class="waste-content">
      <section aria-label="Automaattinen noutoaikataulu" class="automatic">
        <h3>Automaattinen aikataulu<span v-if="automatic?.companyName"> · {{ automatic.companyName }}</span></h3>
        <p v-if="snapshot?.status === 'hidden'">Kiinteistön aikataulu näkyy täydellä käyttöoikeudella.</p>
        <template v-else>
          <p v-if="snapshot?.status === 'stale'" class="warning" role="status">Automaattinen haku epäonnistui. Alla näkyvät aiemmin haetut noutopäivät voivat olla vanhentuneita.</p>
          <p v-else-if="snapshot?.status === 'failed'" class="warning" role="status">Automaattista aikataulua ei saatu. Tarkista jätehuollon yhteys asetuksista.</p>
          <p v-else-if="snapshot?.status === 'idle' && automatic?.enabled">Haetaan noutopäiviä…</p>
          <p v-else-if="!automatic?.enabled">Automaattinen haku ei ole käytössä. Yhteyden voi määrittää asetuksista.</p>
          <ul v-if="automatic?.enabled && upcoming.length">
            <li v-for="event in upcoming.slice(0, 30)" :key="event.id" data-card-row><span>{{ event.label }}</span><time :datetime="event.date">{{ dateLabel(event.date) }}</time></li>
          </ul>
          <p v-else-if="automatic?.enabled && snapshot?.status === 'ok'">Palvelu ei ilmoita tulevia noutopäiviä.</p>
          <p v-if="snapshot?.fetchedAt && automatic?.enabled">Haettu {{ new Date(snapshot.fetchedAt).toLocaleString('fi-FI') }}. Tarkista myös yhtiön poikkeustiedotteet.</p>
          <a v-if="linkable && sourceUrl" :href="sourceUrl" target="_blank" rel="noopener noreferrer">Jätehuollon palvelu</a>
        </template>
      </section>
      <section aria-label="Käsin asetettu aikataulu"><h3>Käsin asetettu aikataulu</h3><HouseholdList :household="household" :can-edit="canEdit" kind="waste" @refresh="emit('refresh')" /></section>
    </div>
  </CardShell>
</template>
<style scoped>
.waste-content { height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
/* HouseholdListin oma `height: 100%; overflow: auto` on tarkoitettu korttiin
   jossa lista on koko sisalto. Taalla se on yksi osio kahdesta, ja sen
   otsikon `h3` verran liian korkea laatikko tyonsi kortin 21 px ylivuotoon
   ilman etta yksikaan rivi jai piiloon (mitattu 2736 x 1824, koko 2 x 2) —
   kortti siis varoitti tyhjasta. Vieritys kuuluu tassa .waste-contentille.
   Sama korjaus kuin NamedayCard.vuessa, samasta syysta. */
.waste-content :deep(.household) { height: auto; overflow: visible; flex-shrink: 0; }
h3 { font-size: .85rem; font-weight: 600; margin: 0 0 .5rem; }
p { font-size: .82rem; color: var(--text-faint); line-height: 1.45; margin: .4rem 0; }
.automatic { padding-bottom: .7rem; border-bottom: 1px solid var(--border); }
ul { list-style: none; padding: 0; margin: .3rem 0; }
li { display: flex; justify-content: space-between; gap: 1rem; padding: .4rem 0; font-size: .9rem; }
li span { overflow-wrap: anywhere; } time { white-space: nowrap; }
a { font-size: .8rem; color: var(--accent-calendar); }.warning { color: var(--warning, #d8a95b); }
</style>
