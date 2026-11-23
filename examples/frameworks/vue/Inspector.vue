<script setup>
import { computed, watch } from "vue";
import { useEditorSelector, useTimelineContext } from "@lumen-timeline/vue";
import { chooseTake, inspectorField, sameInspector } from "../shared/fixture.mjs";

const { host } = defineProps(["host"]);
const context = useTimelineContext();
const field = useEditorSelector(
  () => context.value.editor,
  (state) => inspectorField(context.value.editor)(state),
  sameInspector,
);
watch(field, () => host.counts.inspector++, { immediate: true });
const active = computed(
  () => field.value?.takes.find((take) => take.id === field.value.takeId)?.label ?? "none",
);
</script>

<template>
  <aside class="inspector" aria-label="Take inspector">
    <template v-if="field">
      <h2>{{ field.name }}</h2>
      <p>Active: {{ active }}</p>
      <button
        v-for="take in field.takes"
        :key="take.id"
        type="button"
        :data-take="take.id"
        :aria-pressed="String(take.id === field.takeId)"
        @click="chooseTake(context.editor, field.clipId, take.id)"
      >
        {{ take.label }}
      </button>
    </template>
    <template v-else>
      <h2>No clip selected</h2>
      <p>Select a clip to choose its take.</p>
    </template>
  </aside>
</template>
