import "@lumen-timeline/timeline/style.css";
import "../shared/page.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHost } from "../shared/browser.mjs";
import { App } from "./App.jsx";

const host = createHost("react");
createRoot(document.querySelector("#app")).render(
  <StrictMode>
    <App host={host} />
  </StrictMode>,
);
