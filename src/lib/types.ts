// Original TypeScript types for Ranking Studio Web.
// Modelled on the feature set of the macOS Ranking Studio (Top 3-10 slots,
// countdown playback, text styles, canvas presets) - all code written fresh.

export type PlaybackOrder = "ascending" | "descending" | "random";
export type FitMode = "Contain" | "Cover";
export type LabelMode = "all" | "activeFade" | "currentOnly" | "step";
export type CanvasKey = "shorts1080" | "shorts720" | "portrait" | "square";
export type TitleAlign = "left" | "center" | "right";

export interface CanvasPresetDef {
  key: CanvasKey;
  label: string;
  width: number;
  height: number;
  ratio: string;
}

export const CANVAS_PRESETS: CanvasPresetDef[] = [
  { key: "shorts1080", label: "Shorts / Reels / TikTok - 1080 x 1920", width: 1080, height: 1920, ratio: "9:16" },
  { key: "shorts720", label: "Shorts / Reels / TikTok - 720 x 1280", width: 720, height: 1280, ratio: "9:16" },
  { key: "portrait", label: "Portrait post - 1080 x 1350", width: 1080, height: 1350, ratio: "4:5" },
  { key: "square", label: "Square - 1080 x 1080", width: 1080, height: 1080, ratio: "1:1" },
];

export interface TextStyle {
  font: string; // display family name, e.g. "Anton"
  size: number; // px at 1080-wide canvas
  color: string;
  bold: boolean;
  italic: boolean;
  outline: number; // px at 1080-wide canvas
  outlineColor: string;
  shadow: boolean;
  shadowDepth: number;
  background: boolean; // box behind text
  backgroundColor: string;
  tracking: number; // letter spacing px at 1080-wide canvas
  lineSpacing: number; // percent, e.g. 118
}

export interface ClipSlot {
  id: string;
  rank: number; // 1..count
  label: string;
  color: string; // label text colour
  fileName: string | null;
  url: string | null; // runtime object URL (never serialised)
  duration: number; // seconds, 0 when unknown
  start: number; // trim in
  end: number; // trim out
  volume: number; // 0..1
  muted: boolean;
  needsRelink: boolean;
}

export interface MusicState {
  fileName: string | null;
  url: string | null;
  volume: number;
  loop: boolean;
  needsRelink: boolean;
}

export interface ProjectState {
  name: string;
  title: string;
  count: number;
  slots: ClipSlot[];
  playbackOrder: PlaybackOrder;
  randomOrder: number[]; // ranks in shuffled order
  titleStyle: TextStyle;
  labelSize: number; // px at 1080-wide canvas
  numberColor: string;
  activeHighlightColor: string;
  titleAlign: TitleAlign;
  titleHighlight: string;
  titleHighlightColor: string;
  showTitle: boolean;
  showLabels: boolean;
  labelMode: LabelMode;
  canvas: CanvasKey;
  fit: FitMode;
  blurBackground: boolean;
  canvasColor: string;
  music: MusicState;
}

export const FONT_OPTIONS = [
  "Anton",
  "Bangers",
  "Montserrat",
  "Inter",
  "Barlow Condensed",
  "Georgia",
  "Menlo",
] as const;

/** Map the font identifiers used inside TextPresets.json to web families. */
export function presetFontToWeb(font: string): string {
  switch (font) {
    case "Anton-Regular":
      return "Anton";
    case "Bangers-Regular":
      return "Bangers";
    case "MontserratBold":
      return "Montserrat";
    case "InterBold":
      return "Inter";
    case "BarlowCondensed-Bold":
      return "Barlow Condensed";
    case "Georgia-BoldItalic":
      return "Georgia";
    case "Menlo-Bold":
      return "Menlo";
    default:
      return "Anton";
  }
}

export function fontFamilyCss(font: string): string {
  switch (font) {
    case "Anton":
      return `"Anton", "Arial Narrow", sans-serif`;
    case "Bangers":
      return `"Bangers", "Comic Sans MS", cursive`;
    case "Montserrat":
      return `"Montserrat", Arial, sans-serif`;
    case "Inter":
      return `"Inter", Arial, sans-serif`;
    case "Barlow Condensed":
      return `"Barlow Condensed", "Arial Narrow", sans-serif`;
    case "Georgia":
      return `Georgia, "Times New Roman", serif`;
    case "Menlo":
      return `Menlo, Consolas, monospace`;
    default:
      return `"Anton", sans-serif`;
  }
}

let uidCounter = 0;
export function uid(): string {
  uidCounter += 1;
  return `s${Date.now().toString(36)}_${uidCounter}`;
}

export function emptySlot(rank: number): ClipSlot {
  return {
    id: uid(),
    rank,
    label: `Rank ${rank}`,
    color: "#FFFFFF",
    fileName: null,
    url: null,
    duration: 0,
    start: 0,
    end: 0,
    volume: 1,
    muted: false,
    needsRelink: false,
  };
}

export function defaultProject(): ProjectState {
  return {
    name: "Untitled ranking",
    title: "TOP 3",
    count: 3,
    slots: [emptySlot(1), emptySlot(2), emptySlot(3)],
    playbackOrder: "descending",
    randomOrder: [],
    titleStyle: {
      font: "Bangers",
      size: 96,
      color: "#FFFFFF",
      bold: false,
      italic: false,
      outline: 4,
      outlineColor: "#000000",
      shadow: true,
      shadowDepth: 4,
      background: false,
      backgroundColor: "#000000",
      tracking: 1.5,
      lineSpacing: 112,
    },
    labelSize: 56,
    numberColor: "#FFDD57",
    activeHighlightColor: "#FFDD57",
    titleAlign: "center",
    titleHighlight: "",
    titleHighlightColor: "#FF2020",
    showTitle: true,
    showLabels: true,
    labelMode: "activeFade",
    canvas: "shorts1080",
    fit: "Contain",
    blurBackground: true,
    canvasColor: "#040506",
    music: { fileName: null, url: null, volume: 0.25, loop: true, needsRelink: false },
  };
}

/** Ranks that actually have media, in rank order. */
export function filledRanks(p: ProjectState): number[] {
  return p.slots.filter((s) => s.url).map((s) => s.rank).sort((a, b) => a - b);
}

/** The playback sequence (ranks) for the current order setting. */
export function playbackSequence(p: ProjectState): number[] {
  const ranks = filledRanks(p);
  if (p.playbackOrder === "ascending") return ranks;
  if (p.playbackOrder === "descending") return [...ranks].reverse();
  // random: stored shuffle first, then any ranks not in it
  const seen = new Set<number>();
  const seq: number[] = [];
  for (const r of p.randomOrder) {
    if (ranks.includes(r) && !seen.has(r)) { seq.push(r); seen.add(r); }
  }
  for (const r of ranks) if (!seen.has(r)) seq.push(r);
  return seq;
}

export function shuffled(ranks: number[]): number[] {
  const a = [...ranks];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function slotByRank(p: ProjectState, rank: number): ClipSlot | undefined {
  return p.slots.find((s) => s.rank === rank);
}

export function trimmedLength(s: ClipSlot): number {
  if (!s.url || s.duration <= 0) return 0;
  return Math.max(0, s.end - s.start);
}

export function totalDuration(p: ProjectState): number {
  return playbackSequence(p).reduce((sum, r) => {
    const s = slotByRank(p, r);
    return sum + (s ? trimmedLength(s) : 0);
  }, 0);
}

export function canvasDef(p: ProjectState): CanvasPresetDef {
  return CANVAS_PRESETS.find((c) => c.key === p.canvas) ?? CANVAS_PRESETS[0];
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
