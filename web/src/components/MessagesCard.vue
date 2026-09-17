<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CardShell from "./CardShell.vue";
import MessageDialog from "./MessageDialog.vue";
import PaikkyMessages from "./PaikkyMessages.vue";
import { useEditAccess } from "../composables/useEditAccess";
import type { PaikkyData, PaikkyMessage, ProviderSnapshot, ProviderStatus, WilmaData, WilmaMessage } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<WilmaData>;
  /** Puuttuu kokonaan jos Päikkyä ei ole konfiguroitu — silloin kortti on entisellään. */
  paikkySnapshot?: ProviderSnapshot<PaikkyData>;
  hidePreviews: boolean;
}>();

const editAccess = useEditAccess();

type Source = "wilma" | "paikky";
type Mode = "unread" | "read";

/**
 * Valinta on kaksiulotteinen: LÄHDE (Wilma / Päikky) ja LUKUTILA (lukematta /
 * luetut). Yhdeksi välilehtiriviksi ne eivät mahdu — neljä välilehteä
 * ("Wilma lukematta", "Wilma luetut", …) ei ole luettavissa parin metrin
 * päästä — joten ne ovat kaksi eri asiaa myös näytöllä:
 *
 * - Lähdevälilehdet ylimpänä, kumpikin oma lukemattomien lukumääränsä mukana.
 *   Ne kertovat mitä korttiin on tullut; siksi lukumäärä on nimenomaan täällä.
 * - Niiden alla ohut ohjausrivi: lukutilan valinta ja "merkitse kaikki
 *   luetuiksi". Se ei ole välilehtirivi vaan valitun lähteen työkalut.
 *
 * Ilman Päikkyä lähderiviä EI piirretä lainkaan: yhdellä lähteellä se olisi
 * yksi nappi joka ei valitse mitään, ja kortti jäisi entiselleen — yksi rivi,
 * ja lukemattomien lukumäärä siirtyy silloin "Lukematta"-valintaan, koska se
 * on ainoa paikka jossa se on yksiselitteinen. Lukumäärä näkyy siis aina
 * täsmälleen kerran, sillä rivillä joka kertoo mitä lasketaan.
 */
const source = ref<Source>("wilma");
const mode = ref<Mode>("unread");

const paikkyConfigured = computed(() => props.paikkySnapshot !== undefined);

// Jos Päikky poistetaan käytöstä kesken kaiken, kortti ei saa jäädä auki
// lähteeseen jota ei enää ole.
watch(paikkyConfigured, (configured) => {
  if (!configured && source.value === "paikky") source.value = "wilma";
});

/**
 * `localRead` tulee Päikyn viesteihin palvelimelta samalla tavalla kuin
 * Wilman viesteihin, mutta se on tyypissä valinnainen: se on tämän näytön
 * kirjanpitoa eikä Päikyn kenttä, eikä sitä ole vanhemman palvelimen
 * vastauksessa. Puuttuva kenttä ei ole "luettu".
 */
type PaikkyMessageWithRead = PaikkyMessage & { localRead?: boolean };

/**
 * Local read state, keyed by message id. Seeded from what the server already
 * persisted (`message.localRead`, from server/src/core/store.ts's
 * `message_reads` table) and then updated the moment a message is opened or
 * merkitään luetuksi, so the tabs react instantly instead of waiting for the
 * next dashboard poll (which only runs every few minutes).
 *
 * Avain on merkkijono ja lähde on osa sitä: Wilman tunniste on numero ja
 * Päikyn merkkijono, joten pelkkä id sekoittaisi Wilman viestin 5 ja Päikyn
 * viestin "5" toisiinsa.
 */
const localReads = ref(new Set<string>());

function readKey(source: Source, id: string | number): string {
  return `${source}:${id}`;
}

watch(
  () => props.snapshot?.data?.messages,
  (messages) => {
    for (const message of messages ?? []) {
      if (message.localRead) localReads.value.add(readKey("wilma", message.id));
    }
  },
  { immediate: true },
);

watch(
  () => props.paikkySnapshot?.data?.messages as PaikkyMessageWithRead[] | undefined,
  (messages) => {
    for (const message of messages ?? []) {
      if (message.localRead) localReads.value.add(readKey("paikky", message.id));
    }
  },
  { immediate: true },
);

function isWilmaRead(message: WilmaMessage): boolean {
  return localReads.value.has(readKey("wilma", message.id));
}

/**
 * Päikyn lukutila ratkeaa samalla säännöllä kuin Wilman: tämän näytön oma
 * kirjanpito ensin. Päikyn oma `unread === false` kelpaa myös perusteeksi —
 * se on Päikyn väite että viesti on luettu. `unread === null` EI ole: se
 * tarkoittaa "Päikky ei kerro", jolloin viesti pysyy lukemattomana kunnes se
 * merkitään täällä. Tuntematonta ei siis esitetä luettuna.
 */
function isPaikkyRead(message: PaikkyMessage): boolean {
  if (localReads.value.has(readKey("paikky", message.id))) return true;
  return message.unread === false;
}

const allMessages = computed(() => props.snapshot?.data?.messages ?? []);
const wilmaUnread = computed(() => allMessages.value.filter((m) => !isWilmaRead(m)));
const wilmaRead = computed(() => allMessages.value.filter((m) => isWilmaRead(m)));

const paikkyMessages = computed(() => props.paikkySnapshot?.data?.messages ?? []);
const paikkyUnread = computed(() => paikkyMessages.value.filter((m) => !isPaikkyRead(m)));
const paikkyRead = computed(() => paikkyMessages.value.filter((m) => isPaikkyRead(m)));

const unreadCount = computed(() => wilmaUnread.value.length + paikkyUnread.value.length);

/** Lähde on tyhjä vasta kun se on oikeasti luettu — ei silloin kun se on piilotettu tai poikki. */
function showable(snapshot?: ProviderSnapshot<unknown>): boolean {
  return snapshot?.status === "ok" || snapshot?.status === "stale";
}

/**
 * Molemmat lähteet luettu ja tyhjinä: ei välilehtiä, vain rauhallinen
 * tyhjätila. Piilotettu tai epäonnistunut lähde EI ole tyhjä postilaatikko —
 * "Ei viestejä" olisi silloin suoraan väärä väite, ja puhelimessa (Wilma ja
 * Päikky molemmat `hidden`) se olisi juuri se tilanne. Ne kerrotaan
 * välilehden sisällä.
 */
const nothingAtAll = computed(() => {
  if (!showable(props.snapshot)) return false;
  if (paikkyConfigured.value && !showable(props.paikkySnapshot)) return false;
  // Epäonnistunut viestihaku ei ole tyhjä postilaatikko: se kerrotaan Päikyn
  // välilehdellä, joten välilehdet on säilytettävä.
  if (props.paikkySnapshot?.data?.messagesError) return false;
  return allMessages.value.length === 0 && paikkyMessages.value.length === 0;
});

/*
 * EI PIIRTOKATTOA. Kortti näyttää kaikki viestit, ja `.messages` vierittää.
 *
 * Tässä oli `MAX_VISIBLE = 6`. Se oli peruja yhden listan vanhasta näkymästä
 * ja perusteltu sillä ettei kortti kasvaisi seinänäytön tilaa suuremmaksi —
 * mutta lista on vierittävä, joten se ei voi kasvaa liikaa; se vain rajasi
 * mihin pääsee käsiksi.
 *
 * Ja kortti LUPASI ne viestit itse: välilehdessä lukee "Lukematta 8", koska
 * luku tulee koko listasta. Mitattu 2736 x 1824: välilehti sanoi 8,
 * renderöityjä kuusi, eikä kahteen viimeiseen päässyt vierittämälläkään.
 * Numero jota kortti näyttää ja sisältö jonka se antaa ovat nyt sama asia.
 *
 * Määrä ei voi karata: molemmat lähteet on katkaistu palvelimella kahteenkym-
 * meneen (wilma.ts `raw.slice(0, 20)`, paikky.ts `MESSAGE_LIMIT = 20`), eli
 * pahin tapaus on 20 viestiä per lista eikä satoja.
 */
const visibleMessages = computed(() =>
  mode.value === "unread" ? wilmaUnread.value : wilmaRead.value,
);
const visiblePaikkyMessages = computed(() =>
  mode.value === "unread" ? paikkyUnread.value : paikkyRead.value,
);

const cardTitle = computed(() => (paikkyConfigured.value ? "Viestit" : "Wilma-viestit"));

const activeSnapshot = computed(() => (source.value === "paikky" ? props.paikkySnapshot : props.snapshot));

/**
 * Ilman Päikkyä kuori saa Wilman tilan sellaisenaan — kortti käyttäytyy kuten
 * ennen. Välilehtien kanssa vain `stale` päästetään kuoreen asti (merkki
 * koskee silloin näkyvissä olevaa sisältöä); `hidden`, `failed` ja `idle`
 * korvaisivat CardShellissä koko rungon ja veisivät välilehdet mukanaan,
 * jolloin toimivaan lähteeseen ei enää pääsisi takaisin. Ks. sama ratkaisu
 * ScheduleCard.vue:ssa.
 */
const shellStatus = computed<ProviderStatus | undefined>(() => {
  if (!paikkyConfigured.value) return props.snapshot?.status;
  return activeSnapshot.value?.status === "stale" ? "stale" : "ok";
});

/** Sama sanamuoto kuin CardShellissä, koska tämä korvaa sen juuri tälle välilehdelle. */
const wilmaState = computed<{ title: string | null; text: string } | null>(() => {
  if (!paikkyConfigured.value) return null;
  const status = props.snapshot?.status;
  if (!props.snapshot || status === "idle") return { title: null, text: "Haetaan…" };
  if (status === "failed") {
    return { title: "Tietoja ei saatu", text: props.snapshot.error?.message ?? "Lähde ei vastaa" };
  }
  if (status === "hidden") {
    return {
      title: "Vain infonäytöllä",
      text: "Koulutiedot näkyvät vain keittiön näytöllä, eivät kotiverkon muilla laitteilla.",
    };
  }
  return null;
});

function studentName(message: WilmaMessage): string | null {
  const data = props.snapshot?.data;
  if (!data || data.students.length < 2) return null;
  return data.byStudent[message.studentNumber]?.student.name ?? null;
}

function sentLabel(iso: string): string {
  const sent = new Date(iso);
  if (Number.isNaN(sent.getTime())) return "";
  const today = new Date();
  const sameDay =
    sent.getFullYear() === today.getFullYear() &&
    sent.getMonth() === today.getMonth() &&
    sent.getDate() === today.getDate();
  if (sameDay) return sent.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  return sent.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" });
}

/** Kept short: the wall display is a glance, not a reading view. */
function preview(message: WilmaMessage): string {
  if (props.hidePreviews || !message.content) return "";
  const text = message.content.replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

/**
 * Epäonnistunut lukumerkintä kerrotaan tässä. Se on koko toiminnon ainoa
 * näkyvä jälki silloin kun palvelin ei ottanut merkintää vastaan: ilman tätä
 * lista palautuisi ennalleen ilman mitään selitystä, mikä näyttäisi siltä
 * että painike ei tee mitään.
 */
const actionError = ref<string | null>(null);
let errorTimer: ReturnType<typeof setTimeout> | null = null;

function showActionError(text: string): void {
  actionError.value = text;
  if (errorTimer !== null) clearTimeout(errorTimer);
  // Seinänäytöllä virhettä ei kuittaa kukaan, joten se ei jää syömään riviä
  // ikuisesti — mutta se näkyy tarpeeksi kauan että ohi kulkeva ehtii lukea sen.
  errorTimer = setTimeout(() => {
    actionError.value = null;
    errorTimer = null;
  }, 12000);
}

function clearActionError(): void {
  if (errorTimer !== null) {
    clearTimeout(errorTimer);
    errorTimer = null;
  }
  actionError.value = null;
}

onBeforeUnmount(clearActionError);

const markBusy = ref(false);

/**
 * Valitun lähteen lukemattomien tunnisteet, AINA merkkijonoina — myös Päikyn,
 * jonka id on jo merkkijono. `String()` ei ole tässä varmuuden vuoksi: Wilman
 * id on numero, ja numerona lähetetty tunniste päätyy palvelimen TEXT-
 * sarakkeeseen muodossa "86922.0", jota mikään myöhempi haku ei enää löydä.
 * Lukutila hajoaisi pysyvästi ja kaikki viestit näyttäisivät lukemattomilta.
 * Palvelin hylkää ei-merkkijonot 400:lla, mutta se on verkko, ei tämä
 * invariantti.
 */
const markableIds = computed<string[]>(() =>
  source.value === "wilma" ? wilmaUnread.value.map((m) => String(m.id)) : paikkyUnread.value.map((m) => String(m.id)),
);

/** Vain lukemattomien näkymässä ja vain kun merkittävää on. */
const canMarkAll = computed(() => mode.value === "unread" && markableIds.value.length > 0);

/**
 * Lukumäärä on painikkeessa, koska merkintä osuu KAIKKIIN valitun lähteen
 * lukemattomiin — myös niihin joita kuuden rivin listalla ei näy — eikä
 * Wilman viestiä saa enää takaisin lukemattomaksi. Luku kertoo teon
 * laajuuden ohimennen painavalle ilman erillistä vahvistusdialogia, joka
 * kosketusnäytöllä seinällä olisi kömpelö.
 */
const markAllLabel = computed(() =>
  markBusy.value ? "Merkitään…" : `Merkitse kaikki luetuiksi (${markableIds.value.length})`,
);

/**
 * Merkitsee valitun lähteen — vain sen — lukemattomat luetuiksi. Merkintä
 * tehdään paikalliseen tilaan heti, koska seuraavaa pollausta odotellaan
 * minuutteja, ja perutaan kokonaan jos palvelin ei ottanut sitä vastaan.
 * Peruminen on tarkka: listalle päätyvät vain ne viestit joita ei ollut
 * merkitty, joten ennestään luettuja ei nollata vahingossa.
 */
async function markAllRead(): Promise<void> {
  if (markBusy.value) return;
  const target = source.value;
  const ids = markableIds.value;
  if (ids.length === 0) return;

  const keys = ids.map((id) => readKey(target, id));
  markBusy.value = true;
  clearActionError();
  for (const key of keys) localReads.value.add(key);

  try {
    // editFetch eikä paljas fetch: reitti vaatii luotetun laitteen, ja
    // FULL_PIN-laitteella luottamus kulkee juuri x-edit-pin-otsikossa jonka
    // editFetch liittää mukaan (ks. useEditAccess.ts).
    const response = await editAccess.editFetch(`/api/messages/${target}/read-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error();
  } catch {
    for (const key of keys) localReads.value.delete(key);
    showActionError("Viestejä ei saatu merkittyä luetuiksi");
  } finally {
    markBusy.value = false;
  }
}

// Holding just the id — not the message object — is what lets the open dialog
// pick up sender/content as soon as a later dashboard poll fills them in.
// `withDetails` in the provider fetches those in the background, and every
// poll response builds fresh message objects (see api.ts's withLocalReadState),
// so a captured reference would freeze on whatever was known at click time.
const openMessageId = ref<number | null>(null);
const openMessage = computed(() => allMessages.value.find((m) => m.id === openMessageId.value) ?? null);
const dialogOpen = computed(() => openMessageId.value !== null);
const dialogStudentName = computed(() => (openMessage.value ? studentName(openMessage.value) : null));

// If the message drops out of the feed entirely (Wilma prunes old ones), the
// dialog has nothing left to show and should close instead of sitting there
// blank.
watch(openMessage, (message) => {
  if (message === null) openMessageId.value = null;
});

async function openDialog(message: WilmaMessage): Promise<void> {
  openMessageId.value = message.id;
  if (isWilmaRead(message)) return;

  // Optimistic: the wall display must update the instant the message is
  // opened, not on the next dashboard poll (see the localReads comment above).
  const key = readKey("wilma", message.id);
  localReads.value.add(key);
  try {
    // String(): sama syy kuin markableIdsissä — tunniste kulkee merkkijonona
    // polkuunkin asti, eikä numeron muotoilu jää sattuman varaan.
    const response = await editAccess.editFetch(`/api/messages/wilma/${String(message.id)}/read`, { method: "POST" });
    if (!response.ok) throw new Error();
  } catch {
    // The server never recorded it, so roll the optimistic update back —
    // otherwise the card would keep claiming "read" after a reload. Sanotaan
    // se myös ääneen: viesti hyppäisi muuten takaisin lukemattomiin ilman
    // mitään syytä.
    localReads.value.delete(key);
    showActionError("Lukumerkintää ei saatu tallennettua");
  }
}

function closeDialog(): void {
  openMessageId.value = null;
}
</script>

<template>
  <CardShell
    :title="cardTitle"
    :accent="source === 'paikky' ? 'var(--accent-calendar)' : 'var(--accent-school)'"
    :status="shellStatus"
    :fetched-at="activeSnapshot?.fetchedAt"
    :error="activeSnapshot?.error"
    :note="unreadCount > 0 ? `${unreadCount} lukematonta` : undefined"
  >
    <div v-if="nothingAtAll" class="state">
      <span>Ei viestejä</span>
    </div>

    <div v-else class="messages-panel" :class="{ 'messages-panel--care': source === 'paikky' }">
      <!-- Lähderivi: kumpi postilaatikko, ja montako lukematonta siinä on.
           Piirretään vain kun lähteitä on kaksi. -->
      <div v-if="paikkyConfigured" class="sources" role="tablist" aria-label="Viestien lähde">
        <button
          type="button"
          role="tab"
          class="sources__btn sources__btn--school"
          :class="{ 'sources__btn--active': source === 'wilma' }"
          :aria-selected="source === 'wilma'"
          @click="source = 'wilma'"
        >
          Wilma
          <span v-if="wilmaUnread.length > 0" class="count">{{ wilmaUnread.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="sources__btn sources__btn--care"
          :class="{ 'sources__btn--active': source === 'paikky' }"
          :aria-selected="source === 'paikky'"
          @click="source = 'paikky'"
        >
          Päikky
          <span v-if="paikkyUnread.length > 0" class="count count--care">{{ paikkyUnread.length }}</span>
        </button>
      </div>

      <!-- Ohjausrivi, ei toinen välilehtirivi: valitun lähteen lukutila ja sen
           joukkomerkintä. Ilman Päikkyä tämä on kortin ainoa rivi, ja saa
           silloin lähdevälilehtien mitat (modes--primary). -->
      <div class="controls">
        <div class="modes" :class="{ 'modes--primary': !paikkyConfigured }" role="tablist" aria-label="Lukutila">
          <button
            type="button"
            role="tab"
            class="modes__btn"
            :class="{ 'modes__btn--active': mode === 'unread' }"
            :aria-selected="mode === 'unread'"
            @click="mode = 'unread'"
          >
            Lukematta
            <!-- Yhdellä lähteellä lukumäärä on tässä, koska lähderiviä ei ole. -->
            <span v-if="!paikkyConfigured && wilmaUnread.length > 0" class="count">{{ wilmaUnread.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="modes__btn"
            :class="{ 'modes__btn--active': mode === 'read' }"
            :aria-selected="mode === 'read'"
            @click="mode = 'read'"
          >
            Luetut
          </button>
        </div>

        <!-- `|| markBusy`: paikallinen merkintä tyhjentää lukemattomat heti,
             joten ilman tätä painike katoaisi ennen kuin pyyntö on edes
             palannut — ja epäonnistuessa vilkahtaisi takaisin. -->
        <button v-if="canMarkAll || markBusy" type="button" class="mark-all" :disabled="markBusy" @click="markAllRead">
          {{ markAllLabel }}
        </button>
      </div>

      <p v-if="actionError" class="notice">{{ actionError }}</p>

      <PaikkyMessages
        v-if="source === 'paikky'"
        :snapshot="paikkySnapshot"
        :messages="visiblePaikkyMessages"
        :mode="mode"
        :total="paikkyMessages.length"
        :hide-previews="hidePreviews"
      />

      <div v-else-if="wilmaState" class="state">
        <span v-if="wilmaState.title" class="state__title">{{ wilmaState.title }}</span>
        <span>{{ wilmaState.text }}</span>
      </div>

      <div v-else-if="visibleMessages.length === 0" class="state">
        <span>{{ mode === "unread" ? "Ei lukemattomia viestejä" : "Ei luettuja viestejä" }}</span>
      </div>

      <ul v-else class="messages">
        <li v-for="message in visibleMessages" :key="message.id" class="message">
          <button type="button" class="message__open" @click="openDialog(message)">
            <div class="message__row">
              <!-- The sender only becomes known once the detail has been fetched;
                   until then the line stays empty rather than claiming ignorance. -->
              <span class="message__sender">{{ message.senderName ?? "" }}</span>
              <span class="message__time tnum">{{ sentLabel(message.sentAt) }}</span>
            </div>
            <div class="message__subject" :class="{ 'message__subject--unread': !isWilmaRead(message) }">
              <span v-if="!isWilmaRead(message)" class="message__dot" aria-hidden="true" />
              {{ message.subject }}
              <span v-if="studentName(message)" class="message__student">{{ studentName(message) }}</span>
            </div>
            <p v-if="preview(message)" class="message__preview">{{ preview(message) }}</p>
          </button>
        </li>
      </ul>
    </div>
  </CardShell>

  <MessageDialog :open="dialogOpen" :message="openMessage" :student-name="dialogStudentName" @close="closeDialog" />
</template>

<style scoped>
/* Valitun lähteen tunnusväri yhdessä paikassa: ohjausrivi ja joukkomerkintä
   ottavat sen tästä, jolloin ne kertovat mitä lähdettä ne koskevat. */
.messages-panel {
  --source-accent: var(--accent-school);
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  gap: 0.35rem;
}

.messages-panel--care {
  --source-accent: var(--accent-calendar);
}

.sources {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.sources__btn {
  flex: 1;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  background: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-faint);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

.sources__btn--active {
  background: var(--surface-strong);
  color: var(--text);
}

/* Lähteen oma väri, ei valitun — sama merkki kuin kortin otsikkopallossa,
   jotta lähde tunnistuu vilkaisulla eikä lukemalla. */
.sources__btn--school.sources__btn--active {
  border-color: var(--accent-school);
}

.sources__btn--care.sources__btn--active {
  border-color: var(--accent-calendar);
}

/* Ohjausrivi on tarkoituksella kevyempi kuin lähderivi: se on työkalu, ei
   navigaatio. Rivi rullaa omalle rivilleen vasta jos kortti on niin kapea
   ettei painike mahdu — leikkautunut "Merkitse kaikki lue…" olisi pahempi. */
.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.modes {
  display: flex;
  gap: 0.3rem;
  flex: 1 1 12rem;
  min-width: 0;
}

.modes__btn {
  flex: 1;
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-faint);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.modes__btn--active {
  background: var(--surface-strong);
  border-color: var(--source-accent);
  color: var(--text);
}

/* Ilman Päikkyä tämä rivi on kortin välilehtirivi, ja pitää entiset mittansa. */
.modes--primary .modes__btn {
  min-height: 44px;
  border-color: var(--border);
}

.modes--primary .modes__btn--active {
  border-color: var(--source-accent);
}

.count {
  min-width: 1.3rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: var(--accent-school);
  color: #0b0d12;
  font-size: 0.78rem;
  font-weight: 700;
  line-height: 1.2;
}

.count--care {
  background: var(--accent-calendar);
}

.mark-all {
  min-height: 38px;
  padding: 0 0.9rem;
  background: none;
  border: 1px solid var(--source-accent);
  border-radius: 999px;
  color: var(--source-accent);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}

.mark-all:disabled {
  opacity: 0.55;
  cursor: default;
}

/* Sama sävy kuin CardShellin card__reason -selitteessä ja Päikyn omassa
   huomautuksessa: vika kerrotaan, mutta se ei ole hälytys. */
.notice {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.3;
  color: #f3c26b;
  flex-shrink: 0;
}

.messages {
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.message:last-child {
  border-bottom: none;
}

.message__open {
  width: 100%;
  min-height: 44px;
  display: block;
  background: none;
  border: none;
  padding: 0.5rem 0;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
}

.message__open:hover,
.message__open:focus-visible {
  background: var(--surface);
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
  background: var(--accent-school);
  flex-shrink: 0;
}

.message__student {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-school);
  opacity: 0.8;
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
