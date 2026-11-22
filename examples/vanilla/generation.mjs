import { commands, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

// The studio.generation plugin. The core knows nothing of it: a line's text
// lives in entity data, each generated take records the request that made it
// in its extensions, and results that no longer fit stay in a host job log.

/** The take extension that records a generation request. */
export const generation = "studio.generation";
/** The entity data scope of line text: `source`, `text` and its `revision`. */
export const lines = "studio.line";

/** The line a clip carries, or `undefined`. A split copies `lineId` to both halves. */
export function lineOf(snapshot, clipId) {
  const clip = snapshot.clips.find((c) => c.id === clipId);
  const fields = clip?.lineId && snapshot.entityData?.[lines]?.[clip.lineId];
  return fields ? { lineId: clip.lineId, ...fields } : undefined;
}

/**
 * The simulated host generator: audio derived only from the request, so the
 * same request always yields the same samples. A reopened project rebuilds a
 * generated take's asset from the request in its extensions.
 */
export function synthesize(context, request) {
  const rate = context.sampleRate;
  const seconds = (request.out - request.in) / hz;
  const buffer = context.createBuffer(1, Math.max(1, Math.round(seconds * rate)), rate);
  const samples = buffer.getChannelData(0);
  const words = request.text.split(/\s+/).filter(Boolean);
  const span = samples.length / Math.max(1, words.length);
  for (const [w, word] of words.entries()) {
    let code = 0;
    for (const char of word) code = (code * 31 + char.codePointAt(0)) % 997;
    const pitch = 180 + (code % 23) * 9 + request.number * 3;
    const from = Math.floor(w * span);
    const to = Math.floor((w + 0.8) * span);
    for (let i = from; i < to && i < samples.length; i++) {
      const t = (i - from) / rate;
      const envelope = Math.min(1, t * 40, ((to - i) / rate) * 40);
      samples[i] = Math.sin(2 * Math.PI * pitch * t) * 0.15 * envelope;
    }
  }
  return buffer;
}

/**
 * Generates takes for clips through a host generator. `generate(clipId)`
 * snapshots the clip's line and content range, waits for the generator, then
 * commits the new candidate only if the line's text revision and the clip's
 * line are still those of the request. Either way the job stays in `jobs()`.
 */
export function createGeneration({ editor, context, assets, transport }) {
  const jobs = [];
  const listeners = new Set();
  // Requests in saved takes continue the numbering and rebuild their assets.
  let count = 0;
  for (const take of editor.getSnapshot().takes ?? []) {
    const request = take.extensions?.[generation]?.request;
    if (!request) continue;
    count = Math.max(count, request.number);
    assets.register(take.assetId, synthesize(context, request));
  }
  transport.setCatalog(assets.catalog);
  const notify = () => {
    for (const listener of listeners) listener(jobs);
  };
  const plugin = {
    /** Milliseconds the simulated generator takes. */
    latency: 400,
    jobs: () => jobs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async generate(clipId) {
      const snapshot = editor.getSnapshot();
      const clip = snapshot.clips.find((c) => c.id === clipId);
      const line = lineOf(snapshot, clipId);
      if (!clip || !line) throw new Error("Select a clip that carries a line");
      const number = ++count;
      const request = Object.freeze({
        number,
        clipId,
        lineId: line.lineId,
        text: line.text,
        revision: line.revision,
        in: clip.contentIn,
        out: clip.contentIn + clip.duration,
      });
      const job = { number, clipId, request, status: "pending" };
      jobs.unshift(job);
      notify();
      await new Promise((resolve) => setTimeout(resolve, plugin.latency));
      const assetId = "generated-" + number;
      transport.setCatalog(assets.register(assetId, synthesize(context, request)));
      // The generated audio starts at the requested content point.
      const result = editor.dispatch([
        commands.expectData({
          scope: lines,
          id: line.lineId,
          key: "revision",
          value: line.revision,
        }),
        commands.expectClip({ clipId, fields: { lineId: line.lineId } }),
        commands.addTake({
          clipIds: [clipId],
          take: {
            assetId,
            streamId: "mono",
            sourceAtContentZero: -request.in,
            label: "Generated " + number,
            extensions: { [generation]: { request } },
          },
        }),
      ]);
      job.assetId = assetId;
      if (result.ok) {
        job.status = "applied";
        job.takeId = result.takePatches[0]?.id;
      } else {
        job.status = "rejected";
        job.reason =
          result.code === "expectation-failed"
            ? "The line changed after the request"
            : result.reason;
      }
      notify();
      return job;
    },
  };
  return plugin;
}

/** Saves a line's text and advances its revision in one edit. */
export function editLine(editor, lineId, text) {
  const line = editor.getSnapshot().entityData?.[lines]?.[lineId];
  return editor.dispatch([
    commands.setEntityData({ scope: lines, id: lineId, key: "text", value: text }),
    commands.setEntityData({
      scope: lines,
      id: lineId,
      key: "revision",
      value: (line?.revision ?? 0) + 1,
    }),
  ]);
}

// The selected clip's line in both languages, the generate action and the job
// log. Mounted below the timeline, so its changing height moves nothing above.
export function mountLinePanel(container, { editor, plugin, words, report }) {
  const doc = container.ownerDocument;
  const events = new AbortController();
  const root = doc.createElement("div");
  root.className = "line-panel";
  root.innerHTML = `
    <div class="line-edit">
      <div class="panel-head">Line <small class="line-id"></small></div>
      <p class="line-source" lang="fr"></p>
      <form>
        <label>Line text <textarea rows="2" lang="en"></textarea></label>
        <div class="line-actions">
          <button type="submit">Save text</button>
          <button type="button" class="line-generate"></button>
        </div>
      </form>
    </div>
    <div class="line-jobs">
      <div class="panel-head">Generation jobs</div>
      <ol aria-label="Generation jobs"></ol>
    </div>`;
  container.append(root);
  const id = root.querySelector(".line-id");
  const source = root.querySelector(".line-source");
  const form = root.querySelector("form");
  const text = root.querySelector("textarea");
  const generate = root.querySelector(".line-generate");
  const log = root.querySelector("ol");
  generate.textContent = "Generate " + words.take;
  let clipId;
  let off = () => {};

  function show() {
    const line = lineOf(editor.getSnapshot(), clipId);
    id.textContent = line ? line.lineId + " · revision " + line.revision : "";
    source.textContent = line?.source ?? "Select a clip that carries a line.";
    if (text.dataset.line !== line?.lineId || doc.activeElement !== text)
      text.value = line?.text ?? "";
    text.dataset.line = line?.lineId ?? "";
    text.disabled = generate.disabled = !line;
    form.querySelector("[type=submit]").disabled = !line;
  }
  function bind() {
    off();
    clipId = editor.session.getSelection().at(-1);
    off = editor.subscribe((s) => JSON.stringify(lineOf(s, clipId) ?? null), show);
    show();
  }
  function jobs(list) {
    log.replaceChildren(
      ...list.map((job) => {
        const item = doc.createElement("li");
        item.dataset.status = job.status;
        const detail =
          job.status === "applied"
            ? "added " + (job.takeId ?? "")
            : job.status === "rejected"
              ? job.reason
              : "pending";
        item.textContent =
          "#" + job.number + " " + job.clipId + " · " + job.status + " · " + detail;
        return item;
      }),
    );
  }
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const line = lineOf(editor.getSnapshot(), clipId);
      if (!line) return;
      const result = editLine(editor, line.lineId, text.value);
      report(result.ok ? "" : result.reason);
    },
    { signal: events.signal },
  );
  generate.addEventListener(
    "click",
    async () => {
      try {
        const job = await plugin.generate(clipId);
        report(
          job.status === "applied"
            ? "Generated " + job.number + " added."
            : "Generation " + job.number + " rejected: " + job.reason + ".",
        );
      } catch (error) {
        report(error.message);
      }
    },
    { signal: events.signal },
  );
  const offSelection = editor.session.subscribeSelection(bind);
  const offJobs = plugin.subscribe(jobs);
  bind();
  jobs(plugin.jobs());
  return () => {
    events.abort();
    off();
    offSelection();
    offJobs();
    root.remove();
  };
}
