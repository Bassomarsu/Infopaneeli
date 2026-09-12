<script setup lang="ts">
/**
 * Ylen uutisotsikot.
 *
 * YLEN KÄYTTÖEHDOT (https://yle.fi/aihe/a/20-10008076, päivitetty 15.11.2024)
 * rajaavat tätä korttia enemmän kuin mikään muu vaatimus. Nämä eivät ole
 * makuasioita eivätkä jousta:
 *
 *   - Otsikot näytetään SELLAISENAAN. Ei uudelleensanoitusta, ei tiivistystä.
 *     Näyttötilan takia otsikon saa katkaista, ja se tehdään CSS:llä
 *     (`-webkit-line-clamp`) eikä merkkijonoa leikkaamalla.
 *   - Linkin on vietävä SUORAAN kyseiseen juttuun Ylen sivustolla. Siksi
 *     `row.link` menee `href`iin sellaisenaan — ei omaa osoitteenrakennusta,
 *     ei välisivua, ei hakua.
 *   - Valokuvia ei käytetä. Syötteessä ei ole kuvia eikä niitä haeta mistään.
 *   - Lähde on käytävä ilmi. Se on kortin otsikossa ("Uutiset · Yle") eikä
 *     alatunnisteessa, koska otsikko näkyy MYÖS virhe- ja tyhjässä tilassa
 *     ja matalimmassakin paneelissa — alatunniste olisi ensimmäinen asia
 *     joka jäisi pois tilan loppuessa.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import CardShell from "./CardShell.vue";
import { fittingItemCount, newsRows } from "./news";
import { useClock } from "../composables/useClock";
import type { NewsData, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<NewsData>;
  /**
   * Saako otsikkoa painaa auki yle.fi:hin.
   *
   * KIOSKIONGELMA: seinänäyttö on kioskiselain ilman näppäimistöä. Jos
   * otsikko veisi yle.fi:hin, takaisin ei pääsisi — selain jäisi Ylen
   * sivulle eikä infonäyttöä saisi takaisin ilman että joku kävelee koneelle.
   * Ylen ehdot vaativat, että JOS linkitetään, linkki vie suoraan juttuun;
   * ne eivät vaadi linkittämistä. Näytöllä otsikot ovat siis pelkkää
   * tekstiä, puhelimessa oikeita linkkejä.
   *
   * Päätöksen tekee App.vue (ks. `newsLinksAllowed`), ei tämä kortti — sama
   * kortti ei saa itse päätellä millä laitteella se on.
   */
  linkable: boolean;
}>();

const { now } = useClock();

const rows = computed(() => newsRows(props.snapshot?.data?.items, now.value));

// ── Montako otsikkoa mahtuu ─────────────────────────────────────────────────
//
// Paneelin korkeus on käyttäjän säädettävissä (2–8 riviä ruudukkoa) ja
// otsikon korkeus vaihtelee yhden ja kahden tekstirivin välillä, joten sen
// paremmin kiinteä määrä kuin kertolaskukaan ei voi olla oikein. Mitataan
// sama kuvio kuin kalenterin kuukausinäkymässä (ResizeObserver), mutta
// rivien todellisista reunoista.
//
// KAIKKI rivit renderöidään aina; ylimääräiset vain piilotetaan
// `visibility`illä paikoilleen. Näin mittaus ei muuta asettelua eikä voi
// jäädä heilumaan kahden arvon välille — ks. news.ts:n fittingItemCount.

const listEl = ref<HTMLElement | null>(null);
const itemEls = ref<HTMLElement[]>([]);
const visibleCount = ref(0);

function captureItem(el: unknown, index: number): void {
  if (el instanceof HTMLElement) itemEls.value[index] = el;
}

function measure(): void {
  const area = listEl.value;
  if (!area) return;
  const areaRect = area.getBoundingClientRect();
  // Piilotettu tai vielä mittaamaton kortti antaa nollia; niistä ei saa
  // päätellä mitään, vaan edellinen tunnettu arvo jää voimaan.
  if (areaRect.height <= 0) return;
  const bottoms = itemEls.value
    .slice(0, rows.value.length)
    .map((el) => el.getBoundingClientRect().bottom - areaRect.top);
  visibleCount.value = fittingItemCount(areaRect.height, bottoms);
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  observer = new ResizeObserver(() => measure());
  if (listEl.value) observer.observe(listEl.value);
  void nextTick(measure);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

// Uusi syöte voi vaihtaa rivien korkeutta (yksirivinen otsikko kaksiriviseksi)
// ilman että listan oma korkeus muuttuu — ResizeObserver ei herää siitä.
watch(rows, () => {
  itemEls.value.length = rows.value.length;
  void nextTick(measure);
});

// Tyhjä lista onnistuneella haulla on oma tilansa: "ei uutisia" on eri asia
// kuin "ei saatu uutisia", ja jälkimmäisen hoitaa CardShell providerin
// statuksesta (ks. CardShell.vue — sama tapa kaikilla korteilla).
const isEmpty = computed(() => rows.value.length === 0);
</script>

<template>
  <CardShell
    title="Uutiset · Yle"
    accent="var(--accent-weather)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
  >
    <div v-if="isEmpty" class="state">
      <span class="state__title">Ei uutisia</span>
      <span>Ylen syötteessä ei ole juttuja juuri nyt.</span>
    </div>

    <div v-else ref="listEl" class="news">
      <component
        :is="linkable ? 'a' : 'article'"
        v-for="(row, index) in rows"
        :key="row.id"
        :ref="(el: unknown) => captureItem(el, index)"
        class="news__item"
        :class="{ 'news__item--link': linkable }"
        :style="index < visibleCount ? undefined : { visibility: 'hidden' }"
        :aria-hidden="index < visibleCount ? undefined : 'true'"
        :href="linkable ? row.link : undefined"
        :target="linkable ? '_blank' : undefined"
        :rel="linkable ? 'noopener noreferrer' : undefined"
      >
        <span class="news__title">{{ row.title }}</span>
        <span v-if="row.age" class="news__age tnum">{{ row.age }}</span>
      </component>
    </div>
  </CardShell>
</template>

<style scoped>
.news {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* Kaikki rivit ovat aina DOMissa (ks. `measure`), joten alareunan yli
     menevät on leikattava. Mahtumattomat ovat jo `visibility: hidden`, joten
     tämä koskee vain mittausten välistä yhtä ruudunpäivitystä. */
  overflow: hidden;
}

.news__item {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  flex: 0 0 auto;
  min-height: 0;
  /* Tekstin väri periytyy myös <a>-elementille — linkki ei saa näyttää
     siniseltä alleviivatulta verkkolinkiltä muiden korttien seassa. */
  color: var(--text);
  text-decoration: none;
}

.news__title {
  flex: 1;
  min-width: 0;
  font-size: 0.95rem;
  line-height: 1.3;
  /* Kaksi riviä on se raja jolla pitkäkin otsikko luetaan parin metrin
     päästä yhdellä silmäyksellä; kolmas rivi veisi tilan kokonaiselta
     uutiselta. Katkaisu on NÄYTTÖTILAN takia — otsikkoa ei muokata, vain
     rajataan mitä siitä mahtuu näkyviin (Ylen ehdot). */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.news__age {
  flex: 0 0 auto;
  font-size: 0.72rem;
  color: var(--text-faint);
  white-space: nowrap;
}

/* Puhelimessa otsikko on oikea linkki. Seinänäytöllä tätä luokkaa ei ole
   lainkaan, joten siellä ei ole myöskään mitään painettavan näköistä. */
.news__item--link {
  /* Sormelle isompi kosketusalue. Rivi on tämän takia linkkitilassa
     korkeampi kuin näytöllä, eikä se haittaa: mahtuvien rivien määrä
     MITATAAN renderöinnistä (ks. `measure`), joten se sopeutuu itsestään. */
  padding: 0.25rem 0.3rem;
  margin: 0 -0.3rem;
  border-radius: 10px;
}

.news__item--link:hover .news__title,
.news__item--link:focus-visible .news__title {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.news__item--link:active {
  background: var(--surface);
}
</style>
