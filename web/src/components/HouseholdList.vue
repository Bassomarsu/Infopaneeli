<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { mutateHousehold, dateLabel, type HouseholdData } from '../household.ts';
const props = defineProps<{ household: HouseholdData; canEdit: boolean; kind: keyof HouseholdData }>();
const emit = defineEmits<{ refresh: [] }>();
const editing = ref<string | null>(null), open = ref(false), label = ref(''), date = ref(''), interval = ref(1), annual = ref(true), busy = ref(false), error = ref(''), deleting = ref<string | null>(null);
const rows = computed(() => props.household[props.kind].map(item => ({id:item.id,label:'text' in item ? item.text : item.label,date:'nextDate' in item ? item.nextDate : 'occurrenceDate' in item ? item.occurrenceDate : '',done:'done' in item && item.done,completedDate:'completedDate' in item ? item.completedDate : null})).sort((a,b)=>Number(a.done)-Number(b.done)));
watch(() => props.canEdit, allowed => { if (!allowed) { open.value=false; deleting.value=null; } });
function edit(id?: string) {
 editing.value=id??null; const item=props.household[props.kind].find(row=>row.id===id);
 label.value=item ? ('text' in item ? item.text : item.label) : ''; date.value=item && 'date' in item ? item.date : new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Helsinki'}).format(new Date());
 interval.value=item && 'intervalWeeks' in item ? item.intervalWeeks : 1; annual.value=item && 'annual' in item ? item.annual : true; error.value=''; open.value=true;
}
async function run(method:'POST'|'PATCH'|'DELETE', body?:Record<string,unknown>, id?:string) {
 if (busy.value || !props.canEdit) return; busy.value=true; error.value='';
 try { await mutateHousehold(props.kind,method,body,id); open.value=false; deleting.value=null; emit('refresh'); } catch(e) { error.value=e instanceof Error ? e.message : 'Tallennus epäonnistui'; } finally {busy.value=false;}
}
function save() { const body:Record<string,unknown>=props.kind==='shopping' ? {text:label.value} : {label:label.value,date:date.value}; if(props.kind==='waste')body.intervalWeeks=interval.value; if(props.kind==='seasonal')body.annual=annual.value; void run(editing.value?'PATCH':'POST',body,editing.value??undefined); }
</script>
<template>
 <div class="household">
  <button v-if="canEdit && !open" @click="edit()" :disabled="busy">Lisää</button>
  <p v-if="!canEdit" class="hint">Muokkaa avaamalla lukko yläpalkista.</p>
  <p v-if="error" role="alert" class="error">{{error}}</p>
  <form v-if="open && canEdit" @submit.prevent="save">
   <label>{{kind==='shopping'?'Ostos':'Nimi'}}<input v-model="label" required maxlength="200" :disabled="busy" /></label>
   <label v-if="kind!=='shopping'">{{kind==='waste'?'Seuraava tiedossa oleva nouto':'Päivämäärä'}}<input type="date" v-model="date" required min="1900-01-01" max="9998-12-31" :disabled="busy" /></label>
   <label v-if="kind==='waste'">Toistoväli viikkoina (0 = kerran)<input type="number" v-model.number="interval" min="0" max="52" required :disabled="busy" /></label>
   <label v-if="kind==='seasonal'" class="check"><input type="checkbox" v-model="annual" :disabled="busy" />Toistuu vuosittain</label>
   <div class="actions"><button :disabled="busy || !label.trim()">Tallenna</button><button type="button" :disabled="busy" @click="open=false">Peruuta</button></div>
  </form>
  <p v-if="!rows.length" class="hint">Ei merkintöjä.{{canEdit?' Lisää ensimmäinen yllä olevasta painikkeesta.':''}}</p>
  <ul><li v-for="row in rows" :key="row.id">
   <div class="entry" :class="{done:row.done}"><button v-if="canEdit && (kind==='shopping'||kind==='seasonal')" class="toggle" :disabled="busy" :aria-label="row.done ? 'Merkitse tekemättömäksi: '+row.label : 'Merkitse tehdyksi: '+row.label" :aria-pressed="row.done" @click="run('PATCH',{done:!row.done,...(kind==='seasonal'?{occurrenceDate:row.date}:{})},row.id)">{{row.done?'✓':'○'}}</button><div><strong>{{row.label}}</strong><time v-if="row.date" :datetime="row.date">{{dateLabel(row.date)}}</time></div></div>
   <div v-if="canEdit" class="actions"><button v-if="kind==='seasonal' && row.completedDate && !row.done" :disabled="busy" @click="run('PATCH',{done:false,occurrenceDate:row.completedDate},row.id)">Peru kuittaus {{dateLabel(row.completedDate)}}</button><template v-if="deleting===row.id"><span>Poistetaanko?</span><button :disabled="busy" @click="run('DELETE',undefined,row.id)">Kyllä, poista</button><button :disabled="busy" @click="deleting=null">Peruuta</button></template><template v-else><button :disabled="busy" @click="edit(row.id)">Muokkaa</button><button :disabled="busy" @click="deleting=row.id">Poista</button></template></div>
  </li></ul>
 </div>
</template>
<style scoped>
.household{display:flex;flex-direction:column;gap:.55rem;min-height:0;height:100%;overflow:auto}ul{list-style:none;margin:0;padding:0}li{padding:.65rem 0;border-bottom:1px solid var(--border)}.entry{display:flex;align-items:center;gap:.5rem;overflow-wrap:anywhere}time{display:block;color:var(--text-muted)}.done strong{text-decoration:line-through;opacity:.6}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin-top:.3rem}button,input{min-height:44px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;padding:.4rem .6rem}button{cursor:pointer;min-width:44px}button:disabled{opacity:.5;cursor:default}form{display:grid;gap:.5rem}label{display:grid;gap:.25rem}input{width:100%;min-width:0;box-sizing:border-box}.check{display:flex;align-items:center}.check input{width:24px}.error{color:#f79b9b}.hint{color:var(--text-muted);font-size:.85rem;margin:0}.toggle{flex-shrink:0}strong{font-weight:500}
</style>
