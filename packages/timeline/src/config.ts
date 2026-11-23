import { laneHeight as defaultLaneHeight, rowInset as defaultRowInset } from "./geometry.ts";
import { inkOn, mixHex, rgba } from "./layout.ts";
import type { Rgba } from "./layout.ts";
import type {
  TimelineChrome,
  TimelineChromeOption,
  TimelineLabels,
  TimelineLayoutOptions,
  TimelineTheme,
  TimelineTrackColors,
} from "./types.ts";

export type ResolvedChrome = { readonly [K in keyof TimelineChrome]-?: boolean };

const chromeKeys = [
  "toolbar",
  "ruler",
  "trackHeaders",
  "scrollBar",
  "markerEditor",
  "editToolbar",
  "status",
  "clipNavigator",
  "markerNavigator",
  "trackRename",
  "trackReorder",
  "history",
  "snapToggle",
  "clipToolbar",
  "takeLanes",
  "trackControls",
] as const satisfies readonly (keyof TimelineChrome)[];

function everyChrome(value: (key: keyof TimelineChrome) => boolean): ResolvedChrome {
  return {
    toolbar: value("toolbar"),
    ruler: value("ruler"),
    trackHeaders: value("trackHeaders"),
    scrollBar: value("scrollBar"),
    markerEditor: value("markerEditor"),
    editToolbar: value("editToolbar"),
    status: value("status"),
    clipNavigator: value("clipNavigator"),
    markerNavigator: value("markerNavigator"),
    trackRename: value("trackRename"),
    trackReorder: value("trackReorder"),
    history: value("history"),
    snapToggle: value("snapToggle"),
    clipToolbar: value("clipToolbar"),
    takeLanes: value("takeLanes"),
    trackControls: value("trackControls"),
  };
}

export function resolveChrome(option?: TimelineChromeOption): ResolvedChrome {
  if (option === false) return everyChrome(() => false);
  if (option === "minimal") return everyChrome((key) => key === "ruler" || key === "trackHeaders");
  return everyChrome((key) => option?.[key] ?? true);
}

export function sameChrome(a: ResolvedChrome, b: ResolvedChrome): boolean {
  return chromeKeys.every((key) => a[key] === b[key]);
}

type UiLabelKey = Exclude<keyof TimelineLabels, "take" | "takes" | "none">;
export type ResolvedUiLabels = { readonly [K in UiLabelKey]: string };

const defaultUiLabels: ResolvedUiLabels = {
  play: "Play",
  pause: "Pause",
  tracks: "Tracks",
  clip: "Clip",
  selectClip: "Select clip",
  marker: "Marker",
  selectMarker: "Select marker",
  addMarker: "Add marker",
  markerLabel: "Marker label",
  renameMarker: "Rename marker",
  removeMarker: "Remove marker",
  scroll: "Scroll",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  operation: "Operation",
  move: "Move",
  trimStart: "Trim start",
  trimEnd: "Trim end",
  delta: "Delta (s)",
  apply: "Apply",
  splitAtPlayhead: "Split at playhead",
  undo: "Undo",
  redo: "Redo",
  trackName: "Track name",
  reorderTrack: "Drag to reorder",
  trackMoved: "{name} moved to position {position} of {count}",
  snap: "Snap",
  split: "Split",
  takeLanes: "Takes",
  mute: "Mute",
  solo: "Solo",
  locked: "Locked",
  audition: "Audition",
};

const uiLabelKeys: readonly UiLabelKey[] = [
  "play",
  "pause",
  "tracks",
  "clip",
  "selectClip",
  "marker",
  "selectMarker",
  "addMarker",
  "markerLabel",
  "renameMarker",
  "removeMarker",
  "scroll",
  "zoomIn",
  "zoomOut",
  "operation",
  "move",
  "trimStart",
  "trimEnd",
  "delta",
  "apply",
  "splitAtPlayhead",
  "undo",
  "redo",
  "trackName",
  "reorderTrack",
  "trackMoved",
  "snap",
  "split",
  "takeLanes",
  "mute",
  "solo",
  "locked",
  "audition",
];

export function resolveUiLabels(labels: TimelineLabels = {}): ResolvedUiLabels {
  const text = (key: UiLabelKey): string => labels[key] ?? defaultUiLabels[key];
  return {
    play: text("play"),
    pause: text("pause"),
    tracks: text("tracks"),
    clip: text("clip"),
    selectClip: text("selectClip"),
    marker: text("marker"),
    selectMarker: text("selectMarker"),
    addMarker: text("addMarker"),
    markerLabel: text("markerLabel"),
    renameMarker: text("renameMarker"),
    removeMarker: text("removeMarker"),
    scroll: text("scroll"),
    zoomIn: text("zoomIn"),
    zoomOut: text("zoomOut"),
    operation: text("operation"),
    move: text("move"),
    trimStart: text("trimStart"),
    trimEnd: text("trimEnd"),
    delta: text("delta"),
    apply: text("apply"),
    splitAtPlayhead: text("splitAtPlayhead"),
    undo: text("undo"),
    redo: text("redo"),
    trackName: text("trackName"),
    reorderTrack: text("reorderTrack"),
    trackMoved: text("trackMoved"),
    snap: text("snap"),
    split: text("split"),
    takeLanes: text("takeLanes"),
    mute: text("mute"),
    solo: text("solo"),
    locked: text("locked"),
    audition: text("audition"),
  };
}

export function sameUiLabels(a: ResolvedUiLabels, b: ResolvedUiLabels): boolean {
  return uiLabelKeys.every((key) => a[key] === b[key]);
}

export interface ResolvedLayout {
  readonly laneHeight: number;
  readonly rowInset: number;
}

export function resolveLayout(layout?: TimelineLayoutOptions): ResolvedLayout {
  const laneHeight = layout?.laneHeight ?? defaultLaneHeight;
  const rowInset = layout?.rowInset ?? defaultRowInset;
  if (!Number.isFinite(laneHeight) || laneHeight < 16 || !Number.isFinite(rowInset) || rowInset < 0)
    throw new RangeError("Invalid timeline layout configuration");
  return { laneHeight, rowInset };
}

export function sameLayout(a: ResolvedLayout, b: ResolvedLayout): boolean {
  return a.laneHeight === b.laneHeight && a.rowInset === b.rowInset;
}

export interface ResolvedTrackColors {
  readonly fillHex: string;
  readonly stripeHex: string;
  readonly waveformHex: string;
  /** The clip name's color. */
  readonly textHex: string;
  readonly fill: Rgba;
  readonly stripe: Rgba;
  readonly waveform: Rgba;
}

export type ColorScheme = "light" | "dark";

export interface ResolvedTheme {
  readonly scheme: ColorScheme;
  readonly rowEvenHex: string;
  readonly rowOddHex: string;
  readonly gridHex: string;
  readonly rowEven: Rgba;
  readonly rowOdd: Rgba;
  readonly grid: Rgba;
  /** The band that holds a track's take lanes, and the hairline above it. */
  readonly drawer: Rgba;
  readonly drawerLine: Rgba;
  readonly selectionStroke: string;
  readonly handleFill: string;
  readonly ghostFill: string;
  readonly ghostStroke: string;
  readonly marker: string;
  readonly rulerText: string;
  /** The text of a marker flag, or `undefined` for whichever ink reads on the flag. */
  readonly rulerMarkerBackground: string | undefined;
  /** One color for every clip name, or `undefined` for each palette entry's own. */
  readonly labelColor: string | undefined;
  readonly nameFont: string;
  readonly captionFont: string;
  readonly rulerFont: string;
  readonly markerFont: string;
  readonly palette: readonly ResolvedTrackColors[];
  readonly locked: ResolvedTrackColors;
}

interface Preset {
  readonly lane: string;
  readonly selection: string;
  readonly ghostFill: string;
  readonly marker: string;
  readonly rulerText: string;
  readonly palette: readonly TimelineTrackColors[];
  readonly locked: TimelineTrackColors;
}

const ink = "#0c0e11";
const presets: { readonly [K in ColorScheme]: Preset } = {
  dark: {
    lane: "#090a0c",
    selection: "#ffffff",
    ghostFill: "#ffffff26",
    marker: "#e9ecef",
    rulerText: "#808a96",
    palette: [
      { fill: "#4cd7c8", stripe: "#4cd7c8", waveform: "#004942", text: ink },
      { fill: "#f9a870", stripe: "#f9a870", waveform: "#593215", text: ink },
      { fill: "#c3aeff", stripe: "#c3aeff", waveform: "#40355e", text: ink },
    ],
    locked: { fill: "#999fa6", stripe: "#999fa6", waveform: "#3e4349", text: ink },
  },
  light: {
    lane: "#ffffff",
    selection: "#9c4b1e",
    ghostFill: "#9c4b1e24",
    marker: "#9c4b1e",
    rulerText: "#5f6e72",
    palette: [
      { fill: "#d8f1ec", stripe: "#1a8f7d", waveform: "#2fa392", text: "#0b4a40" },
      { fill: "#fde6d6", stripe: "#d9783a", waveform: "#e08548", text: "#5a2a0c" },
      { fill: "#e9e4ff", stripe: "#7a66de", waveform: "#8b78e6", text: "#2d2175" },
    ],
    locked: { fill: "#e9edec", stripe: "#8a999d", waveform: "#9aa7ab", text: "#2a3336" },
  },
};

function resolveColors(entry: TimelineTrackColors): ResolvedTrackColors {
  const waveHex = entry.waveform ?? entry.stripe;
  return {
    fillHex: entry.fill,
    stripeHex: entry.stripe,
    waveformHex: waveHex,
    textHex: entry.text ?? inkOn(entry.fill),
    fill: rgba(entry.fill),
    stripe: rgba(entry.stripe),
    waveform: entry.waveform ? rgba(entry.waveform) : rgba(entry.stripe, 0x66),
  };
}

export function resolveTheme(theme: TimelineTheme = {}): ResolvedTheme {
  const scheme: ColorScheme = theme.scheme === "light" ? "light" : "dark";
  const preset = presets[scheme];
  const rowEvenHex = theme.rowEven ?? preset.lane;
  const rowOddHex = theme.rowOdd ?? preset.lane;
  const gridHex = theme.grid ?? "#00000000";
  const toward = scheme === "dark" ? "#ffffff" : "#000000";
  const paletteInput = theme.palette && theme.palette.length > 0 ? theme.palette : preset.palette;
  return {
    scheme,
    rowEvenHex,
    rowOddHex,
    gridHex,
    rowEven: rgba(rowEvenHex),
    rowOdd: rgba(rowOddHex),
    grid: rgba(gridHex),
    drawer: rgba(mixHex(rowEvenHex, toward, 0.035)),
    drawerLine: rgba(mixHex(rowEvenHex, toward, 0.12)),
    selectionStroke: theme.selectionStroke ?? preset.selection,
    handleFill: theme.handleFill ?? theme.selectionStroke ?? preset.selection,
    ghostFill: theme.ghostFill ?? preset.ghostFill,
    ghostStroke: theme.ghostStroke ?? theme.selectionStroke ?? preset.selection,
    marker: theme.marker ?? preset.marker,
    rulerText: theme.rulerText ?? preset.rulerText,
    rulerMarkerBackground: theme.rulerMarkerBackground,
    labelColor: theme.labelColor,
    nameFont: theme.nameFont ?? "600 11.5px system-ui, sans-serif",
    captionFont: theme.captionFont ?? "10.5px system-ui, sans-serif",
    rulerFont: theme.rulerFont ?? "10px ui-monospace, SFMono-Regular, Menlo, monospace",
    markerFont: theme.markerFont ?? "700 10px system-ui, sans-serif",
    palette: paletteInput.map(resolveColors),
    locked: resolveColors(theme.locked ?? preset.locked),
  };
}

export function sameAtlasTheme(a: ResolvedTheme, b: ResolvedTheme): boolean {
  return a.nameFont === b.nameFont && a.captionFont === b.captionFont;
}

const sameColors = (a: ResolvedTrackColors, b: ResolvedTrackColors | undefined): boolean =>
  b !== undefined &&
  a.fillHex === b.fillHex &&
  a.stripeHex === b.stripeHex &&
  a.waveformHex === b.waveformHex &&
  a.textHex === b.textHex &&
  a.waveform === b.waveform;

export function sameTheme(a: ResolvedTheme, b: ResolvedTheme): boolean {
  return (
    a.scheme === b.scheme &&
    a.rowEvenHex === b.rowEvenHex &&
    a.rowOddHex === b.rowOddHex &&
    a.gridHex === b.gridHex &&
    a.selectionStroke === b.selectionStroke &&
    a.handleFill === b.handleFill &&
    a.ghostFill === b.ghostFill &&
    a.ghostStroke === b.ghostStroke &&
    a.marker === b.marker &&
    a.rulerText === b.rulerText &&
    a.rulerMarkerBackground === b.rulerMarkerBackground &&
    a.labelColor === b.labelColor &&
    a.rulerFont === b.rulerFont &&
    a.markerFont === b.markerFont &&
    sameAtlasTheme(a, b) &&
    a.palette.length === b.palette.length &&
    a.palette.every((entry, index) => sameColors(entry, b.palette[index])) &&
    sameColors(a.locked, b.locked)
  );
}
