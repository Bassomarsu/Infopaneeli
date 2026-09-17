<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref } from "vue";
import type { ProviderStatus } from "../types";

import { widgetPanelKey, widgetSettingsKey, WIDGET_SETTING_KEYS } from '../composables/widgetSettings';
import { cardCompactKey } from '../composables/cardShell';
import { isCompactCard } from '../cardOverflow';
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

/* ── Tiivis kortti ─────────────────────────────────────────────────────────
 *
 * Yksi paikka kaikille kahdelletoista kortille, samasta syystä kuin
 * "vanhentunut"-merkki on täällä: kortin korkeus ei ole yhdenkään kortin oma
 * asia vaan ruudukon, eikä sitä voi jättää sen varaan että jokainen kortti
 * muistaa mitata sen erikseen.
 *
 * Mitataan vain kortin KORKEUS. Rivien skannausta ei ole, koska ilmoitusta
 * piiloon jääneistä riveistä ei ole: kortit vierittävät sisältönsä, ja
 * vierityspalkki kertoo itse että listaa on enemmän.
 *
 * Sääntö (kynnys) on cardOverflow.ts:ssä ilman DOMia; täällä on vain mittaus.
 */
const cardEl = ref<HTMLElement | null>(null);
const cardHeight = ref(0);

const compact = computed(() => isCompactCard(cardHeight.value));
provide(cardCompactKey, compact);

function measure(): void {
  const height = cardEl.value?.getBoundingClientRect().height ?? 0;
  // Mittaamaton kortti (ei vielä asettunut, tai piilotettu) antaa nollan, eikä
  // siitä saa päätellä mitään: edellinen tunnettu korkeus jää voimaan.
  if (height <= 0) return;
  cardHeight.value = height;
}

/**
 * Mittaus niputetaan yhteen ruudunpäivitykseen.
 *
 * `requestAnimationFrame` on oikea hetki: se ajetaan asettelun jälkeen, joten
 * mitat ovat valmiit. Niputus myös estää silmukan siinä tapauksessa että
 * tiiviin kortin pienempi täyte sattuisi vaikuttamaan kortin omaan kokoon.
 *
 * Tämä näyttö on auki kuukausia yhteen menoon, joten turha työ ei ole
 * makuasia — ja juuri siksi täällä ei ole enää `MutationObserver`ia. Se oli
 * olemassa vain leikkausilmoituksen mittausta varten ja ajoi työtä jokaisesta
 * DOM-muutoksesta jokaisella kortilla.
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
 * Kortin korkeuden muuttaa VAIN ruudukko: asettelun muokkaus, ikkunan koko tai
 * näytön kääntyminen. Sisällön määrä ei muuta sitä, koska kortti on
 * ruudukkosolu jonka korkeus tulee kiinteästä rivikorkeudesta
 * (`--layout-row-height`, ks. App.vuen measureGridRows). Siksi
 * `ResizeObserver` yksin riittää — sisällön muutoksia ei tarvitse kuunnella.
 */
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleMeasure);
  if (cardEl.value) resizeObserver.observe(cardEl.value);
  scheduleMeasure();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
  pendingFrame = null;
});
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

    <div class="card__body">
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
