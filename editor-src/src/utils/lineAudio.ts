/**
 * Welche Tonquelle bekommt eine exportierte Zeile?
 *
 * 1. Die optionale „Vocals only“-Spur: saubere Stimmen ohne Musik/Effekte. Sie hat Vorrang —
 *    früher gewann ein mitimportierter Clip-Ton (z. B. aus einem älteren Export), und schlechte
 *    alte Zeilen wurden so immer weiter vererbt.
 * 2. Ein importierter Clip-Ton (z. B. Einzelstimme aus einem Pack) — aber nur, solange die
 *    Zeile nicht verschoben/gekürzt wurde, sonst passt er nicht mehr zum Zeitfenster.
 * 3. Der Ton des Videos (Stimmen + Musik gemischt).
 * 4. Notfalls der importierte Clip-Ton, auch wenn verschoben — besser als gar nichts.
 *
 * Aus Spuren geschnittene Zeilen werden zu Mono gemacht (ohne Auslöschung bei gegenphasigen
 * Kanälen) und auf eine gut hörbare Lautstärke gebracht — vorher kamen manche Zeilen fast
 * unhörbar leise aus dem Export.
 */
import { MediaSource, TimelineClip } from '../types';
import { audioBufferToWavBlob, sliceAudioBuffer } from './audio';
import { asBlob } from './media';

export interface LineAudioSources {
  vocals?: MediaSource;
  video?: MediaSource;
}

const TARGET_PEAK = 0.89;   // ca. -1 dB
const MAX_GAIN = 12;        // höchstens ~ +21 dB, sonst wird nur Rauschen laut

/** Fast stille Zeile? (RMS unter ca. −50 dBFS) — dann stimmt meist die Vocals-Spur nicht zum Video. */
export function isNearlySilent(buf: AudioBuffer): boolean {
  let sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 4) { sum += d[i] * d[i]; n++; } }
  return !n || Math.sqrt(sum / n) < 0.003;
}
/** Wie viele Zeilen beim letzten Export fast still waren (für den Hinweis nach dem Export). */
export const lineAudioStats = { silent: 0 };

/** Mono-Mix + Spitzenpegel angleichen. */
export function prepareLineBuffer(buf: AudioBuffer): AudioBuffer {
  const n = buf.length;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const energy = (a: Float32Array | number[]) => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return e; };
  let mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (const ch of chans) v += ch[i]; mono[i] = v / chans.length; }
  // Löschen sich die Kanäle beim Zusammenmischen gegenseitig aus, den lautesten Kanal nehmen
  if (chans.length > 1) {
    const loudest = chans.reduce((a, b) => (energy(b) > energy(a) ? b : a));
    if (energy(mono) < energy(loudest) * 0.25) mono = Float32Array.from(loudest);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  const gain = peak > 1e-4 ? Math.min(MAX_GAIN, TARGET_PEAK / peak) : 1;
  const OfflineCtx = window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const out = new OfflineCtx(1, Math.max(1, n), buf.sampleRate).createBuffer(1, Math.max(1, n), buf.sampleRate);
  const o = out.getChannelData(0);
  for (let i = 0; i < n; i++) o[i] = Math.max(-1, Math.min(1, mono[i] * gain));
  return out;
}

export function clipAudioFor(clip: TimelineClip, from: number, to: number, sources: LineAudioSources): Blob | null {
  const own = asBlob(clip.audioBlob);
  const unmoved = clip.audioStart == null || clip.audioEnd == null ||
    (Math.abs(clip.audioStart - clip.startTime) < 0.002 && Math.abs(clip.audioEnd - clip.endTime) < 0.002);
  const slice = (media?: MediaSource, allowSilent = true) => {
    if (!media?.audioBuffer) return null;
    try {
      const raw = sliceAudioBuffer(media.audioBuffer, from, to);
      if (isNearlySilent(raw)) {
        if (!allowSilent) return null;
        lineAudioStats.silent++;
        return audioBufferToWavBlob(raw);   // nicht hochziehen — sonst wird nur Rauschen/Knacken laut
      }
      return audioBufferToWavBlob(prepareLineBuffer(raw));
    } catch { return null; }
  };
  // Vocals zuerst; ist die Stelle dort still, lieber den passenden Clip-Ton nehmen
  return slice(sources.vocals, !(own && unmoved)) || (own && unmoved ? own : null) || slice(sources.video) || own;
}
