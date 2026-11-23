import { laneHeight as defaultLaneHeight, rowInset as defaultRowInset } from "./geometry.ts";
import { rgba } from "./layout.ts";
import type { Rgba } from "./layout.ts";
import type {
  TimelineChromeOption,
  TimelineLabels,
  TimelineLayoutOptions,
  TimelineTheme,
  TimelineTrackColors,
} from "./types.ts";

export interface ResolvedChrome {
  readonly toolbar: boolean;
  readonly ruler: boolean;
  readonly trackHeaders: boolean;
  readonly scrollBar: boolean;
  readonly markerEditor: boolean;
  readonly editToolbar: boolean;
  readonly status: boolean;
  readonly clipNavigator: boolean;
  readonly markerNavigator: boolean;
  readonly trackRename: boolean;
  readonly trackReorder: boolean;
}

export function resolveChrome(option?: TimelineChromeOption): ResolvedChrome {
  if (option === false) {
    return {
      toolbar: false,
      ruler: false,
      trackHeaders: false,
      scrollBar: false,
      markerEditor: false,
      editToolbar: false,
      status: false,
      clipNavigator: false,
      markerNavigator: false,
      trackRename: false,
      trackReorder: false,
    };
  }
  if (option === "minimal") {
    return {
      toolbar: false,
      ruler: true,
      trackHeaders: true,
      scrollBar: false,
      markerEditor: false,
      editToolbar: false,
      status: false,
      clipNavigator: false,
      markerNavigator: false,
      trackRename: false,
      trackReorder: false,
    };
  }
  return {
    toolbar: option?.toolbar ?? true,
    ruler: option?.ruler ?? true,
    trackHeaders: option?.trackHeaders ?? true,
    scrollBar: option?.scrollBar ?? true,
    markerEditor: option?.markerEditor ?? true,
    editToolbar: option?.editToolbar ?? true,
    status: option?.status ?? true,
    clipNavigator: option?.clipNavigator ?? true,
    markerNavigator: option?.markerNavigator ?? true,
    trackRename: option?.trackRename ?? true,
    trackReorder: option?.trackReorder ?? true,
  };
}

export function sameChrome(a: ResolvedChrome, b: ResolvedChrome): boolean {
  return (
    a.toolbar === b.toolbar &&
    a.ruler === b.ruler &&
    a.trackHeaders === b.trackHeaders &&
    a.scrollBar === b.scrollBar &&
    a.markerEditor === b.markerEditor &&
    a.editToolbar === b.editToolbar &&
    a.status === b.status &&
    a.clipNavigator === b.clipNavigator &&
    a.markerNavigator === b.markerNavigator &&
    a.trackRename === b.trackRename &&
    a.trackReorder === b.trackReorder
  );
}

export interface ResolvedUiLabels {
  readonly play: string;
  readonly pause: string;
  readonly tracks: string;
  readonly clip: string;
  readonly selectClip: string;
  readonly marker: string;
  readonly selectMarker: string;
  readonly addMarker: string;
  readonly markerLabel: string;
  readonly renameMarker: string;
  readonly removeMarker: string;
  readonly scroll: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly operation: string;
  readonly move: string;
  readonly trimStart: string;
  readonly trimEnd: string;
  readonly delta: string;
  readonly apply: string;
  readonly splitAtPlayhead: string;
  readonly undo: string;
  readonly redo: string;
  readonly trackName: string;
  readonly reorderTrack: string;
  readonly trackMoved: string;
}

export function resolveUiLabels(labels: TimelineLabels = {}): ResolvedUiLabels {
  return {
    play: labels.play ?? "Play",
    pause: labels.pause ?? "Pause",
    tracks: labels.tracks ?? "Tracks",
    clip: labels.clip ?? "Clip",
    selectClip: labels.selectClip ?? "Select clip",
    marker: labels.marker ?? "Marker",
    selectMarker: labels.selectMarker ?? "Select marker",
    addMarker: labels.addMarker ?? "Add marker",
    markerLabel: labels.markerLabel ?? "Marker label",
    renameMarker: labels.renameMarker ?? "Rename marker",
    removeMarker: labels.removeMarker ?? "Remove marker",
    scroll: labels.scroll ?? "Scroll",
    zoomIn: labels.zoomIn ?? "Zoom in",
    zoomOut: labels.zoomOut ?? "Zoom out",
    operation: labels.operation ?? "Operation",
    move: labels.move ?? "Move",
    trimStart: labels.trimStart ?? "Trim start",
    trimEnd: labels.trimEnd ?? "Trim end",
    delta: labels.delta ?? "Delta (s)",
    apply: labels.apply ?? "Apply",
    splitAtPlayhead: labels.splitAtPlayhead ?? "Split at playhead",
    undo: labels.undo ?? "Undo",
    redo: labels.redo ?? "Redo",
    trackName: labels.trackName ?? "Track name",
    reorderTrack: labels.reorderTrack ?? "Drag to reorder",
    trackMoved: labels.trackMoved ?? "{name} moved to position {position} of {count}",
  };
}

export function sameUiLabels(a: ResolvedUiLabels, b: ResolvedUiLabels): boolean {
  return (
    a.play === b.play &&
    a.pause === b.pause &&
    a.tracks === b.tracks &&
    a.clip === b.clip &&
    a.selectClip === b.selectClip &&
    a.marker === b.marker &&
    a.selectMarker === b.selectMarker &&
    a.addMarker === b.addMarker &&
    a.markerLabel === b.markerLabel &&
    a.renameMarker === b.renameMarker &&
    a.removeMarker === b.removeMarker &&
    a.scroll === b.scroll &&
    a.zoomIn === b.zoomIn &&
    a.zoomOut === b.zoomOut &&
    a.operation === b.operation &&
    a.move === b.move &&
    a.trimStart === b.trimStart &&
    a.trimEnd === b.trimEnd &&
    a.delta === b.delta &&
    a.apply === b.apply &&
    a.splitAtPlayhead === b.splitAtPlayhead &&
    a.undo === b.undo &&
    a.redo === b.redo &&
    a.trackName === b.trackName &&
    a.reorderTrack === b.reorderTrack &&
    a.trackMoved === b.trackMoved
  );
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
  readonly fill: Rgba;
  readonly stripe: Rgba;
  readonly waveform: Rgba;
}

export interface ResolvedTheme {
  readonly rowEvenHex: string;
  readonly rowOddHex: string;
  readonly gridHex: string;
  readonly rowEven: Rgba;
  readonly rowOdd: Rgba;
  readonly grid: Rgba;
  readonly selectionStroke: string;
  readonly handleFill: string;
  readonly ghostFill: string;
  readonly ghostStroke: string;
  readonly marker: string;
  readonly rulerText: string;
  readonly rulerMarkerBackground: string;
  readonly labelColor: string;
  readonly nameFont: string;
  readonly captionFont: string;
  readonly palette: readonly ResolvedTrackColors[];
}

const defaultPaletteInput: readonly TimelineTrackColors[] = [
  { fill: "#2b5555", stripe: "#87d6cb" },
  { fill: "#604332", stripe: "#ffb184" },
  { fill: "#464360", stripe: "#c8bbff" },
];

function resolveColors(entry: TimelineTrackColors): ResolvedTrackColors {
  const waveHex = entry.waveform ?? entry.stripe;
  return {
    fillHex: entry.fill,
    stripeHex: entry.stripe,
    waveformHex: waveHex,
    fill: rgba(entry.fill),
    stripe: rgba(entry.stripe),
    waveform: entry.waveform ? rgba(entry.waveform) : rgba(entry.stripe, 0x66),
  };
}

export function resolveTheme(theme: TimelineTheme = {}): ResolvedTheme {
  const rowEvenHex = theme.rowEven ?? "#191e22";
  const rowOddHex = theme.rowOdd ?? "#1b2025";
  const gridHex = theme.grid ?? "#2b3136";
  const paletteInput =
    theme.palette && theme.palette.length > 0 ? theme.palette : defaultPaletteInput;
  return {
    rowEvenHex,
    rowOddHex,
    gridHex,
    rowEven: rgba(rowEvenHex),
    rowOdd: rgba(rowOddHex),
    grid: rgba(gridHex),
    selectionStroke: theme.selectionStroke ?? "#fff3d9",
    handleFill: theme.handleFill ?? "#ffddaa",
    ghostFill: theme.ghostFill ?? "#ffe6ab33",
    ghostStroke: theme.ghostStroke ?? "#ffe6ab",
    marker: theme.marker ?? "#ffd7a4",
    rulerText: theme.rulerText ?? "#9da9ad",
    rulerMarkerBackground: theme.rulerMarkerBackground ?? "#14191c",
    labelColor: theme.labelColor ?? "#faf6e9",
    nameFont: theme.nameFont ?? "500 12px system-ui, sans-serif",
    captionFont: theme.captionFont ?? "11px system-ui, sans-serif",
    palette: paletteInput.map(resolveColors),
  };
}

export function sameAtlasTheme(a: ResolvedTheme, b: ResolvedTheme): boolean {
  return (
    a.labelColor === b.labelColor && a.nameFont === b.nameFont && a.captionFont === b.captionFont
  );
}

export function sameTheme(a: ResolvedTheme, b: ResolvedTheme): boolean {
  return (
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
    sameAtlasTheme(a, b) &&
    a.palette.length === b.palette.length &&
    a.palette.every(
      (entry, index) =>
        entry.fillHex === b.palette[index]?.fillHex &&
        entry.stripeHex === b.palette[index]?.stripeHex &&
        entry.waveformHex === b.palette[index]?.waveformHex &&
        entry.waveform === b.palette[index]?.waveform,
    )
  );
}
