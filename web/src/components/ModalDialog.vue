<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
let previousOverflow = '';
onMounted(() => {
  previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.documentElement.style.overflow = previousOverflow;
});
</script>
<template>
  <dialog ref="dialog" class="modal" :aria-label="label" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <slot />
  </dialog>
</template>
<style scoped>
.modal { border: 0; padding: 1.5rem; margin: 0; inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: none; box-sizing: border-box; color: var(--text); background: transparent; }
.modal[open] { display: flex; align-items: center; justify-content: center; }
.modal::backdrop { background: rgba(4, 6, 10, .78); backdrop-filter: blur(6px); }
@media (max-width: 600px) { .modal { padding: .6rem; } }
</style>
