<script setup lang="ts">
import { computed, inject } from "vue";
import CardShell from "./CardShell.vue";
import { cardCompactKey } from "../composables/cardShell.ts";
import { useClock } from "../composables/useClock";
import type { ProviderSnapshot } from "../types";
import type { MenuCollection } from "../publicWidgets.ts";
const props = defineProps<{ snapshot?: ProviderSnapshot<MenuCollection>; selectedIds: string[]; linkable?: boolean }>();
const compact = inject(cardCompactKey, computed(() => false));
const { now } = useClock();
const today = computed(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now.value));
/**
 * Luettava nimi koulutunnisteesta, kun lähde ei ole ehtinyt kertoa oikeaa.
 * Yleinen muunnos eikä pelkkä Karstulan erikoistapaus, koska kortilla voi olla
 * kahdeksan eri koulua: `porin_lyseo` -> "Porin lyseo".
 */
function fallbackName(id: string): string {
  if (id === "karstula_koulut") return "Karstulan koulut";
  const pretty = id.replace(/[_-]+/g, " ").trim();
  return pretty ? pretty[0]!.toUpperCase() + pretty.slice(1) : id;
}
const schools = computed(() => props.selectedIds.map(id => {
  const school = props.snapshot?.data?.schools?.find(s => s.locationId === id);
  const base = school ?? { locationId: id, locationName: id, sourceUrl: "", days: [], status: "loading" as const, error: null, fetchedAt: null };
  // Varanimi pätee MYÖS silloin kun kouluolio on olemassa mutta palvelin ei
  // ole saanut lähteestä nimeä: selectedMenuData täyttää silloin
  // `locationName`in tunnisteella, ja ilman tätä kortilla luki raaka
  // `karstula_koulut` aina kun ensihaku epäonnistui ilman välimuistia.
  return base.locationName && base.locationName !== id ? base : { ...base, locationName: fallbackName(id) };
}));
function label(date: string): string {
  return (date === today.value ? "Tänään · " : "") + new Intl.DateTimeFormat("fi-FI", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(date));
}
</script>
<template>
  <!--
    Tila tulee providerilta eikä ole kiinteä "ok". Kiinteänä kortti väitti
    ruokalistaa tuoreeksi silloinkin kun haku oli ollut poikki päiviä: nyt
    kaikkien koulujen kaatuminen nostaa virheen providerille asti (ks.
    providers/menu.ts), ja CardShell näyttää sen samalla tavalla kuin muillakin
    korteilla — "vanhentunut" vanhan listan päällä tai "Tietoja ei saatu" kun
    mitään näytettävää ei ole.
  -->
  <CardShell
    title="Ruokalista"
    accent="var(--accent-calendar)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
    note="kouluruoka.fi"
  >
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
          <p v-for="(meal, i) in day.meals" :key="i" class="meal" data-card-row><span>{{ meal.type }}</span>{{ meal.name }}</p>
        </section>
        <!--
          Lähdemaininta jää pois tiiviistä kortista, ja se on ainoa asia joka
          jää: sama tieto on jo kortin otsikkorivillä (`note="kouluruoka.fi"`),
          joten mitään ei katoa — vain toisto. Koulua kohden se maksoi rivin,
          ja mitattu ruokalista vuoti 2 x 2 -koossa 899 px yli jo yhdellä
          koululla. Linkki säilyy aina kun kortissa on tilaa, koska
          puhelimessa se on oikea tapa avata koko lista.

          SISÄLTÖÄ EI KOSKAAN PUDOTETA NÄIN. Ateria tai päivä joka ei mahdu
          jää leikkautuneeksi ja kortti kertoo siitä (ks. cardOverflow.ts);
          hiljaa pois jätetty ateria olisi täsmälleen se vika jota tässä
          korjataan.
        -->
        <template v-if="!compact">
          <a v-if="linkable && school.sourceUrl" :href="school.sourceUrl" target="_blank" rel="noopener noreferrer">Lähde: kouluruoka.fi</a>
          <span v-else class="hint">Lähde: kouluruoka.fi</span>
        </template>
      </section>
    </div>
  </CardShell>
</template>
<style scoped>
.menu { overflow: auto; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 1rem; }
.school + .school { border-top: 2px solid var(--border); padding-top: .8rem; }
.day { border-bottom: 1px solid var(--border); padding: .6rem 0; }
/* Ks. HouseholdList.vue: listan viimeisen erottimen alapuolinen tila on
   tyhjaa, mutta mitassa se on sisaltoa ja laukaisee vaaran ylivuotoilmoituksen. */
.day:last-child { border-bottom: none; padding-bottom: 0; }
h3 { margin: 0 0 .4rem; font-size: 1rem; }
h4 { margin: 0 0 .4rem; font-size: .9rem; }
.meal { margin: .35rem 0; line-height: 1.4; font-size: .85rem; }
.meal span { display: block; color: var(--text-faint); font-size: .73rem; }
.hint, a { color: var(--text-faint); font-size: .74rem; margin: 0; line-height: 1.4; }
.warning { color: var(--text); }
</style>
