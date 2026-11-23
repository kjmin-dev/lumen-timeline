import assert from "node:assert/strict";
import test from "node:test";
import {
  gainText,
  inkOn,
  mixHex,
  nameRow,
  resolveChrome,
  resolveTheme,
  resolveUiLabels,
  rgba,
  sameTheme,
  takeLanesHeight,
} from "@lumen-timeline/timeline/internal";

test("the dark scheme is the default, and the light scheme swaps every built-in color", () => {
  const dark = resolveTheme();
  assert.equal(dark.scheme, "dark");
  assert.deepEqual(resolveTheme({ scheme: "dark" }), dark);
  const light = resolveTheme({ scheme: "light" });
  assert.equal(light.scheme, "light");
  assert.equal(sameTheme(dark, light), false);
  assert.equal(sameTheme(light, resolveTheme({ scheme: "light" })), true);
  // Vivid clips with dark waveforms on dark; tinted clips with saturated ones on light.
  assert.deepEqual(
    [dark.rowEvenHex, dark.selectionStroke, dark.palette[0]?.fillHex, dark.palette[0]?.textHex],
    ["#090a0c", "#ffffff", "#4cd7c8", "#0c0e11"],
  );
  assert.deepEqual(
    [light.rowEvenHex, light.selectionStroke, light.palette[0]?.fillHex, light.palette[0]?.textHex],
    ["#ffffff", "#9c4b1e", "#d8f1ec", "#0b4a40"],
  );
  assert.equal(dark.palette.length, 3);
  assert.equal(light.locked.fillHex, "#e9edec");
  // Grid lines are off until a theme asks for them.
  assert.equal(dark.grid >>> 24, 0);
  assert.equal(resolveTheme({ grid: "#334455" }).grid, rgba("#334455"));
});

test("single theme fields override the scheme, and palette entries fill in what they leave out", () => {
  const theme = resolveTheme({
    scheme: "light",
    rowEven: "#101010",
    selectionStroke: "#ff0000",
    palette: [{ fill: "#102030", stripe: "#a0b0c0" }],
    locked: { fill: "#eeeeee", stripe: "#777777", text: "#123456" },
  });
  assert.equal(theme.rowEvenHex, "#101010");
  assert.equal(theme.rowOddHex, "#ffffff");
  // The handles and the ghost outline follow the selection color.
  assert.deepEqual([theme.handleFill, theme.ghostStroke], ["#ff0000", "#ff0000"]);
  const [entry] = theme.palette;
  assert.ok(entry);
  // No waveform: the accent at 40%. No text: an ink that reads on the fill.
  assert.equal(entry.waveform, rgba("#a0b0c0", 0x66));
  assert.equal(entry.textHex, "#f4f6f7");
  assert.equal(theme.locked.textHex, "#123456");
  assert.equal(sameTheme(theme, resolveTheme({ scheme: "light" })), false);
  // An empty palette keeps the scheme's.
  assert.equal(resolveTheme({ palette: [] }).palette.length, 3);
});

test("inks and mixes", () => {
  assert.equal(inkOn("#ffffff"), "#0c0e11");
  assert.equal(inkOn("#f9a870"), "#0c0e11");
  assert.equal(inkOn("#123456"), "#f4f6f7");
  assert.equal(inkOn("not a color"), "#f4f6f7");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#204060", "#ffffff", 0), "#204060");
  assert.equal(mixHex("nope", "#ffffff", 0.5), "nope");
});

test("the new chrome is on by default, and off in the minimal and bare presets", () => {
  const keys = ["history", "snapToggle", "clipToolbar", "takeLanes", "trackControls"] as const;
  const on = resolveChrome();
  const minimal = resolveChrome("minimal");
  const bare = resolveChrome(false);
  for (const key of keys) {
    assert.equal(on[key], true, key);
    assert.equal(minimal[key], false, key);
    assert.equal(bare[key], false, key);
  }
  assert.equal(resolveChrome({ takeLanes: false }).takeLanes, false);
  assert.equal(resolveChrome({ takeLanes: false }).clipToolbar, true);
});

test("the new labels have English defaults", () => {
  const labels = resolveUiLabels({ takeLanes: "Versions" });
  assert.deepEqual(
    [
      labels.snap,
      labels.split,
      labels.takeLanes,
      labels.mute,
      labels.solo,
      labels.locked,
      labels.audition,
    ],
    ["Snap", "Split", "Versions", "Mute", "Solo", "Locked", "Audition"],
  );
});

test("a gain reads in decibels", () => {
  assert.equal(gainText(undefined), "0.0 dB");
  assert.equal(gainText(1), "0.0 dB");
  assert.equal(gainText(0.5), "−6.0 dB");
  assert.equal(gainText(2), "6.0 dB");
  assert.equal(gainText(0.999999), "0.0 dB");
  assert.equal(gainText(0), "−∞ dB");
});

test("row metrics: take lanes add 26 px each, and short clips lose the name row", () => {
  assert.deepEqual([takeLanesHeight(0), takeLanesHeight(1), takeLanesHeight(3)], [0, 28, 80]);
  assert.deepEqual([nameRow(44), nameRow(40), nameRow(31), nameRow(29)], [19, 19, 16, 0]);
});
