<script setup>
import { watch } from "vue";
import { useTimelineContext, useTransportSelector } from "@lumen-timeline/vue";
import { clockField, clockText } from "../shared/fixture.mjs";

const { host } = defineProps(["host"]);
const context = useTimelineContext();
const tenths = useTransportSelector(() => context.value.transport, clockField);
watch(tenths, () => host.counts.clock++, { immediate: true });
</script>

<template>
  <output class="clock">{{ clockText(tenths) }}</output>
</template>
