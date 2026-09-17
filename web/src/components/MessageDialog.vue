<script setup lang="ts">
/**
 * Yhden Wilma-viestin koko sisältö.
 *
 * KEHYS ON `ModalDialog` (`<dialog showModal>`), EI OMA `position: fixed`
 * -overlay — ÄLÄ PALAUTA OVERLAYTÄ. Perustelu ja mitatut poikkeamat ovat
 * ModalDialog.vuen alussa: yötilan `filter` tekee `.app`ista sijoitussäiliön
 * myös `fixed`ille (tämän dialogin kehys oli vieritystilassa yöllä
 * −511…−1735 px näkymän yläpuolella), ja tarttuva yläpalkki peitti
 * "Sulje viesti" -painikkeen myös päivällä.
 *
 * `dim`: TÄMÄ DIALOGI HIMMENEE yötilan mukana. Se on passiivista tietoa, sama
 * pinta kuin viestikortti sen takana — viesti luetaan, sitä ei täytetä.
 * Sama ratkaisu kuin CalendarMonthDialog ja WeatherHourlyDialog.
 */
import { nextTick, watch } from "vue";
import ModalDialog from "./ModalDialog.vue";
import type { WilmaMessage } from "../types";

const props = defineProps<{
  open: boolean;
  message: WilmaMessage | null;
  /** Only shown when the family has more than one child, same rule as the card's list. */
  studentName: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

function fullSentLabel(iso: string): string {
  const sent = new Date(iso);
  if (Number.isNaN(sent.getTime())) return "";
  const date = sent.toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" });
  const time = sent.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  return `${date} klo ${time}`;
}

// Escapelle ei ole omaa kuuntelijaa: `<dialog showModal>` lähettää
// `cancel`-tapahtuman, jonka ModalDialog kääntää `close`-emitiksi. Sama
// ratkaisu kuin WeatherHourlyDialog.vuessa.

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // Long messages start scrolled to the top, not wherever the previous
    // dialog left off.
    void nextTick(() => {
      document.querySelector(".message-dialog__body")?.scrollTo({ top: 0 });
    });
  },
);
</script>

<template>
  <ModalDialog v-if="open && message" label="Viesti" dim @close="emit('close')">
    <section class="panel">
      <header class="panel__head">
        <div class="panel__head-text">
          <h2>{{ message.subject || "(Ei aihetta)" }}</h2>
          <p class="panel__meta">
            <span>{{ message.senderName ?? "Lähettäjä ei tiedossa" }}</span>
            <span class="tnum">{{ fullSentLabel(message.sentAt) }}</span>
            <span v-if="studentName" class="panel__student">{{ studentName }}</span>
          </p>
        </div>
        <button class="panel__close" type="button" aria-label="Sulje viesti" @click="emit('close')">
          Sulje
        </button>
      </header>

      <div class="panel__body message-dialog__body">
        <p v-if="message.content" class="message-dialog__text">{{ message.content }}</p>
        <p v-else class="empty">Viestin sisältöä ei ole vielä haettu Wilmasta.</p>

        <!-- The one honest thing this feature can say about its own limits — see
             store.ts's message_reads comment for the full reasoning. -->
        <p class="message-dialog__hint">Merkitään luetuksi vain tällä näytöllä — Wilman oma lukutila ei ole tiedossa.</p>
      </div>
    </section>
  </ModalDialog>
</template>

<style scoped>
/* Taustan tummennus, sumennus, keskitys ja täyte tulevat ModalDialogin
   `.modal`/`::backdrop`-säännöistä — tässä ei ole omaa overlaytä, ks.
   komponentin alun perustelu. */
.panel {
  background: #141821;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(34rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 1rem 1.3rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.panel__head-text {
  min-width: 0;
}

.panel__head h2 {
  margin: 0;
  font-size: 1.1rem;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.panel__meta {
  margin: 0.35rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.78rem;
  color: var(--text-faint);
}

.panel__student {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-school);
  opacity: 0.8;
}

.panel__close {
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 0.6rem 0.8rem;
  min-height: 44px;
  border-radius: 10px;
  flex-shrink: 0;
}

.panel__close:hover,
.panel__close:focus-visible {
  color: var(--text);
  background: var(--surface);
}

.panel__body {
  padding: 1rem 1.3rem;
  overflow-y: auto;
}

.empty {
  color: var(--text-faint);
}

.message-dialog__text {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message-dialog__hint {
  margin: 1.2rem 0 0;
  padding-top: 0.8rem;
  border-top: 1px solid var(--border);
  font-size: 0.72rem;
  color: var(--text-faint);
}
</style>
