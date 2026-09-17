<script setup lang="ts">
import { computed } from "vue";
import type { PaikkyData, PaikkyMessage, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<PaikkyData>;
  /**
   * Valmiiksi lukutilan mukaan suodatettu ja katkaistu lista. Kirjanpito
   * luetuista on MessagesCardissa, koska sama tila ohjaa myös välilehtien
   * lukumääriä ja joukkomerkintää — kaksi eri käsitystä samasta asiasta olisi
   * juuri se kohta jossa numero ja lista eroaisivat toisistaan.
   */
  messages: PaikkyMessage[];
  /**
   * Kumpaa listaa näytetään. Suodatus on jo tehty, joten tämä ratkaisee vain
   * lukemattoman merkin ja tyhjän tilan sanamuodon.
   */
  mode: "unread" | "read";
  /** Montako viestiä lähteessä on kaikkiaan — erottaa "ei viestejä" ja "ei lukemattomia". */
  total: number;
  hidePreviews: boolean;
}>();

/**
 * Viestin laji kerrotaan vain kun se ei ole tavallinen viesti: tiedote ja
 * varsinkin vastaamaton lomake vaativat eri reaktion kuin viesti.
 * Tuntematon laji näytetään sellaisenaan (ks. PaikkyCareDays.vue) — lajien
 * joukkoa ei ole nähty oikeasta datasta, vain renderointikoodista.
 */
const TYPE_LABELS: Record<string, string> = {
  message: "",
  bulletin: "tiedote",
  "answered-form": "lomake",
  "unanswered-form": "lomake vastaamatta",
};

/**
 * Viestihaun oma virhe silloin kun hoitoajat onnistuivat. Viestipäätepiste on
 * koko toteutuksen heikoiten todennettu osa, joten sen rikkoutuminen ei saa
 * vanhentaa hoitoaikoja — mutta sitä ei myöskään piiloteta tyhjän tilan
 * taakse, koska "ei viestejä" ja "viestejä ei saatu" ovat eri asioita.
 */
const messagesError = computed(() => props.snapshot?.data?.messagesError ?? null);

function typeLabel(message: PaikkyMessage): string {
  return TYPE_LABELS[message.type] ?? message.type;
}

/** Sama muoto kuin Wilman viesteissä: tänään kellonaika, muuten päivämäärä. */
function sentLabel(value: string | null): string {
  if (!value) return "";
  const sent = new Date(value);
  if (Number.isNaN(sent.getTime())) return "";
  const today = new Date();
  const sameDay =
    sent.getFullYear() === today.getFullYear() &&
    sent.getMonth() === today.getMonth() &&
    sent.getDate() === today.getDate();
  if (sameDay) return sent.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  return sent.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" });
}

function preview(message: PaikkyMessage): string {
  if (props.hidePreviews || !message.preview) return "";
  const text = message.preview.replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

/**
 * Päikyn oma tila kerrotaan tässä eikä CardShellissä, jotta kortin runko ja
 * sen välilehdet säilyvät näkyvissä myös silloin kun tämä lähde on poikki.
 */
const state = computed<{ title: string | null; text: string } | null>(() => {
  const status = props.snapshot?.status;
  if (!props.snapshot || status === "idle") return { title: null, text: "Haetaan…" };
  if (status === "failed") {
    return { title: "Viestejä ei saatu", text: props.snapshot.error?.message ?? "Päikky ei vastaa" };
  }
  if (status === "hidden") {
    return {
      title: "Vain infonäytöllä",
      text: "Päivähoidon viestit näkyvät vain keittiön näytöllä, eivät kotiverkon muilla laitteilla.",
    };
  }
  if (props.messages.length === 0) {
    // Tyhjä lista on kaksi eri asiaa: onko koko postilaatikko tyhjä, vai vain
    // tämä lukutila. Ne eivät saa sanoa samaa, muuten luettujen puolelle
    // siirtyneet viestit näyttäisivät kadonneen kokonaan.
    if (props.total > 0) {
      return {
        // Virhe ei katoa senkään vuoksi että juuri tämä lukutila on tyhjä:
        // listan yläpuolinen huomautus ei ole nyt näkyvissä, joten se
        // sanotaan tässä.
        title: messagesError.value ? "Päikyn viestejä ei saatu haettua kokonaan" : null,
        text: props.mode === "unread" ? "Ei lukemattomia Päikky-viestejä" : "Ei luettuja Päikky-viestejä",
      };
    }
    // Virhe voittaa tyhjän tilan: rikkinäistä hakua ei saa esittää tyhjänä
    // postilaatikkona.
    if (messagesError.value) {
      return { title: "Päikyn viestejä ei saatu haettua", text: messagesError.value };
    }
    // Tyhjä postilaatikko on normaali tila, ei virhe — Päikkyyn tulee viestejä
    // harvakseltaan.
    return { title: null, text: "Ei Päikky-viestejä" };
  }
  return null;
});
</script>

<template>
  <div v-if="state" class="state">
    <span v-if="state.title" class="state__title">{{ state.title }}</span>
    <span>{{ state.text }}</span>
  </div>

  <!--
    Rivit eivät ole painikkeita: Päikylle ei haeta viestin sisältöä erikseen,
    joten avattavaa ei ole. Napautuksen näköinen rivi joka ei tee mitään olisi
    pahempi kuin pelkkä teksti. Luetuksi merkitseminen tapahtuu kortin
    "merkitse kaikki luetuiksi" -painikkeesta.
  -->
  <!-- Osa viesteistä saatiin, mutta haku epäonnistui silti: lista näytetään ja
       vika kerrotaan sen yllä yhdellä rivillä. -->
  <template v-else>
    <p v-if="messagesError" class="notice">Päikyn viestejä ei saatu haettua kokonaan</p>

    <ul class="messages">
      <li v-for="message in messages" :key="message.id" class="message">
        <div class="message__row">
          <span class="message__sender">{{ message.sender ?? "" }}</span>
          <span class="message__time tnum">{{ sentLabel(message.sentAt) }}</span>
        </div>
        <div class="message__subject" :class="{ 'message__subject--unread': mode === 'unread' }">
          <span v-if="mode === 'unread'" class="message__dot" aria-hidden="true" />
          {{ message.title || "(Ei otsikkoa)" }}
          <span v-if="typeLabel(message)" class="message__type">{{ typeLabel(message) }}</span>
        </div>
        <p v-if="preview(message)" class="message__preview">{{ preview(message) }}</p>
      </li>
    </ul>
  </template>
</template>

<style scoped>
/*
 * Rivien mitat on pidetty samoina kuin Wilman listalla, jotta välilehden
 * vaihto ei hyppäytä koko korttia. Päikyn oma tunnusväri erottaa lähteen.
 */
.messages {
  --care: var(--accent-calendar);
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}

.message {
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.message:last-child {
  border-bottom: none;
}

.message__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.6rem;
}

.message__sender {
  font-size: 0.78rem;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message__time {
  font-size: 0.74rem;
  color: var(--text-faint);
  flex-shrink: 0;
}

.message__subject {
  font-size: 1rem;
  line-height: 1.25;
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  color: var(--text-dim);
}

.message__subject--unread {
  color: var(--text);
  font-weight: 600;
}

.message__dot {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: var(--care);
  flex-shrink: 0;
}

.message__type {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--care);
  opacity: 0.8;
  flex-shrink: 0;
}

/* Sama sävy kuin CardShellin card__reason -selitteessä: vika kerrotaan, mutta
   se ei ole hälytys. */
.notice {
  margin: 0 0 0.3rem;
  font-size: 0.75rem;
  line-height: 1.3;
  color: #f3c26b;
  flex-shrink: 0;
}

.message__preview {
  margin: 0.2rem 0 0;
  font-size: 0.82rem;
  line-height: 1.35;
  color: var(--text-faint);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
