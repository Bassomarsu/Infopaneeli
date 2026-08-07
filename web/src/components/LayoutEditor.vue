<script setup lang="ts">
/**
 * Yhden paneelin kehys asettelun muokkaustilassa. Kääriytyy varsinaisen
 * kortin ympärille (slot) ja lisää muokkaustilassa raahauskerroksen sekä
 * koon muutoskahvan — kortin oma sisältö pysyy koskemattomana, se vain
 * lakkaa reagoimasta kosketukseen niin kauan kuin muokataan.
 */
import { computed, inject, ref } from "vue";
import { GRID_COLUMNS, GRID_ROWS, PANEL_TITLES, type PanelId, type PanelPlacement } from "../types";
import { panelGridKey } from "../composables/usePanelLayout";

const props = defineProps<{
  panelId: PanelId;
  placement: PanelPlacement;
  editing: boolean;
}>();

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
}>();

const gridEl = inject(panelGridKey, ref(null));

const title = computed(() => PANEL_TITLES[props.panelId]);

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
  return { rect, w: rect.width / GRID_COLUMNS, h: rect.height / GRID_ROWS };
}

/** Ruudukon solu suoraan annetun pisteen alla (1-pohjainen, typistetty rajoihin). */
function pointerCell(event: PointerEvent, size: { rect: DOMRect; w: number; h: number }): { col: number; row: number } {
  const col = clamp(Math.floor((event.clientX - size.rect.left) / size.w) + 1, 1, GRID_COLUMNS);
  const row = clamp(Math.floor((event.clientY - size.rect.top) / size.h) + 1, 1, GRID_ROWS);
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
  dragOriginY = event.clientY;
  dragStartCol = props.placement.col;
  dragStartRow = props.placement.row;
  lastMoveCol = dragStartCol;
  lastMoveRow = dragStartRow;
  lastPointerCol = -1;
  lastPointerRow = -1;
}

function onDragMove(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  const size = gridRect();
  if (!size) return;
  const deltaCol = Math.round((event.clientX - dragOriginX) / size.w);
  const deltaRow = Math.round((event.clientY - dragOriginY) / size.h);
  const col = clamp(dragStartCol + deltaCol, 1, GRID_COLUMNS);
  const row = clamp(dragStartRow + deltaRow, 1, GRID_ROWS);
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
  resizeOriginY = event.clientY;
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
  const deltaRow = Math.round((event.clientY - resizeOriginY) / size.h);
  // Typistetään vain ruudukon ulkorajaan, EI MIN_PANEL_SPANiin: raaka pyyntö
  // päästetään läpi asti usePanelLayoutiin asti, jotta se voi näyttää
  // "Pienin koko on..." -vihjeen kun käyttäjä yrittää kutistaa liikaa.
  // Typistäminen tässä jo piilottaisi sen yrityksen kokonaan.
  const colSpan = clamp(resizeStartColSpan + deltaCol, 1, GRID_COLUMNS);
  const rowSpan = clamp(resizeStartRowSpan + deltaRow, 1, GRID_ROWS);
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
      <span class="panel-frame__title">{{ title }}</span>
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
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text);
  background: rgba(11, 13, 18, 0.7);
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  pointer-events: none;
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
