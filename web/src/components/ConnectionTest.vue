<script setup lang="ts">
/**
 * "Testaa yhteys" -painike Wilman katkaisijan manuaaliseen avaamiseen (ks.
 * server/src/core/provider.ts:n manualTest ja docs/wilma.md:n "Tilin lukituksen
 * esto"). Katkaisijan automaattinen jäähdytys voi venyä neljään tuntiin —
 * tämä antaa käyttäjälle keinon yrittää heti sen sijaan että odottaisi tai
 * käynnistäisi palvelimen uudelleen. Uudelleenyhdistäminen on tällöin
 * käyttäjän omalla vastuulla, ei automaation.
 *
 * Itsenäinen, ei-liitetty komponentti — ei riipu SettingsPanel.vuesta.
 * Liitetään paikkaan jossa asetuspaneelin muut fieldset-ryhmät ovat, esim.:
 *
 *   <fieldset class="group">
 *     <legend>Wilma-yhteys</legend>
 *     <ConnectionTest />
 *   </fieldset>
 *
 * — jolloin ryhmän otsikko/reunaviiva tulee samasta .group/legend-tyylistä
 * kuin muillakin ryhmillä, ja tämä komponentti piirtää vain sisällön.
 *
 * Viiden minuutin ja vuorokausikaton rajoitin on PALVELIMELLA (ks.
 * provider.ts:n manualTest) — tässä näkyvä lasku on vain käyttöliittymän
 * arvio eikä säily sivun päivityksen yli. Se ei haittaa: jos painiketta
 * painetaan liian aikaisin (esim. toiselta laitteelta tai sivu ladattu
 * uudelleen juuri ennen jäähtymistä), palvelin vastaa 429:llä ja tuoreella
 * retryAfterSecondsilla, josta laskuri käynnistyy uudelleen oikeana.
 */
import { onUnmounted, ref } from "vue";
import { useEditAccess } from "../composables/useEditAccess.ts";

/**
 * Sama oletusarvo kuin palvelimen manualTestIntervalMs (server/src/core/
 * provider.ts). Käytetään vain kun palvelin ei anna tarkkaa lukua (onnistunut
 * tai epäonnistunut testi, ei 429) — pelkkä paras arvaus laskurin näyttöön.
 */
const MANUAL_TEST_INTERVAL_SECONDS = 5 * 60;

const editAccess = useEditAccess();

const testing = ref(false);
const countdownSeconds = ref(0);
const resultMessage = ref<string | null>(null);
const resultOk = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function stopCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function startCountdown(seconds: number): void {
  stopCountdown();
  countdownSeconds.value = Math.max(0, Math.round(seconds));
  if (countdownSeconds.value <= 0) return;
  countdownTimer = setInterval(() => {
    countdownSeconds.value -= 1;
    if (countdownSeconds.value <= 0) stopCountdown();
  }, 1000);
}

onUnmounted(stopCountdown);

/** "125 s" -> "2 min 5 s" — sama muotoilu kuin EditAccessDialog/KioskExitDialog. */
function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes === 0) return `${secs} s`;
  if (secs === 0) return `${minutes} min`;
  return `${minutes} min ${secs} s`;
}

interface TestResponseBody {
  ok?: boolean;
  error?: string | { type?: string; message?: string };
  retryAfterSeconds?: number;
}

function errorText(body: TestResponseBody | null, status: number): string {
  const err = body?.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  return `Testi epäonnistui (HTTP ${status})`;
}

async function test(): Promise<void> {
  if (testing.value || countdownSeconds.value > 0) return;
  testing.value = true;
  resultMessage.value = null;
  try {
    const response = await editAccess.editFetch("/api/providers/wilma/test", { method: "POST" });
    const body = (await response.json().catch(() => null)) as TestResponseBody | null;

    switch (response.status) {
      case 200:
        // Onnistunut testi on aina myös oikea yritys palvelimen rajoittimen
        // kannalta — laskuri käynnistyy samalla oletusarvolla kuin epäonnistunutkin.
        resultOk.value = true;
        resultMessage.value = "Yhteys toimii — katkaisija nollattu.";
        startCountdown(MANUAL_TEST_INTERVAL_SECONDS);
        break;
      case 502:
        // Todellinen yritys tehtiin ja se epäonnistui — sama rajoitin koskee seuraavaa.
        resultOk.value = false;
        resultMessage.value = errorText(body, response.status);
        startCountdown(MANUAL_TEST_INTERVAL_SECONDS);
        break;
      case 429:
        // Palvelin kertoo tarkan jäljellä olevan ajan — joko tämän napin omasta
        // rajoittimesta tai PIN-rajoittimesta (access.ts), kumpikin näytetään samoin.
        resultOk.value = false;
        resultMessage.value = errorText(body, response.status);
        startCountdown(body?.retryAfterSeconds ?? MANUAL_TEST_INTERVAL_SECONDS);
        break;
      case 409:
        // Testi oli jo käynnissä — ei kuluttanut rajoitinta, painike käytettävissä heti.
        resultOk.value = false;
        resultMessage.value = "Yhteystesti on jo käynnissä — odota sen valmistumista.";
        break;
      default:
        // 400/401/403/404 ym.: pyyntö hylättiin ennen kuin mitään yhteyttä edes
        // yritettiin (esim. puuttuva muokkausoikeus) — ei kuluta rajoitinta.
        resultOk.value = false;
        resultMessage.value = errorText(body, response.status);
        break;
    }
  } catch {
    resultOk.value = false;
    resultMessage.value = "Verkkovirhe — pyyntö ei tavoittanut palvelinta. Yritä uudelleen.";
    // Ei laskuria: emme tiedä tavoittiko pyyntö palvelinta asti, joten sitä
    // ei ole syytä olettaa kuluneeksi yritykseksi.
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="connection-test">
    <p class="hint hint--faint">
      Kokeilee Wilma-yhteyttä heti ja palauttaa katkaisijan onnistuessaan — automaattinen jäähdytys voi muuten kestää
      jopa 4 tuntia. Vaikuttaa heti, ei odota Tallenna-painiketta. Enintään kerran 5 minuutissa, jottei toistuva
      kirjautuminen lukitse Wilma-tiliä.
    </p>

    <button type="button" class="btn" :disabled="testing || countdownSeconds > 0" @click="test">
      {{ testing ? "Testataan… (voi kestää minuutteja)" : "Testaa yhteys" }}
    </button>

    <p v-if="!testing && countdownSeconds > 0" class="hint hint--faint">
      Seuraava testi mahdollinen {{ formatCountdown(countdownSeconds) }} kuluttua.
    </p>

    <p v-if="resultMessage" :class="['result', resultOk ? 'result--ok' : 'result--error']">
      {{ resultMessage }}
    </p>
  </div>
</template>

<style scoped>
.connection-test {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.hint {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-dim);
}

.hint--faint {
  font-size: 0.82rem;
  color: var(--text-faint);
}

.btn {
  align-self: flex-start;
  min-height: 44px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.result {
  margin: 0;
  font-size: 0.88rem;
}

.result--ok {
  color: var(--accent-school);
}

.result--error {
  color: #f79b9b;
}
</style>
