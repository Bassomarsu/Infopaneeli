<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useEditAccess, type PinLevel } from "../composables/useEditAccess.ts";

const props = defineProps<{
  open: boolean;
  /**
   * Mitä tallennettu koodi juuri nyt avaa palvelimen mukaan — null jos
   * mitään ei ole tallessa. Aina tuore (ks. App.vuen currentPinLevel), joten
   * "aktiivinen"-näkymä ei voi jäädä näyttämään väärää tasoa vaikka FULL_PIN
   * muuttuisi .env:ssä toisen istunnon aikana.
   */
  currentLevel: PinLevel | null;
}>();
const emit = defineEmits<{ close: []; authorized: [] }>();

const editAccess = useEditAccess();

const draft = ref("");
const verifying = ref(false);
const error = ref<string | null>(null);
const retryHint = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

/**
 * Taso jonka juuri lähetetty koodi todistetusti avasi — palvelimen
 * välitön vastaus, ei odota App.vuen seuraavaa /api/dashboard-pollausta.
 * Näytetään erillisenä vahvistusnäkymänä, jotta käyttäjä NÄKEE syöttö-
 * hetkellä kummalle tasolle päätyi (vaatimus: "täydet oikeudet" ja
 * "muokkaus" eivät saa sekoittua, ja vieraalla laitteella täyden koodin
 * syöttäjän pitää huomata mitä juuri tapahtui). Nollataan aina kun
 * dialogi suljetaan, jotta seuraava avaus näyttää tuoreen, currentLevel-
 * propin ohjaaman tilan eikä jää roikkumaan vanhaan vahvistukseen.
 */
const justVerifiedLevel = ref<PinLevel | null>(null);

type Mode = "confirmed" | "active" | "unavailable" | "form";

const mode = computed<Mode>(() => {
  if (justVerifiedLevel.value) return "confirmed";
  if (editAccess.hasStoredPin.value) return "active";
  if (editAccess.editPinConfigured.value === false && editAccess.fullPinConfigured.value === false) {
    return "unavailable";
  }
  return "form";
});

/** Selittää "form"-tilassa mitä tasoja on ylipäätään tarjolla — ei mainita tasoa jota ei ole otettu käyttöön .env:ssä. */
const availableTiersHint = computed(() => {
  const edit = editAccess.editPinConfigured.value;
  const full = editAccess.fullPinConfigured.value;
  if (edit && full) {
    return "Tällä laitteella voi ottaa käyttöön joko muokkausoikeuden (muistilista, asetukset, hälytykset) tai täydet oikeudet (myös lasten Wilma-tiedot) — sama kenttä toimii kummallekin koodille, palvelin tunnistaa kumpi on kyseessä.";
  }
  if (full) return "Tällä koodilla saa täydet oikeudet — myös lasten Wilma-tiedot.";
  if (edit) return "Tällä koodilla saa muokkausoikeuden muistilistaan, asetuksiin ja hälytyksiin.";
  return "";
});

/** "125 s" -> "2 min 5 s" — palvelin palauttaa sekunteina, käyttäjälle selkeämpi minuutteina. */
function formatRetryHint(retryAfterSeconds: number): string {
  const minutes = Math.floor(retryAfterSeconds / 60);
  const seconds = retryAfterSeconds % 60;
  if (minutes === 0) return `noin ${seconds} sekunnin kuluttua`;
  if (seconds === 0) return `noin ${minutes} minuutin kuluttua`;
  return `noin ${minutes} min ${seconds} s kuluttua`;
}

// Jokaisella avauskerralla kysytään palvelimelta mitkä tasot ylipäätään ovat
// käytössä — se on voinut muuttua (EDIT_PIN/FULL_PIN lisätty tai poistettu
// .env:stä ja palvelin käynnistetty uudelleen sen jälkeen kun tämä puhelin
// viimeksi latasi sivun).
watch(
  () => props.open,
  (open) => {
    if (!open) {
      draft.value = "";
      error.value = null;
      retryHint.value = null;
      justVerifiedLevel.value = null;
      return;
    }
    void editAccess.refreshPinConfigured();
    if (!editAccess.hasStoredPin.value) {
      void nextTick(() => inputEl.value?.focus());
    }
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  },
);

async function submit(): Promise<void> {
  const pin = draft.value.trim();
  if (!pin || verifying.value) return;
  verifying.value = true;
  error.value = null;
  retryHint.value = null;
  const result = await editAccess.verifyAndStore(pin);
  verifying.value = false;
  if (result.ok && result.level) {
    draft.value = "";
    justVerifiedLevel.value = result.level;
    // Ei suljeta dialogia — käyttäjän pitää nähdä vahvistus kummasta
    // tasosta on kyse ennen kuin sen sulkee itse. Loppusovellus (Wilma-
    // näkyvyys ym.) päivittyy taustalla heti.
    emit("authorized");
    return;
  }
  error.value = result.error;
  retryHint.value = result.retryAfterSeconds !== undefined ? formatRetryHint(result.retryAfterSeconds) : null;
}

function forget(): void {
  editAccess.forget();
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <section class="panel">
      <header class="panel__head">
        <h2>Muokkausoikeus</h2>
        <button class="panel__close" type="button" aria-label="Sulje" @click="emit('close')">Sulje</button>
      </header>

      <div class="panel__body">
        <!-- Juuri vahvistettu koodi: näytetään selkeästi kumpi taso avautui. -->
        <template v-if="mode === 'confirmed'">
          <p class="hint hint--strong">
            {{ justVerifiedLevel === "full" ? "Täydet oikeudet otettu käyttöön." : "Muokkausoikeus otettu käyttöön." }}
          </p>
          <p v-if="justVerifiedLevel === 'full'" class="hint hint--full">
            Tämä laite näkee nyt myös lasten Wilma-tiedot — aivan kuten näyttölaite.
          </p>
          <p v-else class="hint hint--faint">
            Muistilista, asetukset ja hälytykset ovat nyt muokattavissa tällä laitteella. Ei lasten Wilma-tietoja.
          </p>
          <button type="button" class="btn btn--primary" @click="emit('close')">Valmis</button>
        </template>

        <!-- Koodi jo tallessa entuudestaan: tarjotaan vain unohtaminen, ei uutta kysytä. currentLevel on aina tuore, ks. prop-kommentti. -->
        <template v-else-if="mode === 'active'">
          <p class="hint hint--strong">
            {{ currentLevel === "full" ? "Täydet oikeudet ovat käytössä tällä laitteella." : "Muokkaus on käytössä tällä laitteella." }}
          </p>
          <p v-if="currentLevel === 'full'" class="hint hint--full">Tämä laite näkee myös lasten Wilma-tiedot.</p>
          <p v-else class="hint hint--faint">
            Ei näytä lasten Wilma-tietoja — niihin tarvitaan täysien oikeuksien koodi.
          </p>
          <button type="button" class="btn" @click="forget">Unohda koodi</button>
        </template>

        <!-- Palvelimella ei ole kumpikaan koodi käytössä: ei tarjota syöttöä. -->
        <template v-else-if="mode === 'unavailable'">
          <p class="hint">
            Kumpaakaan koodia ei ole otettu käyttöön. Muokkaus onnistuu tällä hetkellä vain näyttölaitteelta.
          </p>
        </template>

        <!-- Normaalitapaus: jokin taso on käytössä palvelimella, tätä laitetta ei ole vielä valtuutettu. -->
        <template v-else>
          <p v-if="editAccess.expired.value" class="hint hint--warn">
            Tallennettu koodi ei enää kelpaa — syötä uusi.
          </p>
          <p class="hint">Syötä koti-infonäytön PIN-koodi ottaaksesi muokkauksen tai täydet oikeudet käyttöön.</p>
          <p class="hint hint--faint">{{ availableTiersHint }}</p>

          <form class="form" @submit.prevent="submit">
            <input
              ref="inputEl"
              v-model="draft"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]*"
              maxlength="10"
              placeholder="PIN"
              class="form__input"
            />
            <button type="submit" class="btn btn--primary" :disabled="verifying || draft.trim().length === 0">
              {{ verifying ? "Tarkistetaan…" : "Ota käyttöön" }}
            </button>
          </form>

          <p v-if="error" class="panel__error">
            {{ error }}<template v-if="retryHint"> Yritä uudelleen {{ retryHint }}.</template>
          </p>
        </template>
      </div>
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
  z-index: 65;
  padding: 1.5rem;
}

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

.hint--warn {
  color: #f3c26b;
}

/* Täydet oikeudet -korostus — sama väri kuin topbarin lukkopisteen "full"-tila, jotta tasot tunnistaa samasta väristä koko sovelluksessa. */
.hint--full {
  font-size: 0.85rem;
  color: #e08a5a;
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
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
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
