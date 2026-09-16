<script setup lang="ts">
/**
 * Vahvistus + PIN kioskista poistumiselle (avaa KioskExitHotspot.vuen pitkä
 * painallus). Malli otettu EditAccessDialog.vuesta (sama overlay/panel/
 * form/btn-rakenne ja focus-/Escape-käytös) — ei kuitenkaan sama komponentti,
 * koska tarkoitus on eri: EditAccessDialog TALLENTAA koodin tulevia
 * pyyntöjä varten, tämä käyttää koodin KERTALUONTEISESTI yhteen palvelin-
 * pyyntöön eikä tallenna sitä mihinkään. Vaatii FULL_PIN:n, ei EDIT_PIN:n
 * (ks. server/src/routes/access.ts:n verifyFullPinOnly) — palvelin päättää
 * tämän, dialogi vain näyttää palvelimen vastauksen.
 *
 * Onnistuneen pyynnön jälkeen palvelin sulkee kioskiselaimen sekunnin tai
 * kahden sisällä — ruutu katoaa itsestään, joten dialogissa ei ole erillistä
 * "onnistui"-näkymää, ainoastaan "Suljetaan…"-tila joka jää näkyviin siihen
 * asti kun sivu lakkaa olemasta.
 *
 * KEHYS ON `ModalDialog` (`<dialog showModal>`), EI OMA `position: fixed`
 * -overlay — ÄLÄ PALAUTA OVERLAYTÄ. Yötila on `.app`-elementillä
 * `filter: brightness(...)` (ks. style.css), ja suodatin tekee elementistä
 * sijoitussäiliön myös `position: fixed`ille. Silloin overlay asemoitui
 * dokumenttiin eikä näkymään, ja mitä kauemmas sivu oli vieritetty, sitä
 * kauemmas dialogi lipui: mitattuna poikkeama oli tasan puolet vierityksestä
 * (901 px:llä −116, 1280:llä −177, 1920:llä −247, 2736:lla −433), ja
 * 800 × 480:n paneelilla — Raspberry Pi:n virallisella näytöllä, jossa
 * vieritystä oli 2434 px — dialogi jäi kokonaan ruudun ulkopuolelle.
 * Selain vieritti itse PIN-kenttään (2434 → 1348) EIKÄ palauttanut
 * vieritystä dialogin sulkemisen jälkeen, joten kioskiruutu jäi väärään
 * kohtaan. Ylätason `<dialog>` on ainoa kehys joka ei ole suodattimen
 * armoilla: se piirretään top layerissa, jolloin sekä sijainti että
 * kirkkaus tulevat näkymästä eivätkä `.app`ista. Sama kehys kuin
 * SettingsPanelilla (ks. ModalDialog.vue).
 */
import { nextTick, ref, watch } from "vue";
import ModalDialog from "./ModalDialog.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const draft = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);
const retryHint = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

/** "125 s" -> "2 min 5 s" — sama muotoilu kuin EditAccessDialog.vuessa. */
function formatRetryHint(retryAfterSeconds: number): string {
  const minutes = Math.floor(retryAfterSeconds / 60);
  const seconds = retryAfterSeconds % 60;
  if (minutes === 0) return `noin ${seconds} sekunnin kuluttua`;
  if (seconds === 0) return `noin ${minutes} minuutin kuluttua`;
  return `noin ${minutes} min ${seconds} s kuluttua`;
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      draft.value = "";
      error.value = null;
      retryHint.value = null;
      submitting.value = false;
      return;
    }
    void nextTick(() => inputEl.value?.focus());
  },
);

// Escapelle ei ole omaa kuuntelijaa: `<dialog showModal>` lähettää
// `cancel`-tapahtuman, jonka ModalDialog kääntää `close`-emitiksi. Oma
// window-kuuntelija sulkisi saman dialogin toiseen kertaan.

async function submit(): Promise<void> {
  const pin = draft.value.trim();
  if (!pin || submitting.value) return;
  submitting.value = true;
  error.value = null;
  retryHint.value = null;
  try {
    const response = await fetch("/api/kiosk/exit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (response.ok) {
      // Ei nollata submitting-lippua: kioski sulkeutuu itsestään muutaman
      // sekunnin sisällä, "Suljetaan…" saa jäädä näkyviin siihen asti.
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: string; retryAfterSeconds?: number } | null;
    error.value = body?.error ?? `Pyyntö epäonnistui (HTTP ${response.status})`;
    retryHint.value = body?.retryAfterSeconds !== undefined ? formatRetryHint(body.retryAfterSeconds) : null;
    submitting.value = false;
  } catch {
    error.value = "Verkkovirhe — yritä uudelleen";
    submitting.value = false;
  }
}
</script>

<template>
  <ModalDialog v-if="open" label="Poistu kioskitilasta" @close="emit('close')">
    <section class="panel">
      <header class="panel__head">
        <h2>Poistu kioskitilasta</h2>
        <button class="panel__close" type="button" aria-label="Sulje" @click="emit('close')">Sulje</button>
      </header>

      <div class="panel__body">
        <p class="hint hint--strong">Tämä sulkee kioskiselaimen kokonaan ja jättää näytön työpöydälle.</p>
        <p class="hint">Vaatii täysien oikeuksien PIN-koodin (FULL_PIN) — muokkausoikeuden koodi ei riitä.</p>
        <p class="hint hint--faint">
          Käynnistä kioski takaisin käynnistämällä laite uudelleen, tai käynnistä ajastettu tehtävä/palvelu käsin —
          tarkat ohjeet: asennus/KAYTTOONOTTO.md (Windows) tai asennus/KAYTTOONOTTO-LINUX.md (Linux), kohta
          "Kioskista poistuminen".
        </p>

        <form class="form" @submit.prevent="submit">
          <input
            ref="inputEl"
            v-model="draft"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            maxlength="10"
            placeholder="FULL_PIN"
            class="form__input"
          />
          <button type="submit" class="btn btn--danger" :disabled="submitting || draft.trim().length === 0">
            {{ submitting ? "Suljetaan…" : "Sulje kioski" }}
          </button>
        </form>

        <p v-if="error" class="panel__error">
          {{ error }}<template v-if="retryHint"> Yritä uudelleen {{ retryHint }}.</template>
        </p>
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
  width: min(24rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.3rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.panel__head h2 {
  margin: 0;
  font-size: 1.15rem;
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
}

.panel__close:hover,
.panel__close:focus-visible {
  color: var(--text);
  background: var(--surface);
}

.panel__body {
  padding: 0.4rem 1.3rem 1.3rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.hint {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-dim);
}

.hint--strong {
  color: var(--text);
  font-weight: 600;
}

.hint--faint {
  font-size: 0.8rem;
  color: var(--text-faint);
}

.form {
  display: flex;
  gap: 0.6rem;
}

.form__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 1.2rem;
  letter-spacing: 0.15em;
  padding: 0 0.9rem;
}

.btn {
  min-height: 44px;
  border-radius: 12px;
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

/* Punainen, ei vihreä kuten EditAccessDialogin btn--primary: tämä on
   tuhoisa/peruuttamattoman tuntuinen toimenpide, sen pitää erottua
   visuaalisesti tavallisesta "ota käyttöön" -napista. */
.btn--danger {
  background: #b8443f;
  border: 1px solid transparent;
  color: #fff;
  font-weight: 600;
  white-space: nowrap;
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
