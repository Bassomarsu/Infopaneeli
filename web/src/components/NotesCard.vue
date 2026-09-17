<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useEditAccess } from "../composables/useEditAccess.ts";
import CardShell from "./CardShell.vue";

const editAccess = useEditAccess();

export interface Note {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

const props = defineProps<{
  notes: Note[];
  canEdit: boolean;
}>();

const emit = defineEmits<{ refresh: [] }>();

const MAX_LENGTH = 200;

const draft = ref("");
const submitting = ref(false);
const errorMessage = ref<string | null>(null);

// Done items sink to the bottom but keep their relative order otherwise, so
// ticking one off doesn't reshuffle the rest of the list.
const sortedNotes = computed(() => [...props.notes].sort((a, b) => Number(a.done) - Number(b.done)));

const overLimit = computed(() => draft.value.length > MAX_LENGTH);
const canSubmit = computed(() => draft.value.trim().length > 0 && !overLimit.value && !submitting.value);

// The server rejects with 400 and a message; 401/403 mean the edit grant
// expired mid-session (PIN timeout), which reads better as a plain hint here
// than as a raw HTTP error.
async function errorFor(response: Response, fallback: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Muokkaus vaatii PIN-koodin";
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

async function addNote(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMessage.value = null;
  try {
    const response = await editAccess.editFetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: draft.value.trim() }),
    });
    if (!response.ok) throw new Error(await errorFor(response, "Lisäys epäonnistui"));
    draft.value = "";
    emit("refresh");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "Lisäys epäonnistui";
  } finally {
    submitting.value = false;
  }
}

async function toggleDone(note: Note): Promise<void> {
  errorMessage.value = null;
  try {
    const response = await editAccess.editFetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: !note.done }),
    });
    if (!response.ok) throw new Error(await errorFor(response, "Päivitys epäonnistui"));
    emit("refresh");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "Päivitys epäonnistui";
  }
}

/**
 * Poisto kysyy vahvistuksen suoraan rivillä eikä selaimen `confirm()`-ikkunalla:
 * kioskiselain voi estää natiivit dialogit kokonaan, ja seinänäytöllä modaali on
 * raskaampi kuin kaksi napautusta samassa kohdassa.
 */
const PENDING_TIMEOUT_MS = 8_000;

/** Vain yksi rivi voi odottaa vahvistusta kerrallaan. */
const pendingDeleteId = ref<number | null>(null);
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function askDelete(note: Note): void {
  errorMessage.value = null;
  pendingDeleteId.value = note.id;
  clearPendingTimer();
  // Näyttö on auki päiviä kerrallaan, joten kysymys ei saa jäädä roikkumaan
  // riville odottamaan vastausta jota kukaan ei ole antamassa.
  pendingTimer = setTimeout(() => {
    pendingDeleteId.value = null;
    pendingTimer = null;
  }, PENDING_TIMEOUT_MS);
}

function cancelDelete(): void {
  pendingDeleteId.value = null;
  clearPendingTimer();
}

onBeforeUnmount(clearPendingTimer);

async function removeNote(note: Note): Promise<void> {
  errorMessage.value = null;
  cancelDelete();
  try {
    const response = await editAccess.editFetch(`/api/notes/${note.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await errorFor(response, "Poisto epäonnistui"));
    emit("refresh");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "Poisto epäonnistui";
  }
}
</script>

<template>
  <CardShell title="Muistilista" accent="var(--accent-school)" status="ok">
    <div class="notes">
      <form v-if="canEdit" class="notes__add" @submit.prevent="addNote">
        <input v-model="draft" type="text" class="notes__input" placeholder="Uusi muistiinpano…" />
        <button type="submit" class="notes__add-btn" :disabled="!canSubmit">Lisää</button>
      </form>
      <p v-else class="notes__hint">
        Muokkaus onnistuu näyttölaitteelta tai ottamalla käyttöön PIN-koodi lukko-kuvakkeesta yläpalkissa.
      </p>

      <p v-if="overLimit" class="notes__warn">Teksti on liian pitkä (max {{ MAX_LENGTH }} merkkiä)</p>
      <p v-if="errorMessage" class="notes__warn">{{ errorMessage }}</p>

      <div v-if="sortedNotes.length === 0" class="state">
        <span>Muistilista on tyhjä</span>
      </div>

      <ul v-else class="notes__list">
        <li v-for="note in sortedNotes" :key="note.id" class="note" :class="{ 'note--done': note.done }" data-card-row>
          <label v-if="canEdit" class="note__check">
            <input type="checkbox" :checked="note.done" @change="toggleDone(note)" />
            <span class="note__text">{{ note.text }}</span>
          </label>
          <span v-else class="note__text note__text--readonly">{{ note.text }}</span>

          <template v-if="canEdit">
            <span v-if="pendingDeleteId === note.id" class="note__confirm">
              <button
                type="button"
                class="note__confirm-btn note__confirm-btn--danger"
                @click="removeNote(note)"
              >
                Poista
              </button>
              <button type="button" class="note__confirm-btn" @click="cancelDelete">Peruuta</button>
            </span>
            <button v-else type="button" class="note__delete" aria-label="Poista" @click="askDelete(note)">
              ✕
            </button>
          </template>
        </li>
      </ul>
    </div>
  </CardShell>
</template>

<style scoped>
.notes {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  height: 100%;
  min-height: 0;
}

.notes__add {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.notes__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 1rem;
  padding: 0 0.8rem;
}

.notes__add-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1.1rem;
  background: var(--accent-school);
  border: none;
  border-radius: 10px;
  color: #0b0d12;
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
}

.notes__add-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.notes__hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-faint);
  flex-shrink: 0;
}

.notes__warn {
  margin: 0;
  font-size: 0.82rem;
  color: #f79b9b;
  flex-shrink: 0;
}

.notes__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}

.note {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 44px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.note:last-child {
  border-bottom: none;
}

.note__check {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  cursor: pointer;
}

.note__check input {
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
  accent-color: var(--accent-school);
}

.note__text {
  font-size: 0.95rem;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.note__text--readonly {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: 44px;
}

.note--done .note__text {
  text-decoration: line-through;
  color: var(--text-faint);
  opacity: 0.75;
}

.note__delete {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 1.1rem;
  cursor: pointer;
}

.note__delete:hover {
  color: #f79b9b;
}

/* Napit kertovat itse mitä tekevät ("Poista" / "Peruuta"), koska pelkkä ✓/✕
   on seinänäytöllä helppo tulkita väärin — ja väärin tulkittu poisto on
   peruuttamaton. */
.note__confirm {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

.note__confirm-btn {
  min-height: 44px;
  padding: 0 0.6rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
}

.note__confirm-btn--danger {
  border-color: rgba(247, 155, 155, 0.55);
  color: #f79b9b;
  font-weight: 600;
}
</style>
