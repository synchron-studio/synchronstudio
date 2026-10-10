/**
 * Gemeinsamer FFmpeg-Lader für alle Exporte.
 *
 * Vorher hatten zipExporter und ssExport je eine eigene Instanz — beide luden die
 * 32 MB WebAssembly-Datei getrennt. Außerdem merkte sich ssExport einen einzigen
 * Fehlschlag für immer: ein kurzer Netz-Aussetzer machte den Video-Export bis zum
 * Neuladen der Seite unmöglich.
 *
 * Single-thread core only (no workerURL) — works on GitHub Pages without COOP/COEP.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

const CDN_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

/** 32-MB-Datei mit Fortschritt laden. (Eigene Variante: die aus @ffmpeg/util bricht ab, wenn der
 *  Server komprimiert ausliefert und Content-Length dadurch nicht zur echten Größe passt.) */
async function blobUrlWithProgress(url: string, type: string, onPct?: (p: number) => void): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body?.getReader) return URL.createObjectURL(new Blob([await resp.arrayBuffer()], { type }));
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    if (total) onPct?.(Math.min(99, Math.round((got / total) * 100)));
  }
  return URL.createObjectURL(new Blob(parts as BlobPart[], { type }));
}

async function loadFrom(base: string, onPct?: (p: number) => void): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await blobUrlWithProgress(`${base}/ffmpeg-core.wasm`, 'application/wasm', onPct),
  });
  return ffmpeg;
}

/** Lädt FFmpeg (lokal, sonst CDN). Wirft, wenn beides scheitert — der nächste Aufruf versucht es erneut. */
export async function getFFmpeg(onStatus?: (s: string) => void): Promise<FFmpeg> {
  if (instance?.loaded) return instance;
  if (loading) return loading;
  loading = (async () => {
    try {
      onStatus?.('Loading video engine (FFmpeg)…');
      const localBase = new URL('ffmpeg/', window.location.href).href.replace(/\/$/, '');
      return await loadFrom(localBase, (p) => onStatus?.(`Loading video engine (FFmpeg)… ${p}%`));
    } catch (localErr) {
      console.warn('Local FFmpeg load failed, trying CDN:', localErr);
      onStatus?.('Loading video engine from CDN…');
      return await loadFrom(CDN_BASE, (p) => onStatus?.(`Loading video engine from CDN… ${p}%`));
    }
  })();
  try {
    instance = await loading;
    return instance;
  } finally {
    loading = null;
  }
}

/** Wie getFFmpeg, liefert aber null statt eines Fehlers. */
export async function tryGetFFmpeg(onStatus?: (s: string) => void): Promise<FFmpeg | null> {
  try {
    return await getFFmpeg(onStatus);
  } catch (err) {
    console.warn('FFmpeg unavailable:', err);
    return null;
  }
}

/** Laufende Arbeit hart abbrechen (Export abgebrochen). Die nächste Nutzung lädt neu. */
export function terminateFFmpeg(ffmpeg?: FFmpeg | null) {
  const target = ffmpeg || instance;
  try { target?.terminate(); } catch { /* egal */ }
  if (!ffmpeg || ffmpeg === instance) instance = null;
}

/** Dateien im virtuellen FFmpeg-Dateisystem aufräumen — sonst wächst der Speicher mit jedem Export. */
export async function cleanupFiles(ffmpeg: FFmpeg, names: string[]) {
  for (const name of names) {
    try { await ffmpeg.deleteFile(name); } catch { /* existiert nicht */ }
  }
}

/** Fortschritt von FFmpeg kann Unsinn liefern (negativ/riesig) — auf 0..1 begrenzen. */
export function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
}

/**
 * Video-Engine schon im Hintergrund laden (z. B. sobald ein Video im Projekt ist) — dann startet
 * der Export sofort, statt erst 32 MB nachzuladen. Fehler sind hier egal: der Export versucht es erneut.
 */
export function prefetchFFmpeg() {
  if (instance?.loaded || loading) return;
  const run = () => { getFFmpeg().catch(() => { /* später beim Export nochmal */ }); };
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 8000 });
  else setTimeout(run, 3000);
}
