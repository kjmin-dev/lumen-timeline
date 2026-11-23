import "@lumen-timeline/timeline/style.css";
import "../shared/page.css";
import { createApp } from "vue";
import { createHost } from "../shared/browser.mjs";
import App from "./App.vue";

const host = createHost("vue");
createApp(App, { host }).mount("#app");
