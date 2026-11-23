import "@lumen-timeline/timeline/style.css";
import "../shared/page.css";
import { render } from "@solidjs/web";
import { createHost } from "../shared/browser.mjs";
import { App } from "./App.jsx";

const host = createHost("solid");
render(() => <App host={host} />, document.querySelector("#app"));
