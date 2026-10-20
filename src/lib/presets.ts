// Text preset handling. The preset data itself is the original
// TextPresets.json from the macOS app (32 styles), copied into src/data/.
// The mapping/application logic below is original TypeScript.

import rawPresets from "../data/TextPresets.json";
import { ProjectState, TextStyle, presetFontToWeb } from "./types";

export interface TextPreset {
  name: string;
  category: string;
  font: string;
  color: string;
  accent: string;
  outline: number;
  shadow: number;
  tracking: number;
  spacing: number;
  italic: boolean;
  box: boolean;
  background: string;
  single: boolean;
}

export const TEXT_PRESETS: TextPreset[] = rawPresets as TextPreset[];

export const PRESET_CATEGORIES: string[] = [
  "All",
  ...Array.from(new Set(TEXT_PRESETS.map((p) => p.category))),
];

/**
 * Apply a preset the same way the Mac app does: it restyles the title and
 * (linked) labels only. Words, clips, trims, canvas and colours per-slot
 * are left untouched. For multi-word styles, the second word of the title
 * becomes the highlighted word in the preset accent colour.
 */
export function applyPreset(p: ProjectState, preset: TextPreset): ProjectState {
  const style: TextStyle = {
    ...p.titleStyle,
    font: presetFontToWeb(preset.font),
    color: preset.single ? preset.accent : preset.color,
    bold: true,
    italic: preset.italic,
    outline: preset.outline,
    outlineColor: "#000000",
    shadow: preset.shadow > 0,
    shadowDepth: preset.shadow,
    tracking: preset.tracking,
    lineSpacing: preset.spacing,
    background: preset.box,
    backgroundColor: preset.background,
  };
  let highlight = "";
  if (!preset.single && !preset.box) {
    const words = p.title.split(/\s+/).filter(Boolean);
    highlight = words.length > 1 ? words[1] : words[0] ?? "";
  }
  return {
    ...p,
    titleStyle: style,
    titleHighlight: highlight,
    titleHighlightColor: preset.accent,
    showTitle: true,
    showLabels: true,
    slots: p.slots.map((s) => ({ ...s })),
  };
}
