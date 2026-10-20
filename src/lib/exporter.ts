// In-browser export. Two engines, both 100% client-side:
//
// 1) MP4 via WebCodecs + mp4-muxer (v2): the trimmed sequence is rendered
//    frame-by-frame (offline, faster or slower than realtime depending on
//    the machine) onto a canvas at the chosen export size, and each frame is
//    encoded as H.264. The sound is built as one offline Web Audio timeline
//    (each clip's trimmed audio in playback order, with its volume/mute,
//    plus the background music mixed underneath), encoded to AAC with
//    WebCodecs AudioEncoder and muxed into the same MP4. Browsers without
//    AAC encoding still get the MP4, but video-only - the export result
//    carries a clear warning in that case (also stated in the UI).
//
// 2) WebM via canvas.captureStream + MediaRecorder: realtime playback of the
//    sequence while the canvas and a WebAudio mix (clip sound + background
//    music) are recorded. This path also includes audio.
//
// The overlay (title + ranking list) is drawn with the exact same renderer
// as the live preview in both engines.

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { ProjectState, canvasDef, playbackSequence, slotByRank, totalDuration, trimmedLength } from "./types";
import { drawOverlay, drawVideoFrame } from "./draw";

export interface ExportProgress {
  phase: string;
  ratio: number; // 0..1
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  format: "mp4" | "webm";
  includesAudio: boolean;
  /** Set when the project had audio but this browser could not put it into the MP4. */
  audioWarning?: string;
}

export function webCodecsSupported(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

// ------------------------------------------------------------------ audio
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AAC_CODEC = "mp4a.40.2"; // AAC-LC
const AAC_BITRATE = 128_000;

function aacConfig(): AudioEncoderConfig {
  return {
    codec: AAC_CODEC,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AAC_BITRATE,
  };
}

/** True when this browser can encode AAC for MP4 with WebCodecs. */
export async function mp4AudioSupported(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !("AudioEncoder" in window)) return false;
    const support = await AudioEncoder.isConfigSupported(aacConfig());
    return !!support.supported;
  } catch {
    return false;
  }
}

interface CollectedAudioChunk {
  chunk: EncodedAudioChunk;
  meta?: EncodedAudioChunkMetadata;
}

interface AudioPrep {
  /** Project actually has sound sources (clips and/or music). */
  hasSources: boolean;
  chunks: CollectedAudioChunk[];
  warning?: string;
}

const AAC_FALLBACK_NOTE =
  "Use the WebM export in this browser if you need the sound in the file.";

async function decodeWith(
  decodeCtx: BaseAudioContext,
  url: string,
): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.arrayBuffer();
    if (!raw.byteLength) return null;
    // decodeAudioData detaches the buffer it is given - hand it a copy.
    return await decodeCtx.decodeAudioData(raw.slice(0));
  } catch {
    // No decodable audio track (or a decode failure) = silence, never a crash.
    return null;
  }
}

/**
 * Render the whole project sound into one AudioBuffer with OfflineAudioContext:
 * clips in playback sequence, each sliced to its trim range and placed at its
 * timeline offset with volume/mute applied; music mixed underneath (looped
 * to the total length when the project's loop setting is on).
 */
async function buildAudioTimeline(
  p: ProjectState,
  seq: number[],
  isCancelled: () => boolean,
  onProgress: (pr: ExportProgress) => void,
): Promise<AudioBuffer> {
  const total = totalDuration(p);
  const frames = Math.max(1, Math.ceil(total * AUDIO_SAMPLE_RATE));
  const offline = new OfflineAudioContext(AUDIO_CHANNELS, frames, AUDIO_SAMPLE_RATE);

  let offset = 0;
  for (let pos = 0; pos < seq.length; pos++) {
    if (isCancelled()) throw new Error("Export cancelled.");
    const slot = slotByRank(p, seq[pos]);
    if (!slot) continue;
    const len = trimmedLength(slot);
    if (len <= 0) continue;
    if (slot.url && !slot.muted && slot.volume > 0) {
      onProgress({ phase: `Preparing audio - clip ${pos + 1} of ${seq.length} (MP4)`, ratio: 0 });
      const decoded = await decodeWith(offline, slot.url);
      if (decoded && slot.start < decoded.duration) {
        const src = offline.createBufferSource();
        src.buffer = decoded;
        const gain = offline.createGain();
        gain.gain.value = Math.min(1, Math.max(0, slot.volume));
        src.connect(gain);
        gain.connect(offline.destination);
        const usable = Math.min(len, decoded.duration - slot.start);
        if (usable > 0.01) src.start(offset, slot.start, usable);
      }
      // No decoded audio -> this clip's slice stays silent.
    }
    offset += len;
  }

  if (p.music.url && p.music.volume > 0) {
    if (isCancelled()) throw new Error("Export cancelled.");
    onProgress({ phase: "Preparing audio - background music (MP4)", ratio: 0 });
    const decodedMusic = await decodeWith(offline, p.music.url);
    if (decodedMusic && decodedMusic.duration > 0) {
      const src = offline.createBufferSource();
      src.buffer = decodedMusic;
      src.loop = p.music.loop;
      const gain = offline.createGain();
      gain.gain.value = Math.min(1, Math.max(0, p.music.volume));
      src.connect(gain);
      gain.connect(offline.destination);
      src.start(0);
      // Looping sources fill the whole timeline; a non-looping track plays
      // once. Either way nothing may run past the end of the project.
      try { src.stop(total); } catch { /* already stopped */ }
    }
  }

  onProgress({ phase: "Mixing audio timeline (MP4)", ratio: 0 });
  return offline.startRendering();
}

/** Encode a rendered AudioBuffer to AAC chunks with WebCodecs AudioEncoder. */
async function encodeAudioAac(
  rendered: AudioBuffer,
  isCancelled: () => boolean,
): Promise<CollectedAudioChunk[]> {
  const chunks: CollectedAudioChunk[] = [];
  let encoderError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => { chunks.push({ chunk, meta }); },
    error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(aacConfig());

  const FRAMES_PER_CHUNK = 1024; // one AAC frame
  try {
    for (let frameOffset = 0; frameOffset < rendered.length; frameOffset += FRAMES_PER_CHUNK) {
      if (isCancelled()) throw new Error("Export cancelled.");
      if (encoderError) throw encoderError;
      const frames = Math.min(FRAMES_PER_CHUNK, rendered.length - frameOffset);
      // f32-planar: channel 0 frames first, then channel 1 frames.
      const data = new Float32Array(frames * AUDIO_CHANNELS);
      for (let ch = 0; ch < AUDIO_CHANNELS; ch++) {
        const source = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
        data.set(source.subarray(frameOffset, frameOffset + frames), ch * frames);
      }
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfFrames: frames,
        numberOfChannels: AUDIO_CHANNELS,
        timestamp: Math.round((frameOffset / AUDIO_SAMPLE_RATE) * 1_000_000),
        data: data.buffer,
      });
      encoder.encode(audioData);
      audioData.close();
      while (encoder.encodeQueueSize > 24 && !encoderError) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (encoderError) throw encoderError;
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    try { encoder.close(); } catch { /* ignore */ }
  }
  return chunks;
}

/**
 * Full MP4-audio preparation: capability check -> offline mix -> AAC encode.
 * Never throws for capability/decode problems; it reports a warning instead
 * so the caller can still ship the (video-only) MP4.
 */
async function prepareMp4Audio(
  p: ProjectState,
  seq: number[],
  isCancelled: () => boolean,
  onProgress: (pr: ExportProgress) => void,
): Promise<AudioPrep> {
  const hasSources = seq.some((r) => !!slotByRank(p, r)?.url) || !!p.music.url;
  if (!hasSources || totalDuration(p) <= 0) return { hasSources: false, chunks: [] };

  if (typeof window === "undefined" || !("AudioEncoder" in window)) {
    return {
      hasSources,
      chunks: [],
      warning: `This browser does not support WebCodecs audio encoding, so the MP4 was exported without sound. ${AAC_FALLBACK_NOTE}`,
    };
  }
  let supported = false;
  try {
    supported = !!(await AudioEncoder.isConfigSupported(aacConfig())).supported;
  } catch { supported = false; }
  if (!supported) {
    return {
      hasSources,
      chunks: [],
      warning: `AAC audio encoding is not supported in this browser, so the MP4 was exported without sound. ${AAC_FALLBACK_NOTE}`,
    };
  }

  try {
    const rendered = await buildAudioTimeline(p, seq, isCancelled, onProgress);
    if (isCancelled()) throw new Error("Export cancelled.");
    onProgress({ phase: "Encoding audio (AAC)", ratio: 0 });
    const chunks = await encodeAudioAac(rendered, isCancelled);
    if (!chunks.length) {
      return {
        hasSources,
        chunks: [],
        warning: `Audio encoding produced no sound data, so the MP4 was exported without sound. ${AAC_FALLBACK_NOTE}`,
      };
    }
    return { hasSources, chunks };
  } catch (e) {
    if (e instanceof Error && e.message === "Export cancelled.") throw e;
    return {
      hasSources,
      chunks: [],
      warning: `The sound could not be encoded in this browser (${e instanceof Error ? e.message : String(e)}), so the MP4 was exported without sound. ${AAC_FALLBACK_NOTE}`,
    };
  }
}

function waitEvent(el: HTMLElement, name: string): Promise<void> {
  return new Promise((resolve) => {
    const h = () => { el.removeEventListener(name, h); resolve(); };
    el.addEventListener(name, h);
  });
}

async function makeVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  if (v.readyState < 1) await waitEvent(v, "loadedmetadata");
  return v;
}

async function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  const clamped = Math.min(Math.max(t, 0), Math.max(0, (v.duration || t) - 0.001));
  if (Math.abs(v.currentTime - clamped) < 0.001 && v.readyState >= 2) return;
  const p = waitEvent(v, "seeked");
  v.currentTime = clamped;
  await p;
}

function downloadName(p: ProjectState, ext: string): string {
  const base = (p.name || "ranking").trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").toLowerCase() || "ranking";
  return `${base}.${ext}`;
}

export interface ExportHandle {
  promise: Promise<ExportResult>;
  cancel: () => void;
}

// ---------------------------------------------------------------- MP4 path
export function exportMp4(p: ProjectState, onProgress: (pr: ExportProgress) => void): ExportHandle {
  let cancelled = false;
  const isCancelled = () => cancelled;
  const promise = (async (): Promise<ExportResult> => {
    const def = canvasDef(p);
    const W = def.width;
    const H = def.height;
    const FPS = 30;
    const seq = playbackSequence(p);
    if (!seq.length) throw new Error("Add at least one video clip before exporting.");

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available in this browser.");

    // ---- Sound first: build + encode the audio timeline offline, so we
    // know whether this MP4 will carry an audio track before muxing.
    onProgress({ phase: "Preparing audio (MP4)", ratio: 0 });
    const audioPrep = await prepareMp4Audio(p, seq, isCancelled, onProgress);
    if (cancelled) throw new Error("Export cancelled.");
    const includesAudio = audioPrep.chunks.length > 0;

    // Video chunks are collected (not muxed on the fly) so audio and video
    // chunks can be handed to the muxer in one chronological merge below.
    interface CollectedVideoChunk { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }
    const videoChunks: CollectedVideoChunk[] = [];
    let encoderError: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => { videoChunks.push({ chunk, meta }); },
      error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
    });
    encoder.configure({
      codec: "avc1.640033", // High profile, level 5.1 - covers 1080x1920
      width: W,
      height: H,
      bitrate: 10_000_000,
      framerate: FPS,
    });

    const totalFrames = seq.reduce((sum, r) => {
      const s = slotByRank(p, r);
      return sum + Math.max(1, Math.round((s ? trimmedLength(s) : 0) * FPS));
    }, 0);
    let frameIndex = 0;

    try {
      for (let pos = 0; pos < seq.length; pos++) {
        if (cancelled) throw new Error("Export cancelled.");
        const rank = seq[pos];
        const slot = slotByRank(p, rank);
        if (!slot?.url) continue;
        const video = await makeVideo(slot.url);
        const len = trimmedLength(slot);
        const frames = Math.max(1, Math.round(len * FPS));
        for (let f = 0; f < frames; f++) {
          if (cancelled) throw new Error("Export cancelled.");
          if (encoderError) throw encoderError;
          const t = slot.start + f / FPS;
          await seekTo(video, t);
          drawVideoFrame(ctx, video, p, W, H);
          drawOverlay(ctx, p, W, H, { activeRank: rank, sequencePos: pos });
          const frame = new VideoFrame(canvas, {
            timestamp: Math.round((frameIndex * 1_000_000) / FPS),
            duration: Math.round(1_000_000 / FPS),
          });
          encoder.encode(frame, { keyFrame: frameIndex % (FPS * 2) === 0 });
          frame.close();
          frameIndex++;
          if (encoder.encodeQueueSize > 6) {
            await new Promise((r) => setTimeout(r, 0));
          }
          if (f % 5 === 0) onProgress({ phase: `Rendering clip ${pos + 1} of ${seq.length} (MP4)`, ratio: frameIndex / totalFrames });
        }
        video.removeAttribute("src");
        video.load();
      }
      onProgress({ phase: "Finishing MP4 file", ratio: 0.98 });
      await encoder.flush();
      if (encoderError) throw encoderError;
    } finally {
      try { encoder.close(); } catch { /* ignore */ }
    }

    // ---- Mux: merge-add every chunk (video + audio) in timestamp order.
    const target = new ArrayBufferTarget();
    const muxer = includesAudio
      ? new Muxer({
          target,
          video: { codec: "avc", width: W, height: H },
          audio: { codec: "aac", numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE },
          fastStart: "in-memory",
          firstTimestampBehavior: "offset",
        })
      : new Muxer({
          target,
          video: { codec: "avc", width: W, height: H },
          fastStart: "in-memory",
          firstTimestampBehavior: "offset",
        });

    type MergedChunk =
      | { kind: "video"; timestamp: number; chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }
      | { kind: "audio"; timestamp: number; chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata };
    const merged: MergedChunk[] = [
      ...videoChunks.map((v): MergedChunk => ({ kind: "video", timestamp: v.chunk.timestamp, chunk: v.chunk, meta: v.meta })),
      ...audioPrep.chunks.map((a): MergedChunk => ({ kind: "audio", timestamp: a.chunk.timestamp, chunk: a.chunk, meta: a.meta })),
    ];
    // Chronological across tracks; video wins ties deterministically.
    merged.sort((a, b) => (a.timestamp - b.timestamp) || (a.kind === b.kind ? 0 : a.kind === "video" ? -1 : 1));
    for (const item of merged) {
      if (item.kind === "video") muxer.addVideoChunk(item.chunk, item.meta);
      else muxer.addAudioChunk(item.chunk, item.meta);
    }
    muxer.finalize();
    const buffer = target.buffer;
    if (!buffer) throw new Error("Export produced no data.");
    onProgress({ phase: "Done", ratio: 1 });
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      filename: downloadName(p, "mp4"),
      format: "mp4",
      includesAudio,
      audioWarning: !includesAudio && audioPrep.hasSources ? audioPrep.warning : undefined,
    };
  })();
  return { promise, cancel: () => { cancelled = true; } };
}

// ---------------------------------------------------------------- WebM path
export function exportWebm(p: ProjectState, onProgress: (pr: ExportProgress) => void): ExportHandle {
  let cancelled = false;
  let cleanup: (() => void) | null = null;
  const promise = (async (): Promise<ExportResult> => {
    const def = canvasDef(p);
    const W = def.width;
    const H = def.height;
    const seq = playbackSequence(p);
    if (!seq.length) throw new Error("Add at least one video clip before exporting.");

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available in this browser.");

    // Audio graph: each export video element + the music element feed one mix.
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AC();
    const mixDest = audioCtx.createMediaStreamDestination();

    const videos = new Map<number, HTMLVideoElement>();
    for (const rank of seq) {
      const slot = slotByRank(p, rank);
      if (!slot?.url) continue;
      const v = await makeVideo(slot.url);
      v.muted = false;
      v.volume = slot.muted ? 0 : slot.volume;
      try {
        const src = audioCtx.createMediaElementSource(v);
        src.connect(mixDest);
      } catch { /* element already wired - ignore */ }
      videos.set(rank, v);
    }
    // Deliberately NOT connected to audioCtx.destination: the mix should be
    // recorded, not played aloud through the speakers during export.

    let musicEl: HTMLAudioElement | null = null;
    if (p.music.url) {
      musicEl = new Audio(p.music.url);
      musicEl.loop = p.music.loop;
      musicEl.volume = p.music.volume;
      try {
        const mSrc = audioCtx.createMediaElementSource(musicEl);
        const g = audioCtx.createGain();
        g.gain.value = 1;
        mSrc.connect(g); g.connect(mixDest);
      } catch { /* ignore */ }
    }

    const stream = canvas.captureStream(30);
    const combined = new MediaStream([...stream.getVideoTracks(), ...mixDest.stream.getAudioTracks()]);
    const mimeCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>((res) => { recorder.onstop = () => res(); });

    const total = seq.reduce((sum, r) => { const s = slotByRank(p, r); return sum + (s ? trimmedLength(s) : 0); }, 0);
    let elapsedBefore = 0;
    let raf = 0;
    let currentRank: number | null = null;
    let currentPos = 0;
    let activeVideo: HTMLVideoElement | null = null;

    cleanup = () => {
      cancelAnimationFrame(raf);
      try { recorder.state !== "inactive" && recorder.stop(); } catch { /* ignore */ }
      videos.forEach((v) => { try { v.pause(); } catch { /* ignore */ } });
      if (musicEl) { try { musicEl.pause(); } catch { /* ignore */ } }
      void audioCtx.close().catch(() => undefined);
    };

    recorder.start(250);
    if (musicEl) { void musicEl.play().catch(() => undefined); }

    await new Promise<void>((resolve, reject) => {
      const drawLoop = () => {
        if (cancelled) { reject(new Error("Export cancelled.")); return; }
        if (activeVideo && currentRank !== null) {
          drawVideoFrame(ctx, activeVideo, p, W, H);
          drawOverlay(ctx, p, W, H, { activeRank: currentRank, sequencePos: currentPos });
          const within = Math.max(0, activeVideo.currentTime - (slotByRank(p, currentRank)?.start ?? 0));
          onProgress({ phase: `Recording clip ${currentPos + 1} of ${seq.length} (WebM, realtime)`, ratio: Math.min(1, (elapsedBefore + within) / Math.max(total, 0.01)) });
        }
        raf = requestAnimationFrame(drawLoop);
      };
      drawLoop();

      (async () => {
        try {
          for (let pos = 0; pos < seq.length; pos++) {
            if (cancelled) throw new Error("Export cancelled.");
            const rank = seq[pos];
            const slot = slotByRank(p, rank);
            const v = videos.get(rank);
            if (!slot || !v) continue;
            currentRank = rank; currentPos = pos; activeVideo = v;
            await seekTo(v, slot.start);
            v.volume = slot.muted ? 0 : slot.volume;
            await v.play();
            await new Promise<void>((res) => {
              const check = () => {
                if (cancelled || v.currentTime >= slot.end - 0.03 || v.ended) { res(); return; }
                setTimeout(check, 40);
              };
              check();
            });
            v.pause();
            elapsedBefore += trimmedLength(slot);
          }
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    }).finally(() => {
      cancelAnimationFrame(raf);
    });

    if (musicEl) { try { musicEl.pause(); } catch { /* ignore */ } }
    if (cancelled) throw new Error("Export cancelled.");
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already stopped by cancel */ }
    await stopped;
    void audioCtx.close().catch(() => undefined);
    onProgress({ phase: "Done", ratio: 1 });
    return { blob: new Blob(chunks, { type: "video/webm" }), filename: downloadName(p, "webm"), format: "webm", includesAudio: true };
  })();
  return { promise, cancel: () => { cancelled = true; cleanup?.(); } };
}
