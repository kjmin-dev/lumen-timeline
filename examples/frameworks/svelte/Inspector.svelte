<script>
  import { untrack } from "svelte";
  import { editorSelector, getTimelineContext } from "@lumen-timeline/svelte";
  import { chooseTake, inspectorField, sameInspector } from "../shared/fixture.mjs";

  const { host } = $props();
  const context = getTimelineContext();
  const field = editorSelector(
    () => context.editor,
    (state) => inspectorField(context.editor)(state),
    sameInspector,
  );
  // Counts each value the panel receives.
  const count = () => untrack(() => host.counts.inspector++);
  $effect(() => count(field.current));
</script>

<aside class="inspector" aria-label="Take inspector">
  {#if field.current}
    {@const clip = field.current}
    <h2>{clip.name}</h2>
    <p>Active: {clip.takes.find((take) => take.id === clip.takeId)?.label ?? "none"}</p>
    {#each clip.takes as take (take.id)}
      <button
        type="button"
        data-take={take.id}
        aria-pressed={String(take.id === clip.takeId)}
        onclick={() => chooseTake(context.editor, clip.clipId, take.id)}>{take.label}</button
      >
    {/each}
  {:else}
    <h2>No clip selected</h2>
    <p>Select a clip to choose its take.</p>
  {/if}
</aside>
