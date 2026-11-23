import { render as renderApp } from "svelte/server";
import App from "./App.svelte";

export function render(host) {
  return renderApp(App, { props: { host } }).body;
}
