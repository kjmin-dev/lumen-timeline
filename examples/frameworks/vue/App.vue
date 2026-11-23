<script setup>
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watchEffect } from "vue";
import { provideTimeline, Timeline } from "@lumen-timeline/vue";
import { viewOptions } from "../shared/fixture.mjs";
import Clock from "./Clock.vue";
import Inspector from "./Inspector.vue";

const { host } = defineProps(["host"]);
const controls = shallowRef(host.controls.get());
let stop = null;
onMounted(() => {
  controls.value = host.controls.get();
  stop = host.controls.subscribe(() => {
    controls.value = host.controls.get();
  });
});
onBeforeUnmount(() => stop?.());
const pair = computed(() => host.pairs[controls.value.pair]);
const options = computed(() => viewOptions(host, controls.value));
provideTimeline(pair);
// The template ref exposes the mounted view.
const timeline = useTemplateRef("timeline");
watchEffect(() => host.setView(timeline.value?.view ?? null));
</script>

<template>
  <header class="bar">
    <strong>Lumen · Vue</strong>
    <Clock v-if="controls.panels" :host="host" />
  </header>
  <main class="workspace">
    <Timeline
      v-if="controls.timeline"
      ref="timeline"
      class="timeline"
      :editor="pair.editor"
      :transport="pair.transport"
      v-bind="options"
    />
    <Inspector v-if="controls.panels" :host="host" />
  </main>
</template>
