"use client";

// Ranking Studio Web - v3 (fast MP4 export: play-and-capture pipeline;
// MP4 includes AAC audio where supported).
// Original TypeScript/React implementation of the ranking-video workflow:
// numbered slots -> trim -> style -> sequential preview -> in-browser export.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CANVAS_PRESETS,
  FONT_OPTIONS,
  ProjectState,
  canvasDef,
  defaultProject,
  emptySlot,
  fmtTime,
  fontFamilyCss,
  playbackSequence,
  presetFontToWeb,
  shuffled,
  slotByRank,
  totalDuration,
  trimmedLength,
} from "../lib/types";
import { drawOverlay, drawVideoFrame } from "../lib/draw";
import { PRESET_CATEGORIES, TEXT_PRESETS, applyPreset } from "../lib/presets";
import { ExportHandle, exportMp4, exportWebm, mp4AudioSupported, webCodecsSupported } from "../lib/exporter";

const LS_KEY = "ranking-studio-web:autosave:v1";

type SerializedProject = Omit<ProjectState, "slots" | "music"> & {
  slots: ProjectState["slots"];
  music: ProjectState["music"];
};

function serialize(p: ProjectState): SerializedProject {
  return {
    ...p,
    slots: p.slots.map((s) => ({ ...s, url: null, needsRelink: !!s.fileName })),
    music: { ...p.music, url: null, needsRelink: !!p.music.fileName },
  };
}

function deserialize(raw: unknown): ProjectState | null {
  if (!raw || typeof raw !== "object") return null;
  const base = defaultProject();
  const r = raw as Partial<ProjectState>;
  const count = Math.min(10, Math.max(3, Math.round(r.count ?? base.count)));
  const slots = Array.from({ length: count }, (_, i) => {
    const rank = i + 1;
    const found = (r.slots ?? []).find((s) => s.rank === rank);
    const slot = { ...emptySlot(rank), ...(found ?? {}), rank, url: null };
    slot.needsRelink = !!slot.fileName;
    if (!slot.fileName) slot.needsRelink = false;
    return slot;
  });
  return {
    ...base,
    ...r,
    count,
    slots,
    titleStyle: { ...base.titleStyle, ...(r.titleStyle ?? {}) },
    music: { ...base.music, ...(r.music ?? {}), url: null, needsRelink: !!(r.music?.fileName) },
  };
}

async function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.onloadedmetadata = () => resolve(isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => resolve(0);
  });
}

async function ensureFonts() {
  try {
    await Promise.race([
      (async () => {
        await document.fonts.load('400 80px "Anton"');
        await document.fonts.load('400 80px "Bangers"');
        await document.fonts.load('700 80px "Montserrat"');
        await document.fonts.load('700 80px "Inter"');
        await document.fonts.load('700 80px "Barlow Condensed"');
        await document.fonts.ready;
      })(),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* fonts fall back gracefully */ }
}

export default function StudioPage() {
  const [project, setProject] = useState<ProjectState>(() => defaultProject());
  const [playing, setPlaying] = useState(false);
  const [seqPos, setSeqPos] = useState(0);
  const [status, setStatus] = useState<string>("Add clips to the numbered slots to start your ranking.");
  const [statusKind, setStatusKind] = useState<"info" | "err" | "ok">("info");
  const [presetSearch, setPresetSearch] = useState("");
  const [presetCat, setPresetCat] = useState("All");
  const [activePreset, setActivePreset] = useState<string>("");
  const [exportFormat, setExportFormat] = useState<"auto" | "mp4" | "webm">("auto");
  const [exporting, setExporting] = useState(false);
  const [exportPhase, setExportPhase] = useState("");
  const [exportRatio, setExportRatio] = useState(0);
  const [hasWebCodecs, setHasWebCodecs] = useState(false);
  const [hasMp4Audio, setHasMp4Audio] = useState<boolean | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const nowPlayingRef = useRef<HTMLDivElement | null>(null);
  const exportHandleRef = useRef<ExportHandle | null>(null);
  const projectFileRef = useRef<HTMLInputElement | null>(null);

  const seq = useMemo(() => playbackSequence(project), [project]);
  const total = useMemo(() => totalDuration(project), [project]);
  const def = canvasDef(project);
  const previewW = Math.round(def.width / 2);
  const previewH = Math.round(def.height / 2);

  const projectRef = useRef(project);
  projectRef.current = project;
  const seqRef = useRef(seq);
  seqRef.current = seq;
  const seqPosRef = useRef(seqPos);
  seqPosRef.current = seqPos;

  const say = useCallback((msg: string, kind: "info" | "err" | "ok" = "info") => {
    setStatus(msg); setStatusKind(kind);
  }, []);

  const update = useCallback((fn: (p: ProjectState) => ProjectState) => {
    setProject((prev) => fn(prev));
  }, []);

  // ---- hydrate autosave ----
  useEffect(() => {
    setHasWebCodecs(webCodecsSupported());
    void mp4AudioSupported().then((ok) => setHasMp4Audio(ok)).catch(() => setHasMp4Audio(false));
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const restored = deserialize(JSON.parse(raw));
        if (restored) {
          setProject(restored);
          say("Restored your last session's settings. Media files are not stored in the browser - re-link each clip with its Upload button.", "info");
        }
      }
    } catch { /* ignore */ }
    setHydrated(true);
    void ensureFonts();
  }, [say]);

  // ---- autosave settings ----
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(serialize(project))); } catch { /* quota */ }
    }, 400);
    return () => clearTimeout(t);
  }, [project, hydrated]);

  // ---- clamp sequence position ----
  useEffect(() => {
    if (seqPos > Math.max(0, seq.length - 1)) setSeqPos(Math.max(0, seq.length - 1));
  }, [seq.length, seqPos]);

  const activeRank = seq.length ? seq[Math.min(seqPos, seq.length - 1)] : null;

  // ---- keep the music element in sync ----
  useEffect(() => {
    if (musicRef.current) {
      musicRef.current.volume = project.music.volume;
      musicRef.current.loop = project.music.loop;
    }
  }, [project.music.volume, project.music.loop, project.music.url]);

  // ---- keep video element volumes in sync ----
  useEffect(() => {
    videoRefs.current.forEach((v, rank) => {
      const s = slotByRank(project, rank);
      if (s) { v.volume = s.muted ? 0 : s.volume; }
    });
  }, [project]);

  // ---- play / pause transport ----
  useEffect(() => {
    const videos = videoRefs.current;
    if (!playing) {
      videos.forEach((v) => { try { v.pause(); } catch { /* ignore */ } });
      if (musicRef.current) { try { musicRef.current.pause(); } catch { /* ignore */ } }
      return;
    }
    if (activeRank === null) { setPlaying(false); return; }
    videos.forEach((v, rank) => { if (rank !== activeRank) { try { v.pause(); } catch { /* ignore */ } } });
    const v = videos.get(activeRank);
    const slot = slotByRank(projectRef.current, activeRank);
    if (v && slot) {
      if (v.currentTime < slot.start - 0.05 || v.currentTime >= slot.end - 0.05) {
        try { v.currentTime = slot.start; } catch { /* ignore */ }
      }
      void v.play().catch(() => undefined);
    }
    if (musicRef.current && projectRef.current.music.url) {
      void musicRef.current.play().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeRank]);

  const advance = useCallback(() => {
    const s = seqRef.current;
    const pos = seqPosRef.current;
    if (pos + 1 < s.length) {
      setSeqPos(pos + 1);
    } else {
      setPlaying(false);
      setSeqPos(0);
      const first = s[0];
      const v = first ? videoRefs.current.get(first) : undefined;
      const slot = first ? slotByRank(projectRef.current, first) : undefined;
      if (v && slot) { try { v.currentTime = slot.start; } catch { /* ignore */ } }
      if (musicRef.current) { try { musicRef.current.pause(); musicRef.current.currentTime = 0; } catch { /* ignore */ } }
    }
  }, []);

  // ---- preview draw loop ----
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      const p = projectRef.current;
      if (canvas) {
        const d = canvasDef(p);
        const W = Math.round(d.width / 2);
        const H = Math.round(d.height / 2);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const s = seqRef.current;
          const pos = Math.min(seqPosRef.current, Math.max(0, s.length - 1));
          const rank = s.length ? s[pos] : null;
          const v = rank !== null ? videoRefs.current.get(rank) ?? null : null;
          drawVideoFrame(ctx, v, p, W, H);
          drawOverlay(ctx, p, W, H, { activeRank: rank, sequencePos: pos });
          // transport readouts (direct DOM writes - no re-render churn)
          let elapsed = 0;
          for (let i = 0; i < pos; i++) {
            const sl = slotByRank(p, s[i]);
            if (sl) elapsed += trimmedLength(sl);
          }
          const activeSlot = rank !== null ? slotByRank(p, rank) : undefined;
          if (v && activeSlot) elapsed += Math.min(Math.max(0, v.currentTime - activeSlot.start), trimmedLength(activeSlot));
          const tot = totalDuration(p);
          if (progressBarRef.current) progressBarRef.current.style.width = `${tot > 0 ? Math.min(100, (elapsed / tot) * 100) : 0}%`;
          if (timeLabelRef.current) timeLabelRef.current.textContent = `${fmtTime(elapsed)} / ${fmtTime(tot)}`;
          if (nowPlayingRef.current) {
            nowPlayingRef.current.innerHTML = rank !== null && activeSlot
              ? `Now showing: <strong>#${rank} - ${escapeHtml(activeSlot.label)}</strong> (clip ${pos + 1} of ${s.length})`
              : "Nothing loaded yet - upload a clip into a slot below.";
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- media intake ----
  const assignFileToSlot = useCallback(async (rank: number, file: File) => {
    const url = URL.createObjectURL(file);
    const duration = await probeDuration(url);
    update((p) => ({
      ...p,
      slots: p.slots.map((s) => {
        if (s.rank !== rank) return s;
        if (s.url) URL.revokeObjectURL(s.url);
        return {
          ...s,
          url,
          fileName: file.name,
          duration,
          start: 0,
          end: duration,
          needsRelink: false,
          label: s.label === `Rank ${rank}` || s.needsRelink ? (s.label || `Rank ${rank}`) : s.label,
        };
      }),
    }));
    say(`Added "${file.name}" to slot #${rank}${duration ? ` (${fmtTime(duration)})` : ""}.`, "ok");
  }, [say, update]);

  const assignMusic = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    update((p) => {
      if (p.music.url) URL.revokeObjectURL(p.music.url);
      return { ...p, music: { ...p.music, url, fileName: file.name, needsRelink: false } };
    });
    say(`Background music set: "${file.name}".`, "ok");
  }, [say, update]);

  const bulkAdd = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const free = projectRef.current.slots.filter((s) => !s.url).map((s) => s.rank);
    if (!free.length) { say("All slots are full. Remove a clip first, or raise the Top count.", "err"); return; }
    for (let i = 0; i < Math.min(list.length, free.length); i++) {
      await assignFileToSlot(free[i], list[i]);
    }
    if (list.length > free.length) say(`Only ${free.length} empty slot(s) were available - extra files were skipped.`, "err");
  }, [assignFileToSlot, say]);

  const removeSlotMedia = useCallback((rank: number) => {
    update((p) => ({
      ...p,
      slots: p.slots.map((s) => {
        if (s.rank !== rank) return s;
        if (s.url) URL.revokeObjectURL(s.url);
        return { ...s, url: null, fileName: null, duration: 0, start: 0, end: 0, needsRelink: false };
      }),
    }));
  }, [update]);

  const setCount = useCallback((n: number) => {
    update((p) => {
      const slots = Array.from({ length: n }, (_, i) => {
        const rank = i + 1;
        return p.slots.find((s) => s.rank === rank) ?? emptySlot(rank);
      });
      return { ...p, count: n, slots, title: p.title === `TOP ${p.count}` ? `TOP ${n}` : p.title };
    });
    setSeqPos(0);
    setPlaying(false);
  }, [update]);

  const newMix = useCallback(() => {
    update((p) => ({ ...p, playbackOrder: "random", randomOrder: shuffled(p.slots.filter((s) => s.url).map((s) => s.rank)) }));
    setSeqPos(0);
    say("New random mix shuffled. Press play to preview it - export uses this same mix.", "ok");
  }, [say, update]);

  // ---- project save / open ----
  const saveProject = useCallback(() => {
    const data = { app: "ranking-studio-web", version: 1, exportedAt: new Date().toISOString(), project: serialize(projectRef.current) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(projectRef.current.name || "ranking").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "ranking"}.rankstudio.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    say("Project file saved. It stores settings and clip names/trims - the video and music files themselves are not inside it, so re-link them when you open the project again.", "ok");
  }, [say]);

  const openProjectFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { project?: unknown } | unknown;
      const candidate = (parsed as { project?: unknown })?.project ?? parsed;
      const restored = deserialize(candidate);
      if (!restored) throw new Error("Not a Ranking Studio project file.");
      setPlaying(false);
      setSeqPos(0);
      setProject(restored);
      say("Project opened. Slots keep their labels and trims - use each slot's Upload button to re-link its video file.", "ok");
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not open that project file.", "err");
    }
  }, [say]);

  const newProject = useCallback(() => {
    if (!window.confirm("Start a new project? Unsaved changes to this one will be lost (use Save Project first if you need them).")) return;
    projectRef.current.slots.forEach((s) => { if (s.url) URL.revokeObjectURL(s.url); });
    if (projectRef.current.music.url) URL.revokeObjectURL(projectRef.current.music.url);
    setPlaying(false);
    setSeqPos(0);
    setProject(defaultProject());
    say("New project started.", "ok");
  }, [say]);

  // ---- export ----
  const startExport = useCallback(async () => {
    const p = projectRef.current;
    if (!playbackSequence(p).length) { say("Add at least one video clip before exporting.", "err"); return; }
    setPlaying(false);
    await ensureFonts();
    const fmt = exportFormat === "auto" ? (webCodecsSupported() ? "mp4" : "webm") : exportFormat;
    if (fmt === "mp4" && !webCodecsSupported()) {
      say("This browser does not support WebCodecs, so MP4 export is unavailable here. WebM export works instead.", "err");
      return;
    }
    setExporting(true);
    setExportRatio(0);
    setExportPhase("Starting export");
    const handle = fmt === "mp4" ? exportMp4(p, (pr) => { setExportPhase(pr.phase); setExportRatio(pr.ratio); }) : exportWebm(p, (pr) => { setExportPhase(pr.phase); setExportRatio(pr.ratio); });
    exportHandleRef.current = handle;
    try {
      const result = await handle.promise;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(result.blob);
      a.download = result.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      if (result.audioWarning) {
        say(`Export finished: ${result.filename} (${(result.blob.size / 1_000_000).toFixed(1)} MB, ${result.format.toUpperCase()}, video only). ${result.audioWarning}`, "err");
      } else {
        say(`Export finished: ${result.filename} (${(result.blob.size / 1_000_000).toFixed(1)} MB, ${result.format.toUpperCase()}${result.includesAudio ? ", with audio" : ", video only"}).`, "ok");
      }
    } catch (e) {
      say(e instanceof Error ? e.message : "Export failed.", "err");
    } finally {
      setExporting(false);
      exportHandleRef.current = null;
    }
  }, [exportFormat, say]);

  const filteredPresets = TEXT_PRESETS.filter((pr) =>
    (presetCat === "All" || pr.category === presetCat) &&
    (presetSearch.trim() === "" || pr.name.toLowerCase().includes(presetSearch.trim().toLowerCase())),
  );

  const ts = project.titleStyle;

  return (
    <main>
      {/* hidden media elements that feed the preview canvas */}
      <div aria-hidden="true" style={{ display: "none" }}>
        {project.slots.filter((s) => s.url).map((s) => (
          <video
            key={`${s.id}:${s.url}`}
            ref={(el) => {
              if (el) videoRefs.current.set(s.rank, el);
              else videoRefs.current.delete(s.rank);
            }}
            src={s.url ?? undefined}
            preload="auto"
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              const d = isFinite(v.duration) ? v.duration : 0;
              if (d > 0 && Math.abs(d - s.duration) > 0.05) {
                update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, duration: d, end: x.end > 0 && x.end <= d + 0.05 ? x.end : d } : x) }));
              }
              if (activeRank === s.rank) { try { v.currentTime = s.start; } catch { /* ignore */ } }
            }}
            onTimeUpdate={(e) => {
              if (activeRank === s.rank && playing && e.currentTarget.currentTime >= s.end - 0.04) advance();
            }}
            onEnded={() => { if (activeRank === s.rank && playing) advance(); }}
          />
        ))}
        {project.music.url && (
          <audio ref={musicRef} src={project.music.url} loop={project.music.loop} preload="auto" />
        )}
      </div>

      <header className="topbar">
        <div className="logo"><span className="logo-badge">R</span> Ranking Studio <span style={{ color: "var(--muted)", fontWeight: 500 }}>Web</span></div>
        <input
          type="text"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          aria-label="Project name"
          style={{ minWidth: 170 }}
        />
        <div className="spacer" />
        <span className="hint">100% in-browser - no uploads, no watermark, no account</span>
        <button className="btn" onClick={newProject}>New</button>
        <button className="btn" onClick={saveProject}>Save Project</button>
        <button className="btn" onClick={() => projectFileRef.current?.click()}>Open Project</button>
        <input
          ref={projectFileRef}
          className="hidden-input"
          type="file"
          accept="application/json,.json"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openProjectFile(f); e.target.value = ""; }}
        />
      </header>

      <div style={{ padding: "14px 16px 0" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Ranking Studio Web - Free Ranking Video Maker for Top 3-10 Countdowns</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)" }}>
          Add your clips to numbered slots, style the countdown, preview it live and export a finished video - everything happens on your device.
        </p>
      </div>

      <div className="studio">
        {/* ---------------- Preview ---------------- */}
        <div className="preview-pane">
          <div className="preview-wrap">
            <canvas ref={canvasRef} className="screen" width={previewW} height={previewH} style={{ aspectRatio: `${def.width} / ${def.height}` }} />
            <div className="transport">
              <button
                className="btn primary"
                onClick={() => {
                  if (!seq.length) { say("Add at least one clip first.", "err"); return; }
                  if (!playing) {
                    const rank = seq[Math.min(seqPos, seq.length - 1)];
                    const v = videoRefs.current.get(rank);
                    const slot = slotByRank(project, rank);
                    if (v && slot && (v.currentTime < slot.start || v.currentTime >= slot.end - 0.05)) { try { v.currentTime = slot.start; } catch { /* ignore */ } }
                  }
                  setPlaying(!playing);
                }}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button className="btn" onClick={() => { setPlaying(false); setSeqPos(0); const r = seq[0]; const v = r ? videoRefs.current.get(r) : undefined; const s = r ? slotByRank(project, r) : undefined; if (v && s) { try { v.currentTime = s.start; } catch { /* ignore */ } } if (musicRef.current) { try { musicRef.current.currentTime = 0; } catch { /* ignore */ } } }}>Restart</button>
              <div className="progress"><div ref={progressBarRef} /></div>
              <span className="time" ref={timeLabelRef}>00:00 / {fmtTime(total)}</span>
            </div>
            <div className="now-playing" ref={nowPlayingRef}>Nothing loaded yet - upload a clip into a slot below.</div>
            <div className="kbd-note" style={{ maxWidth: 430 }}>
              Preview and export share the same renderer, so titles and ranking labels land in the exported file exactly as you see them here.
              Canvas: <strong>{def.width} x {def.height} ({def.ratio})</strong>
            </div>
          </div>
        </div>

        {/* ---------------- Editor ---------------- */}
        <div className="editor-pane">
          <p className={`status ${statusKind === "err" ? "err" : statusKind === "ok" ? "ok" : ""}`} role="status">{status}</p>

          {/* Clips */}
          <section className="panel">
            <h2>1. Clips &amp; title</h2>
            <p className="sub">Each numbered slot is one rank. Upload a video, rename its label, trim it and set its volume. Browser-playable files work best: MP4 (H.264), WebM or MOV.</p>
            <div className="row">
              <label className="f">Ranking size
                <select value={project.count} onChange={(e) => setCount(parseInt(e.target.value, 10))}>
                  {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>Top {n}</option>)}
                </select>
              </label>
              <label className="f">Playback order
                <select
                  value={project.playbackOrder}
                  onChange={(e) => {
                    const v = e.target.value as ProjectState["playbackOrder"];
                    update((p) => ({ ...p, playbackOrder: v, randomOrder: v === "random" && p.randomOrder.length === 0 ? shuffled(p.slots.filter((s) => s.url).map((s) => s.rank)) : p.randomOrder }));
                    setSeqPos(0); setPlaying(false);
                  }}
                >
                  <option value="descending">Countdown (Top N → 1)</option>
                  <option value="ascending">Ascending (1 → Top N)</option>
                  <option value="random">Random mix</option>
                </select>
              </label>
              {project.playbackOrder === "random" && <button className="btn small violet" onClick={newMix} style={{ alignSelf: "flex-end" }}>New mix</button>}
              <label className="f grow" style={{ alignSelf: "flex-end" }}>
                <span className="btn small" role="button">Add multiple clips (fills empty slots)</span>
                <input className="hidden-input" type="file" accept="video/*" multiple onChange={(e) => { if (e.target.files) void bulkAdd(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
            <div className="row">
              <label className="f grow">Video title (one per line for multiple lines)
                <textarea value={project.title} onChange={(e) => update((p) => ({ ...p, title: e.target.value }))} />
              </label>
            </div>

            {project.slots.map((s) => (
              <div className="slot" key={s.id}>
                <div className="slot-head">
                  <span className="rank-badge">{s.rank}</span>
                  <input type="text" className="grow" value={s.label} aria-label={`Label for rank ${s.rank}`} onChange={(e) => update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, label: e.target.value } : x) }))} />
                  <label className="f inline">Text <input type="color" value={s.color} onChange={(e) => update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, color: e.target.value } : x) }))} /></label>
                  {s.fileName
                    ? <span className="fname" title={s.fileName}>{s.fileName}</span>
                    : s.needsRelink
                      ? <span className="relink">File needs re-linking</span>
                      : <span className="fname">Empty slot</span>}
                  <label className="btn small">
                    {s.url ? "Replace video" : "Upload video"}
                    <input className="hidden-input" type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignFileToSlot(s.rank, f); e.target.value = ""; }} />
                  </label>
                  {s.url && <button className="btn small" onClick={() => { const idx = seq.indexOf(s.rank); if (idx >= 0) { setPlaying(false); setSeqPos(idx); const v = videoRefs.current.get(s.rank); if (v) { try { v.currentTime = s.start; } catch { /* ignore */ } } } }}>Preview</button>}
                  {s.url && <button className="btn small danger" onClick={() => removeSlotMedia(s.rank)}>Remove</button>}
                </div>
                {s.url && (
                  <div className="trim-grid">
                    <label className="f">Trim start - {fmtTime(s.start)} (of {fmtTime(s.duration)})
                      <span className="row" style={{ marginTop: 0 }}>
                        <input type="range" min={0} max={Math.max(0, s.duration - 0.1)} step={0.1} value={s.start} className="grow" onChange={(e) => { const val = Math.min(parseFloat(e.target.value), s.end - 0.1); update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, start: Math.max(0, val) } : x) })); }} />
                        <input type="number" className="num" min={0} step={0.1} value={Number(s.start.toFixed(1))} onChange={(e) => { const val = Math.max(0, Math.min(parseFloat(e.target.value || "0"), s.end - 0.1)); update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, start: val } : x) })); }} />
                      </span>
                    </label>
                    <label className="f">Trim end - {fmtTime(s.end)} (plays {fmtTime(trimmedLength(s))})
                      <span className="row" style={{ marginTop: 0 }}>
                        <input type="range" min={0.1} max={Math.max(0.1, s.duration)} step={0.1} value={s.end} className="grow" onChange={(e) => { const val = Math.max(parseFloat(e.target.value), s.start + 0.1); update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, end: Math.min(val, x.duration || val) } : x) })); }} />
                        <input type="number" className="num" min={0} step={0.1} value={Number(s.end.toFixed(1))} onChange={(e) => { const val = Math.min(Math.max(parseFloat(e.target.value || "0"), s.start + 0.1), s.duration || parseFloat(e.target.value || "0")); update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, end: val } : x) })); }} />
                      </span>
                    </label>
                    <label className="f">Clip volume - {Math.round(s.volume * 100)}%
                      <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, volume: parseFloat(e.target.value) } : x) }))} />
                    </label>
                    <label className="f inline" style={{ alignSelf: "end" }}>
                      <input type="checkbox" checked={s.muted} onChange={(e) => update((p) => ({ ...p, slots: p.slots.map((x) => x.rank === s.rank ? { ...x, muted: e.target.checked } : x) }))} /> Mute this clip
                    </label>
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* Title & text */}
          <section className="panel">
            <h2>2. Title &amp; text style</h2>
            <p className="sub">One shared style drives the title and the ranking labels (labels keep their own size and per-slot colours), just like the desktop studio.</p>
            <div className="row">
              <label className="f">Font
                <select value={ts.font} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, font: e.target.value } }))}>
                  {FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="f">Title size <input type="number" className="num" min={24} max={220} value={ts.size} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, size: Math.min(220, Math.max(24, parseFloat(e.target.value || "96"))) } }))} /></label>
              <label className="f">Title colour <input type="color" value={ts.color} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, color: e.target.value } }))} /></label>
              <label className="f inline"><input type="checkbox" checked={ts.bold} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, bold: e.target.checked } }))} /> Bold</label>
              <label className="f inline"><input type="checkbox" checked={ts.italic} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, italic: e.target.checked } }))} /> Italic</label>
              <label className="f">Alignment
                <select value={project.titleAlign} onChange={(e) => update((p) => ({ ...p, titleAlign: e.target.value as ProjectState["titleAlign"] }))}>
                  <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="f grow">Outline width <input type="range" min={0} max={12} step={0.2} value={ts.outline} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, outline: parseFloat(e.target.value) } }))} /></label>
              <label className="f">Outline colour <input type="color" value={ts.outlineColor} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, outlineColor: e.target.value } }))} /></label>
              <label className="f inline"><input type="checkbox" checked={ts.shadow} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, shadow: e.target.checked } }))} /> Shadow</label>
              <label className="f grow">Shadow depth <input type="range" min={0} max={12} step={0.2} value={ts.shadowDepth} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, shadowDepth: parseFloat(e.target.value) } }))} /></label>
            </div>
            <div className="row">
              <label className="f inline"><input type="checkbox" checked={ts.background} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, background: e.target.checked } }))} /> Box behind text</label>
              <label className="f">Box colour <input type="color" value={ts.backgroundColor} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, backgroundColor: e.target.value } }))} /></label>
              <label className="f grow">Letter spacing <input type="range" min={-2} max={10} step={0.25} value={ts.tracking} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, tracking: parseFloat(e.target.value) } }))} /></label>
              <label className="f grow">Line spacing % <input type="range" min={90} max={160} step={2} value={ts.lineSpacing} onChange={(e) => update((p) => ({ ...p, titleStyle: { ...p.titleStyle, lineSpacing: parseFloat(e.target.value) } }))} /></label>
            </div>
            <div className="row">
              <label className="f grow">Highlight word in title <input type="text" value={project.titleHighlight} placeholder="e.g. FUNNIEST" onChange={(e) => update((p) => ({ ...p, titleHighlight: e.target.value }))} /></label>
              <label className="f">Highlight colour <input type="color" value={project.titleHighlightColor} onChange={(e) => update((p) => ({ ...p, titleHighlightColor: e.target.value }))} /></label>
              <label className="f">Number colour <input type="color" value={project.numberColor} onChange={(e) => update((p) => ({ ...p, numberColor: e.target.value }))} /></label>
              <label className="f">Active colour <input type="color" value={project.activeHighlightColor} onChange={(e) => update((p) => ({ ...p, activeHighlightColor: e.target.value }))} /></label>
              <label className="f">Label size <input type="number" className="num" min={20} max={140} value={project.labelSize} onChange={(e) => update((p) => ({ ...p, labelSize: Math.min(140, Math.max(20, parseFloat(e.target.value || "56"))) }))} /></label>
            </div>
            <div className="row">
              <label className="f inline"><input type="checkbox" checked={project.showTitle} onChange={(e) => update((p) => ({ ...p, showTitle: e.target.checked }))} /> Show title</label>
              <label className="f inline"><input type="checkbox" checked={project.showLabels} onChange={(e) => update((p) => ({ ...p, showLabels: e.target.checked }))} /> Show ranking labels</label>
              <label className="f">Ranking labels
                <select value={project.labelMode} onChange={(e) => update((p) => ({ ...p, labelMode: e.target.value as ProjectState["labelMode"] }))}>
                  <option value="all">All labels visible</option>
                  <option value="activeFade">Active clip + faded list</option>
                  <option value="currentOnly">Current clip only</option>
                  <option value="step">Step-by-step reveal</option>
                </select>
              </label>
            </div>
          </section>

          {/* Presets */}
          <section className="panel">
            <h2>3. Text presets</h2>
            <p className="sub">32 ready-made title looks. Applying one changes typography only - your words, clips, trims and canvas stay untouched.</p>
            <div className="row">
              <input type="text" className="grow" placeholder="Search text styles" value={presetSearch} onChange={(e) => setPresetSearch(e.target.value)} />
            </div>
            <div className="row chips">
              {PRESET_CATEGORIES.map((c) => (
                <button key={c} className={`chip ${presetCat === c ? "on" : ""}`} onClick={() => setPresetCat(c)}>{c}</button>
              ))}
            </div>
            <div className="preset-grid">
              {filteredPresets.map((pr) => {
                const fam = presetFontToWeb(pr.font);
                return (
                  <button
                    key={pr.name}
                    className={`preset-card ${activePreset === pr.name ? "active" : ""}`}
                    onClick={() => { setActivePreset(pr.name); update((p) => applyPreset(p, pr)); say(`Applied text preset "${pr.name}". Words, clips and trims were kept.`, "ok"); }}
                  >
                    <span
                      className="preset-sample"
                      style={{
                        fontFamily: fontFamilyCss(fam),
                        fontStyle: pr.italic ? "italic" : "normal",
                        color: pr.single ? pr.accent : pr.color,
                        background: pr.box ? pr.background : "transparent",
                        padding: pr.box ? "4px 8px" : 0,
                        borderRadius: 6,
                        textShadow: pr.shadow > 0 ? `0 3px 0 rgba(0,0,0,0.9)` : "none",
                        WebkitTextStroke: pr.outline > 0 ? `${Math.min(1.4, pr.outline / 3)}px #000` : undefined,
                      }}
                    >
                      {pr.single ? "QUICK" : "Top Moments"}
                    </span>
                    <span className="preset-name">{pr.name}</span>
                    <span className="preset-cat" style={{ display: "block" }}>{pr.category} - {fam}</span>
                  </button>
                );
              })}
              {filteredPresets.length === 0 && <p className="status">No matching presets. Try another category or search.</p>}
            </div>
          </section>

          {/* Canvas & audio */}
          <section className="panel">
            <h2>4. Canvas &amp; audio</h2>
            <p className="sub">Canvas size is the export size. Fit decides how each clip sits inside it; the blurred background fills the empty space with the same frame, blurred.</p>
            <div className="row">
              <label className="f">Canvas
                <select value={project.canvas} onChange={(e) => update((p) => ({ ...p, canvas: e.target.value as ProjectState["canvas"] }))}>
                  {CANVAS_PRESETS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
              <label className="f">Video fit
                <select value={project.fit} onChange={(e) => update((p) => ({ ...p, fit: e.target.value as ProjectState["fit"] }))}>
                  <option value="Contain">Contain - whole clip visible</option>
                  <option value="Cover">Cover - fill frame, crop edges</option>
                </select>
              </label>
              <label className="f inline"><input type="checkbox" checked={project.blurBackground} onChange={(e) => update((p) => ({ ...p, blurBackground: e.target.checked }))} /> Blurred background</label>
              <label className="f">Canvas colour <input type="color" value={project.canvasColor} onChange={(e) => update((p) => ({ ...p, canvasColor: e.target.value }))} /></label>
            </div>
            <div className="row">
              <label className="btn small">
                {project.music.url ? "Replace music" : "Add background music"}
                <input className="hidden-input" type="file" accept="audio/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignMusic(f); e.target.value = ""; }} />
              </label>
              {project.music.fileName
                ? <span className="fname" title={project.music.fileName}>{project.music.fileName}</span>
                : project.music.needsRelink
                  ? <span className="relink">Music file needs re-linking</span>
                  : <span className="fname">No music added</span>}
              {project.music.url && <button className="btn small danger" onClick={() => update((p) => { if (p.music.url) URL.revokeObjectURL(p.music.url); return { ...p, music: { ...p.music, url: null, fileName: null, needsRelink: false } }; })}>Remove music</button>}
              <label className="f grow">Music volume - {Math.round(project.music.volume * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={project.music.volume} onChange={(e) => { const val = parseFloat(e.target.value); update((p) => ({ ...p, music: { ...p.music, volume: val } })); if (musicRef.current) musicRef.current.volume = val; }} />
              </label>
              <label className="f inline"><input type="checkbox" checked={project.music.loop} onChange={(e) => update((p) => ({ ...p, music: { ...p.music, loop: e.target.checked } }))} /> Loop music</label>
            </div>
          </section>

          {/* Export */}
          <section className="panel">
            <h2>5. Export</h2>
            <p className="sub">
              Export renders at <strong>{def.width} x {def.height}</strong> on this device - nothing is uploaded.
              MP4 uses WebCodecs in this browser: <strong>{hasWebCodecs ? "supported" : "not supported here"}</strong>.
              MP4 audio (AAC) in this browser: <strong>{hasMp4Audio === null ? "checking..." : hasMp4Audio ? "supported" : "not supported here"}</strong>.
            </p>
            <div className="kbd-note">
              <strong>MP4 (WebCodecs):</strong> the fast export - rendered with an accelerated play-and-capture pipeline, usually the sharpest result - on browsers with AAC encoding (Chrome and Edge) it <strong>includes clip sound + background music</strong> mixed into the file. If this browser cannot encode AAC audio, the MP4 still exports but without sound, and the result message will say so clearly.<br />
              <strong>WebM (MediaRecorder):</strong> recorded in realtime while the sequence plays, and it <strong>includes clip sound + background music</strong>. It remains the fallback - and the safe pick for sound in browsers without WebCodecs audio.<br />
              Clip sound is read straight out of the video file in your browser, and every MP4 export checks that the mixed sound is not silent: if the sound in your files could not be read here, the MP4 result will say so clearly and point you to WebM instead of quietly shipping a soundless file.
            </div>
            <p className="sub" style={{ marginTop: 10 }}>
              <strong>Speed note:</strong> MP4 is the fast export. WebM records in realtime, so a WebM export takes as long as the video itself.
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f">Format
                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}>
                  <option value="auto">Auto (MP4 if supported, else WebM)</option>
                  <option value="mp4">MP4 - with audio where supported</option>
                  <option value="webm">WebM - with audio (realtime)</option>
                </select>
              </label>
              <span className="status">Total length: {fmtTime(total)} - {seq.length} clip(s) in the current playback order</span>
            </div>
            <div className="row">
              {!exporting
                ? <button className="btn primary" onClick={() => void startExport()} disabled={!seq.length}>Export video</button>
                : <button className="btn danger" onClick={() => exportHandleRef.current?.cancel()}>Cancel export</button>}
              {exporting && <span className="status">{exportPhase} - {Math.round(exportRatio * 100)}%</span>}
            </div>
            {exporting && <div className="exportbar"><div style={{ width: `${exportRatio * 100}%` }} /></div>}
            <p className="sub" style={{ marginTop: 10 }}>
              Project files (.rankstudio.json) save your settings, labels and trims. Video and music files are never stored -
              reopening a project asks you to re-link each file with its Upload button. Your current settings autosave in this browser.
            </p>
          </section>
        </div>
      </div>

      {/* ---------------- SEO content ---------------- */}
      <div className="seo">
        <h2>How to make a ranking video</h2>
        <ol>
          <li><strong>Pick your list size.</strong> Choose Top 3 up to Top 10 - every rank gets its own numbered slot.</li>
          <li><strong>Add one clip per rank.</strong> Upload a video into each slot, rename its label and pick its text colour. Use Add multiple clips to fill empty slots in one go.</li>
          <li><strong>Trim each clip.</strong> Drag the start and end sliders so only the moment that matters plays. Set clip volume, or mute a clip, per slot.</li>
          <li><strong>Choose the playback order.</strong> Countdown plays Top N down to number 1, ascending plays 1 up, and random shuffles a fresh mix you can preview before exporting.</li>
          <li><strong>Style the title.</strong> Pick one of 32 text presets or build your own look - font, outline, shadow, box, highlight word and alignment are all editable.</li>
          <li><strong>Set the canvas.</strong> 9:16 for Shorts, Reels and TikTok, 4:5 for portrait posts, 1:1 for square. Add a local music file if you want a backing track.</li>
          <li><strong>Export.</strong> Download an MP4 or a WebM - both include your clip sound and background music on supported browsers, rendered entirely on your device.</li>
        </ol>

        <h2>Why make ranking videos here?</h2>
        <ul>
          <li><strong>Private by design:</strong> your clips never leave your device. There is no server upload and no account.</li>
          <li><strong>No watermark:</strong> exports are clean, at full canvas resolution.</li>
          <li><strong>Preview = export:</strong> the live preview and the exporter draw with the same renderer, so the title and ranking list you see are what you get.</li>
          <li><strong>Portable projects:</strong> save a small project file with your settings and trims, and re-link the media whenever you come back.</li>
        </ul>

        <h2>Frequently asked questions</h2>
        <details className="faq">
          <summary>Is Ranking Studio Web really free?</summary>
          <p>Yes. The tool runs entirely in your browser, so there is nothing to sign up for and no watermark on exports.</p>
        </details>
        <details className="faq">
          <summary>Are my videos uploaded anywhere?</summary>
          <p>No. Files you pick are read locally by your browser and rendered on your device. Closing the tab removes them; project files store only names, labels and trim settings.</p>
        </details>
        <details className="faq">
          <summary>MP4 or WebM - which should I export?</summary>
          <p>MP4 (via WebCodecs, in Chrome and Edge) is rendered frame-by-frame and includes clip sound plus your background music, mixed and encoded as AAC audio in the same file. A browser that cannot encode AAC will still export the MP4, but without sound - the export result tells you when that happens, and in that case WebM is the pick for audio: it is recorded in realtime and also includes clip sound plus your background music.</p>
        </details>
        <details className="faq">
          <summary>Which video formats can I add?</summary>
          <p>Anything your browser can play - MP4 with H.264 is the safest choice, and WebM and most MOV files work too. If a file will not preview, convert it to H.264 MP4 first.</p>
        </details>
        <details className="faq">
          <summary>Why does a reopened project ask me to re-link files?</summary>
          <p>Browsers cannot keep access to files on your disk, and this tool does not upload or store your media. The project file keeps every setting, label and trim - you just point each slot back at its file.</p>
        </details>
      </div>

      <footer className="site">
        Ranking Studio Web - an independent in-browser ranking video maker. Your media stays on your device.
      </footer>
    </main>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
