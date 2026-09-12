<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import AlarmsPanel from "./components/AlarmsPanel.vue";
import CalendarCard, { type CalendarData } from "./components/CalendarCard.vue";
import EditAccessDialog from "./components/EditAccessDialog.vue";
import ElectricityCard from "./components/ElectricityCard.vue";
import KioskExitDialog from "./components/KioskExitDialog.vue";
import KioskExitHotspot from "./components/KioskExitHotspot.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import MessagesCard from "./components/MessagesCard.vue";
import NewsCard from "./components/NewsCard.vue";
import NotesCard from "./components/NotesCard.vue";
import ScheduleCard from "./components/ScheduleCard.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import WeatherCard, { type WeatherData } from "./components/WeatherCard.vue";
import { describeOccurrenceShort, nextUpcomingAlarm } from "./composables/useAlarms.ts";
import { useBattery } from "./composables/useBattery.ts";
import { useClock } from "./composables/useClock";
import { useDashboard } from "./composables/useDashboard";
import { useEditAccess } from "./composables/useEditAccess.ts";
import { panelGridKey, usePanelLayout } from "./composables/usePanelLayout";
import { useScheduleDay } from "./composables/useScheduleDay";
import { PANEL_IDS, panelVisibilityRows, shouldRenderPanel, type PanelId } from "./types";
import type {
  ElectricityData,
  NewsData,
  PaikkyData,
  PanelLayout,
  ProviderSnapshot,
  Settings,
  WilmaData,
} from "./types";

const { now } = useClock();
// Puretaan refit tässä, jotta template viittaa niihin suoraan ilman `.value`:a
// — sisäkkäisenä oliossa Vue ei pura niitä automaattisesti.
const {
  supported: batterySupported,
  percent: batteryPercent,
  charging: batteryCharging,
} = useBattery();

const batteryVisible = computed(() => batterySupported.value && batteryPercent.value !== null);

/**
 * Kuvakkeen täyttöaste piirretään suoraan prosentista. Alaraja pitää täytön
 * näkyvänä myös tyhjällä akulla, jottei kuvake näytä rikkinäiseltä.
 */
const batteryFillWidth = computed(() => Math.max(0.8, ((batteryPercent.value ?? 0) / 100) * 19.6));

/**
 * Seinänäyttö on tarkoitus pitää laturissa, joten laskeva varaus on merkki
 * siitä että laturi on irronnut — siksi väri vaihtuu jo hyvissä ajoin.
 * Latauksessa oleva akku ei ole matala vaikka lukema olisi pieni.
 */
const batteryLow = computed(() => !batteryCharging.value && (batteryPercent.value ?? 100) <= 20);
const batteryCritical = computed(() => !batteryCharging.value && (batteryPercent.value ?? 100) <= 10);
const { dashboard, connected, refresh } = useDashboard();
const editAccess = useEditAccess();

const settingsOpen = ref(false);
const alarmsOpen = ref(false);
const editAccessOpen = ref(false);
// Ei sidottu canEditiin eikä isTrustedClientiin: kioskista poistuminen on
// oma, FULL_PIN:llä suojattu porttinsa (ks. KioskExitDialog.vue), ei riipu
// siitä onko tällä laitteella jo muokkausoikeutta.
const kioskExitOpen = ref(false);

const timeLabel = computed(() =>
  now.value.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }),
);

const dateLabel = computed(() =>
  now.value.toLocaleDateString("fi-FI", { weekday: "long", day: "numeric", month: "long" }),
);

const provider = <T,>(id: string): ProviderSnapshot<T> | undefined =>
  dashboard.value?.providers[id] as ProviderSnapshot<T> | undefined;

const electricity = computed(() => provider<ElectricityData>("electricity"));
const weather = computed(() => provider<WeatherData>("weather"));
const calendar = computed(() => provider<CalendarData>("calendar"));
const wilma = computed(() => provider<WilmaData>("wilma"));
// Undefined = Päikkyä ei ole konfiguroitu. Kortit tulkitsevat sen niin, ettei
// välilehtiä näytetä lainkaan, joten tata EI saa korvata tyhjällä oletuksella.
const paikky = computed(() => provider<PaikkyData>("paikky"));
const news = computed(() => provider<NewsData>("news"));

const settings = computed<Settings | null>(() => dashboard.value?.settings ?? null);
const wilmaData = computed(() => wilma.value?.data ?? null);

const rolloverTime = computed(() => settings.value?.rolloverTime ?? "12:00");
const visibleStudents = computed(() => settings.value?.visibleStudents ?? null);
const visiblePaikkyChildren = computed(() => settings.value?.visiblePaikkyChildren ?? null);

// Asetuspaneelin lapsivalintaa varten: koko lapsilista litistettynä, ei
// suodatettuna. Piilotettuunkin lapseen on päästävä käsiksi, jotta valinnan
// voi perua. `paikky` on undefined vain jos Päikkyä ei ole konfiguroitu —
// puhelimella se on olemassa mutta datattomana (status "hidden").
const paikkyChildren = computed(
  () => paikky.value?.data?.children.map((entry) => entry.child) ?? [],
);
const paikkyConfigured = computed(() => paikky.value !== undefined);

// Kaikki tunnetut lapset, ei vain kortilla näytettävät — hälytys voi koskea
// lasta joka on piilotettu lukujärjestyskortilta, joten AlarmsPanel ei saa
// käyttää visibleStudents-suodatettua listaa.
const allStudents = computed(() => wilmaData.value?.students ?? []);
const activeAlarmCount = computed(() => settings.value?.alarms.filter((a) => a.enabled).length ?? 0);

// Sama oletus kuin AlarmsPanelissa — kattaa vain hetken ennen ensimmäistä
// asetusvastausta, ks. server/src/core/settings.ts.
const breakfastTime = computed(() => settings.value?.breakfastTime ?? "08:00");

/**
 * Yläpalkin keskellä näkyvä "seuraava hälytys" -banneri. Laskenta on kokonaan
 * useAlarms.ts:n `nextUpcomingAlarm`issa eikä täällä: hälytysaikojen on
 * tultava yhdestä lähteestä, samasta jota hälytyspaneelin esikatselu käyttää.
 *
 * Null = ei yhtään tulevaa soittoa (ei hälytyksiä, kaikki pois päältä, loma,
 * tai tämä laite ei saa lukujärjestystä) → banneria ei renderöidä lainkaan,
 * eikä se v-if:n takia jätä tyhjää tilaakaan. Ks. nextUpcomingAlarmin kommentti.
 *
 * Soivan hälytyksen aikana tämä osoittaa jo SEURAAVAAN soittoon: hetkellä jona
 * hälytys laukeaa, `nextAlarmOccurrence` ei enää palauta juuri mennyttä
 * ajankohtaa. Erikoiskäsittelyä ei siis tarvita — eikä sitä näkisikään, koska
 * hälytysnäkymä on teleportattu <body>:n alle koko ruudun päälle.
 */
const nextAlarm = computed(() => {
  // Vertailu nimenomaan `=== true`: mikä tahansa muu arvo (puuttuva avain
  // vanhassa tallennetussa asetusoliossa, null) tarkoittaa "ei piiloteta",
  // eli oletus säilyy päällä. Ks. hideNextAlarmin kommentti types.ts:ssä.
  if (settings.value?.hideNextAlarm === true) return null;
  return nextUpcomingAlarm(
    settings.value?.alarms ?? [],
    wilmaData.value,
    allStudents.value,
    now.value,
    breakfastTime.value,
  );
});

const nextAlarmTime = computed(() =>
  nextAlarm.value === null ? "" : describeOccurrenceShort(nextAlarm.value.occurrence, now.value),
);

// Nimi on vapaaehtoinen kenttä ja voi olla tyhjä — silloin kellonaika yksinään
// on koko banneri, ei tyhjää väliä erottimineen.
const nextAlarmLabel = computed(() => nextAlarm.value?.alarm.label.trim() ?? "");

// Koko composable annetaan kortille yhtenä oliona, jotta selauspainikkeet ja
// automaattinen päivänvaihto asuvat samassa paikassa eikä App.vue joudu
// välittämään jokaista nappia erikseen.
const schedule = useScheduleDay(wilmaData, now, rolloverTime, visibleStudents);
const { students } = schedule;

const currentHour = computed(() => now.value.getHours());

// isTrustedClient = dashboard.localClient = palvelimen isTrustedRequest-
// päätös tälle laitteelle: näyttölaite, TRUSTED_HOSTS-laite, TAI kelvollinen
// FULL_PIN otsikossa (ks. server/src/routes/access.ts). Koska
// useDashboard.ts lähettää tallennetun koodin joka pollauksella
// (editAccess.editFetch), tämä kääntyy todeksi automaattisesti heti kun
// FULL_PIN on tallessa — mitään erillistä "täysi taso" -kytkintä ei
// tarvita täällä, se on jo täsmälleen sama asia kuin TRUSTED_HOSTS-laite.
//
// canEdit = isTrustedClient TAI kelvollinen EDIT_PIN tallessa
// (editAccess.hasStoredPin — huom. FULL_PIN:kin päätyy tänne tallessa
// olevana koodina, mutta silloin isTrustedClient on jo tosi eikä tarvitse
// tätä toista ehtoa). EDIT_PIN itsessään EI koskaan laajenna
// isTrustedClient-tilaa — Wilma-data pysyy palvelimen päättämänä
// piilotettuna siltä, riippumatta tästä.
const isTrustedClient = computed(() => dashboard.value?.localClient ?? false);

/**
 * Onko tämä se seinällä oleva kioskinäyttö (ks. displayDevice types.ts:ssä).
 * ERI KYSYMYS kuin `isTrustedClient`: liput eroavat täsmälleen silloin kun
 * puhelimella on FULL_PIN. Oletus `false` on turvallinen suunta vain tälle
 * käyttötarkoitukselle — ennen ensimmäistä vastausta ei renderöidä vielä
 * mitään uutisia, joten linkkejäkään ei ehdi syntyä.
 *
 * VAIN ULKOASUUN. Tämä ei ole käyttöoikeus eikä sitä saa käyttää sellaisena.
 */
const isDisplayDevice = computed(() => dashboard.value?.displayDevice ?? false);
const canEdit = computed(() => isTrustedClient.value || editAccess.hasStoredPin.value);

// Puhelin jolla ei ole täyttä luottamusta ei näe Wilma-dataa (palvelin
// piilottaa sen, ks. api.ts), joten hälytysten esikatselu ("soi klo 7.55")
// ei voi toimia siellä vaikka hälytyksiä voisi muokata EDIT_PIN:llä.
// AlarmsPanel/SettingsPanel käyttävät tätä erottaakseen "ei tunteja
// lähipäivinä" -tilan "tätä laitetta ei ole luotettu" -tilasta.
const canPreviewSchedule = computed(() => isTrustedClient.value);

/*
 * ── Saako uutisotsikosta olla linkki yle.fi:hin ──────────────────────────────
 *
 * Kioskiselaimessa ulos navigointi on peruuttamatonta: tavallinen linkki vie
 * dashboardin pois ja `KioskExitHotspot` tuhoutuu sen mukana, ja
 * `target="_blank"` avaa toisen koko ruudun ikkunan dashboardin päälle ilman
 * otsikkopalkkia. Kummastakaan ei pääse takaisin ilman näppäimistöä. Ylen
 * ehdot vaativat, että JOS linkitetään, linkki vie suoraan juttuun — ne
 * eivät vaadi linkittämistä.
 *
 * EHTO ON `displayDevice`, EI `localClient` EIKÄ RUUDUN LEVEYS. Kioski
 * avataan aina http://localhost:PORTTI, joten loopback on täsmälleen se
 * kysymys johon tässä tarvitaan vastaus (ks. displayDevicen kommentti
 * types.ts:ssä).
 *
 * Tässä ehtona oli kahdesti jotain muuta, ja molemmat olivat väärin:
 *
 *   - `!isTrustedClient` olisi vienyt linkit myös TRUSTED_HOSTS-puhelimelta
 *     ja FULL_PIN:n syöttäneeltä puhelimelta. Wilman takia koodin syöttänyt
 *     vanhempi menettäisi linkit juuri siltä laitteelta jolla ne ovat koko
 *     pointti. `localClient` on oikeuskysymys, tämä on laitekysymys.
 *
 *   - `!isTrustedClient || kapea ruutu` rikkoi kioskin: oikealla
 *     kioskiselaimella sama localhost antoi 3840 px:llä nolla linkkiä mutta
 *     800x1280:llä kaksitoista. Raspberry Pi:n virallinen paneeli on
 *     800x480 ja asennus/KAYTTOONOTTO.md lupaa Pi-tuen, joten kapea
 *     seinänäyttö on tuettu kokoonpano eikä reunatapaus. LEVEYS EI KERRO
 *     MITÄÄN KIOSKIUDESTA — se korreloi puhelimen kanssa, eikä korrelaatio
 *     riitä kun väärä arvaus rikkoo laitteen jolta ei pääse ulos.
 */
const newsLinksAllowed = computed(() => !isDisplayDevice.value);

/**
 * Saako ruudukko vuotaa ruudun alalaidan yli (jolloin sivu vierittyy), vai
 * puristetaanko se aina näkyviin? Ks. Settings.gridOverflow.
 *
 * Oletus on `false` myös silloin kun asetuksia ei ole vielä haettu: seinällä
 * ei kosketa näyttöön ohi kulkiessa, joten piiloon vieritetty kortti olisi
 * yhtä kuin poissa. Väärään suuntaan erehtyminen maksaa siis eri verran —
 * puristettu kortti on luettavissa, vieritetty ei ole edes tiedossa.
 */
const gridScrolls = computed(() => settings.value?.gridOverflow === "scroll");

/**
 * Mitä tallennettu koodi TÄLLÄ HETKELLÄ avaa — aina johdettu tuoreimmasta
 * palvelinvastauksesta (isTrustedClient), ei erikseen muistiin talletetusta
 * lipusta. Näin näyttö ei voi jäädä väittämään "täydet oikeudet" enää sen
 * jälkeen kun FULL_PIN on esim. vaihdettu .env:ssä lyhyemmäksi tai
 * poistettu — se korjautuu itsestään seuraavalla /api/dashboard-pollauksella
 * aivan kuten Wilma-näkyvyyskin. Käytetään dialogin ja asetuspaneelin
 * "kummalla tasolla olen" -tekstiin (vaatimus: se ei saa jäädä epäselväksi).
 */
const currentPinLevel = computed<"full" | "edit" | null>(() => {
  if (!editAccess.hasStoredPin.value) return null;
  return isTrustedClient.value ? "full" : "edit";
});

// Muokkausoikeus-lukko näkyy vain laitteille jotka eivät ole valmiiksi
// luotettuja — näyttölaitteella se olisi merkityksetön (canEdit on jo tosi).
// Piilotetaan vasta kun tiedetään VARMASTI ettei kumpikaan taso ole
// käytössä palvelimella, jottei nappi vilku ennen ensimmäistä
// /api/edit-access-vastausta (null = ei vielä kysytty).
const showEditAccessButton = computed(() => {
  if (isTrustedClient.value) return false;
  return editAccess.editPinConfigured.value !== false || editAccess.fullPinConfigured.value !== false;
});

void editAccess.refreshPinConfigured();

// Lukko-napin teksti/väri — sama kolmijako kuin dialogissa: vanhentunut
// (huomiovärillä, riippumatta siitä mikä taso se oli) voittaa, muuten
// kerrotaan suoraan kumpi taso on käytössä, jottei niitä voi sekoittaa
// (vaatimus: "täydet oikeudet" ja "muokkaus" ovat eri asioita).
const editAccessButtonLabel = computed(() => {
  if (editAccess.expired.value) return "Tallennettu koodi ei enää kelpaa — syötä uusi";
  if (currentPinLevel.value === "full") return "Täydet oikeudet käytössä (sis. lasten Wilma-tiedot)";
  if (currentPinLevel.value === "edit") return "Muokkausoikeus käytössä";
  return "Ota käyttöön PIN-koodilla";
});
const editAccessBadgeVisible = computed(() => editAccess.hasStoredPin.value || editAccess.expired.value);
const editAccessBadgeModifier = computed(() => {
  if (editAccess.expired.value) return "topbar__badge--warn";
  if (currentPinLevel.value === "full") return "topbar__badge--full";
  return null; // "edit": peruspiste riittää, ei omaa väriä
});

// Jos muokkausoikeus katoaa kesken kaiken (PIN vanhentui — EDIT_PIN vaihtui
// .env:ssä), auki oleva asetus-/hälytyspaneeli jäisi näyttämään näkymän
// jonka jokainen tallennus vain epäonnistuisi selittämättä. Suljetaan se ja,
// jos syy oli nimenomaan vanhentunut PIN, avataan heti pyyntö uudelle.
watch(canEdit, (isEditable, wasEditable) => {
  if (wasEditable && !isEditable) {
    settingsOpen.value = false;
    alarmsOpen.value = false;
    if (editAccess.expired.value) editAccessOpen.value = true;
  }
});

// Ruudukkoelementin viittaus jaetaan LayoutEditor-lapsille provide/injectillä,
// jotta jokainen paneeli ei mittaisi DOMia erikseen raahauksen aikana.
const gridEl = ref<HTMLElement | null>(null);
provide(panelGridKey, gridEl);

const panelLayoutSetting = computed<PanelLayout | null>(() => settings.value?.panelLayout ?? null);
// Puuttuva avain vanhassa tallennetussa asetusoliossa tarkoittaa "kaikki
// näkyy" — ks. hiddenPanelsin kommentti types.ts:ssä.
const hiddenPanelsSetting = computed<readonly unknown[] | null>(() => settings.value?.hiddenPanels ?? null);
const panelLayout = usePanelLayout(panelLayoutSetting, hiddenPanelsSetting, canEdit, refresh);

/**
 * Renderöidäänkö paneeli ruudukossa. Sama vastaus myös muokkaustilassa: pois
 * kytketty paneeli on yläpalkin parkkirivissä, ei ruudukossa. Sääntö on
 * kokonaan types.ts:n `shouldRenderPanel`issa, jotta se on testattavissa
 * ilman selainta ja jotta arkaluontoisuussuodatus ei voi vuotaa siihen (ks.
 * sen kommentti).
 */
function renders(id: PanelId): boolean {
  return shouldRenderPanel(id, panelLayout.hiddenPanels.value);
}

const allPanelsHidden = computed(() => !panelLayout.editing.value && !PANEL_IDS.some((id) => renders(id)));

/**
 * Pois kytketyt paneelit muokkaustilan yläpalkkiin. Tämä on ainoa paikka
 * josta ne saa takaisin muokkaustilassa, joten listan on sisällettävä ne
 * kaikki — ks. panelVisibilityRows.
 */
const parkedPanels = computed(() =>
  panelVisibilityRows(panelLayout.hiddenPanels.value).filter((row) => row.hidden),
);

function minutesOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Night mode brackets across midnight, so the comparison has to handle a start
 * that is later in the day than the end.
 */
const isNight = computed(() => {
  const current = settings.value;
  if (!current) return false;
  const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
  const start = minutesOfDay(current.nightModeStart);
  const end = minutesOfDay(current.nightModeEnd);
  return start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
});
</script>

<template>
  <div class="app" :class="{ night: isNight, 'app--scroll': gridScrolls }">
    <header v-if="panelLayout.editing.value" class="topbar topbar--editing">
      <div class="topbar__editing-main">
        <span class="topbar__editing-label" :class="{ 'topbar__editing-label--notice': panelLayout.notice.value }">
          {{
            panelLayout.notice.value ??
            "Muokkaa asettelua — raahaa paneeleja, kahva oikeassa alakulmassa muuttaa kokoa"
          }}
        </span>

        <!--
          Parkkirivi: pois kytketyt paneelit. Nämä EIVÄT ole ruudukossa —
          ruudukkoon jätettynä ne olisivat väistämättä toisen kortin päällä
          aina kun asettelu on täynnä (ks. shouldRenderPanel types.ts:ssä), ja
          kahden päällekkäisen kortin sekamelska on luettavuudeltaan pahempi
          kuin nimi palkissa. Samalla tämä tekee näkyväksi sen, että pois
          kytketty paneeli ei varaa ruutuja: ruudukkoon jää aito aukko jonka
          naapurin voi heti kasvattaa täyttämään.

          Painallus yrittää ottaa paneelin takaisin. Se voi epäonnistua
          tilanpuutteeseen, jolloin syy tulee yllä olevaan selitteeseen
          (panelLayout.notice) — nappia ei siis kytketä pois käytöstä, koska
          harmaa nappi ilman syytä ei kerro mitä pitäisi tehdä.
        -->
        <div v-if="parkedPanels.length > 0" class="parked">
          <span class="parked__caption">Pois käytöstä:</span>
          <button
            v-for="row in parkedPanels"
            :key="row.id"
            type="button"
            class="parked__chip"
            :title="`Ota paneeli ${row.title} takaisin käyttöön`"
            @click="panelLayout.showPanel(row.id)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
            {{ row.title }}
          </button>
        </div>
      </div>

      <div class="topbar__editing-actions">
        <button
          type="button"
          class="edit-btn"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.cancelEditing()"
        >
          Peruuta
        </button>
        <button
          type="button"
          class="edit-btn"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.resetToDefault()"
        >
          Palauta oletusasettelu
        </button>
        <button
          type="button"
          class="edit-btn edit-btn--primary"
          :disabled="panelLayout.saving.value"
          @click="panelLayout.finishEditing()"
        >
          {{ panelLayout.saving.value ? "Tallennetaan…" : "Valmis" }}
        </button>
      </div>
    </header>
    <!-- `topbar--with-next` rajaa keskisaraketta ja kapean ruudun rivitystä
         koskevat säännöt VAIN tilaan jossa banneri on olemassa. Ilman sitä
         asetuksista pois kytketty banneri jättäisi jälkeensä muuttuneen
         palkin — kytkimen pitää palauttaa palkki täsmälleen ennalleen. -->
    <header v-else class="topbar" :class="{ 'topbar--with-next': nextAlarm }">
      <div class="topbar__time">
        <span class="topbar__clock tnum">{{ timeLabel }}</span>
        <!-- topbar__date-wrap on position:relative vain siksi että
             KioskExitHotspot (position:absolute) voi ankkuroitua PÄIVÄMÄÄRÄN
             OMAAN reunaan eikä kiinteään pikselimäärään — dateLabel vaihtaa
             pituutta päivästä toiseen (esim. "maanantai 16. elokuuta" vs.
             "sunnuntai 1. tammikuuta"). inline-block ilman omaa täytettä/
             reunusta ei muuta mitään visuaalisesti eikä rivin korkeutta;
             hotspot itse on pois dokumentin virtauksesta eikä siis voi
             työntää kelloa/päivämäärää sivuun. -->
        <span class="topbar__date-wrap">
          <span class="topbar__date">{{ dateLabel }}</span>
          <KioskExitHotspot @trigger="kioskExitOpen = true" />
        </span>
      </div>

      <!-- Seuraava tuleva hälytys. Renderöidään vain kun sellainen on
           (ks. nextAlarm) — ei tyhjää paikanvaraajaa. Ei painike eikä linkki:
           tieto on passiivista, ja hälytyspaneeli aukeaa jo saman palkin
           kellokuvakkeesta muutaman sentin päästä. Tärkeämpi syy on
           `pointer-events: none` tyyleissä — se on ainoa tapa taata ettei
           keskielementti voi napata kosketuksia KioskExitHotspotilta eikä
           oikean laidan painikkeilta. -->
      <div v-if="nextAlarm" class="topbar__next">
        <span class="topbar__next-pill">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
            />
          </svg>
          <span class="topbar__next-caption">Seuraava hälytys</span>
          <span class="topbar__next-time tnum">{{ nextAlarmTime }}</span>
          <span v-if="nextAlarmLabel" class="topbar__next-label">{{ nextAlarmLabel }}</span>
        </span>
      </div>

      <div class="topbar__meta">
        <span v-if="dashboard?.place" class="topbar__place">{{ dashboard.place }}</span>
        <span v-if="!connected" class="badge badge--error">palvelin ei vastaa</span>

        <!-- Näkyy vain kun laitteessa on akku ja selain kertoo siitä. -->
        <span
          v-if="batteryVisible"
          class="battery"
          :class="{ 'battery--low': batteryLow, 'battery--critical': batteryCritical }"
        >
          <svg viewBox="0 0 28 14" width="26" height="13" aria-hidden="true">
            <rect
              x="0.6"
              y="0.6"
              width="23"
              height="12.8"
              rx="3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path d="M25 4.6v4.8a2.6 2.6 0 0 0 0-4.8z" fill="currentColor" />
            <rect
              x="2.2"
              y="2.2"
              :width="batteryFillWidth"
              height="9.6"
              rx="1.6"
              fill="currentColor"
            />
          </svg>
          <svg
            v-if="batteryCharging"
            class="battery__bolt"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" fill="currentColor" />
          </svg>
          <span class="battery__pct tnum">{{ batteryPercent }} %</span>
        </span>
        <button
          v-if="canEdit"
          class="topbar__settings"
          type="button"
          title="Hälytykset"
          @click="alarmsOpen = true"
        >
          <!-- Kello, ei hammasratas eikä aurinko — muoto: kellon runko + kieli
               alaosassa, tunnistettava hälytyskellon ikoni. -->
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
            />
          </svg>
          <span v-if="activeAlarmCount > 0" class="topbar__badge" aria-hidden="true"></span>
          <span class="sr-only">Hälytykset{{ activeAlarmCount > 0 ? ` (${activeAlarmCount} päällä)` : "" }}</span>
        </button>
        <button
          v-if="canEdit"
          class="topbar__settings"
          type="button"
          title="Asetukset"
          @click="settingsOpen = true"
        >
          <!-- Oikea hammasratas: ympyrä ja säteittäiset viivat olisivat aurinko,
               ei ratas — hampaiden pitää olla kehällä, ei siitä ulos osoittavia. -->
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.48.48 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
            />
          </svg>
          <span class="sr-only">Asetukset</span>
        </button>
        <button
          v-if="showEditAccessButton"
          class="topbar__settings"
          type="button"
          :title="editAccessButtonLabel"
          @click="editAccessOpen = true"
        >
          <!-- Munalukko — kertoo onko muokkaus tai täydet oikeudet otettu
               käyttöön PIN-koodilla tällä laitteella. Näytetään vain
               laitteille jotka eivät ole valmiiksi luotettuja, ks.
               showEditAccessButton yllä. Pisteen väri erottaa tason
               (editAccessBadgeClass): vihreä = muokkaus, oranssi = täydet
               oikeudet, keltainen = vanhentunut. -->
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 17a2 2 0 0 0 2-2 2 2 0 0 0-4 0 2 2 0 0 0 2 2m6-9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h1V6a5 5 0 0 1 10 0v2h1M12 3a3 3 0 0 0-3 3v2h6V6a3 3 0 0 0-3-3z"
            />
          </svg>
          <span v-if="editAccessBadgeVisible" class="topbar__badge" :class="editAccessBadgeModifier" aria-hidden="true"></span>
          <span class="sr-only">{{ editAccessButtonLabel }}</span>
        </button>
      </div>
    </header>

    <p v-if="panelLayout.error.value" class="layout-error">{{ panelLayout.error.value }}</p>

    <main ref="gridEl" class="grid" :class="{ 'grid--editing': panelLayout.editing.value }">
      <LayoutEditor
        v-if="renders('schedule')"
        class="grid__slot--schedule"
        panel-id="schedule"
        :placement="panelLayout.layout.value.schedule"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('schedule', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('schedule', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('schedule')"
      >
        <ScheduleCard
          :snapshot="wilma"
          :paikky-snapshot="paikky"
          :schedule="schedule"
          :layout="settings?.scheduleLayout ?? 'split'"
          :rollover-time="rolloverTime"
          :visible-paikky-children="visiblePaikkyChildren"
        />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('weather')"
        class="grid__slot--weather"
        panel-id="weather"
        :placement="panelLayout.layout.value.weather"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('weather', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('weather', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('weather')"
      >
        <WeatherCard :snapshot="weather" :place="dashboard?.place" />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('messages')"
        class="grid__slot--messages"
        panel-id="messages"
        :placement="panelLayout.layout.value.messages"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('messages', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('messages', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('messages')"
      >
        <MessagesCard
          :snapshot="wilma"
          :paikky-snapshot="paikky"
          :hide-previews="settings?.hideMessagePreviews ?? false"
        />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('electricity')"
        class="grid__slot--power"
        panel-id="electricity"
        :placement="panelLayout.layout.value.electricity"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('electricity', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('electricity', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('electricity')"
      >
        <ElectricityCard :snapshot="electricity" :current-hour="currentHour" />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('calendar')"
        class="grid__slot--calendar"
        panel-id="calendar"
        :placement="panelLayout.layout.value.calendar"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('calendar', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('calendar', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('calendar')"
      >
        <CalendarCard :snapshot="calendar" />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('notes')"
        class="grid__slot--notes"
        panel-id="notes"
        :placement="panelLayout.layout.value.notes"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('notes', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('notes', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('notes')"
      >
        <NotesCard :notes="dashboard?.notes ?? []" :can-edit="canEdit" @refresh="refresh" />
      </LayoutEditor>

      <LayoutEditor
        v-if="renders('news')"
        class="grid__slot--news"
        panel-id="news"
        :placement="panelLayout.layout.value.news"
        :editing="panelLayout.editing.value"
        @move="(col, row, pointerCol, pointerRow) => panelLayout.movePanel('news', col, row, pointerCol, pointerRow)"
        @resize="(colSpan, rowSpan) => panelLayout.resizePanel('news', colSpan, rowSpan)"
        @hide="panelLayout.hidePanel('news')"
      >
        <NewsCard :snapshot="news" :linkable="newsLinksAllowed" />
      </LayoutEditor>

      <!--
        Kaikki paneelit voi kytkeä pois — sitä ei estetä, koska estäminen
        tarkoittaisi että jokin paneeli olisi pakko pitää näkyvissä, eikä
        mikään niistä ansaitse sitä asemaa. Tyhjä ruutu ei kuitenkaan saa
        olla umpikuja: yläpalkki hammasrattaineen on `.grid`in ULKOPUOLELLA
        eikä katoa mihinkään, ja tämä teksti kertoo mistä paneelit saa
        takaisin. Ilman sitä ruutu näyttäisi rikkinäiseltä.
      -->
      <p v-if="allPanelsHidden" class="grid__empty">
        Kaikki paneelit on kytketty pois näkyvistä. Avaa asetukset yläpalkin
        hammasrattaasta ja valitse näytettävät paneelit.
      </p>
    </main>

    <!--
      `allStudents` eikä kortin suodatettua `students`-listaa: asetuspaneeli on
      juuri se paikka jossa piilotettu lapsi otetaan takaisin käyttöön, joten se
      ei voi lukea listaa josta piilotetut on jo karsittu — muuten valintaa ei
      saisi enää peruttua. Sama syy kuin AlarmsPanelilla alempana.
    -->
    <SettingsPanel
      v-if="settings"
      :settings="settings"
      :students="allStudents"
      :paikky-children="paikkyChildren"
      :paikky-configured="paikkyConfigured"
      :can-preview-schedule="canPreviewSchedule"
      :current-level="currentPinLevel"
      :open="settingsOpen"
      @close="settingsOpen = false"
      @saved="refresh"
      @edit-layout="panelLayout.startEditing()"
    />

    <!--
      Ei v-if="settings": hälytysmoottorin (useAlarms-composable AlarmsPanelin
      sisällä) pitää olla käynnissä heti sivun latauduttua, oletusarvoisesti
      tyhjillä hälytyksillä, eikä vasta kun ensimmäinen /api/dashboard on
      onnistunut. Muuten palvelimen hetkellinen tavoittamattomuus juuri
      aamulla (esim. uudelleenkäynnistyksen jälkeen) jättäisi koko
      hälytysjärjestelmän lataamatta sen sijaan että se vain odottaisi
      asetuksia. AlarmsPanel käsittelee settings === null itse.
    -->
    <AlarmsPanel
      :settings="settings"
      :students="allStudents"
      :wilma-data="wilmaData"
      :can-preview-schedule="canPreviewSchedule"
      :now="now"
      :open="alarmsOpen"
      @close="alarmsOpen = false"
      @saved="refresh"
    />

    <EditAccessDialog
      :open="editAccessOpen"
      :current-level="currentPinLevel"
      @close="editAccessOpen = false"
      @authorized="refresh"
    />

    <!-- KioskExitHotspot on yllä, topbar__date-wrapin sisällä — tässä vain vahvistusdialogi. -->
    <KioskExitDialog :open="kioskExitOpen" @close="kioskExitOpen = false" />
  </div>
</template>

<style scoped>
.app {
  /* Ks. style.css:n #app — `100vh` jättää sisällön puhelimen alapalkin alle. */
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  /* Alareunaan puhelimen turva-alue (iOS:n kotipalkki) päälle normaalin
     täytteen, jottei viimeinen kortti pääty aivan palkin rajaan kiinni. */
  padding: 1.1rem 1.3rem max(1.3rem, env(safe-area-inset-bottom));
  gap: 0.9rem;
}

/*
 * `flex-wrap: wrap` EI ole kosmetiikkaa eikä rajattu mihinkään leveyteen.
 *
 * Palkin kaksi laitaa eivät mahdu puhelimen leveydelle samalle riville:
 * vasen laita kutistuu vielä (kello + päivämäärä ~259 px), mutta oikea laita
 * ei kutistu lainkaan — paikkakunta, akku ja 2–3 painiketta ovat yhteensä
 * ~313 px, ja painikkeiden leveys on kuvakkeen kokoinen vakio. Flex-lapsi ei
 * mene `min-width: auto`in alle, joten rivittämättömässä palkissa ylimääräinen
 * työntyi ULOS oikeasta reunasta: 390 px:n ruudulla `.topbar__meta` ulottui
 * x=531:een, eli kaikki kolme painiketta — myös asetusten hammasratas — jäivät
 * kokonaan ruudun ulkopuolelle, ja päivämäärä puristui kolmelle riville.
 *
 * Rivitys oli jo olemassa mutta `.topbar--with-next`-rajattuna, joten palkki
 * toimi kapealla VAIN kun hälytysbanneri sattui olemaan näkyvissä. Sääntö
 * kuuluu tänne rajaamattomana: vika ei liity banneriin mitenkään.
 *
 * Tästä oppi joka kannattaa muistaa tätä palkkia muokatessa: OMINAISUUS-
 * KOHTAINEN RAJAUS on vaarallinen silloin kun sääntö ei oikeasti koske vain
 * sitä ominaisuutta. Rivitys kirjoitettiin bannerin yhteydessä ja rajattiin
 * banneriin, jolloin kapean ruudun asettelu jäi riippumaan siitä onko
 * hälytyksiä juuri nyt olemassa — eli vika näkyi vain puolet ajasta ja katosi
 * testatessa. Rajaa sääntö siihen mitä se koskee, älä siihen mitä oltiin
 * tekemässä silloin kun se kirjoitettiin.
 *
 * Rivitys on tarkoituksella ilman mediakyselyä — se laukeaa täsmälleen silloin
 * kun sisältö ei mahdu, eikä kiinteä raja voi osua väärin, kun paikkakunnan
 * pituus ja painikkeiden määrä vaihtelevat laitteittain. Leveällä näytöllä se
 * ei voi laueta: silloin lapset mahtuvat riville, eikä `.topbar--with-next`in
 * kolmen sarakkeen `flex: 1 1 0` (basis 0) voi ylittää säiliötä lainkaan.
 * Mitattu 1920 px:ssä identtiseksi ennen ja jälkeen.
 *
 * `row-gap: 1.5rem` EI ole väljyyttä väljyyden vuoksi. KioskExitHotspot
 * ulottuu päivämäärän ympäriltä 0.9rem ALASPÄIN (ks. KioskExitHotspot.vue), ja
 * kääritty oikea laita nousee sen päälle: `.topbar__meta` on `z-index: 60`
 * hotspotin yläpuolella, joten päällekkäinen kaistale EI avaisi kioskista
 * väärää dialogia, mutta se söisi näkymättömän painikkeen alareunan pois.
 * 0.4rem:n välillä mitattuna hotspotin alin kolmannes lakkasi osumasta (6/9
 * pistettä), 1.5rem:llä kaikki 9 osuvat. Sama 1.5rem kuin banneririvillä
 * (0.4rem + 1.1rem, ks. mediakysely alempana) — ÄLÄ pienennä mittaamatta.
 *
 * Pystyväli koskee VAIN käärittyä palkkia: yhden rivin leveällä näytöllä
 * `row-gap` ei vaikuta mihinkään.
 */
.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  row-gap: 1.5rem;
  flex-shrink: 0;
  padding: 0 0.3rem;
}

.topbar__time {
  display: flex;
  align-items: baseline;
  gap: 0.9rem;
}

.topbar__clock {
  font-size: 2.6rem;
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.01em;
}

.topbar__date {
  font-size: 1rem;
  color: var(--text-dim);
  text-transform: capitalize;
}

/* Ankkuri KioskExitHotspotille (ks. topbar__time-templaatin kommentti) —
   inline-block + position:relative, ei omaa täytettä/reunusta/marginaalia,
   joten se ei muuta rivin korkeutta eikä kellon/päivämäärän asemointia. */
.topbar__date-wrap {
  position: relative;
  display: inline-block;
}

/* KioskExitHotspot on näkymätön ja ulottuu päivämäärästä oikealle. Leveällä
   ruudulla se jää yläpalkin tyhjään väliin, mutta puhelimessa topbar on
   ahdas (space-between + 1rem gap), jolloin alue voisi peittää tämän laidan
   painikkeita — ja koska se on näkymätön, painike vain lakkaisi toimimasta
   ilman mitään näkyvää syytä. Oma pinoamiskonteksti hotspotin yläpuolelle
   takaa että painikkeet saavat kosketuksen aina; hotspot menettää vain sen
   osan alueestaan joka oikeasti jää alle. Ks. .topbar__meta alempana. */

/*
 * Seuraava hälytys, yläpalkin keskellä.
 *
 * ASEMOINTI ON FLEX-VIRTAUSTA, EI absolute-keskitystä. Absoluuttinen elementti
 * ei varaa tilaa, joten se voi mennä naapuriensa päälle pelkän `max-width`in
 * varassa — ja kun oikeaan laitaan tulee pitkä paikannimi tai "palvelin ei
 * vastaa" -merkki, se oikeasti menee. Flex-virtauksessa törmäys on rakenteesta
 * johtuen mahdoton: laatikot eivät voi olla päällekkäin, ja ahtaalla tila
 * otetaan bannerin omasta tekstistä (`min-width: 0` + katkaisu, ks.
 * .topbar__next-label).
 *
 * Kolme `flex: 1 1 0` -saraketta pitää KESKISARAKKEEN TARKALLEEN palkin
 * keskellä, vaikka laidat ovat eri levyisiä — pelkkä `flex: 1` bannerille
 * keskittäisi sen vain jäljelle jäävään tilaan, jolloin pilleri ajautuisi
 * kymmeniä pikseleitä oikeasta keskilinjasta. Säännöt ovat
 * `.topbar--with-next`-rajattuja, joten ilman banneria palkki on
 * täsmälleen entisensä (space-between kahdella lapsella).
 *
 * `pointer-events: none` on yhä paikallaan vaikka päällekkäisyys ei enää ole
 * mahdollinen: yläpalkissa on NÄKYMÄTÖN KioskExitHotspot, ja näkymättömän
 * painikkeen nielaisema painallus ei näkyisi vikana vaan "kioskista ei enää
 * pääse ulos" -mysteerinä. Banneri ei ota kosketuksia vastaan lainkaan, mikä
 * on myös syy siihen ettei siitä tehty klikattavaa.
 *
 * SARAKEJAKO EI AIKANAAN RIITTÄNYT YKSIN, koska KioskExitHotspot ei ole
 * laatikoiden virtauksessa mukana: se oli `position: absolute` ja ulottui
 * päivämäärän oikeasta reunasta 3.5rem eteenpäin, eli ULOS omasta
 * sarakkeestaan. 901 px:n ruudulla aikasarake loppui x=298:aan mutta hotspot
 * jatkui x=341:een — 42 px keskisarakkeen puolelle, NÄKYVÄN pillerin alle, ja
 * koska bannerissa on `pointer-events: none`, painallus valui pillerin läpi
 * hotspotille. Mitattuna 901 px:ssä kolme eri NÄKYVÄÄ kohdetta (pillerin vasen
 * reuna, kellokuvake, "SEURAAVA HÄLYTYS" -teksti) avasivat kioskin
 * poistumisdialogin oikealla kolmen sekunnin painalluksella, välillä 901–975 px.
 *
 * SE ON KORJATTU HOTSPOTIN OMASSA GEOMETRIASSA (ks. KioskExitHotspot.vue):
 * alue pysyy nyt päivämäärän kohdalla eikä ulotu sarakkeensa ulkopuolelle,
 * joten päällekkäisyyttä ei voi syntyä. ÄLÄ siis lisää tänne pilleriin
 * kiertoteitä — kaksi sellaista kokeiltiin ja molemmat MITATTIIN HUONOMMIKSI:
 *
 *  1. `pointer-events: auto` + `z-index` pillerille. Ei riitä yksinään:
 *     hotspot on `z-index: 50` ja maalautuu virtauksessa olevan pillerin
 *     PÄÄLLE, joten pelkkä `pointer-events` ei poistanut vuodosta yhtään
 *     pistettä (192/192 ansapistettä jäljellä 905 px:ssä). Pinoamiskontekstin
 *     kanssa vuoto katosi, mutta pilleri peitti hotspotin: käyttökelpoista
 *     alaa jäi 56x28 px pisimmällä päiväyksellä, ja OIKEALLA 3,2 s
 *     painalluksella hotspotin keskeltä dialogi EI AUENNUT LAINKAAN välillä
 *     901–1010 px. Kioskista ei siis pääsisi ulos — pahempi kuin alkuperäinen.
 *  2. `max-width: calc(100% - 5rem)` pillerille. Vapautti hotspotin, mutta
 *     pillerin SISÄLTÖ ei kutistu mukana (selite ja kellonaika ovat
 *     `flex-shrink: 0`): teksti valui ulos laatikostaan 30–65 px ja kellonaika
 *     päätyi paikkakuntatekstin päälle, 25–95 px päällekkäin välillä 905–1010.
 */
.topbar--with-next .topbar__time,
.topbar--with-next .topbar__meta {
  flex: 1 1 0;
  min-width: 0;
}

.topbar--with-next .topbar__meta {
  /* space-between hoiti tämän kun lapsia oli kaksi; kolmella yhtä leveällä
     sarakkeella oikea laita on asemoitava sarakkeen sisällä. */
  justify-content: flex-end;
}

.topbar__next {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  pointer-events: none;
}

.topbar__next-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  max-width: 100%;
  padding: 0.3rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-dim);
  white-space: nowrap;
}

/* Sama hiljainen versaalityyli kuin .topbar__placella — kertoo mistä luvusta
   on kyse, jottei kellonaikaa sekoita vasemman laidan nykyiseen kelloon. */
.topbar__next-caption {
  font-size: 0.68rem;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  flex-shrink: 0;
}

/* Bannerin varsinainen sisältö: kellonaika kirkkaimpana, koska juuri se on se
   mitä ohi kulkeva vilkaisee. Ei koskaan katkaistava. */
.topbar__next-time {
  font-size: 1.05rem;
  color: var(--text);
  font-weight: 500;
  flex-shrink: 0;
}

/* Hälytyksen oma nimi on vapaamuotoista käyttäjän tekstiä (enintään 60
   merkkiä) ja ainoa osa jonka saa katkaista: ahtaalla tila otetaan tästä eikä
   naapurisarakkeista. */
.topbar__next-label {
  font-size: 0.85rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/*
 * Yötilassa banneri olisi pillerin kehyksineen palkin ainoa reunustettu,
 * täytetty laatikko ja vetäisi katseen ennen kelloa. Yöllä ruudulta katsotaan
 * kelloa, ja banneri on passiivista tietoa — kehys ja tausta pois, teksti jää.
 */
.app.night .topbar__next-pill {
  background: none;
  border-color: transparent;
  padding-left: 0;
  padding-right: 0;
}

/*
 * Kapealla ruudulla laitojen väliin ei mahdu mitään, joten banneri siirtyy
 * palkin omalle riville ilman pillerin kehystä. Raja on sama 900 px jossa
 * ruudukkokin vaihtuu yhteen sarakkeeseen (ks. .grid-mediakysely alempana).
 * `flex: 0 0 100%` yksinään
 * riittää rivitykseen — ei `order`ia, jolloin rivijärjestys tulee suoraan
 * templaatista: kello, seuraava hälytys, oikean laidan tiedot.
 *
 * `margin-top` EI ole koristelua. KioskExitHotspot ulottuu päivämäärän
 * ympäriltä 0.9rem ALASPÄIN (ks. KioskExitHotspot.vue: top/bottom: -0.9rem),
 * ja koska bannerissa on `pointer-events: none`, käärityn rivin päälle osunut
 * painallus menisi SUORAAN hotspotille: kolmen sekunnin painallus bannerin
 * vasemmassa päässä avaisi kioskin poistumisdialogin. Marginaali työntää
 * käärityn rivin kokonaan hotspotin alapuolelle. Mitattu osumatestauksella
 * 17 leveydellä välillä 320–1920 px — älä pienennä tätä mittaamatta uudelleen.
 *
 * Lohko on `.topbar--with-next`-rajattu: se purkaa keskisaraketta varten
 * tehdyn kolmen sarakkeen jaon. Itse `flex-wrap`/`row-gap` EIVÄT ole enää
 * täällä vaan perussäännössä `.topbar`issa — ilman banneria palkki kärsi
 * samasta ylivuodosta, ks. sen perustelu.
 */
@media (max-width: 900px) {
  /* Banneririvi kantaa hotspotin vaatiman välin omassa `margin-top`issaan, ks.
     alla — siksi tässä tilassa palkin oma pystyväli on pienempi kuin
     perussäännön 1.5rem. Yhteensä sama 1.5rem, ja rivejä on yksi enemmän. */
  .topbar--with-next {
    row-gap: 0.4rem;
  }

  .topbar--with-next .topbar__time,
  .topbar--with-next .topbar__meta {
    flex: 0 1 auto;
  }

  .topbar--with-next .topbar__meta {
    justify-content: flex-start;
  }

  .topbar__next {
    flex: 0 0 100%;
    /* 0.4rem row-gap + 1.1rem = 1.5rem, eli reilusti hotspotin 0.9rem:n yli. */
    margin-top: 1.1rem;
  }

  .topbar__next-pill {
    padding: 0;
    border: none;
    background: none;
  }
}

/*
 * Kaikkein kapein ruutu: banneri kahdelle riville.
 *
 * Pillerin sisällöstä VAIN hälytyksen nimi kutistuu; kuvake, selite ja
 * kellonaika ovat `flex-shrink: 0`. Kun nimi on jo kutistunut nollaan eikä
 * tila silti riitä, ylimääräinen ei katkea vaan valuu ulos — ja koska
 * kellonaika on rivin viimeinen kutistumaton osa, juuri SE meni ruudun reunan
 * yli. Mitattu kesäajan siirtopäivän pitkällä muodolla ("huomenna 3.30→4.00" /
 * "su 29.3. klo 3.30→4.00"): 320 px:llä aika oli 36–39 px ruudun ulkopuolella,
 * 340 px:llä 16–19 px, 360 px:stä ylöspäin 0. Se on kerran vuodessa toistuva
 * tieto joka leikkautuisi juuri sinä yönä jolloin se on tärkein.
 *
 * Rivitys eikä selitteen pudotus: näin mitään ei menetetä. Nimelle jää oma
 * rivi (mitattu 189–229 px sen sijaan että se katoaisi kokonaan), ja selite
 * säilyy — ilman sitä bannerissa olisi kellonaika ilman selitystä aivan
 * vasemman laidan ison kellon vieressä, ja ne sekoittuisivat keskenään.
 *
 * `white-space: nowrap` jätetään voimaan: rivitys koskee flex-lapsia, ei
 * tekstiä, joten kellonaika ei voi katketa kahdelle riville.
 */
@media (max-width: 389px) {
  .topbar__next-pill {
    flex-wrap: wrap;
    row-gap: 0.15rem;
  }

  /* Nimi omalle rivilleen; kuvake, selite ja aika jäävät ensimmäiselle. */
  .topbar__next-label {
    flex-basis: 100%;
  }
}

.battery {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  color: var(--text-dim);
}

/* Latausmerkki kuvakkeen päälle, jottei rivi levene latauksen alkaessa. */
.battery__bolt {
  margin-left: -1.35rem;
  margin-right: 0.35rem;
  color: var(--accent-school);
}

.battery__pct {
  font-size: 0.85rem;
  letter-spacing: 0.01em;
}

.battery--low {
  color: var(--mid);
}

.battery--critical {
  color: var(--expensive);
}

.topbar__meta {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  /* Pinoamiskonteksti KioskExitHotspotin yläpuolelle — ks. perustelu
     .topbar__date-wrapin kohdalla. */
  position: relative;
  z-index: 60;
}

.topbar__place {
  font-size: 0.85rem;
  color: var(--text-faint);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/*
 * Kapean ruudun varaventtiili. Rivitys yksinään riittää tavalliselle
 * puhelimelle, mutta 320 px:llä oikea laita ei mahdu edes OMALLE rivilleen:
 * sisältöä on ~313 px ja tilaa ~269 px. `min-width: 0` päästää laidan
 * kutistumaan alle min-content-leveytensä, ja koko kutistuminen otetaan
 * paikkakunnasta — painikkeet ja akku eivät kutistu lainkaan (`flex-shrink: 0`
 * omissa säännöissään), joten kuvake ei voi leikkautua. Ilman tätä kolmas
 * painike jäi 320 px:llä 19 px ruudun ulkopuolelle.
 *
 * KOKO LOHKO ON RAJATTU 900 px:iin tarkoituksella, vaikka itse rivitys ei ole.
 * Bannerin kanssa `.topbar__meta` on `flex: 1 1 0` eli tasan kolmasosa
 * palkista, ja noin 1024 px:n paikkeilla laidan sisältö on hiuksenverran sitä
 * leveämpi. Rajaamattomina nämä säännöt muuttaisivat juuri sen leveyden
 * ulkoasua: paikkakunta alkoi lyhentyä (mitattu 101 px → 87 px) ja akku
 * siirtyi 14 px. Leveällä ruudulla laita mahtuu aina, joten venttiiliä ei
 * siellä tarvita — mitattu identtiseksi HEADin kanssa kaikilla leveyksillä
 * 1024–1920, molemmissa bannerin tiloissa.
 */
@media (max-width: 900px) {
  .topbar__meta {
    min-width: 0;
  }

  /* `white-space: nowrap` estää paikkakuntaa myös rivittymästä kahdelle
     riville ja kasvattamasta palkin korkeutta. */
  .topbar__place {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Painike on kuvakkeen kokoinen ja akku kuvake + prosenttiluku — kumpikaan
     ei kutistu siististi, joten laidan koko jousto otetaan paikkakunnasta. */
  .topbar__settings,
  .battery {
    flex-shrink: 0;
  }
}

.topbar__settings {
  position: relative;
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0.5rem;
  display: flex;
  border-radius: 10px;
}

.topbar__settings:hover {
  color: var(--text);
  background: var(--surface);
}

/* Hienovarainen merkki siitä että vähintään yksi hälytys on päällä. */
.topbar__badge {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--accent-school);
}

/* Tallennettu koodi ei enää kelpaa — sama väri kuin muut varoitukset (ks. AlarmsPanelin panel__warning). */
.topbar__badge--warn {
  background: #f3c26b;
}

/* Täydet oikeudet (sis. lasten Wilma-tiedot) — oma, huomiota herättävämpi väri kuin pelkkä muokkausoikeus, jottei tasoja voi sekoittaa vilkaisulla. */
.topbar__badge--full {
  background: #e08a5a;
}

.topbar--editing {
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 1rem;
}

.topbar__editing-main {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}

.topbar__editing-label {
  font-size: 0.9rem;
  color: var(--text-dim);
}

.parked {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.parked__caption {
  font-size: 0.76rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* Kosketusalue sormelle: 44 px korkea kuten muutkin muokkaustilan painikkeet. */
.parked__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 44px;
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  border: 1px dashed var(--text-faint);
  background: var(--surface);
  color: var(--text-dim);
  font-size: 0.85rem;
  cursor: pointer;
}

.parked__chip:hover,
.parked__chip:focus-visible {
  border-style: solid;
  border-color: var(--accent-school);
  color: var(--text);
}

/* Hylätyn siirron/koon muutoksen selite — huomiota herättävämpi väri, mutta
   ei mikään hälytys: sama paikka, ei modaalia, katoaa itsestään. */
.topbar__editing-label--notice {
  color: var(--mid);
}

.topbar__editing-actions {
  display: flex;
  gap: 0.6rem;
  flex-shrink: 0;
}

.edit-btn {
  min-height: 44px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 0.55rem 1.1rem;
  font-size: 0.92rem;
  cursor: pointer;
}

.edit-btn--primary {
  background: var(--accent-school);
  border-color: transparent;
  color: #0b0d12;
  font-weight: 600;
}

.edit-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.layout-error {
  margin: 0;
  padding: 0.6rem 1rem;
  border-radius: 12px;
  background: rgba(247, 155, 155, 0.1);
  border: 1px solid rgba(247, 155, 155, 0.35);
  color: #f79b9b;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

/*
 * Ruudukko noudattaa types.ts:n GRID_COLUMNS x GRID_ROWS -koordinaatistoa
 * (6x8). Jokainen paneeli asemoidaan LayoutEditorin omalla inline-tyylillä
 * (grid-column/grid-row lasketaan placementista), joten tässä riittää
 * ruudukon rungon määrittely.
 */
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--gap);
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-template-rows: repeat(8, minmax(0, 1fr));
}

/*
 * VIERITYSTILA (Settings.gridOverflow === "scroll").
 *
 * Oletustilassa kahdeksan riviä jakaa ruudun korkeuden keskenään, joten kaikki
 * on aina näkyvissä mutta rivi kutistuu sitä matalammaksi mitä enemmän
 * kortteja on. Vieritystilassa rivillä on VÄHIMMÄISKORKEUS: kortit pysyvät
 * luettavina, ja jos ruudukko ei mahdu, sivu vierittyy.
 *
 * Rivimäärä ei muutu (ks. Settings.gridOverflow) — vain rivin korkeuden
 * käytös. Sama asettelu kelpaa siis molemmissa tiloissa, eikä asetuksen
 * vaihtaminen voi hylätä käyttäjän asettelua.
 *
 * YLÄPALKKI ON TARTTUVA, JA SE ON PAKOLLISTA EIKÄ KOSMEETTISTA.
 * KioskExitHotspot elää yläpalkin päivämäärän kohdalla ja on ainoa tapa
 * poistua kioskitilasta. Jos palkki vierittyisi näkyvistä, poistumisalue
 * katoaisi sen mukana ja laitteen saisi auki vain näppäimistöllä tai
 * virtanapista. Tausta on läpinäkymätön samasta syystä: läpikuultavan palkin
 * alta kulkeva kortti tekisi näkymättömästä alueesta sattumanvaraisen.
 */
.app--scroll {
  height: auto;
  min-height: 100vh;
  min-height: 100dvh;
}

.app--scroll .grid {
  grid-template-rows: repeat(8, minmax(5.5rem, auto));
}

.app--scroll .topbar {
  position: sticky;
  top: 0;
  z-index: 70;
  background: var(--page-bg);
  /* Palkin oma yläpehmuste tulee .appin täytteestä, joka ei vieritä mukana —
     ilman tätä kortti kurkistaisi palkin yläpuolelta sitä vieritettäessä. */
  padding-top: 1.1rem;
  margin-top: -1.1rem;
}

/*
 * Pois kytketty paneeli jättää jälkeensä AUKON eikä tiivistä muita.
 *
 * Tiivistäminen — muiden paneelien siirtäminen tyhjän tilalle — olisi
 * näyttävämpää, mutta se kirjoittaisi käyttäjän itse raahaaman asettelun
 * uusiksi. Silloin paneelin takaisin kytkeminen ei palauttaisi mitään
 * entiselleen: paneeli tulisi takaisin johonkin, ja kaikki muut olisivat jo
 * muualla. Kokeilemisesta tulisi peruuttamaton teko, ja käyttäjä menettäisi
 * asettelunsa juuri sillä että kokeili miltä näyttää ilman jotain paneelia.
 *
 * Aukko taas on täysin peruutettavissa: `hiddenPanels` ei kosketa
 * `panelLayout`iin lainkaan (ks. usePanelLayoutin `togglePanelHidden`), joten
 * paneeli palaa aina täsmälleen samaan ruutuun josta se katosi. Jos aukko
 * häiritsee, käyttäjä siirtää paneelit itse muokkaustilassa — se on hänen
 * valintansa eikä meidän tekemämme.
 *
 * Kapealla ruudulla (mediakysely alempana) ruudukko on pinottu flex-sarake,
 * joten siellä aukkoa ei synny lainkaan: piilotettu paneeli vain puuttuu
 * pinosta.
 */
.grid__empty {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  align-self: center;
  justify-self: center;
  max-width: 26rem;
  margin: 0;
  text-align: center;
  color: var(--text-faint);
  font-size: 0.95rem;
  line-height: 1.5;
}

.grid--editing {
  outline: 1px dashed var(--border);
  outline-offset: 0.4rem;
  border-radius: var(--radius);
}

/*
 * Puhelin saa yhden sarakkeen, muistilista ensin. Grid-sijoittelu ohitetaan
 * kokonaan (display: flex), joten LayoutEditorin inline-tyylit (grid-column/
 * grid-row) eivät vaikuta mihinkään täällä — asettelun muokkaus koskee vain
 * leveää näyttöä.
 */
@media (max-width: 900px) {
  .grid {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .grid :deep(.panel-frame) {
    flex: 0 0 auto;
    min-height: 9rem;
  }

  .grid__slot--notes {
    order: 1;
  }
  .grid__slot--news {
    /* Uutiset heti muistilistan jälkeen: puhelimessa ne ovat kortti jota
       oikeasti selataan, ja siellä otsikot ovat myös linkkejä. */
    order: 2;
  }
  .grid__slot--calendar {
    order: 3;
  }
  .grid__slot--weather {
    order: 4;
  }
  .grid__slot--power {
    order: 5;
  }
  .grid__slot--schedule {
    order: 6;
  }
  .grid__slot--messages {
    order: 7;
  }
}
</style>
