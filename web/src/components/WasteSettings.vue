<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useEditAccess } from '../composables/useEditAccess.ts';
import { safeWasteUrl, type WasteCompany, type WasteConfig, type WasteProperty } from '../waste.ts';
const props = defineProps<{ allowed: boolean; linkable?: boolean }>();
const access = useEditAccess();
const companies = ref<WasteCompany[]>([]);
const config = ref<WasteConfig | null>(null);
const companyId = ref(''), municipality = ref(''), address = ref('');
const username = ref(''), password = ref(''), propertyId = ref('');
const properties = ref<WasteProperty[]>([]);
const busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
const company = computed(() => companies.value.find(item => item.id === companyId.value));
const suggestions = computed(() => {
  const query = municipality.value.trim().toLocaleLowerCase('fi');
  return query.length < 2 ? [] : companies.value.filter(item => item.municipalities.some(name => name.toLocaleLowerCase('fi').includes(query)));
});
const dirty = computed(() => !config.value || companyId.value !== config.value.companyId || municipality.value !== config.value.municipality || address.value !== config.value.address || !!username.value || !!password.value);
const serviceUrl = computed(() => safeWasteUrl(company.value?.website));
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await access.editFetch('/api/waste/' + path, { method, cache: 'no-store', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 429 ? 'Hakuja tehtiin liian tiheästi. Odota minuutti ennen uutta yritystä.' : response.status === 403 ? 'Tarvitset täyden käyttöoikeuden jätehuollon yhteyden asetuksiin.' : 'Jätehuollon pyyntö epäonnistui. Tarkista yhteys ja tunnukset ja yritä uudelleen.');
  return response.json();
}
function apply(value: WasteConfig) {
  config.value = value; companyId.value = value.companyId; municipality.value = value.municipality; address.value = value.address; propertyId.value = value.propertyId;
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await action(); } catch (e) { error.value = e instanceof Error ? e.message : 'Pyyntö epäonnistui.'; } finally { busy.value = false; }
}
async function load() {
  if (!props.allowed) return;
  await run(async () => {
    const [list, stored] = await Promise.all([request<{ companies: WasteCompany[] }>('companies'), request<WasteConfig>('config')]);
    if (!props.allowed) return;
    companies.value = list.companies; apply(stored); loaded.value = true;
  });
}
async function saveConnection() {
  await run(async () => {
    await request('config', 'PUT', { companyId: companyId.value, municipality: municipality.value.trim(), address: address.value.trim(), enabled: false, ...(username.value ? { username: username.value } : {}), ...(password.value ? { password: password.value } : {}) });
    username.value = ''; password.value = ''; properties.value = [];
    apply(await request<WasteConfig>('config'));
    notice.value = company.value?.adapter === 'vingo' ? 'Yhteys tallennettu. Hae seuraavaksi kiinteistöt ja valitse oma kiinteistösi.' : 'Valinta tallennettu. Käytä käsin asetettua aikataulua.';
  });
}
async function loadProperties() {
  await run(async () => {
    const data = await request<{ properties: WasteProperty[] }>('properties', 'POST');
    properties.value = data.properties;
    if (!properties.value.some(item => item.id === propertyId.value)) propertyId.value = '';
    notice.value = properties.value.length ? 'Valitse kiinteistö ja ota automaattinen haku käyttöön.' : 'Tililtä ei löytynyt kiinteistöjä. Tarkista sähköisestä asioinnista, että kiinteistö on liitetty tiliisi.';
  });
}
async function enable() {
  await run(async () => {
    await request('config', 'PUT', { propertyId: propertyId.value, address: properties.value.find(item => item.id === propertyId.value)?.address ?? address.value, enabled: true });
    apply(await request<WasteConfig>('config'));
    notice.value = 'Automaattinen haku on käytössä. Aikataulu päivittyy korttiin.';
  });
}
async function disable() {
  await run(async () => {
    await request('config', 'PUT', { enabled: false });
    apply(await request<WasteConfig>('config')); notice.value = 'Automaattinen haku on pois käytöstä. Käsin asetettu aikataulu säilyy.';
  });
}
async function refresh() {
  await run(async () => { await request('refresh', 'POST'); notice.value = 'Päivityspyyntö käsitelty. Näet aikataulun ja yhteyden tilan kortissa.'; });
}
watch(companyId, () => { username.value = ''; password.value = ''; properties.value = []; });
watch(() => props.allowed, allowed => {
  if (allowed) void load();
  else { config.value = null; loaded.value = false; username.value = ''; password.value = ''; address.value = ''; properties.value = []; }
}, { immediate: true });
</script>
<template>
  <fieldset class="waste-settings">
    <legend>Jätehuollon automaattinen aikataulu</legend>
    <p>Paikkakunta auttaa löytämään jätehuoltoyhtiön. Oman kiinteistön noutopäivät vaativat yhtiön sähköisen asioinnin tunnukset ja kiinteistön valinnan.</p>
    <p v-if="!allowed">Avaa täydet käyttöoikeudet, jotta voit muuttaa yhteyttä. Käsin asetettua aikataulua voi käyttää ilman yhteyttä.</p>
    <template v-else>
      <p class="separate">Yhteysasetukset tallennetaan omilla painikkeillaan heti. Ikkunan sulkeminen ei peru tallennuksia.</p>
      <p v-if="busy" role="status">Käsitellään pyyntöä…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <button v-if="!loaded && !busy" type="button" @click="load">Lataa yhteysasetukset</button>
      <div v-if="loaded" class="fields">
        <label>Jätehuollon paikkakunta<input v-model="municipality" autocomplete="address-level2" :disabled="busy" /></label>
        <div v-if="suggestions.length" class="suggestions"><span>Paikkakuntaan sopivia yhtiöitä:</span><button v-for="item in suggestions" :key="item.id" type="button" :disabled="busy" @click="companyId = item.id">{{ item.name }}</button></div>
        <label>Jätehuoltoyhtiö<select aria-label="Jätehuoltoyhtiö" v-model="companyId" :disabled="busy"><option value="">Valitse yhtiö</option><option v-for="item in companies" :key="item.id" :value="item.id">{{ item.name }}{{ item.adapter === 'manual' ? ' — käsin asetettava aikataulu' : '' }}</option></select></label>
        <p>Voit valita minkä tahansa luettelon yhtiön. Jos yhtiötä ei löydy tai automaattista yhteyttä ei ole, määritä noudot käsin Roskien nouto -kortissa.</p>
        <label>Kiinteistön osoite<input v-model="address" autocomplete="street-address" :disabled="busy" /></label>
        <template v-if="company?.adapter === 'vingo'">
          <p v-if="config?.configured && companyId === config.companyId">Tunnukset on tallennettu. Jätä kentät tyhjiksi säilyttääksesi ne.</p>
          <label>Jätehuollon käyttäjätunnus<input v-model="username" autocomplete="username" :disabled="busy" /></label>
          <label>Jätehuollon salasana<input v-model="password" type="password" autocomplete="current-password" :disabled="busy" /></label>
        </template>
        <p v-else-if="company">Tälle yhtiölle ei ole vielä automaattista yhteyttä. Käsin asetettu aikataulu toimii kaikkialla Suomessa.</p>
        <a v-if="linkable && serviceUrl" :href="serviceUrl" target="_blank" rel="noopener noreferrer">Avaa yhtiön palvelu</a>
        <button type="button" :disabled="busy || !companyId" @click="saveConnection">Tallenna jätehuollon yhteys</button>
        <template v-if="company?.adapter === 'vingo'">
          <p v-if="dirty">Tallenna yhteys ennen kiinteistöjen hakemista. Tallennus pysäyttää automaattisen haun, kunnes valitset kiinteistön uudelleen.</p>
          <p v-if="config?.blocked">Kirjautuminen on estynyt. Tarkista tunnukset, tallenna yhteys ja hae kiinteistöt uudelleen.</p>
          <button type="button" :disabled="busy || dirty || !config?.configured" @click="loadProperties">Hae kiinteistöt</button>
          <template v-if="properties.length">
            <label>Jätehuollon kiinteistö<select aria-label="Jätehuollon kiinteistö" v-model="propertyId" :disabled="busy"><option value="">Valitse kiinteistö</option><option v-for="item in properties" :key="item.id" :value="item.id">{{ item.address }}</option></select></label>
            <button type="button" :disabled="busy || dirty || !propertyId" @click="enable">Ota automaattinen haku käyttöön</button>
          </template>
          <template v-if="config?.enabled">
            <p>Automaattinen haku on käytössä.</p>
            <button type="button" :disabled="busy || dirty" @click="refresh">Päivitä noutopäivät nyt</button>
            <button type="button" :disabled="busy" @click="disable">Poista automaattinen haku käytöstä</button>
          </template>
        </template>
      </div>
    </template>
  </fieldset>
</template>
<style scoped>
.waste-settings { border: 1px solid var(--border); border-radius: .6rem; padding: 1rem; min-width: 0; }
legend { font-weight: 600; padding: 0 .3rem; }
p { font-size: .82rem; color: var(--text-faint); line-height: 1.5; margin: .6rem 0; }
.fields, label { display: flex; flex-direction: column; gap: .5rem; }
.fields { gap: .8rem; }
label { font-size: .85rem; }
input, select, button { font: inherit; padding: .65rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--bg); color: var(--text); min-width: 0; max-width: 100%; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
a { color: var(--accent-calendar); font-size: .85rem; }
.suggestions { display: flex; flex-wrap: wrap; gap: .4rem; font-size: .8rem; }.suggestions span { width: 100%; }
[role="alert"] { color: var(--danger, #e88484); }
.separate { border-left: 2px solid var(--accent-calendar); padding-left: .6rem; }
</style>
