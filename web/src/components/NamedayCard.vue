<script setup lang="ts">
import CardShell from './CardShell.vue';
import HouseholdList from './HouseholdList.vue';
import type { HouseholdData } from '../household.ts';
import type { NamedayData } from '../publicWidgets.ts';
defineProps<{ data: NamedayData | null; household: HouseholdData; canEdit: boolean; linkable?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
function dayLabel(date: string): string { return new Intl.DateTimeFormat('fi-FI', {day:'numeric',month:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')); }
</script>
<template>
 <CardShell title="Nimipäivät ja merkkipäivät" accent="var(--accent-calendar)" status="ok">
  <div class="namedays">
   <template v-if="data">
    <p class="names" data-card-row><strong>Tänään {{dayLabel(data.today.date)}}</strong><span>{{data.today.names.join(', ') || 'Ei nimipäiviä'}}</span></p>
    <p class="names" data-card-row><strong>Huomenna {{dayLabel(data.tomorrow.date)}}</strong><span>{{data.tomorrow.names.join(', ') || 'Ei nimipäiviä'}}</span></p>
    <p class="hint">Nimipäivät · kalenteri {{data.calendarYear}}. Myöhemmin lisätyt nimet puuttuvat.
     <a v-if="linkable" href="https://github.com/fergusq/nimipaivat/tree/53b17371022631140abdd560f85e0800fda415d6/2000" target="_blank" rel="noopener noreferrer">Aineiston lähde</a>
    </p>
   </template>
   <p v-else class="hint">Nimipäivätietoja odotetaan.</p>
   <h3>Omat merkkipäivät</h3>
   <HouseholdList kind="anniversaries" :household="household" :can-edit="canEdit" @refresh="emit('refresh')" />
  </div>
 </CardShell>
</template>
<style scoped>
.namedays{display:flex;flex-direction:column;gap:.6rem;height:100%;min-height:0;overflow:auto}.names{margin:0;line-height:1.4;font-size:.9rem}.names strong,.names span{display:block}.names strong{font-size:.8rem;color:var(--text-faint)}.hint{font-size:.73rem;line-height:1.4;color:var(--text-faint);margin:0}a{color:inherit}h3{font-size:.9rem;margin:.4rem 0 0}.namedays :deep(.household){height:auto;overflow:visible;flex-shrink:0}
</style>
