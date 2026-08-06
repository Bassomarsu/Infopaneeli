<script setup lang="ts">
import { computed } from "vue";
import CardShell from "./CardShell.vue";
import type { ProviderSnapshot, WilmaData, WilmaMessage } from "../types";

const props = defineProps<{
  snapshot?: ProviderSnapshot<WilmaData>;
  hidePreviews: boolean;
}>();

const messages = computed(() => props.snapshot?.data?.messages.slice(0, 6) ?? []);
const unreadCount = computed(() => props.snapshot?.data?.unreadCount ?? 0);

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
</script>

<template>
  <CardShell
    title="Wilma-viestit"
    accent="var(--accent-school)"
    :status="snapshot?.status"
    :fetched-at="snapshot?.fetchedAt"
    :error="snapshot?.error"
    :note="unreadCount > 0 ? `${unreadCount} lukematonta` : undefined"
  >
    <div v-if="messages.length === 0" class="state">
      <span>Ei viestejä</span>
    </div>

    <ul v-else class="messages">
      <li v-for="message in messages" :key="message.id" class="message" :class="{ 'message--unread': message.unread }">
        <div class="message__row">
          <span class="message__sender">{{ message.senderName ?? "Tuntematon lähettäjä" }}</span>
          <span class="message__time tnum">{{ sentLabel(message.sentAt) }}</span>
        </div>
        <div class="message__subject">
          <span v-if="message.unread" class="message__dot" aria-hidden="true" />
          {{ message.subject }}
          <span v-if="studentName(message)" class="message__student">{{ studentName(message) }}</span>
        </div>
        <p v-if="preview(message)" class="message__preview">{{ preview(message) }}</p>
      </li>
    </ul>
  </CardShell>
</template>

<style scoped>
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
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.message:last-child {
  border-bottom: none;
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

.message--unread .message__subject {
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
