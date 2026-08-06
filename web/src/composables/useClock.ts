import { onUnmounted, ref } from "vue";

/**
 * The wall display stays open for days, so anything time-dependent has to tick
 * rather than being decided once at page load. Twenty seconds is fine — every
 * consumer works at minute granularity.
 */
export function useClock(intervalMs = 20_000) {
  const now = ref(new Date());
  const timer = window.setInterval(() => {
    now.value = new Date();
  }, intervalMs);

  onUnmounted(() => window.clearInterval(timer));

  return { now };
}
