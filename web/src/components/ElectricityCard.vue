<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import type { ElectricityData, ProviderSnapshot } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<ElectricityData>;
  currentHour: number;
}>();

const data = computed(() => props.snapshot?.data ?? null);

/**
 * Bars are scaled against both days together so tomorrow is visually
 * comparable to today rather than each day being normalised on its own.
 */
const scaleMax = computed(() => {
  const d = data.value;
  if (!d) return 1;
  const maxima = [d.today?.max ?? 0, d.tomorrow?.max ?? 0];
  return Math.max(...maxima, 1);
});

function barHeight(price: number | null): string {
  if (price === null) return "0%";
  return `${Math.max((Math.max(price, 0) / scaleMax.value) * 100, 2)}%`;
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

function hourTitle(hour: number, price: number | null): string {
  return price === null ? `klo ${hour}: ei hintaa` : `klo ${hour}: ${format(price)} snt/kWh`;
}
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

      <div class="power__day">
        <div class="power__daylabel">
          <span>Tänään</span>
          <span v-if="data.today" class="power__dayavg tnum">ka {{ format(data.today.average) }}</span>
        </div>
        <div v-if="data.today" class="bars">
          <div
            v-for="h in data.today.hours"
            :key="h.hour"
            class="bar"
            :class="{ 'bar--now': h.hour === currentHour }"
            :title="hourTitle(h.hour, h.price)"
          >
            <span class="bar__fill" :style="{ height: barHeight(h.price), background: barColor(h.price) }" />
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
        <div v-if="data.tomorrowAvailable && data.tomorrow" class="bars">
          <div
            v-for="h in data.tomorrow.hours"
            :key="h.hour"
            class="bar"
            :title="hourTitle(h.hour, h.price)"
          >
            <span class="bar__fill" :style="{ height: barHeight(h.price), background: barColor(h.price) }" />
          </div>
        </div>
        <p v-else class="power__empty">Julkaistaan noin klo 14</p>
      </div>

      <div class="power__axis">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  </CardShell>
</template>

<style scoped>
.power {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  height: 100%;
  min-height: 0;
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

.power__day {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1;
  min-height: 0;
}

.power__daylabel {
  display: flex;
  justify-content: space-between;
  font-size: 0.74rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 1;
  min-height: 2.6rem;
}

.bar {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: 2px;
}

.bar--now {
  background: rgba(255, 255, 255, 0.1);
  outline: 1px solid rgba(255, 255, 255, 0.22);
}

.bar__fill {
  display: block;
  width: 100%;
  border-radius: 2px 2px 0 0;
}

.power__empty {
  margin: 0;
  flex: 1;
  display: flex;
  align-items: center;
  font-size: 0.85rem;
  color: var(--text-faint);
}

.power__axis {
  display: flex;
  justify-content: space-between;
  font-size: 0.68rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
