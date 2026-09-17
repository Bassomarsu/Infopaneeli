<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import type { ProviderStatus } from "../types";

import { widgetPanelKey, widgetSettingsKey, WIDGET_SETTING_KEYS } from '../composables/widgetSettings';
import { cardCompactKey } from '../composables/cardShell';
import {
  cardIsClipped,
  clipNotice,
  clipNoticeLabel,
  clippedRowCount,
  hiddenPixels,
  isCompactCard,
  noticeFitsInCard,
  type RowBand,
} from '../cardOverflow';
import { PANEL_TITLES } from '../types';
const panelId = inject(widgetPanelKey, undefined);
const openSettings = inject(widgetSettingsKey, undefined);
const hasSettings = computed(() => panelId && openSettings && panelId.value in WIDGET_SETTING_KEYS);
const settingsLabel = computed(() => panelId ? PANEL_TITLES[panelId.value] + ': asetukset' : 'Widgetin asetukset');
const props = defineProps<{
  title: string;
  accent?: string;
  status?: ProviderStatus;
  fetchedAt?: string | null;
  error?: { type: string; message: string } | null;
  note?: string;
  /**
   * Kun annettu, kortin otsikosta tulee painike joka lähettää `titleClick`.
   * Arvo on painikkeen saavutettava nimi ("Avaa …"), koska otsikkoteksti
   * itsessään ei kerro ruudunlukijalle mitä painallus tekee.
   *
   * Ilman tätä propsia otsikko renderöityy TÄSMÄLLEEN kuten ennen — ei
   * painiketta, ei fokusjärjestystä, ei aria-attribuutteja. Muut kortit
   * eivät saa muuttua siksi että kalenteri tarvitsi tämän.
   */
  titleAction?: string;
}>();

const emit = defineEmits<{ titleClick: [] }>();

/**
 * One place decides how a broken or stale source looks, so a failing card
 * degrades instead of taking the layout with it.
 */
const isStale = computed(() => props.status === "stale");
const isFailed = computed(() => props.status === "failed");
const isHidden = computed(() => props.status === "hidden");
const isLoading = computed(() => props.status === "idle" || props.status === undefined);

const staleLabel = computed(() => {
  if (!props.fetchedAt) return "";
  const then = new Date(props.fetchedAt);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 60) return `päivitetty ${minutes} min sitten`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `päivitetty ${hours} h sitten`;
  return `päivitetty ${Math.round(hours / 24)} vrk sitten`;
});

/* ── Leikkautuuko sisältö, ja kuinka paljon ────────────────────────────────
 *
 * Yksi paikka kaikille kahdelletoista kortille, samasta syystä kuin
 * "vanhentunut"-merkki on täällä: rikkinäinen lähde ja vajaa näkymä ovat
 * molemmat asioita joista kortin on kerrottava itse, eikä kumpaakaan voi
 * jättää sen varaan että jokainen kortti muistaa tehdä sen erikseen.
 *
 * Säännöt ovat cardOverflow.ts:ssä ilman DOMia; täällä on vain mittaus.
 */
const cardEl = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const noticeEl = ref<HTMLElement | null>(null);

const hiddenPx = ref(0);
/** Kortin ITSENSÄ piilottamat rivit (uutiskortti) — ilmoituksen PERUSTE pikselien ohella. */
const concealedRows = ref(0);
/** Rivit joita katsoja ei saa luettua: taitteen alla TAI ilmoitusrivin peitossa. */
const hiddenRows = ref(0);
const cardHeight = ref(0);
/** Mahtuuko ilmoitusrivi runkoon peittämättä otsikkoa. */
const noticeHasRoom = ref(false);

const compact = computed(() => isCompactCard(cardHeight.value));
provide(cardCompactKey, compact);

/*
 * Ilmoituksen TEKSTI on aina olemassa; `noticeVisible` päättää näkyykö se.
 *
 * Rivi renderöidään DOMiin myös piilotettuna, koska sen korkeus tarvitaan
 * päätökseen "mahtuuko tämä runkoon peittämättä otsikkoa" — ja korkeutta ei
 * voi mitata elementistä jota ei ole. Ks. style.css:n `.card__clipped--hidden`.
 */
const notice = computed(() => clipNotice(hiddenRows.value));
const noticeVisible = computed(
  () => noticeHasRoom.value && cardIsClipped(hiddenPx.value, concealedRows.value),
);
const noticeLabel = computed(() => clipNoticeLabel(hiddenRows.value));

/**
 * Ilmoitusrivin korkeus pikseleinä — myös silloin kun rivi on piilotettu.
 *
 * Rivi on asemoitu (`position: absolute`), joten tämä EI ole sen viemä tila
 * kortin korkeudesta: se ei vie yhtään. Tätä käytetään kahteen asiaan:
 * mahtuuko rivi runkoon peittämättä otsikkoa, ja mikä osa sisällöstä jää sen
 * PEITTOON kortin alalaidassa.
 *
 * `offsetHeight` riittää nyt marginaalien sijaan, koska asemoidulla rivillä
 * ei ole marginaaleja lainkaan — kortin täyte tulee `--card-pad-x`:stä.
 */
function noticeSpace(): number {
  return noticeEl.value?.offsetHeight ?? 0;
}

/**
 * Se laatikko joka oikeasti leikkaa. Se ei ole aina sama elementti: listakortit
 * leikkaavat omassa vierityssäiliössään (`.menu`, `.household`, …) ja
 * kaaviokortit (sää, pörssisähkö) suoraan kortin omassa `overflow: hidden`
 * -rajassa. Valitaan se jossa piilossa on eniten — se on se jonka katsoja
 * menettää.
 */
function clippingBox(): { el: HTMLElement; hidden: number } | null {
  const card = cardEl.value;
  const body = bodyEl.value;
  if (!card || !body) return null;
  let best: { el: HTMLElement; hidden: number } | null = null;
  const consider = (el: HTMLElement): void => {
    const hidden = hiddenPixels(el.scrollHeight, el.clientHeight);
    if (hidden > 0 && (best === null || hidden > best.hidden)) best = { el, hidden };
  };
  // Kortin oma kehys ja runko aina: ne ovat se raja jonka yli sisältö ei näy.
  consider(card);
  consider(body);
  /*
   * Rungon sisältä VAIN oikeat vierityssäiliöt.
   *
   * `overflow: hidden` rungon sisällä on tarkoituksellista typistystä, ei
   * ylivuotoa: esim. pörssisähkön `.power__readout` on yhden rivin laatikko
   * jossa on `text-overflow: ellipsis`, ja rivinkorkeuden pyöristys tekee
   * siitä pysyvästi 3 px "ylivuotavan" 20 px:n laatikon. Ilman tätä rajausta
   * pörssisähkökortti väitti sisältönsä leikkautuvan silloinkin kun koko
   * kaavio näkyi (mitattu 1366 x 768, koko 2 x 4) — eli tämä ilmoitus olisi
   * itse ollut väärää tietoa seinällä.
   *
   * Uutiskortti on `overflow: hidden` eikä siis osu tähän, ja se on oikein:
   * se siivoaa ylivuotonsa itse merkitsemällä mahtumattomat otsikot
   * (`data-card-row="hidden"`), jolloin ne lasketaan rivilaskurissa.
   */
  const walk = (el: Element): void => {
    if (el instanceof HTMLElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") consider(el);
    }
    for (const child of el.children) walk(child);
  };
  walk(body);
  return best;
}

function measure(): void {
  const card = cardEl.value;
  const body = bodyEl.value;
  if (!card || !body) return;
  const cardRect = card.getBoundingClientRect();
  // Mittaamaton kortti (ei vielä asettunut, tai piilotettu) antaa nollia, eikä
  // niistä saa päätellä mitään — sama varaus kuin uutiskortin `measure`issa.
  if (cardRect.height <= 0) return;
  cardHeight.value = cardRect.height;

  const noticeHeight = noticeSpace();
  noticeHasRoom.value = noticeFitsInCard(body.clientHeight, noticeHeight);

  const box = clippingBox();
  hiddenPx.value = box?.hidden ?? 0;

  const rows: RowBand[] = [];
  for (const el of body.querySelectorAll<HTMLElement>("[data-card-row]")) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    rows.push({ top: rect.top, bottom: rect.bottom, concealed: el.dataset.cardRow === "hidden" });
  }

  /*
   * PERUSTE ja LUKU mitataan eri taitteesta, ja se on tarkoituksellista.
   *
   * Peruste (`concealedRows`) on vain kortin itsensä piilottamat rivit:
   * uutiskortti siivoaa ylivuotonsa `visibility: hidden` -tilaan, jolloin
   * kortti ei vuoda yli yhtään pikseliä mutta otsikoita jää lukematta.
   * Nollasta pikselistä ei siis saa päätellä että kaikki näkyy.
   *
   * Peruste EI saa sisältää rivejä jotka ilmoitusrivi itse peittää — muuten
   * ilmoitus pitäisi itsensä pystyssä senkin jälkeen kun sisältö on kutistunut
   * mahtuvaksi, eikä katoaisi enää koskaan.
   *
   * Luku (`hiddenRows`) on rivit jotka eivät mahdu leikkaavaan laatikkoon.
   * Merkki itse ei kuulu tähän: se on nurkkapilleri eikä koko leveydeltä
   * kulkeva rivi, joten se ei vie yhdeltäkään riviltä sen luettavuutta.
   */
  concealedRows.value = rows.filter((row) => row.concealed === true).length;

  const reference = box?.el ?? body;
  const referenceRect = reference.getBoundingClientRect();
  const visibleTop = referenceRect.top + reference.clientTop;
  hiddenRows.value = clippedRowCount(rows, visibleTop, visibleTop + reference.clientHeight);
}

/**
 * Mittaukset niputetaan yhteen ruudunpäivitykseen.
 *
 * Yksi mittaus käy koko kortin läpi ja kysyy `getComputedStyle`n jokaiselta
 * elementiltä, ja herätteitä tulee useita peräkkäin samasta muutoksesta
 * (Vuen DOM-päivitys, sen aiheuttama koon muutos, ilmoitusrivin ilmestyminen).
 * Ilman niputusta sama vastaus laskettaisiin kolmesti. `requestAnimationFrame`
 * on myös oikea hetki: se ajetaan asettelun jälkeen, joten mitat ovat valmiit.
 *
 * Tämä näyttö on auki kuukausia yhteen menoon, joten turha työ ei ole
 * makuasia.
 */
let pendingFrame: number | null = null;
function scheduleMeasure(): void {
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    measure();
  });
}

/**
 * Mittaus herätetään kolmesta suunnasta, koska yksikään niistä ei yksin riitä:
 * kortin koon muutos (asettelu, ikkunan koko), sisällön muutos (uusi viesti,
 * poistettu ostos) ja ensimmäinen asettuminen. `MutationObserver` kuuntelee
 * VAIN kortin runkoa — ilmoitusrivi on sen ulkopuolella, joten sen
 * ilmestyminen ei voi herättää mittausta uudestaan.
 *
 * Attribuuteista seurataan vain ne jotka voivat muuttaa sisällön korkeutta tai
 * rivien laskettavuutta: `style` (uutiskortin `visibility: hidden`), `class`
 * (tiiviin kortin tyylit) ja `data-card-row` (rivimerkintä). Kaikkien
 * attribuuttien seuraaminen herättäisi mittauksen jokaisesta aria-lipun
 * käännöstä.
 */
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleMeasure);
  if (cardEl.value) resizeObserver.observe(cardEl.value);
  if (bodyEl.value) resizeObserver.observe(bodyEl.value);
  mutationObserver = new MutationObserver(scheduleMeasure);
  if (bodyEl.value) {
    mutationObserver.observe(bodyEl.value, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-card-row"],
    });
  }
  scheduleMeasure();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
  pendingFrame = null;
});

// Tilan vaihtuminen ("Haetaan…" -> sisältö) vaihtaa koko rungon, ja
// `card__reason` ilmestyy rungon ULKOPUOLELLE — kumpikaan ei näy
// MutationObserverille joka katsoo vain runkoa.
watch(() => [props.status, props.error?.message], () => void nextTick(scheduleMeasure));
</script>

<template>
  <section ref="cardEl" class="card" :class="{ 'card--stale': isStale, 'card--compact': compact }">
    <header class="card__head">
      <h2 class="card__title">
        <button
          v-if="titleAction"
          type="button"
          class="title-button"
          :aria-label="titleAction"
          aria-haspopup="dialog"
          @click="emit('titleClick')"
        >
          <span v-if="accent" class="card__accent" :style="{ background: accent }" />
          {{ title }}
          <!--
            Seinänäytössä ei ole hiiren osoitinta, joten "tätä voi painaa" on
            sanottava muodolla: hiusrajattu pilleri ja merkki joka esittää
            juuri sitä ruudukkoa jonka painallus avaa. Muoto kestää yötilan
            himmennyksen, pelkkä värivihje ei kestäisi.
          -->
          <svg class="title-button__glyph" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="0.6" y="2.1" width="12.8" height="11.3" rx="2" fill="none" stroke="currentColor" stroke-width="1.1" />
            <path d="M0.6 5.9h12.8M4.9 5.9v7.5M9.2 5.9v7.5M0.6 9.65h12.8" stroke="currentColor" stroke-width="0.9" />
            <path d="M4 0.6v2.2M10 0.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <template v-else>
          <span v-if="accent" class="card__accent" :style="{ background: accent }" />
          {{ title }}
        </template>
      </h2>
      <span v-if="isStale" class="badge badge--warn">vanhentunut · {{ staleLabel }}</span>
      <span v-else-if="isFailed" class="badge badge--error">ei yhteyttä</span>
      <span v-else-if="note" class="card__note">{{ note }}</span>
      <button v-if="hasSettings" class="card__settings" type="button" :aria-label="settingsLabel" :title="settingsLabel" aria-haspopup="dialog" @click.stop="panelId && openSettings?.(panelId)">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-.6 2.3-2 .9-2.1-.7-2 3.5 1.6 1.6v2.3L2.3 14.5l2 3.5 2.2-.6 2 .9L9 21h4l.6-2.7 2-.9 2.1.6 2-3.5-1.6-1.6v-2.3l1.6-1.6-2-3.5-2.1.7-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>
      </button>
    </header>

    <!--
      A touchscreen has no hover, so the reason a card is stale cannot live
      only in a `title` tooltip — it has to be text on the card itself, same
      as the electricity card's price-per-hour fix. Kept to one short line:
      just enough to tell "verkko pätkii" (heals on its own) apart from
      "kirjautuminen ei onnistu" (needs a person), read from a couple of
      metres away.
    -->
    <p v-if="isStale && error?.message" class="card__reason">{{ error.message }}</p>

    <div ref="bodyEl" class="card__body">
      <div v-if="isFailed" class="state">
        <span class="state__title">Tietoja ei saatu</span>
        <span>{{ error?.message ?? "Lähde ei vastaa" }}</span>
      </div>
      <div v-else-if="isHidden" class="state">
        <span class="state__title">Vain infonäytöllä</span>
        <span>Koulutiedot näkyvät vain keittiön näytöllä, eivät kotiverkon muilla laitteilla.</span>
      </div>
      <div v-else-if="isLoading" class="state">
        <span>Haetaan…</span>
      </div>
      <slot v-else />
    </div>

    <!--
      Vajaasta näkymästä kerrotaan kortissa, ei lokissa eikä hiiren päällä.
      Seinänäytössä ei ole osoitinta eikä sitä vieritetä, joten tämä rivi on
      ainoa mahdollisuus kertoa että lista jatkuu — ks. cardOverflow.ts.

      `flex-shrink: 0` ja sijainti rungon ULKOPUOLELLA ovat ehto eivätkä
      tyyli: rungon sisällä ilmoitus leikkautuisi itse piiloon täsmälleen
      silloin kun sitä tarvitaan.
    -->
    <p
      ref="noticeEl"
      class="card__clipped"
      :class="{ 'card__clipped--hidden': !noticeVisible }"
      :aria-label="noticeLabel"
      :aria-hidden="noticeVisible ? undefined : 'true'"
      role="status"
    >
      <span class="card__clipped-glyph" aria-hidden="true">⌄</span>{{ notice }}
    </p>
  </section>
</template>

<style scoped>
.card__settings { flex: 0 0 36px; width: 36px; height: 36px; padding: 7px; margin: -6px 0 -6px auto; border: 0; border-radius: 9px; color: var(--text-dim); background: transparent; cursor: pointer; position: relative; z-index: 1; }
.card__settings:hover, .card__settings:focus-visible { color: var(--text); background: var(--surface-strong); }
.card__title { min-width: 0; }

/*
 * Vain klikattavan otsikon tyylit. Kortin muut luokat elävät style.css:ssä
 * globaaleina; näitä ei ole siellä koska ne koskevat yhtä korttia.
 */
.title-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  /* Painike ei peri otsikon kirjasinta itsestään. */
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border);
  /* Negatiivinen marginaali pitää otsikkotekstin samassa kohdassa kuin muissa
     korteissa — pilleri kasvaa ulospäin eikä siirrä otsikkoa. */
  margin: -0.32rem -0.6rem;
  padding: 0.32rem 0.6rem;
  border-radius: 999px;
  cursor: pointer;
  /* Kosketusalue sormelle: pilleri itse on matala, joten alue kasvatetaan
     näkymättömällä reunuksella eikä korttia levittävällä korkeudella. */
  position: relative;
}

.title-button::after {
  content: "";
  position: absolute;
  inset: -0.55rem -0.5rem;
}

.title-button__glyph {
  width: 0.78em;
  height: 0.78em;
  flex-shrink: 0;
  color: var(--accent-calendar);
  /* Merkki on ohut ja pieni; hieman lisää painoa jotta se erottuu parin
     metrin päästä ja yötilan himmennyksen jälkeen. */
  opacity: 0.9;
}

.title-button:hover,
.title-button:focus-visible {
  background: var(--surface-strong);
  color: var(--text);
}

.title-button:active {
  background: var(--surface-strong);
  transform: translateY(1px);
}

@media (prefers-reduced-motion: reduce) {
  .title-button:active {
    transform: none;
  }
}
</style>
