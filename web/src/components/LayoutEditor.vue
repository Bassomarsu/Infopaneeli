<script setup lang="ts">
/**
 * Yhden paneelin kehys asettelun muokkaustilassa. Kääriytyy varsinaisen
 * kortin ympärille (slot) ja lisää muokkaustilassa raahauskerroksen sekä
 * koon muutoskahvan — kortin oma sisältö pysyy koskemattomana, se vain
 * lakkaa reagoimasta kosketukseen niin kauan kuin muokataan.
 */
import { computed, inject, provide, ref } from "vue";
import { GRID_COLUMNS, GRID_ROWS, MAX_LAYOUT_ROWS, PANEL_TITLES, type PanelId, type PanelPlacement } from "../types";
import { panelGridKey } from "../composables/usePanelLayout";

import { widgetPanelKey } from '../composables/widgetSettings';

const props = defineProps<{
  panelId: PanelId;
  placement: PanelPlacement;
  editing: boolean;
}>();

provide(widgetPanelKey, computed(() => props.panelId));

const emit = defineEmits<{
  /**
   * `col`/`row`: raahatun paneelin oma jalanjälki, laskettu deltana
   * raahauksen alusta (käytetään kun pudotuskohta on tyhjässä tilassa).
   * `pointerCol`/`pointerRow`: ruudukon solu suoraan sormen/kursorin alla
   * juuri nyt — riippumaton siitä mistä kohtaa paneelia käyttäjä tarttui
   * (käytetään kohdepaneelin tunnistukseen vaihtoa varten).
   */
  move: [col: number, row: number, pointerCol: number, pointerRow: number];
  resize: [colSpan: number, rowSpan: number];
  /**
   * Kytke tämä paneeli pois näkyvistä. Vain tähän suuntaan: pois kytkettyä
   * paneelia ei renderöidä ruudukossa lainkaan, joten se otetaan takaisin
   * muokkaustilan yläpalkin parkkirivistä (ks. App.vue).
   */
  hide: [];
}>();

const gridEl = inject(panelGridKey, ref(null));

const title = computed(() => PANEL_TITLES[props.panelId]);

const hideLabel = computed(() => `Kytke paneeli ${title.value} pois käytöstä`);

const gridStyle = computed(() => ({
  gridColumn: `${props.placement.col} / span ${props.placement.colSpan}`,
  gridRow: `${props.placement.row} / span ${props.placement.rowSpan}`,
}));

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function gridRect(): { rect: DOMRect; w: number; h: number } | null {
  const el = gridEl.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const style = getComputedStyle(el);
  const columnGap = parseFloat(style.columnGap) || 0;
  const rowGap = parseFloat(style.rowGap) || 0;
  const rowHeight = parseFloat(style.getPropertyValue("--layout-row-height")) || rect.height / GRID_ROWS;
  return { rect, w: (rect.width + columnGap) / GRID_COLUMNS, h: rowHeight + rowGap };
}

/** Ruudukon solu suoraan annetun pisteen alla (1-pohjainen, typistetty rajoihin). */
function pointerCell(event: PointerEvent, size: { rect: DOMRect; w: number; h: number }): { col: number; row: number } {
  const col = clamp(Math.floor((event.clientX - size.rect.left) / size.w) + 1, 1, GRID_COLUMNS);
  const row = clamp(Math.floor((event.clientY - size.rect.top) / size.h) + 1, 1, gridEl.value?.closest(".app--scroll") ? MAX_LAYOUT_ROWS : GRID_ROWS);
  return { col, row };
}

// --- Raahaus (siirto) ---
let dragPointerId: number | null = null;
let dragOriginX = 0;
let dragOriginY = 0;
let dragStartCol = 1;
let dragStartRow = 1;
let lastMoveCol = 1;
let lastMoveRow = 1;
let lastPointerCol = 1;
let lastPointerRow = 1;

function onDragDown(event: PointerEvent): void {
  if (!props.editing) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragPointerId = event.pointerId;
  dragOriginX = event.clientX;
  dragOriginY = event.clientY + window.scrollY;
  dragStartCol = props.placement.col;
  dragStartRow = props.placement.row;
  lastMoveCol = dragStartCol;
  lastMoveRow = dragStartRow;
  lastPointerCol = -1;
  lastPointerRow = -1;
}

function onDragMove(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  if (gridEl.value?.closest(".app--scroll") && event.clientY > window.innerHeight - 70) window.scrollBy(0, 30);
  const size = gridRect();
  if (!size) return;
  const deltaCol = Math.round((event.clientX - dragOriginX) / size.w);
  const deltaRow = Math.round((event.clientY + window.scrollY - dragOriginY) / size.h);
  const col = clamp(dragStartCol + deltaCol, 1, GRID_COLUMNS);
  const row = clamp(dragStartRow + deltaRow, 1, gridEl.value?.closest(".app--scroll") ? MAX_LAYOUT_ROWS : GRID_ROWS);
  const pointer = pointerCell(event, size);
  if (col === lastMoveCol && row === lastMoveRow && pointer.col === lastPointerCol && pointer.row === lastPointerRow) {
    return;
  }
  lastMoveCol = col;
  lastMoveRow = row;
  lastPointerCol = pointer.col;
  lastPointerRow = pointer.row;
  emit("move", col, row, pointer.col, pointer.row);
}

function onDragUp(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  dragPointerId = null;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

// --- Kahva (koon muutos) ---
let resizePointerId: number | null = null;
let resizeOriginX = 0;
let resizeOriginY = 0;
let resizeStartColSpan = 1;
let resizeStartRowSpan = 1;
let lastColSpan = 1;
let lastRowSpan = 1;

function onResizeDown(event: PointerEvent): void {
  if (!props.editing) return;
  event.stopPropagation();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  resizePointerId = event.pointerId;
  resizeOriginX = event.clientX;
  resizeOriginY = event.clientY + window.scrollY;
  resizeStartColSpan = props.placement.colSpan;
  resizeStartRowSpan = props.placement.rowSpan;
  lastColSpan = resizeStartColSpan;
  lastRowSpan = resizeStartRowSpan;
}

function onResizeMove(event: PointerEvent): void {
  if (resizePointerId !== event.pointerId) return;
  event.stopPropagation();
  const size = gridRect();
  if (!size) return;
  const deltaCol = Math.round((event.clientX - resizeOriginX) / size.w);
  const deltaRow = Math.round((event.clientY + window.scrollY - resizeOriginY) / size.h);
  // Typistetään vain ruudukon ulkorajaan, EI MIN_PANEL_SPANiin: raaka pyyntö
  // päästetään läpi asti usePanelLayoutiin asti, jotta se voi näyttää
  // "Pienin koko on..." -vihjeen kun käyttäjä yrittää kutistaa liikaa.
  // Typistäminen tässä jo piilottaisi sen yrityksen kokonaan.
  const colSpan = clamp(resizeStartColSpan + deltaCol, 1, GRID_COLUMNS);
  const rowSpan = clamp(resizeStartRowSpan + deltaRow, 1, gridEl.value?.closest(".app--scroll") ? MAX_LAYOUT_ROWS : GRID_ROWS);
  if (colSpan === lastColSpan && rowSpan === lastRowSpan) return;
  lastColSpan = colSpan;
  lastRowSpan = rowSpan;
  emit("resize", colSpan, rowSpan);
}

function onResizeUp(event: PointerEvent): void {
  if (resizePointerId !== event.pointerId) return;
  event.stopPropagation();
  resizePointerId = null;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}
</script>

<template>
  <div class="panel-frame" :style="gridStyle">
    <div class="panel-frame__content" :class="{ 'panel-frame__content--locked': editing }">
      <slot />
    </div>

    <div
      v-if="editing"
      class="panel-frame__drag"
      @pointerdown="onDragDown"
      @pointermove="onDragMove"
      @pointerup="onDragUp"
      @pointercancel="onDragUp"
    >
      <!--
        Nimilaatta ja "kytke pois" -painike samassa pillerissä, keskellä
        yläreunaa. Painike oli ensin paneelin vasemmassa yläkulmassa, mutta
        se jäi kortin OMAN otsikon päälle jokaisessa kortissa (todennettu
        kuvakaappauksesta). Ylälaidan pilleri on jo valmiiksi kortin päällä
        leijuva elementti, joten se ei peitä mitään.

        Pilleri on raahauskerroksen LAPSI, joten painikkeen pointerdown
        kuplisi raahaukseen ja paneeli lähtisi liikkeelle sormen alta —
        siksi `.stop`. Pilleri itse pysyy `pointer-events: none`:na, jotta
        raahaus onnistuu myös sen kohdalta; vain painike ottaa kosketuksia.
      -->
      <span class="panel-frame__title">
        <button
          type="button"
          class="panel-frame__toggle"
          :aria-label="hideLabel"
          :title="hideLabel"
          @pointerdown.stop
          @click.stop="emit('hide')"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <!-- Yliviivattu silmä = painallus vie paneelin pois näkyvistä. -->
            <path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <path
              d="M10.6 6.2A9.6 9.6 0 0 1 12 6.1c4.8 0 8.2 3.6 9.2 5.9a12 12 0 0 1-2.8 3.6M6.4 7.9A12.4 12.4 0 0 0 2.8 12c1 2.3 4.4 5.9 9.2 5.9 1.3 0 2.5-.26 3.6-.7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <span class="panel-frame__name">{{ title }}</span>
      </span>
    </div>

    <button
      v-if="editing"
      type="button"
      class="panel-frame__handle"
      aria-label="Muuta paneelin kokoa"
      @pointerdown="onResizeDown"
      @pointermove="onResizeMove"
      @pointerup="onResizeUp"
      @pointercancel="onResizeUp"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M19 5L5 19M19 12.5L12.5 19M19 19L19 19"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.panel-frame {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
}

.panel-frame__content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.panel-frame__content :deep(> *) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* Muokkaustilassa kortti ei saa reagoida kosketukseen — muuten esim.
   lukujärjestyksen selauspainike tai muistilistan valintaruutu nappaisi
   kosketuksen raahauksen sijaan. */
.panel-frame__content--locked {
  pointer-events: none;
  user-select: none;
}

.panel-frame__drag {
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  border: 2px dashed var(--accent-school);
  background: rgba(142, 230, 168, 0.1);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 0.6rem;
  cursor: grab;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  z-index: 5;
}

.panel-frame__title {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text);
  background: rgba(11, 13, 18, 0.82);
  border: 1px solid var(--border);
  padding: 0.2rem 0.8rem 0.2rem 0.25rem;
  border-radius: 999px;
  /* Pilleri ei ota kosketuksia — raahauksen on onnistuttava myös sen
     kohdalta. Vain kytkinpainike palauttaa ne itselleen. */
  pointer-events: none;
}

.panel-frame__name {
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Kosketusalue on 44 px korkea, vaikka kuvake on pieni — pilleri kasvaa sen
   mukaan. Pienempi alue ei osu sormella, ja tämä on ainoa keino kytkeä
   paneeli takaisin päälle. */
.panel-frame__toggle {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--accent-school);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  touch-action: none;
  /* Ks. .panel-frame__title — pilleri luopuu kosketuksista, painike ottaa ne. */
  pointer-events: auto;
}

.panel-frame__handle {
  position: absolute;
  right: 0.3rem;
  bottom: 0.3rem;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: nwse-resize;
  touch-action: none;
  z-index: 6;
}
</style>
