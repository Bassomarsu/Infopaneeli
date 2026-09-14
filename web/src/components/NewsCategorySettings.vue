<script setup lang="ts">
import { onMounted, ref } from 'vue';
const model = defineModel<string[]>({ default: () => ['paauutiset'] });
const categories = ref<{id:string;name:string}[]>([]);
const error = ref('');
async function load() {
  error.value = '';
  try { const r = await fetch('/api/news/categories'); if (!r.ok) throw Error(); categories.value = (await r.json()).categories; }
  catch { error.value = 'Uutiskategorioita ei saatu. Yritä uudelleen.'; }
}
function toggle(id:string, checked:boolean) {
  model.value = checked ? [...new Set([...model.value, id])] : model.value.filter(x => x !== id);
}
onMounted(load);
</script>
<template>
  <fieldset class="categories">
    <legend>Uutiskategoriat · Yle</legend>
    <p>Valitse 1–8 kategoriaa. Samat uutiset näytetään vain kerran.</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">Yritä uudelleen</button></p>
    <label v-for="category in categories" :key="category.id">
      <input type="checkbox" :checked="model.includes(category.id)" :disabled="!model.includes(category.id) && model.length >= 8" @change="toggle(category.id, ($event.target as HTMLInputElement).checked)" />
      {{ category.name }}
    </label>
    <p v-if="!model.length" role="alert">Valitse vähintään yksi kategoria.</p>
  </fieldset>
</template>
<style scoped>
.categories{border:0;border-top:1px solid var(--border);margin:0;padding:1rem 0;display:flex;flex-direction:column;gap:.75rem}legend{font-weight:600}p{font-size:.85rem;color:var(--text-dim);margin:0}label{display:flex;gap:.65rem;align-items:center;min-height:32px}input{width:18px;height:18px;accent-color:var(--accent-school)}
</style>
