<script setup lang="ts">
/** Ylen otsikot. Juttusivut estävät upotuksen (X-Frame-Options: DENY).
 * Otsikko avaa suljettavan dialogin; alkuperäiseen juttuun linkitetään suoraan.
 * RSS-käyttöehdot: https://yle.fi/a/20-10008076 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ModalDialog from './ModalDialog.vue';
import type { NewsRow } from './news';
import CardShell from "./CardShell.vue";
import { fittingItemCount, newsRows } from "./news";
import { useClock } from "../composables/useClock";
import type { NewsData, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<NewsData>;
  /** Ulkoiset linkit sallitaan vain laitteella, jossa pääsee takaisin. */
  linkable: boolean;
}>();

const selected = ref<NewsRow | null>(null);
const copied = ref(false);
function openNews(row: NewsRow) { selected.value = row; copied.value = false; }
async function copyLink() {
  try { await navigator.clipboard.writeText(selected.value?.link ?? ''); copied.value = true; }
  catch { copied.value = false; }
}
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
      <button
        type="button"
        v-for="(row, index) in rows"
        :key="row.id"
        :ref="(el: unknown) => captureItem(el, index)"
        class="news__item"
        aria-haspopup="dialog"
        @click="openNews(row)"
        :style="index < visibleCount ? undefined : { visibility: 'hidden' }"
        :aria-hidden="index < visibleCount ? undefined : 'true'"
        :data-card-row="index < visibleCount ? '' : 'hidden'"
      >
        <span class="news__title">{{ row.title }}</span>
        <span v-if="row.age" class="news__age tnum">{{ row.age }}</span>
      </button>
    </div>
  </CardShell>
  <ModalDialog v-if="selected" label="Uutinen · Yle" @close="selected = null">
    <article class="reader">
      <header class="reader__head"><strong>Uutinen · Yle</strong><button autofocus type="button" class="reader__close" @click="selected = null">Sulje uutinen</button></header>
      <div class="reader__body">
        <h2>{{ selected.title }}</h2>
        <p>Yle estää koko artikkelin näyttämisen sovelluksen sisällä. Voit lukea jutun Ylen sivustolla.</p>
        <a v-if="linkable" :href="selected.link" target="_blank" rel="noopener noreferrer" class="reader__link">Lue koko uutinen Ylen sivustolla ↗</a>
        <template v-else><p>Avaa tämä osoite puhelimella tai tietokoneella:</p><p class="reader__url">{{ selected.link }}</p></template>
        <button type="button" class="reader__close" @click="copyLink">{{ copied ? 'Linkki kopioitu' : 'Kopioi uutisen linkki' }}</button>
      </div>
    </article>
  </ModalDialog>
</template>

<style scoped>
.reader { width: min(48rem, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--page-bg); border: 1px solid var(--border); border-radius: var(--radius); }
.reader__head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: 1rem; border-bottom: 1px solid var(--border); }
.reader__body { padding: 1.3rem; overflow-y: auto; line-height: 1.6; }
.reader__body h2 { margin-top: 0; line-height: 1.35; }
.reader__link { display: block; color: var(--accent-school); margin: 1rem 0; }
.reader__close { flex-shrink: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); padding: .65rem; font: inherit; cursor: pointer; }
.reader__url { overflow-wrap: anywhere; }

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
  width: 100%; border: 0; background: transparent; text-align: left; font: inherit; cursor: pointer; padding: .2rem 0;
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

/* Sama avattava otsikko sekä puhelimessa että kioskissa. */
.news__item {
  /* Mahtuvien otsikoiden määrä mitataan renderöinnistä. */
  padding: 0.25rem 0.3rem;
  margin: 0 -0.3rem;
  border-radius: 10px;
}

.news__item:hover .news__title,
.news__item:focus-visible .news__title {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.news__item:active {
  background: var(--surface);
}
</style>
