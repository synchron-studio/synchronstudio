/**
 * Automatische Zeilenerkennung: findet in einer Tonspur die Stellen, an denen jemand spricht.
 *
 * Am treffsichersten mit einer „Vocals only“-Spur (nur Stimmen). Ohne die wird die Tonspur des
 * Videos genommen; liegt ein Backing-Track (Musik/SFX ohne Stimmen) vor, zählt nur, was darüber
 * hinausgeht.
 */
export interface SpeechSegment {
  start: number;
  end: number;
}

export interface DetectOptions {
  /** Kürzeste Zeile in Sekunden (kürzer = Atmer/Knackser) */
  minDuration?: number;
  /** So lange darf eine Pause innerhalb einer Zeile sein */
  maxGap?: number;
  /** Längere Zeilen werden an der deutlichsten Pause geteilt */
  maxDuration?: number;
}

function mono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/** Lautstärke (RMS) je Messfenster */
function frameLevels(data: Float32Array, hop: number, win: number): Float32Array {
  const n = Math.max(0, Math.floor((data.length - 1) / hop) + 1);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const from = f * hop;
    const to = Math.min(data.length, from + win);
    let sum = 0;
    for (let j = from; j < to; j++) sum += data[j] * data[j];
    out[f] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

export function detectSpeechSegments(
  scan: AudioBuffer,
  backing?: AudioBuffer | null,
  opts: DetectOptions = {}
): SpeechSegment[] {
  const minDuration = opts.minDuration ?? 0.35;
  const maxGap = opts.maxGap ?? 0.45;
  const maxDuration = opts.maxDuration ?? 7;
  const sr = scan.sampleRate;
  // ~21 ms Raster, ~43 ms Fenster: fein genug für Wortanfänge, grob genug gegen Zufallsspitzen
  const hop = Math.max(1, Math.round(sr * 0.0213));
  const win = hop * 2;
  const frameSec = hop / sr;

  let level = frameLevels(mono(scan), hop, win);
  if (backing) {
    const bHop = Math.max(1, Math.round(backing.sampleRate * 0.0213));
    const b = frameLevels(mono(backing), bHop, bHop * 2);
    // Nur was über der Musik liegt, zählt als Stimme
    level = level.map((v, i) => Math.max(0, v - (i < b.length ? b[i] : 0) * 1.2));
  }
  if (!level.length) return [];

  // Schwelle aus der Spur selbst: deutlich über dem Grundrauschen, aber relativ zur lauten Sprache.
  // So klappt es bei leise abgemischten Vocals genauso wie bei lauten.
  const floor = percentile(level, 0.2);
  const loud = percentile(level, 0.99);
  const threshold = Math.max(0.004, floor * 3, loud * 0.06);

  // 1) Rohe Abschnitte: über der Schwelle, kurze Pausen (< maxGap) überbrücken
  const raw: [number, number][] = [];
  let startF = -1, lastLoudF = -1;
  const gapFrames = Math.round(maxGap / frameSec);
  for (let f = 0; f < level.length; f++) {
    if (level[f] > threshold) {
      if (startF < 0) startF = f;
      lastLoudF = f;
    } else if (startF >= 0 && f - lastLoudF > gapFrames) {
      raw.push([startF, lastLoudF]);
      startF = -1;
    }
  }
  if (startF >= 0) raw.push([startF, lastLoudF]);

  // 2) Zu lange Abschnitte an der längsten leisen Stelle teilen (Sätze hintereinander)
  const quiet = threshold * 1.5;
  const minPauseFrames = Math.round(0.12 / frameSec);
  const edgeFrames = Math.round(1.2 / frameSec);
  const split = (a: number, b: number): [number, number][] => {
    if ((b - a) * frameSec <= maxDuration) return [[a, b]];
    let best = -1, bestLen = 0, bestDepth = Infinity;
    let runStart = -1;
    for (let f = a + edgeFrames; f <= b - edgeFrames + 1; f++) {
      const isQuiet = f <= b - edgeFrames && level[f] < quiet;
      if (isQuiet && runStart < 0) runStart = f;
      if (!isQuiet && runStart >= 0) {
        const len = f - runStart;
        let depth = 0;
        for (let k = runStart; k < f; k++) depth += level[k];
        depth /= len;
        if (len > bestLen || (len === bestLen && depth < bestDepth)) { best = runStart + Math.floor(len / 2); bestLen = len; bestDepth = depth; }
        runStart = -1;
      }
    }
    if (best < 0 || bestLen < minPauseFrames) {
      // Keine echte Pause: an der leisesten Stelle in der Mitte teilen
      let minV = Infinity;
      for (let f = a + edgeFrames; f <= b - edgeFrames; f++) if (level[f] < minV) { minV = level[f]; best = f; }
      if (best < 0) return [[a, b]];
    }
    return [...split(a, best - 1), ...split(best + 1, b)];
  };

  const out: SpeechSegment[] = [];
  for (const [a, b] of raw) {
    for (const [s, e] of split(a, b)) {
      // Atmer/Knackser verwerfen: zu kurz oder nirgends richtig laut
      let peak = 0;
      for (let f = s; f <= e; f++) if (level[f] > peak) peak = level[f];
      const prevEnd = out.length ? out[out.length - 1].end : 0;
      const start = Math.max(0, prevEnd, s * frameSec - 0.05);   // nie über die vorige Zeile legen
      const end = Math.min(scan.duration, (e + 1) * frameSec + 0.12);
      if (end - start < minDuration || peak < threshold * 1.6) continue;
      out.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
    }
  }
  return out;
}
