// Shared canvas renderer - used by BOTH the live preview and the exporter,
// so what you see in the preview is what lands in the exported file.
// All drawing code here is original.

import {
  ProjectState,
  TextStyle,
  fontFamilyCss,
  playbackSequence,
  slotByRank,
} from "./types";

export interface OverlayState {
  /** Rank currently on screen, or null when nothing is playing. */
  activeRank: number | null;
  /** Position inside the playback sequence of the active clip (for step reveal). */
  sequencePos: number;
}

function fontString(style: TextStyle, sizePx: number): string {
  const weight = style.bold ? "700 " : "400 ";
  const slant = style.italic ? "italic " : "";
  return `${slant}${weight}${sizePx}px ${fontFamilyCss(style.font)}`;
}

function setLetterSpacing(ctx: CanvasRenderingContext2D, px: number) {
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
  } catch {
    /* older browsers: ignore */
  }
}

/** Draw one styled text run: two-pass outline (stroke behind fill) + shadow. */
function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
  scale: number,
  fillColor: string,
) {
  const outline = style.outline * scale;
  ctx.save();
  if (style.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = Math.max(0, style.shadowDepth * scale * 1.6);
    ctx.shadowOffsetY = style.shadowDepth * scale * 0.7;
  }
  if (outline > 0.1) {
    ctx.lineWidth = outline * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = style.outlineColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw the video frame (or a solid placeholder) with Contain / Cover fit. */
export function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  p: ProjectState,
  W: number,
  H: number,
) {
  ctx.save();
  ctx.fillStyle = p.canvasColor;
  ctx.fillRect(0, 0, W, H);

  const ready = video && video.readyState >= 2 && video.videoWidth > 0;
  if (!ready) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = `${Math.round(W * 0.035)}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Add a clip to preview it here", W / 2, H / 2);
    ctx.restore();
    return;
  }

  const vw = video!.videoWidth;
  const vh = video!.videoHeight;
  const fitContain = p.fit === "Contain";
  const scale = fitContain ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  if (p.blurBackground) {
    // Same frame, blown up to cover and blurred, behind the main picture.
    const bScale = Math.max(W / vw, H / vh) * 1.15;
    const bw = vw * bScale;
    const bh = vh * bScale;
    ctx.save();
    try {
      (ctx as CanvasRenderingContext2D).filter = `blur(${Math.round(W * 0.03)}px) brightness(0.75)`;
    } catch { /* ignore */ }
    ctx.drawImage(video!, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.restore();
  }
  ctx.drawImage(video!, dx, dy, dw, dh);
  ctx.restore();
}

function titleLines(p: ProjectState): string[] {
  return p.title.split("\n").map((l) => l.trimEnd());
}

/** Full overlay: title + ranking list. Called after the video frame. */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  p: ProjectState,
  W: number,
  H: number,
  overlay: OverlayState,
) {
  const scale = W / 1080;
  ctx.save();

  // ---- Title ----
  if (p.showTitle && p.title.trim()) {
    const st = p.titleStyle;
    const sizePx = st.size * scale;
    const lineH = sizePx * (st.lineSpacing / 100);
    const lines = titleLines(p);
    ctx.font = fontString(st, sizePx);
    setLetterSpacing(ctx, st.tracking * scale);
    ctx.textBaseline = "top";
    const widths = lines.map((l) => ctx.measureText(l.toUpperCase()).width);
    const blockW = Math.max(...widths, 0);
    const blockH = lineH * lines.length;
    const top = H * 0.045;
    let blockX = W / 2 - blockW / 2;
    if (p.titleAlign === "left") blockX = W * 0.05;
    if (p.titleAlign === "right") blockX = W - W * 0.05 - blockW;
    if (st.background) {
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = st.backgroundColor;
      const pad = sizePx * 0.28;
      roundRect(ctx, blockX - pad, top - pad * 0.55, blockW + pad * 2, blockH + pad * 0.75, sizePx * 0.18);
      ctx.fill();
      ctx.restore();
    }
    const highlight = p.titleHighlight.trim().replace(/[^a-z0-9]/gi, "").toLowerCase();
    lines.forEach((raw, i) => {
      const line = raw.toUpperCase();
      const y = top + i * lineH;
      let x = W / 2 - widths[i] / 2;
      if (p.titleAlign === "left") x = W * 0.05;
      if (p.titleAlign === "right") x = W - W * 0.05 - widths[i];
      ctx.textAlign = "left";
      for (const w of line.split(/(\s+)/)) {
        if (!w) continue;
        const ww = ctx.measureText(w).width;
        if (w.trim()) {
          const clean = w.replace(/[^a-z0-9]/gi, "").toLowerCase();
          const color = highlight && clean === highlight ? p.titleHighlightColor : st.color;
          paintText(ctx, w, x, y, st, scale, color);
        }
        x += ww;
      }
    });
  }

  // ---- Ranking list ----
  if (p.showLabels) {
    const seq = playbackSequence(p);
    const ranksAsc = [...p.slots].filter((s) => s.label || s.url).map((s) => s.rank).sort((a, b) => a - b);
    const labelStyle: TextStyle = { ...p.titleStyle, size: p.labelSize };
    const sizePx = p.labelSize * scale;
    const rowH = sizePx * 1.42;
    const rows = ranksAsc.length;
    const startY = H - H * 0.045 - rows * rowH;
    const leftX = W * 0.055;

    ranksAsc.forEach((rank, idx) => {
      const slot = slotByRank(p, rank);
      if (!slot) return;
      const y = startY + idx * rowH;

      // Visibility / emphasis by label mode
      let alpha = 1;
      let visible = true;
      const isActive = overlay.activeRank === rank;
      if (p.labelMode === "currentOnly") {
        visible = overlay.activeRank === null ? idx === 0 : isActive;
      } else if (p.labelMode === "step") {
        if (overlay.activeRank !== null) {
          const rankPosInSeq = seq.indexOf(rank);
          visible = rankPosInSeq !== -1 && rankPosInSeq <= overlay.sequencePos;
          if (!visible && rankPosInSeq === -1) visible = false;
        }
      } else if (p.labelMode === "activeFade") {
        alpha = overlay.activeRank === null || isActive ? 1 : 0.28;
      }

      if (!visible) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textBaseline = "middle";
      setLetterSpacing(ctx, labelStyle.tracking * scale);

      const numText = `${rank}.`;
      ctx.font = fontString(labelStyle, sizePx);
      const numW = ctx.measureText(numText).width + sizePx * 0.25;
      const labelText = (slot.label || `Rank ${rank}`).toUpperCase();
      const labelW = ctx.measureText(labelText).width;

      if (labelStyle.background || isActive) {
        ctx.save();
        ctx.globalAlpha = alpha * (isActive && !labelStyle.background ? 0.35 : 0.9);
        ctx.fillStyle = labelStyle.background ? labelStyle.backgroundColor : "#000000";
        const padX = sizePx * 0.3;
        const padY = sizePx * 0.16;
        roundRect(ctx, leftX - padX, y - sizePx / 2 - padY, numW + labelW + padX * 2, sizePx + padY * 2, sizePx * 0.22);
        ctx.fill();
        ctx.restore();
      }

      // Number in its own colour, then the label in the slot colour.
      paintText(ctx, numText, leftX, y, labelStyle, scale, isActive ? p.activeHighlightColor : p.numberColor);
      ctx.textAlign = "left";
      paintText(ctx, labelText, leftX + numW, y, { ...labelStyle }, scale, slot.color);
      ctx.restore();
    });
  }
  ctx.restore();
}
