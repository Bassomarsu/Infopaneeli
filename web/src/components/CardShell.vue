<script setup lang="ts">
import { computed } from "vue";
import type { ProviderStatus } from "../types";

const props = defineProps<{
  title: string;
  accent?: string;
  status?: ProviderStatus;
  fetchedAt?: string | null;
  error?: { type: string; message: string } | null;
  note?: string;
}>();

/**
 * One place decides how a broken or stale source looks, so a failing card
 * degrades instead of taking the layout with it.
 */
const isStale = computed(() => props.status === "stale");
const isFailed = computed(() => props.status === "failed");
const isHidden = computed(() => props.status === "hidden");
const isLoading = computed(() => props.status === "idle" || props.status === undefined);

const staleLabel = computed(() => {
  if (!props.fetchedAt) return "";
  const then = new Date(props.fetchedAt);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 60) return `päivitetty ${minutes} min sitten`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `päivitetty ${hours} h sitten`;
  return `päivitetty ${Math.round(hours / 24)} vrk sitten`;
});
</script>

<template>
  <section class="card" :class="{ 'card--stale': isStale }">
    <header class="card__head">
      <h2 class="card__title">
        <span v-if="accent" class="card__accent" :style="{ background: accent }" />
        {{ title }}
      </h2>
      <span v-if="isStale" class="badge badge--warn" :title="error?.message">
        vanhentunut · {{ staleLabel }}
      </span>
      <span v-else-if="isFailed" class="badge badge--error">ei yhteyttä</span>
      <span v-else-if="note" class="card__note">{{ note }}</span>
    </header>

    <div class="card__body">
      <div v-if="isFailed" class="state">
        <span class="state__title">Tietoja ei saatu</span>
        <span>{{ error?.message ?? "Lähde ei vastaa" }}</span>
      </div>
      <div v-else-if="isHidden" class="state">
        <span class="state__title">Vain infonäytöllä</span>
        <span>Koulutiedot näkyvät vain keittiön näytöllä, eivät kotiverkon muilla laitteilla.</span>
      </div>
      <div v-else-if="isLoading" class="state">
        <span>Haetaan…</span>
      </div>
      <slot v-else />
    </div>
  </section>
</template>
