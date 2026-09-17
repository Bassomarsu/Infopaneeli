<script setup lang="ts">
import { computed, onUnmounted, reactive } from "vue";
import CardShell from "./CardShell.vue";
import { hourFromPointerX } from "./electricityChart";
import type { ElectricityData, PriceDay, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<ElectricityData>;
  currentHour: number;
}>();

const data = computed(() => props.snapshot?.data ?? null);

/**
 * Tänään ja huomenna käyttävät samaa asteikkoa (yhteinen min/max), jotta
 * pylväät ovat suoraan vertailukelpoisia päivien välillä. Vaihtoehto olisi
 * skaalata kumpikin päivä erikseen täyteen korkeuteen, mutta silloin
 * samannäköinen pylväs voisi tarkoittaa eri hintaa eri päivinä, mikä on
 * tälle "vilkaisulla luettavalle" kortille pahempi virhe kuin hukattu tila.
 */
const scaleMax = computed(() => {
  const d = data.value;
  if (!d) return 1;
  // Huomisen PriceDay ei ole null heti kun ikkunassa on yksikin huomisen
  // tunti, mutta korttti näyttää huomisen kaavion vasta kun
  // tomorrowAvailable on tosi. Sitä ennen mukana oleva yksittäinen (ja
  // mahdollisesti poikkeava) tunti ei saa venyttää tämän päivän asteikkoa.
  const tomorrowMax = d.tomorrowAvailable ? d.tomorrow?.max ?? 0 : 0;
  const maxima = [d.today?.max ?? 0, tomorrowMax];
  return Math.max(...maxima, 1);
});

/** Alaraja on 0 paitsi jos jompikumpi näytetty päivä käy negatiiviseksi. */
const scaleMin = computed(() => {
  const d = data.value;
  if (!d) return 0;
  const tomorrowMin = d.tomorrowAvailable ? d.tomorrow?.min ?? 0 : 0;
  const minima = [d.today?.min ?? 0, tomorrowMin];
  return Math.min(0, ...minima);
});

/**
 * Kolme apuviivaa/lukemaa: yläraja, keskikohta, alaraja. Jos asteikko
 * ylittää nollan eikä nolla osu lähelle keskiviivaa, lisätään oma
 * nollaviiva — sen täytyy erottua, koska negatiivinen pörssihinta on
 * eri asia kuin "hintaa ei tiedossa".
 */
const yTicks = computed(() => {
  const max = scaleMax.value;
  const min = scaleMin.value;
  const mid = (max + min) / 2;
  const topTick = { value: max, pct: 100, zero: false, edge: true };
  const midTick = { value: mid, pct: 50, zero: false, edge: false };
  const bottomTick = { value: min, pct: 0, zero: false, edge: true };
  const ticks = [topTick, midTick, bottomTick];
  if (min < 0 && max > 0) {
    const zeroPct = ((0 - min) / (max - min)) * 100;
    if (Math.abs(zeroPct - 50) > 8) {
      ticks.push({ value: 0, pct: zeroPct, zero: true, edge: false });
    } else {
      midTick.zero = true;
    }
  }
  return ticks;
});

/**
 * 24 pystysuoraa "sarakepaikkaa" x-akselille, samalla flex(1)+gap-mallilla
 * kuin pylväät itse, jotta kellonaika osuu aina oikean pylvään kohdalle
 * eikä vain arvaa tasaväliä. Vain kuuden tunnin välein näytetään teksti;
 * loput pitävät paikkansa varattuna asettelun vuoksi.
 */
const hourTicks = computed(() =>
  Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hour % 6 === 0 ? String(hour) : "",
    minor: hour % 12 !== 0,
  }))
);

/** Palauttaa null julkaisemattomalle tunnille — sitä ei saa piirtää nollana. */
function barFill(price: number | null): Record<string, string> | null {
  if (price === null) return null;
  const min = scaleMin.value;
  const max = scaleMax.value;
  const range = max - min || 1;
  const zeroPct = ((0 - min) / range) * 100;
  const pricePct = ((price - min) / range) * 100;
  let height = Math.abs(pricePct - zeroPct);
  // Pieni minimi vain siksi, ettei lähes-nolla-hinta katoa täysin näkymättömiin
  // (0 px olisi helppo sekoittaa renderöintivirheeseen). Se ei yritä tehdä
  // pienistä hinnoista keskenään erottuvia — kortti on vilkaisulle, ei
  // tarkkuuslukemiseen, ja "kallis vai halpa" -viesti tulee jo väristä
  // (barColor), ei pylvään tarkasta korkeudesta.
  if (height < 1) height = 1;
  const bottom = price >= 0 ? zeroPct : zeroPct - height;
  return {
    bottom: `${bottom}%`,
    height: `${height}%`,
    background: barColor(price),
  };
}

function barColor(price: number | null): string {
  if (price === null) return "transparent";
  if (price < 5) return "var(--cheap)";
  if (price < 12) return "var(--mid)";
  return "var(--expensive)";
}

function format(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(2).replace(".", ",") : "–";
}

/** Lyhyempi pyöristys akselilukemiin, jotta 2,3 rem:n sarake ei tavuta lukua. */
function formatAxis(value: number): string {
  const v = Math.abs(value) < 0.05 ? 0 : value;
  const decimals = Math.abs(v) < 10 ? 1 : 0;
  return v.toFixed(decimals).replace(".", ",");
}

function hourTitle(hour: number, price: number | null): string {
  return price === null ? `klo ${hour}: ei tiedossa` : `klo ${hour}: ${format(price)} snt/kWh`;
}

type ChartDay = "today" | "tomorrow";

/**
 * Kosketuksella (tai klikkauksella) valittu tunti kummassakin kaaviossa.
 * Pidetään erillisinä tämälle ja huomiselle: kaaviot ovat kaksi eri aluetta,
 * ja käyttäjä saattaa haluta verrata esim. illan hintaa tänään huomisaamun
 * hintaan, joten toisen koskettaminen ei saa hiljaa pyyhkiä toisen lukemaa pois.
 */
const selection = reactive<Record<ChartDay, number | null>>({ today: null, tomorrow: null });
const selectionTimers: Record<ChartDay, ReturnType<typeof setTimeout> | null> = {
  today: null,
  tomorrow: null,
};

/**
 * Valinta raukeaa itsestään, koska näyttö on auki päiviä kerrallaan eikä saa
 * jäädä näyttämään satunnaisen tunnin lukemaa loputtomiin. 8 s vastaa
 * muistilistan poistovahvistuksen aikaa — tämäkin on lyhyt, kertaluonteinen
 * paljastus eikä lukujärjestyksen selauksen kaltainen pysyvä tila (5 min).
 */
const SELECTION_TIMEOUT_MS = 8000;

function selectHour(day: ChartDay, hour: number): void {
  selection[day] = hour;
  const existing = selectionTimers[day];
  if (existing !== null) clearTimeout(existing);
  selectionTimers[day] = setTimeout(() => {
    selection[day] = null;
    selectionTimers[day] = null;
  }, SELECTION_TIMEOUT_MS);
}

function updateSelectionFromEvent(event: PointerEvent, day: ChartDay): void {
  const el = event.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  selectHour(day, hourFromPointerX(event.clientX - rect.left, rect.width));
}

function onBarsPointerDown(event: PointerEvent, day: ChartDay): void {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  updateSelectionFromEvent(event, day);
}

/**
 * Sormea liu'uttamalla (pyyhkäisemällä) lukema seuraa mukana — pointerCapture
 * pitää liikkeen kiinni samassa .bars-elementissä vaikka sormi livahtaisi sen
 * reunan yli. Hiirellä pelkkä kohdistimen liike ilman painettua nappia ei saa
 * vaihtaa valintaa, muuten pelkkä hiiren yli vieminen valitsisi tunteja.
 */
function onBarsPointerMove(event: PointerEvent, day: ChartDay): void {
  if (event.pointerType === "mouse" && event.buttons === 0) return;
  updateSelectionFromEvent(event, day);
}

onUnmounted(() => {
  if (selectionTimers.today !== null) clearTimeout(selectionTimers.today);
  if (selectionTimers.tomorrow !== null) clearTimeout(selectionTimers.tomorrow);
});

/** "klo 14–15: 4,2 snt/kWh" valitulle tunnille; julkaisematon hinta erottuu "ei tiedossa"na, ei nollana. */
function readoutText(day: PriceDay, hour: number): string | null {
  const h = day.hours[hour];
  if (!h) return null;
  const priceText = h.price === null ? "ei tiedossa" : `${format(h.price)} snt/kWh`;
  return `klo ${h.hour}–${h.hour + 1}: ${priceText}`;
}

const todayReadout = computed(() => {
  const day = data.value?.today;
  const hour = selection.today;
  return day && hour !== null ? readoutText(day, hour) : null;
});

const tomorrowReadout = computed(() => {
  const day = data.value?.tomorrow;
  const hour = selection.tomorrow;
  return day && hour !== null ? readoutText(day, hour) : null;
});

/** "Elokuu 2026" -> "Elo 2026", so the two month chips stay on one line. */
function shortLabel(label: string): string {
  return label.replace(/^(\S{3})\S*/, "$1");
}

function monthComplete(m: { knownHours: number; expectedHours: number }): boolean {
  return m.expectedHours > 0 && m.knownHours >= m.expectedHours;
}

/** Reconstructs "as of which day" from expectedHours, which the server derives the same way. */
function asOfDay(expectedHours: number): number {
  return Math.floor((expectedHours - 1) / 24) + 1;
}

function monthTitle(m: { label: string; knownHours: number; expectedHours: number } | null): string {
  if (!m) return "Ei kuukausihistoriaa saatavilla";
  if (monthComplete(m)) return `${m.label} · koko kuukausi (${m.knownHours} h)`;
  return `${m.label} · 1.–${asOfDay(m.expectedHours)}. pv (${m.knownHours}/${m.expectedHours} h)`;
}

/**
 * Direction between last month's average and this month's so-far average.
 * Comparing a partial month to a full one is not perfectly apples-to-apples,
 * but it is exactly the "which way is it moving" signal that is useful here.
 */
const trend = computed<{ symbol: string; className: string; title: string } | null>(() => {
  const cur = data.value?.currentMonth;
  const prev = data.value?.previousMonth;
  if (!cur?.average || !prev?.average) return null;
  const changePct = ((cur.average - prev.average) / prev.average) * 100;
  const title = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(0)} % edellisestä kuukaudesta`;
  if (Math.abs(changePct) < 1) return { symbol: "→", className: "power__trend--flat", title };
  return changePct > 0
    ? { symbol: "↑", className: "power__trend--up", title }
    : { symbol: "↓", className: "power__trend--down", title };
});
</script>

<template>
  <CardShell
    title="Pörssisähkö"
    accent="var(--accent-power)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
    note="snt/kWh sis. alv"
  >
    <div v-if="data" class="power">
      <div class="power__now">
        <span class="power__price tnum">{{ format(data.currentPrice) }}</span>
        <span class="power__unit">snt/kWh nyt</span>
        <span v-if="data.today" class="power__range tnum">
          tänään {{ format(data.today.min) }} – {{ format(data.today.max) }}
          · ka {{ format(data.today.average) }}
        </span>
      </div>

      <div v-if="data.currentMonth || data.previousMonth" class="power__months">
        <span v-if="data.previousMonth" class="power__month" :title="monthTitle(data.previousMonth)">
          <span class="power__monthlabel">{{ shortLabel(data.previousMonth.label) }}</span>
          <span class="power__monthvalue tnum">{{ format(data.previousMonth.average) }}</span>
        </span>
        <span v-if="trend" class="power__trend" :class="trend.className" :title="trend.title">{{ trend.symbol }}</span>
        <span v-if="data.currentMonth" class="power__month" :title="monthTitle(data.currentMonth)">
          <span class="power__monthlabel">
            {{ shortLabel(data.currentMonth.label) }}<span v-if="!monthComplete(data.currentMonth)">*</span>
          </span>
          <span class="power__monthvalue tnum">{{ format(data.currentMonth.average) }}</span>
        </span>
      </div>

      <div class="power__day">
        <div class="power__daylabel">
          <span>Tänään</span>
          <span v-if="data.today" class="power__dayavg tnum">ka {{ format(data.today.average) }}</span>
        </div>
        <div v-if="data.today" class="power__readout tnum">{{ todayReadout ?? ' ' }}</div>
        <div v-if="data.today" class="power__chart">
          <div class="power__yaxis">
            <span
              v-for="t in yTicks"
              :key="t.value + '-' + t.pct"
              class="power__ytick"
              :class="{ 'power__ytick--zero': t.zero, 'power__ytick--minor': !t.edge && !t.zero }"
              :style="{ bottom: t.pct + '%' }"
            >{{ formatAxis(t.value) }}</span>
          </div>
          <div class="power__plot">
            <span
              v-for="t in yTicks"
              :key="'grid-' + t.value + '-' + t.pct"
              class="power__gridline"
              :class="{ 'power__gridline--zero': t.zero }"
              :style="{ bottom: t.pct + '%' }"
            />
            <div
              class="bars"
              @pointerdown="onBarsPointerDown($event, 'today')"
              @pointermove="onBarsPointerMove($event, 'today')"
            >
              <div
                v-for="h in data.today.hours"
                :key="h.hour"
                class="bar"
                :class="{ 'bar--now': h.hour === currentHour, 'bar--selected': h.hour === selection.today }"
                :title="hourTitle(h.hour, h.price)"
              >
                <span v-if="h.price !== null" class="bar__fill" :style="barFill(h.price)!" />
                <span v-else class="bar__missing" />
              </div>
            </div>
          </div>
        </div>
        <p v-else class="power__empty">Ei hintatietoja</p>
      </div>

      <div class="power__day">
        <div class="power__daylabel">
          <span>Huomenna</span>
          <span v-if="data.tomorrowAvailable && data.tomorrow" class="power__dayavg tnum">
            ka {{ format(data.tomorrow.average) }}
          </span>
        </div>
        <div v-if="data.tomorrowAvailable && data.tomorrow" class="power__readout tnum">{{ tomorrowReadout ?? ' ' }}</div>
        <div v-if="data.tomorrowAvailable && data.tomorrow" class="power__chart">
          <div class="power__yaxis">
            <span
              v-for="t in yTicks"
              :key="t.value + '-' + t.pct"
              class="power__ytick"
              :class="{ 'power__ytick--zero': t.zero, 'power__ytick--minor': !t.edge && !t.zero }"
              :style="{ bottom: t.pct + '%' }"
            >{{ formatAxis(t.value) }}</span>
          </div>
          <div class="power__plot">
            <span
              v-for="t in yTicks"
              :key="'grid-' + t.value + '-' + t.pct"
              class="power__gridline"
              :class="{ 'power__gridline--zero': t.zero }"
              :style="{ bottom: t.pct + '%' }"
            />
            <div
              class="bars"
              @pointerdown="onBarsPointerDown($event, 'tomorrow')"
              @pointermove="onBarsPointerMove($event, 'tomorrow')"
            >
              <div
                v-for="h in data.tomorrow.hours"
                :key="h.hour"
                class="bar"
                :class="{ 'bar--selected': h.hour === selection.tomorrow }"
                :title="hourTitle(h.hour, h.price)"
              >
                <span v-if="h.price !== null" class="bar__fill" :style="barFill(h.price)!" />
                <span v-else class="bar__missing" />
              </div>
            </div>
          </div>
        </div>
        <p v-else class="power__empty">Julkaistaan noin klo 14</p>
      </div>

      <div class="power__xaxis">
        <span class="power__xaxis-spacer" aria-hidden="true"></span>
        <div class="power__xaxis-ticks">
          <span
            v-for="t in hourTicks"
            :key="t.hour"
            class="power__xtick"
            :class="{ 'power__xtick--minor': t.minor }"
          >{{ t.label }}</span>
        </div>
      </div>
    </div>
  </CardShell>
</template>

<style scoped>
/*
 * Sisältö vierittyy, sama kuvio kuin yhdeksällä muulla kortilla
 * (`.messages`, `.calendar__days`, `.schedule__cols` …).
 *
 * Vieritys on TÄSSÄ eikä kortissa: kortin oma `overflow: hidden` pitää
 * otsikon ja "vanhentunut"-merkin paikallaan (ks. types.ts:n MIN_PANEL_SPAN),
 * ja vain sisältö saa liikkua. Sisäkkäisiä vierityssäiliöitä ei ole, joten
 * palkkeja on yksi.
 *
 * HUOM `container-type: inline-size`: vierityspalkki kaventaa tämän
 * sisältölaatikkoa ~15 px, joten alempana olevat `@container power-card`
 * -rajat (230 px, 170 px) osuvat kapeassa kortissa hitusen aiemmin. Se on
 * oikea suunta — kapeampi laatikko saa kapean asettelun — mutta se on syytä
 * tietää jos noita rajoja joskus säätää.
 */
.power {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  container-type: inline-size;
  container-name: power-card;
}

.power__now {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.power__price {
  font-size: 2.7rem;
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--accent-power);
}

.power__unit {
  font-size: 0.9rem;
  color: var(--text-dim);
}

.power__range {
  font-size: 0.78rem;
  color: var(--text-faint);
  width: 100%;
}

.power__months {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.72rem;
  color: var(--text-faint);
}

.power__month {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
}

.power__monthlabel {
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.power__monthvalue {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-dim);
}

.power__trend {
  font-weight: 700;
}

.power__trend--up {
  color: var(--expensive);
}

.power__trend--down {
  color: var(--cheap);
}

.power__trend--flat {
  color: var(--text-faint);
}

/*
 * EI `min-height: 0`, samasta syystä kuin WeatherCardin `.weather__days`issa.
 *
 * `min-height: 0` antoi päivälohkon kutistua sisältönsä alle, jolloin kaavio
 * leikkautui lohkon SISÄLLÄ eikä `.power` vuotanut yli — vierityspalkkia ei
 * siis olisi tullut vaikka kaaviosta puuttui osa. Mitattu 901 px: `.power`
 * vuoti 15 px mutta kumpikin päivälohko 43 px.
 *
 * Ilman sitä lohkon vähimmäiskorkeus on sen sisällön korkeus, jonka pohjana
 * on `.power__chart`in `min-height: 2.6rem`. `flex: 1` jää, joten isossa
 * kortissa kaaviot täyttävät tilan kuten ennenkin.
 */
.power__day {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1;
}

.power__daylabel {
  display: flex;
  justify-content: space-between;
  font-size: 0.74rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* Tunnin lukema kosketuksella/klikkauksella (ks. bars-elementin pointer-käsittely).
   Rivi on aina renderöity kun päivän kaavio on näkyvissä — vain teksti vaihtuu
   välilyönniksi kun mitään ei ole valittuna — jotta kortin korkeus ei hyppää
   valinnan tullessa tai raueten. */
.power__readout {
  min-height: 1.1em;
  font-size: 0.95rem;
  font-weight: 650;
  color: var(--accent-power);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Y-akseli + piirtoalue rinnakkain. Pystysuunnassa tarvitaan vähän
   ylimääräistä tilaa (padding-block), jotta reunimmaiset lukemat eivät
   mene aivan kortin reunaan kiinni. */
.power__chart {
  display: flex;
  align-items: stretch;
  gap: 0.35rem;
  flex: 1;
  min-height: 2.6rem;
  padding-block: 0.55em;
}

.power__yaxis {
  position: relative;
  flex: 0 0 auto;
  width: 2.3rem;
  font-size: 0.62rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.power__ytick {
  position: absolute;
  right: 0;
  left: 0;
  transform: translateY(50%);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
}

.power__ytick--zero {
  color: var(--text-dim);
  font-weight: 600;
}

.power__plot {
  position: relative;
  flex: 1;
  min-width: 0;
}

.power__gridline {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--border);
}

.power__gridline--zero {
  background: var(--text-faint);
}

.bars {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  /* Osoitin käsittelee koko alueen itse (ks. onBarsPointerDown/Move) — selaimen
     omat kosketuseleet (esim. vieritys) eivät saa kilpailla pyyhkäisyn kanssa. */
  touch-action: none;
}

.bar {
  position: relative;
  flex: 1;
  height: 100%;
  border-radius: 2px;
}

.bar--now {
  background: rgba(255, 255, 255, 0.1);
  outline: 1px solid rgba(255, 255, 255, 0.22);
}

/* Kosketuksella/klikkauksella valittu tunti — erotettava selvästi bar--now:sta
   (joka merkitsee kuluvaa tuntia), joten oma väri (--accent-power) ja paksumpi
   outline sen sijaan että vain vahvistaisi samaa valkoista korostusta.
   Kummankin osuessa samaan palkkiin tämä sääntö tulee jäljempänä, joten sen
   outline voittaa bar--now:n. */
.bar--selected {
  outline: 2px solid var(--accent-power);
}

.bar__fill {
  position: absolute;
  left: 0;
  right: 0;
  border-radius: 2px 2px 0 0;
}

/* Julkaisematon tunti: viiruttu kenttä koko pylvään korkeudelta, jotta se
   ei sekoitu nollahintaan (joka piirtyy ohuena palkkina nollaviivalle). */
.bar__missing {
  position: absolute;
  inset: 0;
  border-radius: 2px;
  opacity: 0.55;
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0,
    transparent 3px,
    var(--border) 3px,
    var(--border) 4px
  );
}

.power__empty {
  margin: 0;
  flex: 1;
  display: flex;
  align-items: center;
  font-size: 0.85rem;
  color: var(--text-faint);
}

.power__xaxis {
  display: flex;
  gap: 0.35rem;
  font-size: 0.66rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.power__xaxis-spacer {
  flex: 0 0 auto;
  width: 2.3rem;
}

.power__xaxis-ticks {
  display: flex;
  flex: 1;
  gap: 2px;
  min-width: 0;
}

.power__xtick {
  flex: 1;
  text-align: center;
}

/* Kapealla kortilla (esim. 2 saraketta 6:sta) 24 tunnin ruudukko ja neljä
   lukemaa alkavat ahtautua. Harvenna ensin apuviivat/tunnit sen sijaan
   että teksti menisi päällekkäin — piiloon visibility:hidden:llä, jotta
   flex-sarakkeiden leveys (ja siten pylväiden kohdistus) ei muutu. */
@container power-card (max-width: 230px) {
  .power__xtick--minor {
    visibility: hidden;
  }
  .power__yaxis,
  .power__xaxis-spacer {
    width: 1.9rem;
  }
  .power__ytick,
  .power__xtick {
    font-size: 0.58rem;
  }
  .power__readout {
    font-size: 0.8rem;
  }
}

@container power-card (max-width: 170px) {
  .power__ytick--minor {
    visibility: hidden;
  }
}
</style>
