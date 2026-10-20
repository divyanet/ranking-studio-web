"use client";

// Ranking Studio Web - v4 (design overhaul: CapCut/Canva-class dark editor
// shell - tabbed control panel, card-based clip slots with thumbnails,
// centre stage, persistent export strip. Export engine unchanged: fast MP4
// play-and-capture with AAC audio where supported, realtime WebM fallback.)
// Original TypeScript/React implementation of the ranking-video workflow:
// numbered slots -> trim -> style -> sequential preview -> in-browser export.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
const UI_MARKER = "rs-v4-editor-shell";

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

/** Grab a poster frame (JPEG data URL) from a clip for its slot thumbnail. */
function capturePoster(url: string, atSeconds: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: string | null) => { if (!settled) { settled = true; resolve(val); } };
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    const timer = setTimeout(() => done(null), 5000);
    v.addEventListener("loadedmetadata", () => {
      const target = Math.min(Math.max(atSeconds, 0.05), Math.max(0.05, (v.duration || 1) - 0.05));
      try { v.currentTime = target; } catch { clearTimeout(timer); done(null); }
    });
    v.addEventListener("seeked", () => {
      try {
        const W = 138;
        const H = 192;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d");
        if (!ctx || !v.videoWidth) { clearTimeout(timer); done(null); return; }
        const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * scale;
        const dh = v.videoHeight * scale;
        ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
        clearTimeout(timer);
        done(c.toDataURL("image/jpeg", 0.72));
      } catch { clearTimeout(timer); done(null); }
    });
    v.addEventListener("error", () => { clearTimeout(timer); done(null); });
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

/* ================= small UI primitives (v4 design system) ================= */

function rangeBg(value: number, min: number, max: number): string {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return `linear-gradient(90deg, var(--accent) ${pct}%, #26262f ${pct}%) center / 100% 4px no-repeat`;
}

function Range({
  value, min, max, step, onChange, ariaLabel,
}: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; ariaLabel?: string;
}) {
  return (
    <input
      type="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ background: rangeBg(value, min, max) }}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

function SliderRow({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  display?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="slider-row">
        <Range value={value} min={min} max={max} step={step} onChange={onChange} ariaLabel={label} />
        {display !== undefined && <span className="slider-val">{display}</span>}
      </div>
    </div>
  );
}

function Toggle({
  label, sub, checked, onChange,
}: {
  label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <span>
        <span className="sw-label">{label}</span>
        {sub && <span className="sw-sub">{sub}</span>}
      </span>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function Seg<T extends string>({
  value, options, onChange, ariaLabel, className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={`seg ${className ?? ""}`} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ColorField({
  label, value, onChange,
}: {
  label?: string; value: string; onChange: (v: string) => void;
}) {
  const [hex, setHex] = useState(value.toUpperCase());
  useEffect(() => { setHex(value.toUpperCase()); }, [value]);
  return (
    <div className="field">
      {label && <span>{label}</span>}
      <div className="color-field">
        <span className="swatch" style={{ background: value }} title={label ?? "Colour"}>
          <input
            type="color"
            value={value}
            aria-label={label ?? "Colour"}
            onChange={(e) => onChange(e.target.value)}
          />
        </span>
        <input
          className="hex"
          type="text"
          value={hex}
          aria-label={label ? `${label} hex` : "Colour hex"}
          onChange={(e) => {
            const v = e.target.value;
            setHex(v);
            if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) onChange(v.trim());
          }}
          onBlur={() => setHex(value.toUpperCase())}
        />
      </div>
    </div>
  );
}

/* icons (inline, 16px stroke set) */
const I = {
  clips: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M8 4v5M16 4v5" /></svg>),
  text: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 6V4h14v2M12 4v16M9 20h6" /></svg>),
  presets: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /></svg>),
  canvas: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 15l5-4 4 3 4-4 5 5" /></svg>),
  audio: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>),
  export: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>),
  play: (<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>),
  pause: (<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>),
  restart: (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>),
  upload: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V5M7 9l5-5 5 5" /><path d="M4 20h16" /></svg>),
  replace: (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 3v5h-5" /></svg>),
  trash: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>),
  volume: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10v4h3l5 4V6l-5 4H4z" fill="currentColor" stroke="none" /><path d="M15 9a4 4 0 0 1 0 6M18 7a7 7 0 0 1 0 10" /></svg>),
  muted: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10v4h3l5 4V6l-5 4H4z" fill="currentColor" stroke="none" /><path d="M16 9l6 6M22 9l-6 6" /></svg>),
  eye: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>),
  film: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M8 4v16M16 4v16" /></svg>),
  save: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l5 5v13H5z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></svg>),
  folder: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>),
  plus: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>),
  download: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 11l5 5 5-5M4 20h16" /></svg>),
};

type TabKey = "clips" | "text" | "presets" | "canvas" | "audio" | "export";
const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: "clips", label: "Clips", icon: I.clips },
  { key: "text", label: "Text", icon: I.text },
  { key: "presets", label: "Presets", icon: I.presets },
  { key: "canvas", label: "Canvas", icon: I.canvas },
  { key: "audio", label: "Audio", icon: I.audio },
  { key: "export", label: "Export", icon: I.export },
];

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
  const [tab, setTab] = useState<TabKey>("clips");
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [dragRank, setDragRank] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const nowPlayingRef = useRef<HTMLDivElement | null>(null);
  const exportHandleRef = useRef<ExportHandle | null>(null);
  const projectFileRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const posterTriedRef = useRef(new Set<string>());

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

  // ---- clip thumbnails (poster frames, component state only) ----
  useEffect(() => {
    for (const s of project.slots) {
      if (!s.url || posterTriedRef.current.has(s.url)) continue;
      posterTriedRef.current.add(s.url);
      const url = s.url;
      const at = s.start > 0 ? s.start + 0.05 : 0.3;
      void capturePoster(url, at).then((data) => {
        if (data) setPosters((prev) => (prev[url] ? prev : { ...prev, [url]: data }));
      });
    }
  }, [project.slots]);

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
              : "Nothing loaded yet - upload a clip into a slot to begin.";
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

  const goExportTab = useCallback(() => {
    setTab("export");
    if (typeof window !== "undefined" && window.innerWidth <= 1080) {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const filteredPresets = TEXT_PRESETS.filter((pr) =>
    (presetCat === "All" || pr.category === presetCat) &&
    (presetSearch.trim() === "" || pr.name.toLowerCase().includes(presetSearch.trim().toLowerCase())),
  );

  const ts = project.titleStyle;
  const setTitleStyle = useCallback((patch: Partial<ProjectState["titleStyle"]>) => {
    update((p) => ({ ...p, titleStyle: { ...p.titleStyle, ...patch } }));
  }, [update]);
  const patchSlot = useCallback((rank: number, patch: Partial<ProjectState["slots"][number]>) => {
    update((p) => ({ ...p, slots: p.slots.map((x) => (x.rank === rank ? { ...x, ...patch } : x)) }));
  }, [update]);

  return (
    <main data-ui={UI_MARKER}>
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

      {/* ================= top bar ================= */}
      <header className="topbar">
        <div className="logo"><span className="logo-badge">R</span> Ranking Studio <span className="web">Web</span></div>
        <input
          className="proj-name"
          type="text"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          aria-label="Project name"
        />
        <span className="hint">100% in-browser · no uploads · no watermark · no account</span>
        <button className="btn small" onClick={newProject}>{I.plus} New</button>
        <button className="btn small" onClick={() => projectFileRef.current?.click()}>{I.folder} Open</button>
        <button className="btn small" onClick={saveProject}>{I.save} Save</button>
        <button className="btn primary" onClick={goExportTab}>{I.download} Export</button>
        <input
          ref={projectFileRef}
          className="hidden-input"
          type="file"
          accept="application/json,.json"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openProjectFile(f); e.target.value = ""; }}
        />
      </header>

      {/* ================= slim hero (the one H1) ================= */}
      <div className="hero">
        <h1>Ranking Studio Web - Free Ranking Video Maker for Top 3-10 Countdowns</h1>
        <p>Add your clips to numbered slots, style the countdown, preview it live and export a finished video - everything happens on your device.</p>
      </div>

      <div className={`statusbar ${statusKind}`} role="status">
        <span className="dot" />
        <span>{status}</span>
      </div>

      <div className="workspace">
        {/* ================= left control panel ================= */}
        <aside className="panel-col" ref={panelRef}>
          <nav className="tabs" aria-label="Editor sections">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab-btn ${tab === t.key ? "on" : ""}`}
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>

          <div className="tab-body">
            {/* ---------- CLIPS TAB ---------- */}
            {tab === "clips" && (
              <>
                <div>
                  <p className="micro">Ranking size</p>
                  <Seg
                    className="nums"
                    ariaLabel="Ranking size"
                    value={String(project.count)}
                    options={[3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: String(n), label: String(n) }))}
                    onChange={(v) => setCount(parseInt(v, 10))}
                  />
                  <p className="micro-note" style={{ margin: "8px 0 0" }}>Top {project.count} - every rank gets its own numbered slot below.</p>
                </div>

                <div>
                  <p className="micro">Playback order</p>
                  <Seg
                    ariaLabel="Playback order"
                    value={project.playbackOrder}
                    options={[
                      { value: "descending" as const, label: "Countdown" },
                      { value: "ascending" as const, label: "Ascending" },
                      { value: "random" as const, label: "Random" },
                    ]}
                    onChange={(v) => {
                      update((p) => ({ ...p, playbackOrder: v, randomOrder: v === "random" && p.randomOrder.length === 0 ? shuffled(p.slots.filter((s) => s.url).map((s) => s.rank)) : p.randomOrder }));
                      setSeqPos(0); setPlaying(false);
                    }}
                  />
                  {project.playbackOrder === "random" && (
                    <button className="btn small" style={{ marginTop: 9 }} onClick={newMix}>{I.replace} New mix</button>
                  )}
                </div>

                <label className="btn" style={{ width: "100%" }}>
                  {I.upload} Add multiple clips (fills empty slots)
                  <input className="hidden-input" type="file" accept="video/*" multiple onChange={(e) => { if (e.target.files) void bulkAdd(e.target.files); e.target.value = ""; }} />
                </label>

                <div>
                  <p className="micro">Slots</p>
                  <p className="micro-note">Upload a video per rank, rename its label, trim it and set its volume. MP4 (H.264), WebM or MOV work best.</p>
                  {project.slots.map((s) => (
                    <div
                      className={`clip-card ${dragRank === s.rank ? "dragover" : ""}`}
                      key={s.id}
                      onDragOver={(e) => { e.preventDefault(); setDragRank(s.rank); }}
                      onDragLeave={() => setDragRank((d) => (d === s.rank ? null : d))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragRank(null);
                        const f = e.dataTransfer.files?.[0];
                        if (f) void assignFileToSlot(s.rank, f);
                      }}
                    >
                      <div className="clip-top">
                        <span className="rank-badge">{s.rank}</span>
                        {s.url
                          ? (posters[s.url]
                            ? <img className="thumb" src={posters[s.url]} alt={`Rank ${s.rank} thumbnail`} />
                            : <span className="thumb-empty">{I.film}</span>)
                          : null}
                        <div className="clip-main">
                          <input
                            type="text"
                            className="ghost-input"
                            value={s.label}
                            aria-label={`Label for rank ${s.rank}`}
                            onChange={(e) => patchSlot(s.rank, { label: e.target.value })}
                          />
                          {s.fileName
                            ? <span className="fname" title={s.fileName}>{s.fileName}{s.duration > 0 && <span className="dur"> · {fmtTime(s.duration)}</span>}</span>
                            : s.needsRelink
                              ? <span className="relink">File needs re-linking</span>
                              : <span className="fname">Empty slot</span>}
                          <div className="clip-actions">
                            <ColorField
                              label={`Text colour for rank ${s.rank}`}
                              value={s.color}
                              onChange={(v) => patchSlot(s.rank, { color: v })}
                            />
                          </div>
                        </div>
                      </div>

                      {s.url ? (
                        <>
                          <div className="clip-actions">
                            <label className="btn small">
                              {I.replace} Replace
                              <input className="hidden-input" type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignFileToSlot(s.rank, f); e.target.value = ""; }} />
                            </label>
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => { const idx = seq.indexOf(s.rank); if (idx >= 0) { setPlaying(false); setSeqPos(idx); const v = videoRefs.current.get(s.rank); if (v) { try { v.currentTime = s.start; } catch { /* ignore */ } } } }}
                            >
                              {I.eye} Preview
                            </button>
                            <button
                              type="button"
                              className={`icon-btn ${s.muted ? "on" : ""}`}
                              aria-label={s.muted ? `Unmute clip ${s.rank}` : `Mute clip ${s.rank}`}
                              title={s.muted ? "Unmute this clip" : "Mute this clip"}
                              onClick={() => patchSlot(s.rank, { muted: !s.muted })}
                            >
                              {s.muted ? I.muted : I.volume}
                            </button>
                            <button type="button" className="icon-btn danger" aria-label={`Remove clip ${s.rank}`} title="Remove clip" onClick={() => removeSlotMedia(s.rank)}>
                              {I.trash}
                            </button>
                          </div>
                          <div className="trim-box">
                            <div className="field">
                              <span>Trim start · {fmtTime(s.start)} of {fmtTime(s.duration)}</span>
                              <div className="slider-row">
                                <Range
                                  value={s.start} min={0} max={Math.max(0, s.duration - 0.1)} step={0.1} ariaLabel={`Trim start for rank ${s.rank}`}
                                  onChange={(val) => patchSlot(s.rank, { start: Math.max(0, Math.min(val, s.end - 0.1)) })}
                                />
                                <input
                                  type="number" className="num" min={0} step={0.1} value={Number(s.start.toFixed(1))} aria-label={`Trim start seconds for rank ${s.rank}`}
                                  onChange={(e) => patchSlot(s.rank, { start: Math.max(0, Math.min(parseFloat(e.target.value || "0"), s.end - 0.1)) })}
                                />
                              </div>
                            </div>
                            <div className="field">
                              <span>Trim end · {fmtTime(s.end)} · plays {fmtTime(trimmedLength(s))}</span>
                              <div className="slider-row">
                                <Range
                                  value={s.end} min={0.1} max={Math.max(0.1, s.duration)} step={0.1} ariaLabel={`Trim end for rank ${s.rank}`}
                                  onChange={(val) => patchSlot(s.rank, { end: Math.min(Math.max(val, s.start + 0.1), s.duration || Math.max(val, s.start + 0.1)) })}
                                />
                                <input
                                  type="number" className="num" min={0} step={0.1} value={Number(s.end.toFixed(1))} aria-label={`Trim end seconds for rank ${s.rank}`}
                                  onChange={(e) => patchSlot(s.rank, { end: Math.min(Math.max(parseFloat(e.target.value || "0"), s.start + 0.1), s.duration || parseFloat(e.target.value || "0")) })}
                                />
                              </div>
                            </div>
                            <SliderRow
                              label={`Clip volume · ${Math.round(s.volume * 100)}%`}
                              value={s.volume} min={0} max={1} step={0.05}
                              onChange={(val) => patchSlot(s.rank, { volume: val })}
                            />
                            <Toggle
                              label="Mute this clip"
                              checked={s.muted}
                              onChange={(v) => patchSlot(s.rank, { muted: v })}
                            />
                          </div>
                        </>
                      ) : (
                        <label className="dropzone">
                          <span style={{ color: "var(--accent-hi)", display: "grid", placeItems: "center" }}>{I.upload}</span>
                          <span className="dz-title">Upload video</span>
                          <span>Drop a file here, or click to browse</span>
                          <input className="hidden-input" type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignFileToSlot(s.rank, f); e.target.value = ""; }} />
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ---------- TEXT TAB ---------- */}
            {tab === "text" && (
              <div className="stack">
                <div className="field">
                  <span>Video title (one line per line)</span>
                  <textarea value={project.title} onChange={(e) => update((p) => ({ ...p, title: e.target.value }))} aria-label="Video title" />
                </div>

                <div>
                  <p className="micro">Typography</p>
                  <div className="stack">
                    <div className="row">
                      <div className="field">
                        <span>Font</span>
                        <select value={ts.font} onChange={(e) => setTitleStyle({ font: e.target.value })} aria-label="Title font">
                          {FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </div>
                      <div className="field" style={{ flex: "0 0 96px" }}>
                        <span>Title size</span>
                        <input type="number" min={24} max={220} value={ts.size} aria-label="Title size" onChange={(e) => setTitleStyle({ size: Math.min(220, Math.max(24, parseFloat(e.target.value || "96"))) })} />
                      </div>
                    </div>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <ColorField label="Title colour" value={ts.color} onChange={(v) => setTitleStyle({ color: v })} />
                      <div className="field" style={{ flex: 1 }}>
                        <span>Alignment</span>
                        <Seg
                          ariaLabel="Title alignment"
                          value={project.titleAlign}
                          options={[
                            { value: "left" as const, label: "Left" },
                            { value: "center" as const, label: "Center" },
                            { value: "right" as const, label: "Right" },
                          ]}
                          onChange={(v) => update((p) => ({ ...p, titleAlign: v }))}
                        />
                      </div>
                    </div>
                    <Toggle label="Bold" checked={ts.bold} onChange={(v) => setTitleStyle({ bold: v })} />
                    <Toggle label="Italic" checked={ts.italic} onChange={(v) => setTitleStyle({ italic: v })} />
                  </div>
                </div>

                <div className="divider" />

                <div>
                  <p className="micro">Outline &amp; shadow</p>
                  <div className="stack">
                    <SliderRow label="Outline width" value={ts.outline} min={0} max={12} step={0.2} display={ts.outline.toFixed(1)} onChange={(v) => setTitleStyle({ outline: v })} />
                    <ColorField label="Outline colour" value={ts.outlineColor} onChange={(v) => setTitleStyle({ outlineColor: v })} />
                    <Toggle label="Shadow" checked={ts.shadow} onChange={(v) => setTitleStyle({ shadow: v })} />
                    <SliderRow label="Shadow depth" value={ts.shadowDepth} min={0} max={12} step={0.2} display={ts.shadowDepth.toFixed(1)} onChange={(v) => setTitleStyle({ shadowDepth: v })} />
                  </div>
                </div>

                <div className="divider" />

                <div>
                  <p className="micro">Box &amp; spacing</p>
                  <div className="stack">
                    <Toggle label="Box behind text" checked={ts.background} onChange={(v) => setTitleStyle({ background: v })} />
                    <ColorField label="Box colour" value={ts.backgroundColor} onChange={(v) => setTitleStyle({ backgroundColor: v })} />
                    <SliderRow label="Letter spacing" value={ts.tracking} min={-2} max={10} step={0.25} display={ts.tracking.toFixed(2)} onChange={(v) => setTitleStyle({ tracking: v })} />
                    <SliderRow label="Line spacing" value={ts.lineSpacing} min={90} max={160} step={2} display={`${Math.round(ts.lineSpacing)}%`} onChange={(v) => setTitleStyle({ lineSpacing: v })} />
                  </div>
                </div>

                <div className="divider" />

                <div>
                  <p className="micro">Highlight &amp; labels</p>
                  <p className="micro-note">One shared style drives the title and the ranking labels - labels keep their own size and per-slot colours.</p>
                  <div className="stack">
                    <div className="field">
                      <span>Highlight word in title</span>
                      <input type="text" value={project.titleHighlight} placeholder="e.g. FUNNIEST" onChange={(e) => update((p) => ({ ...p, titleHighlight: e.target.value }))} />
                    </div>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <ColorField label="Highlight colour" value={project.titleHighlightColor} onChange={(v) => update((p) => ({ ...p, titleHighlightColor: v }))} />
                      <ColorField label="Number colour" value={project.numberColor} onChange={(v) => update((p) => ({ ...p, numberColor: v }))} />
                    </div>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <ColorField label="Active colour" value={project.activeHighlightColor} onChange={(v) => update((p) => ({ ...p, activeHighlightColor: v }))} />
                      <div className="field" style={{ flex: "0 0 96px" }}>
                        <span>Label size</span>
                        <input type="number" min={20} max={140} value={project.labelSize} aria-label="Label size" onChange={(e) => update((p) => ({ ...p, labelSize: Math.min(140, Math.max(20, parseFloat(e.target.value || "56"))) }))} />
                      </div>
                    </div>
                    <Toggle label="Show title" checked={project.showTitle} onChange={(v) => update((p) => ({ ...p, showTitle: v }))} />
                    <Toggle label="Show ranking labels" checked={project.showLabels} onChange={(v) => update((p) => ({ ...p, showLabels: v }))} />
                    <div className="field">
                      <span>Ranking labels</span>
                      <Seg
                        ariaLabel="Ranking label mode"
                        value={project.labelMode}
                        options={[
                          { value: "all" as const, label: "All visible" },
                          { value: "activeFade" as const, label: "Active + faded" },
                          { value: "currentOnly" as const, label: "Current only" },
                          { value: "step" as const, label: "Step reveal" },
                        ]}
                        onChange={(v) => update((p) => ({ ...p, labelMode: v }))}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ---------- PRESETS TAB ---------- */}
            {tab === "presets" && (
              <div className="stack">
                <div>
                  <p className="micro">Text presets · 32</p>
                  <p className="micro-note">Ready-made title looks. Applying one changes typography only - your words, clips, trims and canvas stay untouched.</p>
                  <input type="text" placeholder="Search text styles" value={presetSearch} onChange={(e) => setPresetSearch(e.target.value)} aria-label="Search text styles" />
                </div>
                <div className="chips">
                  {PRESET_CATEGORIES.map((c) => (
                    <button key={c} type="button" className={`chip ${presetCat === c ? "on" : ""}`} onClick={() => setPresetCat(c)}>{c}</button>
                  ))}
                </div>
                <div className="preset-grid">
                  {filteredPresets.map((pr) => {
                    const fam = presetFontToWeb(pr.font);
                    return (
                      <button
                        key={pr.name}
                        type="button"
                        className={`preset-card ${activePreset === pr.name ? "active" : ""}`}
                        onClick={() => { setActivePreset(pr.name); update((p) => applyPreset(p, pr)); say(`Applied text preset "${pr.name}". Words, clips and trims were kept.`, "ok"); }}
                      >
                        {activePreset === pr.name && <span className="preset-check">✓</span>}
                        <span className="preset-stage">
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
                        </span>
                        <span>
                          <span className="preset-name">{pr.name}</span>
                          <span className="preset-cat">{pr.category} · {fam}</span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredPresets.length === 0 && <p className="micro-note">No matching presets. Try another category or search.</p>}
                </div>
              </div>
            )}

            {/* ---------- CANVAS TAB ---------- */}
            {tab === "canvas" && (
              <div className="stack">
                <div>
                  <p className="micro">Canvas size</p>
                  <p className="micro-note">Canvas size is the export size.</p>
                  <div className="canvas-grid">
                    {CANVAS_PRESETS.map((c) => {
                      const ratio = c.width / c.height;
                      const h = 30;
                      const w = Math.max(12, Math.round(h * ratio));
                      return (
                        <button
                          key={c.key}
                          type="button"
                          className={`canvas-card ${project.canvas === c.key ? "on" : ""}`}
                          aria-pressed={project.canvas === c.key}
                          onClick={() => update((p) => ({ ...p, canvas: c.key }))}
                        >
                          <span className="shape" style={{ width: w, height: h }} />
                          {c.ratio}
                          <span className="dims">{c.width}×{c.height}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="field">
                  <span>Video fit</span>
                  <Seg
                    ariaLabel="Video fit"
                    value={project.fit}
                    options={[
                      { value: "Contain" as const, label: "Contain · whole clip" },
                      { value: "Cover" as const, label: "Cover · fill + crop" },
                    ]}
                    onChange={(v) => update((p) => ({ ...p, fit: v }))}
                  />
                  <p className="micro-note" style={{ margin: 0 }}>Fit decides how each clip sits inside the canvas; the blurred background fills the empty space with the same frame, blurred.</p>
                </div>
                <Toggle
                  label="Blurred background"
                  sub="Fill empty space with the same frame, blurred"
                  checked={project.blurBackground}
                  onChange={(v) => update((p) => ({ ...p, blurBackground: v }))}
                />
                <ColorField label="Canvas colour" value={project.canvasColor} onChange={(v) => update((p) => ({ ...p, canvasColor: v }))} />
              </div>
            )}

            {/* ---------- AUDIO TAB ---------- */}
            {tab === "audio" && (
              <div className="stack">
                <div>
                  <p className="micro">Background music</p>
                  <p className="micro-note">A local audio file mixed under your clips - in the preview and in both export formats.</p>
                  <div className="stack" style={{ gap: 10 }}>
                    <label className="btn" style={{ width: "100%" }}>
                      {I.audio} {project.music.url ? "Replace music" : "Add background music"}
                      <input className="hidden-input" type="file" accept="audio/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignMusic(f); e.target.value = ""; }} />
                    </label>
                    {project.music.fileName
                      ? <span className="fname" title={project.music.fileName}>{project.music.fileName}</span>
                      : project.music.needsRelink
                        ? <span className="relink">Music file needs re-linking</span>
                        : <span className="fname">No music added</span>}
                    {project.music.url && (
                      <button type="button" className="btn small danger" onClick={() => update((p) => { if (p.music.url) URL.revokeObjectURL(p.music.url); return { ...p, music: { ...p.music, url: null, fileName: null, needsRelink: false } }; })}>
                        {I.trash} Remove music
                      </button>
                    )}
                  </div>
                </div>
                <SliderRow
                  label={`Music volume · ${Math.round(project.music.volume * 100)}%`}
                  value={project.music.volume} min={0} max={1} step={0.05}
                  onChange={(val) => { update((p) => ({ ...p, music: { ...p.music, volume: val } })); if (musicRef.current) musicRef.current.volume = val; }}
                />
                <Toggle label="Loop music" sub="Repeat the track for the whole video" checked={project.music.loop} onChange={(v) => update((p) => ({ ...p, music: { ...p.music, loop: v } }))} />
                <div className="divider" />
                <p className="micro-note" style={{ margin: 0 }}>Per-clip volume and mute live on each clip card in the Clips tab.</p>
              </div>
            )}

            {/* ---------- EXPORT TAB ---------- */}
            {tab === "export" && (
              <div className="stack">
                <div>
                  <p className="micro">Export video</p>
                  <p className="micro-note">Renders at <strong style={{ color: "var(--text)" }}>{def.width} × {def.height}</strong> on this device - nothing is uploaded.</p>
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="cap-row">
                      <span className={`dot ${hasWebCodecs ? "ok" : "no"}`} />
                      MP4 via WebCodecs
                      <span className="val">{hasWebCodecs ? "Supported" : "Not supported here"}</span>
                    </div>
                    <div className="cap-row">
                      <span className={`dot ${hasMp4Audio === null ? "" : hasMp4Audio ? "ok" : "no"}`} />
                      MP4 audio (AAC)
                      <span className="val">{hasMp4Audio === null ? "Checking..." : hasMp4Audio ? "Supported" : "Not supported here"}</span>
                    </div>
                  </div>
                </div>

                <div className="field">
                  <span>Format</span>
                  <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)} aria-label="Export format">
                    <option value="auto">Auto (MP4 if supported, else WebM)</option>
                    <option value="mp4">MP4 - with audio where supported</option>
                    <option value="webm">WebM - with audio (realtime)</option>
                  </select>
                </div>

                <div className="note-card">
                  <p><strong>MP4 (WebCodecs):</strong> the fast export - rendered with an accelerated play-and-capture pipeline, usually the sharpest result - on browsers with AAC encoding (Chrome and Edge) it <strong>includes clip sound + background music</strong> mixed into the file. If this browser cannot encode AAC audio, the MP4 still exports but without sound, and the result message will say so clearly.</p>
                  <p><strong>WebM (MediaRecorder):</strong> recorded in realtime while the sequence plays, and it <strong>includes clip sound + background music</strong>. It remains the fallback - and the safe pick for sound in browsers without WebCodecs audio.</p>
                  <p>Clip sound is read straight out of the video file in your browser, and every MP4 export checks that the mixed sound is not silent: if the sound in your files could not be read here, the MP4 result will say so clearly and point you to WebM instead of quietly shipping a soundless file.</p>
                  <p><strong>Speed note:</strong> MP4 is the fast export. WebM records in realtime, so a WebM export takes as long as the video itself.</p>
                </div>

                <p className="micro-note" style={{ margin: 0 }}>Total length: <strong style={{ color: "var(--text)" }}>{fmtTime(total)}</strong> · {seq.length} clip(s) in the current playback order</p>

                {!exporting
                  ? <button className="btn primary" style={{ width: "100%", padding: "12px 14px", fontSize: 14 }} onClick={() => void startExport()} disabled={!seq.length}>{I.download} Export video</button>
                  : <button className="btn danger" style={{ width: "100%", padding: "12px 14px", fontSize: 14 }} onClick={() => exportHandleRef.current?.cancel()}>Cancel export</button>}
                {exporting && (
                  <>
                    <div className="exportbar"><div style={{ width: `${exportRatio * 100}%` }} /></div>
                    <p className="micro-note" style={{ margin: 0 }}>{exportPhase} - {Math.round(exportRatio * 100)}%</p>
                  </>
                )}

                <div className="divider" />
                <p className="micro-note" style={{ margin: 0 }}>
                  Project files (.rankstudio.json) save your settings, labels and trims. Video and music files are never stored -
                  reopening a project asks you to re-link each file with its Upload button. Your current settings autosave in this browser.
                </p>
              </div>
            )}
          </div>
        </aside>

        {/* ================= centre stage ================= */}
        <section className="stage-col">
          <div className="stage">
            <canvas ref={canvasRef} className="screen" width={previewW} height={previewH} style={{ aspectRatio: `${def.width} / ${def.height}` }} />
            <div className="stage-meta">
              <span className="meta-chip">Canvas <strong>{def.width} × {def.height}</strong> ({def.ratio})</span>
              <span className="meta-chip">Length <strong>{fmtTime(total)}</strong></span>
              <span className="meta-chip"><strong>{seq.length}</strong> clip(s)</span>
            </div>
            <div className="now-playing" ref={nowPlayingRef}>Nothing loaded yet - upload a clip into a slot to begin.</div>
          </div>

          <div className="transport">
            <button
              type="button"
              className="play-btn"
              aria-label={playing ? "Pause preview" : "Play preview"}
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
              {playing ? I.pause : I.play}
            </button>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 38, height: 38, borderRadius: 99 }}
              aria-label="Restart preview"
              title="Restart"
              onClick={() => { setPlaying(false); setSeqPos(0); const r = seq[0]; const v = r ? videoRefs.current.get(r) : undefined; const s = r ? slotByRank(project, r) : undefined; if (v && s) { try { v.currentTime = s.start; } catch { /* ignore */ } } if (musicRef.current) { try { musicRef.current.currentTime = 0; } catch { /* ignore */ } } }}
            >
              {I.restart}
            </button>
            <div className="progress"><div ref={progressBarRef} /></div>
            <span className="time" ref={timeLabelRef}>00:00 / {fmtTime(total)}</span>
          </div>

          <div className="export-strip">
            {exporting ? (
              <>
                <div className="exportbar"><div style={{ width: `${exportRatio * 100}%` }} /></div>
                <span className="status" style={{ fontSize: 12.5, color: "var(--muted)" }}>{exportPhase} - {Math.round(exportRatio * 100)}%</span>
                <button type="button" className="btn small danger" onClick={() => exportHandleRef.current?.cancel()}>Cancel</button>
              </>
            ) : (
              <>
                <span className="grow" style={{ fontSize: 13, color: "var(--muted)" }}>
                  Ready when you are - exports render on this device at <strong style={{ color: "var(--text)" }}>{def.width} × {def.height}</strong>.
                </span>
                <button type="button" className="btn" onClick={goExportTab}>Export settings</button>
                <button type="button" className="btn primary" onClick={() => void startExport()} disabled={!seq.length}>{I.download} Export video</button>
              </>
            )}
          </div>

          <p className="stage-note">
            Preview and export share the same renderer, so titles and ranking labels land in the exported file exactly as you see them here.
          </p>
        </section>
      </div>

      {/* ================= SEO content ================= */}
      <div className="seo">
        <h2>How to make a ranking video</h2>
        <ol>
          <li><span className="step-num">1</span><strong>Pick your list size</strong>Choose Top 3 up to Top 10 - every rank gets its own numbered slot.</li>
          <li><span className="step-num">2</span><strong>Add one clip per rank</strong>Upload a video into each slot, rename its label and pick its text colour. Use Add multiple clips to fill empty slots in one go.</li>
          <li><span className="step-num">3</span><strong>Trim each clip</strong>Drag the start and end sliders so only the moment that matters plays. Set clip volume, or mute a clip, per slot.</li>
          <li><span className="step-num">4</span><strong>Choose the playback order</strong>Countdown plays Top N down to number 1, ascending plays 1 up, and random shuffles a fresh mix you can preview before exporting.</li>
          <li><span className="step-num">5</span><strong>Style the title</strong>Pick one of 32 text presets or build your own look - font, outline, shadow, box, highlight word and alignment are all editable.</li>
          <li><span className="step-num">6</span><strong>Set the canvas</strong>9:16 for Shorts, Reels and TikTok, 4:5 for portrait posts, 1:1 for square. Add a local music file if you want a backing track.</li>
          <li><span className="step-num">7</span><strong>Export</strong>Download an MP4 or a WebM - both include your clip sound and background music on supported browsers, rendered entirely on your device.</li>
        </ol>

        <h2>Why make ranking videos here?</h2>
        <ul>
          <li><strong>Private by design</strong>Your clips never leave your device. There is no server upload and no account.</li>
          <li><strong>No watermark</strong>Exports are clean, at full canvas resolution.</li>
          <li><strong>Preview = export</strong>The live preview and the exporter draw with the same renderer, so the title and ranking list you see are what you get.</li>
          <li><strong>Portable projects</strong>Save a small project file with your settings and trims, and re-link the media whenever you come back.</li>
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
