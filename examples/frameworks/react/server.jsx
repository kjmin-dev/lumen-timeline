import { renderToString } from "react-dom/server";
import { App } from "./App.jsx";

export function render(host) {
  return renderToString(<App host={host} />);
}
