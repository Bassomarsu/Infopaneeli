<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { NARROW_LAYOUT_BREAKPOINT_PX } from "../composables/usePanelLayout";
import { useEditAccess, type PinLevel } from "../composables/useEditAccess.ts";
import type { Settings, WilmaStudent } from "../types";

const editAccess = useEditAccess();

const props = defineProps<{
  settings: Settings;
  students: WilmaStudent[];
  /**
   * Palvelin piilottaa Wilma-datan laitteilta joilla ei ole täyttä
   * luottamusta — EDIT_PIN ei riitä tähän, vain FULL_PIN/näyttölaite/
   * TRUSTED_HOSTS (ks. server/src/routes/api.ts, SENSITIVE_PROVIDERS).
   * `students` on siis tyhjä EDIT_PIN:llä muokkaavalla puhelimella. Tämä
   * lippu erottaa sen "Wilma-yhteyttä ei ole vielä konfiguroitu" -tilasta,
   * jotta hintteksti ei väitä väärää syytä (ks. sama erottelu
   * AlarmsPanel.vuessa).
   */
  canPreviewSchedule: boolean;
  /** Mitä tallennettu koodi tällä laitteella juuri nyt avaa — null jos ei mitään. Ks. App.vuen currentPinLevel. */
  currentLevel: PinLevel | null;
  open: boolean;
}>();

const emit = defineEmits<{ close: []; saved: [Settings]; "edit-layout": [] }>();

const draft = ref<Settings>({ ...props.settings });
const error = ref<string | null>(null);
const saving = ref(false);

// Asettelun muokkaus mittaa ruudukkoa pikseleinä; kapealla näytöllä paneelit
// on pinottu (App.vuen mobiilimediakysely), jolloin mittaus osuisi väärään
// asetteluun ja jokainen raahaus hylättäisiin turhaan. Nappi siis piilotetaan
// käytöstä sen sijaan että rikkinäinen tila olisi edes saavutettavissa.
const narrowQuery = `(max-width: ${NARROW_LAYOUT_BREAKPOINT_PX}px)`;
const isNarrow = ref(typeof window !== "undefined" ? window.matchMedia(narrowQuery).matches : false);
let mediaQueryList: MediaQueryList | null = null;
function syncNarrow(): void {
  if (mediaQueryList) isNarrow.value = mediaQueryList.matches;
}
onMounted(() => {
  mediaQueryList = window.matchMedia(narrowQuery);
  syncNarrow();
  mediaQueryList.addEventListener("change", syncNarrow);
});
onUnmounted(() => {
  mediaQueryList?.removeEventListener("change", syncNarrow);
});

// Reopening must show what is actually stored, not whatever was typed and
// abandoned last time.
watch(
  () => [props.open, props.settings] as const,
  ([open]) => {
    if (open) {
      draft.value = { ...props.settings };
      error.value = null;
    }
  },
  { immediate: true },
);

function toggleStudent(studentNumber: string): void {
  const current = draft.value.visibleStudents;
  // null means "every child"; the first deselection turns it into an explicit
  // list so the intent survives a new child appearing in Wilma.
  const list = current === null ? props.students.map((s) => s.studentNumber) : [...current];
  const index = list.indexOf(studentNumber);
  if (index >= 0) list.splice(index, 1);
  else list.push(studentNumber);
  draft.value.visibleStudents = list;
}

function isVisible(studentNumber: string): boolean {
  const list = draft.value.visibleStudents;
  return list === null || list.includes(studentNumber);
}

/**
 * Yhteinen tallennus "Tallenna"-napille ja asettelun muokkaukseen
 * siirtymiselle — kumpikaan ei saa hukata kesken jääneitä muutoksia
 * äänettömästi. Palauttaa onnistuiko, jotta kutsuja voi päättää jatkaako.
 */
async function persistDraft(): Promise<boolean> {
  saving.value = true;
  error.value = null;
  try {
    const response = await editAccess.editFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft.value),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Tallennus epäonnistui (HTTP ${response.status})`);
    }
    emit("saved", (await response.json()) as Settings);
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Tallennus epäonnistui";
    return false;
  } finally {
    saving.value = false;
  }
}

// Siirtyminen asettelun muokkaukseen tallentaa keskeneräiset asetukset
// ensin — muuten esim. juuri säädetty yötilan aika katoaisi huomaamatta.
// Epäonnistunut tallennus jättää asetuspaneelin auki virheineen sen sijaan
// että siirtyisi eteenpäin ja hukkaisi muutokset.
async function editLayout(): Promise<void> {
  if (isNarrow.value) return;
  const ok = await persistDraft();
  if (!ok) return;
  emit("edit-layout");
  emit("close");
}

async function save(): Promise<void> {
  const ok = await persistDraft();
  if (ok) emit("close");
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="panel__head">
        <h2>Asetukset</h2>
        <button class="panel__close" type="button" @click="emit('close')">Sulje</button>
      </header>

      <div class="panel__body">
        <fieldset class="group">
          <legend>Näytettävät lapset</legend>
          <p v-if="!canPreviewSchedule" class="group__hint">Oppilasvalinta näkyy vain näyttölaitteella.</p>
          <p v-else-if="students.length === 0" class="group__hint">
            Ei oppilaita — Wilma-yhteys ei ole vielä käytössä.
          </p>
          <label v-for="student in students" :key="student.studentNumber" class="check">
            <input
              type="checkbox"
              :checked="isVisible(student.studentNumber)"
              @change="toggleStudent(student.studentNumber)"
            />
            <span>{{ student.name }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend>Paneelien asettelu</legend>
          <p class="group__hint">Siirrä paneeleja ja muuta niiden kokoa suoraan näytöllä.</p>
          <button type="button" class="btn" :disabled="isNarrow || saving" @click="editLayout">
            {{ saving ? "Tallennetaan…" : "Muokkaa asettelua" }}
          </button>
          <p v-if="isNarrow" class="group__hint">Asettelua muokataan infonäytöllä — näkymä on nyt liian kapea.</p>
        </fieldset>

        <fieldset class="group">
          <legend>Lukujärjestyksen asettelu</legend>
          <label class="radio">
            <input v-model="draft.scheduleLayout" type="radio" value="split" />
            <span>Rinnakkain — kaikki valitut lapset vierekkäin</span>
          </label>
          <label class="radio">
            <input v-model="draft.scheduleLayout" type="radio" value="single" />
            <span>Allekkain — yksi sarake</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend>Päivän vaihtuminen</legend>
          <p class="group__hint">
            Tähän kellonaikaan asti näkyy kuluva päivä, sen jälkeen seuraava koulupäivä.
          </p>
          <label class="field">
            <span>Vaihtoaika</span>
            <input v-model="draft.rolloverTime" type="time" />
          </label>
        </fieldset>

        <fieldset class="group">
          <legend>Aamupala</legend>
          <p class="group__hint">
            Käytetään hälytysten "aamupala"-ankkurina (ks. Hälytykset) niinä päivinä kun lapsi menee kouluun
            aamupalalle ennen varsinaisen oppitunnin alkua.
          </p>
          <label class="field">
            <span>Alkuaika</span>
            <input v-model="draft.breakfastTime" type="time" />
          </label>
        </fieldset>

        <fieldset class="group">
          <legend>Yötila</legend>
          <p class="group__hint">Näyttö himmenee tällä välillä.</p>
          <div class="field-row">
            <label class="field">
              <span>Alkaa</span>
              <input v-model="draft.nightModeStart" type="time" />
            </label>
            <label class="field">
              <span>Päättyy</span>
              <input v-model="draft.nightModeEnd" type="time" />
            </label>
          </div>
        </fieldset>

        <fieldset class="group">
          <legend>Yksityisyys</legend>
          <label class="check">
            <input v-model="draft.hideMessagePreviews" type="checkbox" />
            <span>Piilota viestien sisältö — näytä vain lähettäjä ja otsikko</span>
          </label>
        </fieldset>

        <!-- Näkyy vain laitteella joka on ottanut jonkin tason käyttöön
             koodilla — näyttölaitteella ei ole tallennettua koodia
             unohdettavaksi. currentLevel on aina tuore (App.vue), joten
             teksti ei voi jäädä väittämään väärää tasoa. -->
        <fieldset v-if="editAccess.hasStoredPin.value" class="group">
          <legend>Muokkausoikeus</legend>
          <p class="group__hint">
            {{
              currentLevel === "full"
                ? "Täydet oikeudet ovat käytössä tällä laitteella — myös lasten Wilma-tiedot."
                : "Muokkaus on käytössä tällä laitteella koodilla. Ei lasten Wilma-tietoja."
            }}
          </p>
          <button type="button" class="btn" @click="editAccess.forget()">Unohda koodi</button>
        </fieldset>

        <p v-if="error" class="panel__error">{{ error }}</p>
      </div>

      <footer class="panel__foot">
        <button type="button" class="btn" @click="emit('close')">Peruuta</button>
        <button type="button" class="btn btn--primary" :disabled="saving" @click="save">
          {{ saving ? "Tallennetaan…" : "Tallenna" }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 6, 10, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 1.5rem;
}

.panel {
  background: #141821;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(38rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.panel__head,
.panel__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.3rem;
  flex-shrink: 0;
}

.panel__head h2 {
  margin: 0;
  font-size: 1.2rem;
}

.panel__foot {
  gap: 0.7rem;
  justify-content: flex-end;
  border-top: 1px solid var(--border);
}

.panel__body {
  padding: 0 1.3rem 1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

.group {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0;
  padding: 1rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.group legend {
  font-size: 0.74rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--text-dim);
  padding: 0;
}

.group__hint {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-faint);
}

.check,
.radio {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 2.6rem;
  cursor: pointer;
  font-size: 0.95rem;
}

.check input,
.radio input {
  width: 1.15rem;
  height: 1.15rem;
  accent-color: var(--accent-school);
  flex-shrink: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.82rem;
  color: var(--text-dim);
}

.field-row {
  display: flex;
  gap: 1.2rem;
}

.field input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 1.1rem;
  padding: 0.55rem 0.7rem;
  font-variant-numeric: tabular-nums;
}

.panel__close {
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 0.5rem;
}

.btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.65rem 1.2rem;
  font-size: 0.95rem;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.panel__error {
  margin: 0;
  color: #f79b9b;
  font-size: 0.88rem;
}
</style>
