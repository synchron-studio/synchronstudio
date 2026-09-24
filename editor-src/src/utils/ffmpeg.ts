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

async function loadFrom(base: string): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
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
      return await loadFrom(localBase);
    } catch (localErr) {
      console.warn('Local FFmpeg load failed, trying CDN:', localErr);
      onStatus?.('Loading video engine from CDN…');
      return await loadFrom(CDN_BASE);
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
