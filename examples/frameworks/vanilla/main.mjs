// The vanilla consumer: the same page as the framework consumers, built from
// the packages' public exports with no framework. It is the reference the suite
// compares every wrapper with.
import "@lumen-timeline/timeline/style.css";
import "../shared/page.css";
import { watchEditor, watchSelect, watchSnapshots } from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import { createHost } from "../shared/browser.mjs";
import {
  chooseTake,
  clockField,
  clockText,
  inspectorField,
  sameInspector,
  viewOptions,
} from "../shared/fixture.mjs";

const host = createHost("vanilla");
const app = document.querySelector("#app");
const bar = document.createElement("header");
bar.className = "bar";
bar.innerHTML = "<strong>Lumen · vanilla</strong>";
const main = document.createElement("main");
main.className = "workspace";
app.append(bar, main);

function renderInspector(aside, field, editor) {
  aside.replaceChildren();
  const title = document.createElement("h2");
  const line = document.createElement("p");
  aside.append(title, line);
  if (!field) {
    title.textContent = "No clip selected";
    line.textContent = "Select a clip to choose its take.";
    return;
  }
  title.textContent = field.name;
  line.textContent = "Active: " + (field.takes.find((t) => t.id === field.takeId)?.label ?? "none");
  for (const take of field.takes) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.take = take.id;
    button.setAttribute("aria-pressed", String(take.id === field.takeId));
    button.textContent = take.label;
    button.addEventListener("click", () => chooseTake(editor, field.clipId, take.id));
    aside.append(button);
  }
}

function mountPanels(editor, transport) {
  const clock = document.createElement("output");
  clock.className = "clock";
  bar.append(clock);
  const aside = document.createElement("aside");
  aside.className = "inspector";
  aside.setAttribute("aria-label", "Take inspector");
  main.append(aside);
  const inspector = watchSelect(watchEditor(editor), inspectorField(editor), sameInspector);
  const tenths = watchSelect(watchSnapshots(transport), clockField);
  const showInspector = () => {
    host.counts.inspector++;
    renderInspector(aside, inspector.get(), editor);
  };
  const showClock = () => {
    host.counts.clock++;
    clock.textContent = clockText(tenths.get());
  };
  const offs = [inspector.subscribe(showInspector), tenths.subscribe(showClock)];
  showInspector();
  showClock();
  return () => {
    for (const off of offs) off();
    clock.remove();
    aside.remove();
  };
}

let mounted = null;
let panels = null;
function sync() {
  const state = host.controls.get();
  const { editor, transport } = host.pairs[state.pair];
  const { renderer, ...options } = viewOptions(host, state);
  const stale = mounted && (mounted.editor !== editor || mounted.transport !== transport);
  if (mounted && (!state.timeline || stale || mounted.renderer !== renderer)) {
    mounted.view.dispose();
    mounted.element.remove();
    host.setView(null);
    mounted = null;
  }
  if (state.timeline && !mounted) {
    const element = document.createElement("div");
    element.className = "timeline";
    main.prepend(element);
    const view = mountTimeline(element, { editor, transport, renderer, ...options });
    mounted = { view, element, editor, transport, renderer };
    host.setView(view);
  } else mounted?.view.update(options);
  if (panels && (!state.panels || panels.editor !== editor)) {
    panels.stop();
    panels = null;
  }
  if (state.panels && !panels) panels = { editor, stop: mountPanels(editor, transport) };
}
host.controls.subscribe(sync);
sync();
