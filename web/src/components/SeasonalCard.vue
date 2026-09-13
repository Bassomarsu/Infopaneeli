<script setup lang="ts">
import CardShell from './CardShell.vue';
import HouseholdList from './HouseholdList.vue';
import type { HouseholdData } from '../household.ts';
defineProps<{household:HouseholdData;canEdit:boolean}>();
const emit=defineEmits<{refresh:[]}>();
</script>
<template><CardShell title="Kausimuistutukset" status="ok" accent="var(--accent-calendar)"><HouseholdList :household="household" :can-edit="canEdit" kind="seasonal" @refresh="emit('refresh')" /></CardShell></template>
