import { renderToString } from "@solidjs/web";
import { App } from "./App.jsx";

export function render(host) {
  return renderToString(() => <App host={host} />);
}
