/**
 * Welche Tonquelle bekommt eine exportierte Zeile?
 *
 * 1. Ein importierter Clip-Ton (z. B. Einzelstimme aus einem Pack) — aber nur, solange die
 *    Zeile nicht verschoben/gekürzt wurde, sonst passt er nicht mehr zum Zeitfenster.
 * 2. Die optionale „Vocals only“-Spur: saubere Stimmen ohne Musik/Effekte.
 * 3. Der Ton des Videos (Stimmen + Musik gemischt).
 * 4. Notfalls der importierte Clip-Ton, auch wenn verschoben — besser als gar nichts.
 */
import { MediaSource, TimelineClip } from '../types';
import { audioBufferToWavBlob, sliceAudioBuffer } from './audio';
import { asBlob } from './media';

export interface LineAudioSources {
  vocals?: MediaSource;
  video?: MediaSource;
}

export function clipAudioFor(clip: TimelineClip, from: number, to: number, sources: LineAudioSources): Blob | null {
  const own = asBlob(clip.audioBlob);
  const unmoved = clip.audioStart == null || clip.audioEnd == null ||
    (Math.abs(clip.audioStart - clip.startTime) < 0.002 && Math.abs(clip.audioEnd - clip.endTime) < 0.002);
  if (own && unmoved) return own;
  for (const media of [sources.vocals, sources.video]) {
    if (!media?.audioBuffer) continue;
    try {
      return audioBufferToWavBlob(sliceAudioBuffer(media.audioBuffer, from, to));
    } catch { /* nächste Quelle */ }
  }
  return own;
}
