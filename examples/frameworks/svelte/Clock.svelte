<script>
  import { untrack } from "svelte";
  import { getTimelineContext, transportSelector } from "@lumen-timeline/svelte";
  import { clockField, clockText } from "../shared/fixture.mjs";

  const { host } = $props();
  const context = getTimelineContext();
  const tenths = transportSelector(() => context.transport, clockField);
  // Counts each value the panel receives.
  const count = () => untrack(() => host.counts.clock++);
  $effect(() => count(tenths.current));
</script>

<output class="clock">{clockText(tenths.current)}</output>
