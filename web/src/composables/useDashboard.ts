import { onUnmounted, ref } from "vue";
import { useEditAccess } from "./useEditAccess.ts";
import type { Dashboard } from "../types";

/**
 * The browser only ever reads the backend's cache. It never triggers an
 * upstream fetch — that is what keeps Wilma from being hit on every page load.
 *
 * Goes through editAccess.editFetch, not a raw fetch, even though this is a
 * read: a stored FULL_PIN has to reach the server on every poll for
 * `localClient`/Wilma visibility to reflect it (this endpoint never 401s, so
 * editFetch's expiry handling is simply a no-op here — it only matters for
 * the write paths that actually can 401).
 */
export function useDashboard(intervalMs = 60_000) {
  const dashboard = ref<Dashboard | null>(null);
  const connected = ref(false);
  const lastUpdate = ref<Date | null>(null);
  const editAccess = useEditAccess();

  async function refresh(): Promise<void> {
    try {
      const response = await editAccess.editFetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      dashboard.value = (await response.json()) as Dashboard;
      connected.value = true;
      lastUpdate.value = new Date();
    } catch {
      // Losing the backend does not clear the screen; the last payload stays
      // visible and the header shows the connection is down.
      connected.value = false;
    }
  }

  void refresh();
  const timer = window.setInterval(() => void refresh(), intervalMs);
  onUnmounted(() => window.clearInterval(timer));

  return { dashboard, connected, lastUpdate, refresh };
}
