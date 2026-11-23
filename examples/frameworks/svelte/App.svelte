<script>
  import { setTimelineContext, timeline } from "@lumen-timeline/svelte";
  import { viewOptions } from "../shared/fixture.mjs";
  import Clock from "./Clock.svelte";
  import Inspector from "./Inspector.svelte";

  const { host } = $props();
  // The harness's controls, followed through Svelte state.
  const read = () => host.controls.get();
  let controls = $state.raw(read());
  $effect(() =>
    host.controls.subscribe(() => {
      controls = read();
    }),
  );
  const pair = $derived(host.pairs[controls.pair]);
  setTimelineContext({
    get editor() {
      return pair.editor;
    },
    get transport() {
      return pair.transport;
    },
  });
</script>

<header class="bar">
  <strong>Lumen · Svelte</strong>
  {#if controls.panels}<Clock {host} />{/if}
</header>
<main class="workspace">
  {#if controls.timeline}
    <div
      class="timeline"
      {@attach timeline(() => ({
        ...viewOptions(host, controls),
        editor: pair.editor,
        transport: pair.transport,
        onview: (view) => host.setView(view),
      }))}
    ></div>
  {/if}
  {#if controls.panels}<Inspector {host} />{/if}
</main>
