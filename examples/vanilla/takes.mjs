import { commands } from "@lumen-timeline/core";

const capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// The candidate list of the selected clip, with audition, apply, reorder and
// remove. Every change is one editor command, so undo, save and reopen cover it.
export function mountTakePanel(container, { editor, transport, words, report }) {
  const doc = container.ownerDocument;
  const events = new AbortController();
  // The panel owns its root, so a reopened project can mount the next one
  // before this one is disposed.
  const root = doc.createElement("div");
  root.innerHTML = `
    <div class="panel-head"><span class="takes-title"></span>
      <label class="takes-isolate"><input type="checkbox" /> Isolated</label></div>
    <div class="takes-body"><p class="takes-empty"></p><ol class="takes"></ol></div>
    <div class="takes-foot">
      <output class="takes-audition" aria-live="polite"></output>
      <button type="button" class="takes-stop" disabled>Stop audition</button>
    </div>`;
  container.append(root);
  const title = root.querySelector(".takes-title");
  const list = root.querySelector(".takes");
  const empty = root.querySelector(".takes-empty");
  const isolated = root.querySelector(".takes-isolate input");
  const auditionState = root.querySelector(".takes-audition");
  const stop = root.querySelector(".takes-stop");
  title.textContent = capitalized(words.takes);
  list.setAttribute("aria-label", capitalized(words.takes) + " of the selected clip");
  empty.textContent = "Select a clip that lists " + words.takes + ".";

  let clipId;
  let offClip = () => {};
  const name = (take) => take.label ?? take.id;
  const dispatch = (command) => {
    const result = editor.dispatch(command);
    report(result.ok ? "" : result.reason);
    return result;
  };

  function render() {
    const snapshot = editor.getSnapshot();
    const clip = snapshot.clips.find((c) => c.id === clipId);
    const takes = clip ? editor.read().takesOf(clip.id) : [];
    const heard = transport.snapshot().audition;
    empty.hidden = takes.length > 0;
    const rows = takes.map((take, index) => {
      const row = doc.createElement("li");
      row.dataset.take = take.id;
      const active = clip.activeTakeId === take.id;
      const playing = heard?.clipId === clip.id && heard.takeId === take.id;
      row.classList.toggle("active", active);
      const label = doc.createElement("span");
      label.className = "take-name";
      label.textContent = name(take);
      const state = doc.createElement("small");
      state.textContent = active ? "Active" : "";
      const button = (action, text, aria, disabled = false) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.dataset.action = action;
        b.textContent = text;
        b.setAttribute("aria-label", aria);
        b.disabled = disabled;
        return b;
      };
      row.append(
        label,
        state,
        button(
          "audition",
          playing ? "Stop" : "Audition",
          (playing ? "Stop " : "Audition ") + name(take),
        ),
        button("apply", "Apply", "Apply " + name(take), active),
        button("up", "↑", "Move " + name(take) + " up", index === 0),
        button("down", "↓", "Move " + name(take) + " down", index === takes.length - 1),
        button("remove", "Remove", "Remove " + name(take), active),
      );
      return row;
    });
    list.replaceChildren(...rows);
    auditionState.textContent = heard
      ? "Auditioning " +
        (heard.takeId === null
          ? words.none
          : name(
              editor
                .read()
                .takesOf(heard.clipId)
                .find((t) => t.id === heard.takeId) ?? { id: heard.takeId },
            )) +
        (heard.mode === "isolated" ? ", isolated" : "")
      : "";
    stop.disabled = !heard;
  }

  function bind() {
    offClip();
    clipId = editor.session.getSelection().at(-1);
    // The panel follows the clip's fields and the takes it lists.
    offClip = editor.subscribe((s) => {
      const clip = s.clips.find((c) => c.id === clipId);
      return (
        clip && JSON.stringify([clip.takeIds, clip.activeTakeId, editor.read(s).takesOf(clip.id)])
      );
    }, render);
    render();
  }

  async function audition(takeId) {
    const heard = transport.snapshot().audition;
    if (heard?.clipId === clipId && heard.takeId === takeId) {
      transport.cancelAudition();
      return;
    }
    try {
      const mode = isolated.checked ? "isolated" : "mix";
      const result = await transport.audition({ clipId, takeId, mode });
      report("Audition " + result + ".");
    } catch (error) {
      report(error.message);
    }
  }

  list.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      const takeId = button?.closest("li")?.dataset.take;
      if (!button || !takeId || !clipId) return;
      const ids = editor.getSnapshot().clips.find((c) => c.id === clipId)?.takeIds ?? [];
      const index = ids.indexOf(takeId);
      const swap = (other) => {
        const next = [...ids];
        [next[index], next[other]] = [next[other], next[index]];
        dispatch(commands.reorderTakes({ clipId, takeIds: next }));
      };
      const action = button.dataset.action;
      if (action === "audition") void audition(takeId);
      else if (action === "apply") dispatch(commands.selectTake({ clipId, takeId }));
      else if (action === "up") swap(index - 1);
      else if (action === "down") swap(index + 1);
      else if (action === "remove") dispatch(commands.removeTake({ clipId, takeId }));
    },
    { signal: events.signal },
  );
  stop.addEventListener("click", () => transport.cancelAudition(), { signal: events.signal });
  const offSelection = editor.session.subscribeSelection(bind);
  // Audition state changes rarely; skip playback frames.
  let lastAudition = transport.snapshot().audition;
  const offTransport = transport.subscribe((state) => {
    if (state.audition === lastAudition) return;
    lastAudition = state.audition;
    render();
  });
  bind();
  return () => {
    events.abort();
    offClip();
    offSelection();
    offTransport();
    root.remove();
  };
}
