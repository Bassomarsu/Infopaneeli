<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { NARROW_LAYOUT_BREAKPOINT_PX } from "../composables/usePanelLayout";
import { useEditAccess, type PinLevel } from "../composables/useEditAccess.ts";
import {
  createPostalCodeLookup,
  fetchCurrentWeatherLocation,
  type CurrentWeatherLocation,
} from "../composables/useWeatherLocation.ts";
import ConnectionTest from "./ConnectionTest.vue";
import type { PaikkyChild, Settings, WilmaStudent } from "../types";

const editAccess = useEditAccess();

const props = defineProps<{
  settings: Settings;
  students: WilmaStudent[];
  /**
   * Päikyn lapset samassa muodossa kuin `students` — provider-datasta
   * litistettynä, jotta paneelin ei tarvitse tuntea PaikkyChildDatan muuta
   * sisältöä. Tyhjä samoista syistä kuin `students`, ks. canPreviewSchedule.
   */
  paikkyChildren: PaikkyChild[];
  /**
   * Onko Päikky ylipäätään konfiguroitu. Sama päättely kuin korteissa
   * (`paikkySnapshot !== undefined`): ilman Päikkyä asetuksiin ei kasvateta
   * tyhjää ryhmää, aivan kuten ScheduleCard/MessagesCard eivät kasvata
   * tyhjää välilehteä. Erillinen lipuksi, koska tyhjä `paikkyChildren` on
   * eri asia — se on myös puhelimen ja hakuvirheen tila.
   */
  paikkyConfigured: boolean;
  /**
   * Palvelin piilottaa Wilma- ja Päikky-datan laitteilta joilla ei ole
   * täyttä luottamusta — EDIT_PIN ei riitä tähän, vain FULL_PIN/näyttölaite/
   * TRUSTED_HOSTS (ks. server/src/routes/api.ts, SENSITIVE_PROVIDERS).
   * `students` ja `paikkyChildren` ovat siis tyhjiä EDIT_PIN:llä
   * muokkaavalla puhelimella. Tämä lippu erottaa sen "yhteyttä ei ole vielä
   * konfiguroitu" -tilasta, jotta hintteksti ei väitä väärää syytä (ks. sama
   * erottelu AlarmsPanel.vuessa). Samalla se estää lasten nimien
   * renderöinnin siellä missä palvelin on ne nimenomaan piilottanut.
   */
  canPreviewSchedule: boolean;
  /** Mitä tallennettu koodi tällä laitteella juuri nyt avaa — null jos ei mitään. Ks. App.vuen currentPinLevel. */
  currentLevel: PinLevel | null;
  open: boolean;
}>();

const emit = defineEmits<{ close: []; saved: [Settings]; "edit-layout": [] }>();

const draft = ref<Settings>({ ...props.settings });

/**
 * Tallennettu avain on `hideNextAlarm` (ks. types.ts), mutta valintaruutu
 * luetaan luontevimmin myöntävänä — "näytä", ei "älä piilota". Kääntö tehdään
 * siis tässä eikä datan puolella: avaimen suunta on yhteensopivuusasia,
 * käyttöliittymän sanamuoto luettavuusasia, eikä kumpikaan saa sanella toista.
 */
const showNextAlarm = computed<boolean>({
  get: () => !draft.value.hideNextAlarm,
  set: (value) => {
    draft.value.hideNextAlarm = !value;
  },
});
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

// ---- Sään sijainti postinumerona -------------------------------------------

const postalInput = ref("");
const postalLookup = createPostalCodeLookup(editAccess.editFetch);
const currentLocation = ref<CurrentWeatherLocation | null>(null);
const currentLocationLoading = ref(false);

onUnmounted(() => postalLookup.dispose());

/**
 * Postinumerokenttä nollataan VAIN kun paneeli avataan, ei aina kun
 * `props.settings` vaihtuu. Yllä oleva draft-watch tekee jälkimmäistä, koska
 * settings on App.vuessa laskettu dashboardista ja saa uuden identiteetin
 * joka pollauksella — kesken kirjoitettu postinumero katoaisi siihen
 * minuutin välein. Siksi tallennettava arvo luetaan hakukentän tilasta
 * (`postalToSave`) eikä draftista.
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    postalInput.value = postalLookup.setInput(props.settings.weatherPostalCode ?? "");
    void loadCurrentLocation();
  },
  { immediate: true },
);

async function loadCurrentLocation(): Promise<void> {
  currentLocationLoading.value = true;
  try {
    currentLocation.value = await fetchCurrentWeatherLocation(editAccess.editFetch);
  } finally {
    currentLocationLoading.value = false;
  }
}

function onPostalInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  postalInput.value = postalLookup.setInput(target.value);
  // Kenttä itse voi jäädä näyttämään hylättyjä merkkejä (kirjaimet, välilyönnit,
  // kuudes numero), koska v-model ei ehdi väliin — pakotetaan sama arvo takaisin.
  if (target.value !== postalInput.value) target.value = postalInput.value;
}

function clearPostalCode(): void {
  postalInput.value = postalLookup.setInput("");
}

/**
 * Mikä arvo lähtee palvelimelle. Tyhjä kenttä on nimenomaan `null` eli
 * "palaa .env:n arvoon" — ei "älä muuta". Muissa kuin tyhjässä ja
 * ratkaistussa tilassa tallennus on estetty, joten viimeinen haara ei
 * käytännössä toteudu; se säilyttää tallennetun arvon varmuuden vuoksi.
 */
const postalToSave = computed<string | null>(() => {
  const state = postalLookup.state.value;
  if (state.kind === "empty") return null;
  if (state.kind === "found") return state.code;
  return props.settings.weatherPostalCode ?? null;
});

/** Näytettävä tila kentän alla. `warn` = käyttäjän pitää korjata jotain. */
const postalStatus = computed<{ tone: "ok" | "warn" | "muted"; text: string }>(() => {
  const state = postalLookup.state.value;
  switch (state.kind) {
    case "empty":
      return { tone: "muted", text: "Tyhjä kenttä: sää haetaan .env-tiedoston sijainnista." };
    case "incomplete":
      return { tone: "muted", text: "Postinumerossa on viisi numeroa, esim. 43500." };
    case "loading":
      return { tone: "muted", text: "Haetaan paikkakuntaa…" };
    case "found":
      return { tone: "ok", text: `${state.code} — ${state.place.place}` };
    case "unknown":
      return {
        tone: "warn",
        text: `Postinumeroa ${state.code} ei löytynyt. Tarkista numero — se on viisi numeroa, esim. 43500.`,
      };
    case "error":
      return { tone: "warn", text: state.message };
  }
});

/**
 * Ratkaisematonta sijaintia ei saa tallentaa: numero näyttäisi menneen
 * perille, mutta virhe paljastuisi vasta säätiedoissa. Null = tallennus saa
 * edetä.
 */
const postalBlocksSave = computed<string | null>(() => {
  const state = postalLookup.state.value;
  switch (state.kind) {
    case "empty":
    case "found":
      return null;
    case "incomplete":
      return "Postinumero on kesken — kirjoita viisi numeroa tai tyhjennä kenttä.";
    case "loading":
      return "Odota hetki: postinumeron paikkakuntaa haetaan vielä.";
    case "unknown":
      return `Postinumeroa ${state.code} ei löytynyt — korjaa numero tai tyhjennä kenttä.`;
    case "error":
      return `Postinumeroa ei voitu tarkistaa: ${state.message}`;
  }
});

/**
 * Mikä sijainti on NYT käytössä ja mistä se tulee. Tallennettu asetus, ei
 * kesken muokattu kenttä — muuten teksti väittäisi jo tapahtuneeksi jotain
 * mitä ei ole vielä tallennettu.
 */
const currentLocationText = computed<string>(() => {
  if (currentLocationLoading.value) return "Haetaan nykyistä sijaintia…";
  const location = currentLocation.value;
  const saved = props.settings.weatherPostalCode ?? null;
  if (!location) {
    // Paikkakunnan nimeä ei saatu palvelimelta. Jos asetuksissa EI ole
    // numeroa, asetukset eivät ole voineet vaikuttaa mihinkään, joten .env on
    // väistämättä lähde ja sen saa sanoa. Toisin päin ei: tallennettu numero
    // voi olla tuntematon, jolloin voimassa on edellinen sijainti eikä tuo
    // numero — siksi tallennetusta numerosta kerrotaan vain että se on
    // kentässä, ei että se olisi käytössä.
    return saved !== null
      ? `Asetuksiin tallennettu postinumero ${saved}. Paikkakunnan nimeä ei saatu palvelimelta.`
      : "Nyt käytössä: .env-tiedoston sijainti. Paikkakunnan nimeä ei saatu palvelimelta.";
  }
  // Lähdettä EI päätellä tallennetusta asetuksesta. Palvelin tietää sen, ja jos
  // se ei kerro (tuntemattoman numeron takia voimassa pidetty vanha sijainti,
  // tai vanha palvelin joka ei lähetä kenttää), lähdettä ei väitetä lainkaan:
  // pelkkä paikannimi on rehellinen, arvattu lähde ei. Aiemmin tässä arvattiin,
  // ja paneeli väitti .env:n sijaintia asetuksista tulleeksi.
  if (location.source === null) return `Nyt käytössä: ${location.place}.`;
  if (location.source === "env") return `Nyt käytössä: ${location.place} — .env-tiedostosta.`;
  return saved !== null
    ? `Nyt käytössä: ${location.place} — postinumerosta ${saved} (asetuksista).`
    : `Nyt käytössä: ${location.place} — asetuksista.`;
});

// ----------------------------------------------------------------------------

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

// Päikyn lapsivalinta noudattaa täsmälleen Wilman sääntöjä yllä: null on
// "kaikki", eikä siitä siirrytä listaan ennen kuin käyttäjä oikeasti poistaa
// jonkun valinnan. `?? null` kattaa vanhemman palvelimen, joka ei vielä
// palauta kenttää lainkaan — muuten ensimmäinen napautus kaatuisi.
function togglePaikkyChild(childId: string): void {
  const current = draft.value.visiblePaikkyChildren ?? null;
  const list = current === null ? props.paikkyChildren.map((c) => c.id) : [...current];
  const index = list.indexOf(childId);
  if (index >= 0) list.splice(index, 1);
  else list.push(childId);
  draft.value.visiblePaikkyChildren = list;
}

function isPaikkyChildVisible(childId: string): boolean {
  const list = draft.value.visiblePaikkyChildren ?? null;
  return list === null || list.includes(childId);
}

/**
 * Yhteinen tallennus "Tallenna"-napille ja asettelun muokkaukseen
 * siirtymiselle — kumpikaan ei saa hukata kesken jääneitä muutoksia
 * äänettömästi. Palauttaa onnistuiko, jotta kutsuja voi päättää jatkaako.
 */
async function persistDraft(): Promise<boolean> {
  // Sama este kuin Tallenna-napin `disabled`illa, mutta tässä myös
  // "Muokkaa asettelua" -polulle — ja tämä on se paikka joka oikeasti
  // estää ratkaisemattoman sijainnin menemästä palvelimelle.
  if (postalBlocksSave.value !== null) {
    error.value = postalBlocksSave.value;
    return false;
  }
  saving.value = true;
  error.value = null;
  try {
    const response = await editAccess.editFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft.value, weatherPostalCode: postalToSave.value }),
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
        <!-- Kaksi lapsivalintaa peräkkäin, kummallakin oma lähteensä: otsikot
             nimeävät lähteen, jotta ryhmiä ei lueta saman listan jatkoksi. -->
        <fieldset class="group">
          <legend>Näytettävät lapset — Wilma</legend>
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

        <fieldset v-if="paikkyConfigured" class="group">
          <legend>Näytettävät lapset — Päikky</legend>
          <p v-if="!canPreviewSchedule" class="group__hint">Lapsivalinta näkyy vain näyttölaitteella.</p>
          <p v-else-if="paikkyChildren.length === 0" class="group__hint">
            Ei lapsia — Päikyn tietoja ei ole vielä saatu.
          </p>
          <label v-for="child in paikkyChildren" :key="child.id" class="check">
            <input
              type="checkbox"
              :checked="isPaikkyChildVisible(child.id)"
              @change="togglePaikkyChild(child.id)"
            />
            <span>{{ child.firstName }} {{ child.lastName }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend>Paneelien asettelu</legend>
          <p class="group__hint">Siirrä paneeleja ja muuta niiden kokoa suoraan näytöllä.</p>
          <button type="button" class="btn" :disabled="isNarrow || saving || postalBlocksSave !== null" @click="editLayout">
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

        <!-- Sää hakee sijaintinsa tästä postinumerosta. Nykyinen sijainti
             näytetään erikseen kentän yläpuolella, koska tyhjä kenttä ei
             tarkoita "ei sijaintia" vaan ".env:n arvo" — ks. types.ts:n
             weatherPostalCode. -->
        <fieldset class="group">
          <legend>Sään sijainti</legend>
          <p class="group__hint">{{ currentLocationText }}</p>
          <label class="field">
            <span>Postinumero</span>
            <!-- inputmode="numeric" nostaa puhelimessa numeronäppäimistön;
                 type pysyy tekstinä, koska number-kenttä syö etunollat
                 (esim. 00100) ja tarjoaa turhat nuolipainikkeet. -->
            <input
              :value="postalInput"
              class="postal__input"
              type="text"
              inputmode="numeric"
              autocomplete="postal-code"
              enterkeyhint="done"
              maxlength="5"
              placeholder="esim. 43500"
              @input="onPostalInput"
            />
          </label>
          <p class="postal__status" :class="`postal__status--${postalStatus.tone}`">
            {{ postalStatus.text }}
          </p>
          <button
            type="button"
            class="btn btn--quiet"
            :disabled="postalInput.length === 0"
            @click="clearPostalCode"
          >
            Tyhjennä — käytä .env:n sijaintia
          </button>
        </fieldset>

        <!-- Oma ryhmänsä eikä yötilan tai yksityisyyden alla: banneri ei ole
             kumpaakaan, vaan yläpalkin sisältöä. Yötilan vieressä siksi että
             molemmat koskevat ruudun yläosaa ja passiivista tietoa. -->
        <fieldset class="group">
          <legend>Yläpalkki</legend>
          <label class="check">
            <input v-model="showNextAlarm" type="checkbox" />
            <span>Näytä seuraava hälytys yläpalkissa</span>
          </label>
          <p class="group__hint">
            Näkyy vain kun jokin hälytys oikeasti soi lähipäivinä.
          </p>
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

        <!-- Viimeisenä, koska tämä on ainoa ryhmä joka EI ole asetus:
             painike vaikuttaa heti eikä odota Tallenna-painiketta, eikä
             Peruuta kumoa sitä. Siksi myös oma selite alla — muuten
             käyttäjä olettaisi paneelin muun logiikan pätevän tähänkin.
             Fieldset ja legend tässä eikä ConnectionTestissä, jotta
             paneelin omat .group/legend-tyylit pätevät sellaisenaan. -->
        <fieldset class="group">
          <legend>Wilma-yhteys</legend>
          <ConnectionTest />
        </fieldset>

        <p v-if="error" class="panel__error">{{ error }}</p>
      </div>

      <footer class="panel__foot">
        <!-- Syy näkyy tässä eikä vain sään ryhmässä: Tallenna on paneelin
             pohjalla, eikä harmaa nappi ilman selitystä kerro mitään. -->
        <p v-if="postalBlocksSave" class="panel__blocked">{{ postalBlocksSave }}</p>
        <button type="button" class="btn" @click="emit('close')">Peruuta</button>
        <button type="button" class="btn btn--primary" :disabled="saving || postalBlocksSave !== null" @click="save">
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
  /* Estesyy voi olla pitkä; puhelimen leveydellä se saa siirtyä omalle
     rivilleen sen sijaan että puristaisi napit kasaan. */
  flex-wrap: wrap;
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

/* Viisi numeroa ei tarvitse paneelin koko leveyttä, mutta kosketuskorkeus
   tulee .field inputin paddingista. `ch` skaalaa kentän sisällön mukaan. */
.postal__input {
  width: 9ch;
  letter-spacing: 0.12em;
}

.postal__status {
  margin: 0;
  font-size: 0.82rem;
  /* Kolme tilaa vaihtelee eri mittaisiksi teksteiksi; kiinteä korkeus estää
     ryhmää hyppimästä kun tila vaihtuu kirjoittaessa. */
  min-height: 2.4em;
}

.postal__status--muted {
  color: var(--text-faint);
}

.postal__status--ok {
  color: var(--text);
  font-weight: 600;
}

.postal__status--warn {
  color: #f79b9b;
}

/* Toissijainen toiminto sään ryhmässä: sama kosketusalue kuin muilla
   napeilla, mutta ei kilpaile Tallenna-napin kanssa katseesta. */
.btn--quiet {
  align-self: flex-start;
  font-size: 0.85rem;
  padding: 0.5rem 0.9rem;
}

.panel__blocked {
  margin: 0 auto 0 0;
  color: #f79b9b;
  font-size: 0.8rem;
  max-width: 22rem;
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
