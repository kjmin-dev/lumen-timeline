import "@lumen-timeline/timeline/style.css";
import "../shared/page.css";
import { mount } from "svelte";
import { createHost } from "../shared/browser.mjs";
import App from "./App.svelte";

const host = createHost("svelte");
mount(App, { target: document.querySelector("#app"), props: { host } });
