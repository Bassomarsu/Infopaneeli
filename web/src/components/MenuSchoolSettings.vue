<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
const props = defineProps<{ modelValue?: string[] }>();
const emit = defineEmits<{ "update:modelValue": [string[]] }>();
interface School { id: string; name: string; city: string }
const schools = ref<School[]>([]);
const query = ref("");
const loading = ref(false);
const error = ref("");
let controller: AbortController | undefined;
const selected = computed(() => props.modelValue ?? ["karstula_koulut"]);
const selectedSchools = computed(() => selected.value.map(id => schools.value.find(s => s.id === id) ?? { id, name: id === "karstula_koulut" ? "Karstulan koulut" : id, city: "" }));
const matches = computed(() => {
  const words = query.value.toLocaleLowerCase("fi").trim().split(/\s+/).filter(Boolean);
  return schools.value.filter(s => !selected.value.includes(s.id) && words.every(word => (s.name + " " + s.city).toLocaleLowerCase("fi").includes(word)));
});
function toggle(id: string) {
  if (selected.value.includes(id)) emit("update:modelValue", selected.value.filter(value => value !== id));
  else if (selected.value.length < 8) emit("update:modelValue", [...selected.value, id]);
}
async function load() {
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/menu-schools", { signal: controller.signal });
    if (!response.ok) throw new Error("Koulujen hakeminen ei onnistunut.");
    const data = await response.json();
    if (!Array.isArray(data.schools)) throw new Error("Koululuetteloa ei voitu lukea.");
    schools.value = data.schools.filter((s: School) => typeof s.id === "string" && typeof s.name === "string" && typeof s.city === "string");
  } catch (e) {
    if (e instanceof Error && e.name !== "AbortError") error.value = e.message;
  } finally { loading.value = false; }
}
onMounted(load);
onUnmounted(() => controller?.abort());
</script>
<template>
  <fieldset class="menu-settings">
    <legend>Ruokalistan koulut</legend>
    <p>Valitse lasten koulut tai yhteinen alueen ruokalista. Tiedot tulevat kouluruoka.fi-palvelusta. Kaikkia kouluja tai päiväkoteja ei löydy palvelusta.</p>
    <p class="selection-count">Valittu {{ selected.length }}/8. Muutokset tulevat voimaan, kun tallennat asetukset.</p>
    <div v-if="selectedSchools.length" class="selected">
      <label v-for="school in selectedSchools" :key="school.id" class="school">
        <input type="checkbox" checked @change="toggle(school.id)" />
        <span>{{ school.name }}<small v-if="school.city">{{ school.city }}</small></span>
      </label>
    </div>
    <p v-else>Ei valittuja kouluja.</p>
    <label class="search"><span>Hae koulua tai kuntaa</span><input v-model="query" type="search" placeholder="Koulun nimi tai kunta" /></label>
    <p v-if="loading" role="status">Haetaan kouluja…</p>
    <div v-else-if="error" role="alert"><p>{{ error }} Nykyiset valinnat säilyvät.</p><button type="button" @click="load">Yritä uudelleen</button></div>
    <template v-else>
      <p v-if="selected.length >= 8">Enintään kahdeksan ruokalistaa. Poista ensin jokin valinta.</p>
      <p v-if="!matches.length">Ei muita hakua vastaavia kouluja. Kokeile kunnan nimeä.</p>
      <div class="results">
        <label v-for="school in matches.slice(0, 100)" :key="school.id" class="school">
          <input type="checkbox" :checked="false" :disabled="selected.length >= 8" @change="toggle(school.id)" />
          <span>{{ school.name }}<small v-if="school.city">{{ school.city }}</small></span>
        </label>
      </div>
      <p v-if="matches.length > 100">Näytetään ensimmäiset 100 tulosta. Tarkenna hakua.</p>
    </template>
  </fieldset>
</template>
<style scoped>
.menu-settings { border: 1px solid var(--border); border-radius: .6rem; padding: 1rem; min-width: 0; }
legend { font-weight: 600; padding: 0 .3rem; }
p { font-size: .82rem; color: var(--text-faint); line-height: 1.5; margin: .5rem 0; }
.school { display: flex; align-items: center; gap: .7rem; padding: .55rem .2rem; font-size: .9rem; }
.school span { overflow-wrap: anywhere; }
.school small { display: block; color: var(--text-faint); font-size: .75rem; }
.school input { flex-shrink: 0; width: 1.1rem; height: 1.1rem; accent-color: var(--accent-calendar); }
.results { max-height: 15rem; overflow-y: auto; margin-top: .5rem; }
.selected { border-bottom: 1px solid var(--border); margin-bottom: .8rem; }
.search { display: flex; flex-direction: column; gap: .4rem; font-size: .85rem; }
.search input, button { font: inherit; padding: .6rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--bg); color: var(--text); }
</style>
