<script setup lang="ts">
import { computed, ref, watch } from "vue";
import CardShell from "./CardShell.vue";
import MessageDialog from "./MessageDialog.vue";
import type { ProviderSnapshot, WilmaData, WilmaMessage } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<WilmaData>;
  hidePreviews: boolean;
}>();

type Tab = "unread" | "read";
const tab = ref<Tab>("unread");

/**
 * Local read state, keyed by message id. Seeded from what the server already
 * persisted (`message.localRead`, from server/src/core/store.ts's
 * `message_reads` table) and then updated the moment a message is opened, so
 * the tabs react instantly instead of waiting for the next dashboard poll
 * (which only runs every few minutes).
 */
const localReads = ref(new Set<number>());

watch(
  () => props.snapshot?.data?.messages,
  (messages) => {
    for (const message of messages ?? []) {
      if (message.localRead) localReads.value.add(message.id);
    }
  },
  { immediate: true },
);

function isRead(message: WilmaMessage): boolean {
  return localReads.value.has(message.id);
}

const allMessages = computed(() => props.snapshot?.data?.messages ?? []);
const unreadMessages = computed(() => allMessages.value.filter((m) => !isRead(m)));
const readMessages = computed(() => allMessages.value.filter((m) => isRead(m)));
const bothEmpty = computed(() => allMessages.value.length === 0);

// Capped like the old single-list view, so the card never grows past what the
// wall display has room for.
const visibleMessages = computed(() => (tab.value === "unread" ? unreadMessages.value : readMessages.value).slice(0, 6));

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
  if (isRead(message)) return;

  // Optimistic: the wall display must update the instant the message is
  // opened, not on the next dashboard poll (see the localReads comment above).
  localReads.value.add(message.id);
  try {
    const response = await fetch(`/api/wilma/messages/${message.id}/read`, { method: "POST" });
    if (!response.ok) throw new Error();
  } catch {
    // The server never recorded it, so roll the optimistic update back —
    // otherwise the card would keep claiming "read" after a reload.
    localReads.value.delete(message.id);
  }
}

function closeDialog(): void {
  openMessageId.value = null;
}
</script>

<template>
  <CardShell
    title="Wilma-viestit"
    accent="var(--accent-school)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
    :note="unreadMessages.length > 0 ? `${unreadMessages.length} lukematonta` : undefined"
  >
    <div v-if="bothEmpty" class="state">
      <span>Ei viestejä</span>
    </div>

    <div v-else class="messages-panel">
      <div class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="tabs__btn"
          :class="{ 'tabs__btn--active': tab === 'unread' }"
          :aria-selected="tab === 'unread'"
          @click="tab = 'unread'"
        >
          Lukematta
          <span v-if="unreadMessages.length > 0" class="tabs__count">{{ unreadMessages.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="tabs__btn"
          :class="{ 'tabs__btn--active': tab === 'read' }"
          :aria-selected="tab === 'read'"
          @click="tab = 'read'"
        >
          Luetut
        </button>
      </div>

      <div v-if="visibleMessages.length === 0" class="state">
        <span>{{ tab === "unread" ? "Ei lukemattomia viestejä" : "Ei luettuja viestejä" }}</span>
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
            <div class="message__subject" :class="{ 'message__subject--unread': !isRead(message) }">
              <span v-if="!isRead(message)" class="message__dot" aria-hidden="true" />
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
.messages-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  gap: 0.4rem;
}

.tabs {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.tabs__btn {
  flex: 1;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  background: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-faint);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.tabs__btn--active {
  background: var(--surface-strong);
  border-color: var(--accent-school);
  color: var(--text);
}

.tabs__count {
  min-width: 1.1rem;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: var(--accent-school);
  color: #0b0d12;
  font-size: 0.72rem;
  font-weight: 700;
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
