/**
 * Synchronstudio scene ZIP export
 *
 * Das ZIP spiegelt die Ordner des Repos, damit man es einfach ins Repo entpacken kann:
 *   scenes/<id>.mp4                Video mit Backing-Track (nie die Originalstimmen)
 *   scenes/<id>/<rolle>.png        Charakterbilder
 *   scenes/<id>/lines/NN.mp3       Original-Zeilen zum Anhören
 *   previews/<id>.mp4              kurze Vorschau für die Szenenauswahl
 *   scene.json                     Eintrag für scenes.json
 *   README.txt                     Schritt-für-Schritt-Anleitung
 *
 * Uses single-thread @ffmpeg/core (no SharedArrayBuffer / COOP-COEP needed on GitHub Pages).
 */
import JSZip from 'jszip';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { Character, MediaSource, PackInfo, TimelineClip } from '../types';
import { audioBufferToWavBlob, sliceAudioBuffer } from './audio';
import { ZipExportProgress } from './zipExporter';
import { cleanupFiles, clampProgress, terminateFFmpeg, tryGetFFmpeg } from './ffmpeg';
import { asBlob, fetchBlob, toPngBlob } from './media';
import { isPlaceholderAvatar } from './sampleData';

/** jsDelivr liefert Dateien über ~20 MB nicht aus — solche Videos müssen im Spiel in OVERSIZE_MP4. */
const CDN_LIMIT_BYTES = 19.5 * 1024 * 1024;
const PREVIEW_SECONDS = 6;
const AVATAR_MAX = 256;

class ExportCancelled extends Error {
  constructor() { super('EXPORT_CANCELLED'); }
}

/** Copy out of wasm/SharedArrayBuffer memory so Blob + JSZip accept the bytes. */
function toPlainU8(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

function u8ToBlob(data: Uint8Array | string, type: string): Blob {
  return new Blob([toPlainU8(data)], { type });
}

export function slugifySceneId(title: string, fallback = 'newscene'): string {
  const s = (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return s || fallback;
}

function panForIndex(i: number, n: number): number {
  if (n <= 1) return 0;
  return -0.35 + (0.7 * i) / (n - 1);
}

async function blobFromMedia(media?: MediaSource): Promise<Blob | null> {
  if (!media) return null;
  return asBlob(media.file) || (await fetchBlob(media.url));
}

function videoExt(blob: Blob, name = ''): string {
  const t = blob.type, n = name.toLowerCase();
  if (t.includes('ogg') || n.endsWith('.ogv')) return 'ogv';
  if (t.includes('webm') || n.endsWith('.webm')) return 'webm';
  if (t.includes('quicktime') || n.endsWith('.mov')) return 'mov';
  if (n.endsWith('.mkv')) return 'mkv';
  return 'mp4';
}

function audioExt(blob: Blob, name = ''): string {
  const t = blob.type, n = name.toLowerCase();
  if (t.includes('wav') || n.endsWith('.wav')) return 'wav';
  if (t.includes('ogg') || n.endsWith('.ogg')) return 'ogg';
  if (t.includes('mp4') || t.includes('aac') || n.endsWith('.m4a')) return 'm4a';
  if (t.includes('opus') || n.endsWith('.opus')) return 'opus';
  return 'mp3';
}

/**
 * ffmpeg.exec mit echtem Abbruch. Vorher lief das Encoding nach „Cancel Export“ einfach
 * weiter, bis es fertig war — der Rechner war minutenlang ausgelastet.
 */
async function runFfmpeg(ffmpeg: FFmpeg, args: string[], abortSignal?: AbortSignal): Promise<number> {
  if (abortSignal?.aborted) throw new ExportCancelled();
  let aborted = false;
  const onAbort = () => { aborted = true; terminateFFmpeg(ffmpeg); };
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await ffmpeg.exec(args);
  } catch (err) {
    if (aborted || abortSignal?.aborted) throw new ExportCancelled();
    throw err;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

// Nur verkleinern, nie vergrößern; Breite und Höhe gerade (libx264 verlangt das).
const SCALE_720P = "scale='trunc(min(1280,iw)/2)*2':-2";

async function muxVideoWithBacking(
  ffmpeg: FFmpeg,
  videoBlob: Blob,
  videoName: string,
  backingBlob: Blob | null,
  backingName: string,
  onProgress: (p: number, msg: string) => void,
  abortSignal?: AbortSignal
): Promise<Blob> {
  const inName = `in.${videoExt(videoBlob, videoName)}`;
  const aName = backingBlob ? `backing.${audioExt(backingBlob, backingName)}` : '';
  const progressHandler = ({ progress }: { progress: number }) => {
    const p = clampProgress(progress);
    onProgress(10 + p * 85, `Encoding scene video… ${Math.round(p * 100)}%`);
  };
  ffmpeg.on('progress', progressHandler);
  try {
    await ffmpeg.writeFile(inName, toPlainU8(new Uint8Array(await videoBlob.arrayBuffer())));
    if (backingBlob) await ffmpeg.writeFile(aName, toPlainU8(new Uint8Array(await backingBlob.arrayBuffer())));
    if (abortSignal?.aborted) throw new ExportCancelled();

    // Ton: der Backing-Track. `apad` + `-shortest` = das Video bestimmt die Länge.
    // Vorher schnitt `-shortest` allein das VIDEO ab, sobald der Backing-Track kürzer war.
    const audioArgs = backingBlob
      ? ['-i', aName, '-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '96k', '-shortest']
      : ['-map', '0:v:0', '-an'];   // ohne Backing-Track lieber stumm als mit Originalstimmen
    const attempts: string[][] = [
      ['-i', inName, ...audioArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-vf', SCALE_720P, '-movflags', '+faststart', 'out.mp4'],
      ['-i', inName, ...audioArgs, '-c:v', 'mpeg4', '-q:v', '6', '-vf', SCALE_720P, 'out.mp4'],
      ['-i', inName, ...audioArgs, '-c:v', 'copy', 'out.mp4'],
    ];
    for (const args of attempts) {
      await cleanupFiles(ffmpeg, ['out.mp4']);
      const code = await runFfmpeg(ffmpeg, ['-y', ...args], abortSignal);
      if (code === 0) {
        const data = await ffmpeg.readFile('out.mp4');
        const blob = u8ToBlob(data as Uint8Array, 'video/mp4');
        if (blob.size > 1000) return blob;
      }
    }
    throw new Error('VIDEO_MUX_FAILED');
  } finally {
    try { ffmpeg.off('progress', progressHandler); } catch { /* egal */ }
    await cleanupFiles(ffmpeg, [inName, aName, 'out.mp4'].filter(Boolean));
  }
}

/** Kurzer Vorschau-Clip (≤ 6 s, 360p) für die Szenenauswahl im Spiel. */
async function makePreview(ffmpeg: FFmpeg, sceneMp4: Blob, startSec: number, abortSignal?: AbortSignal): Promise<Blob | null> {
  try {
    await ffmpeg.writeFile('scene.mp4', toPlainU8(new Uint8Array(await sceneMp4.arrayBuffer())));
    const code = await runFfmpeg(ffmpeg, [
      '-y', '-ss', startSec.toFixed(2), '-i', 'scene.mp4', '-t', String(PREVIEW_SECONDS),
      '-vf', "scale=-2:'min(360,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', 'preview.mp4',
    ], abortSignal);
    if (code !== 0) return null;
    const blob = u8ToBlob((await ffmpeg.readFile('preview.mp4')) as Uint8Array, 'video/mp4');
    return blob.size > 1000 ? blob : null;
  } catch (err) {
    if (err instanceof ExportCancelled) throw err;
    console.warn('Preview clip failed', err);
    return null;
  } finally {
    await cleanupFiles(ffmpeg, ['scene.mp4', 'preview.mp4']);
  }
}

async function toMonoMp3(ffmpeg: FFmpeg, source: Blob, abortSignal?: AbortSignal): Promise<Blob | null> {
  const inName = `clip_in.${audioExt(source)}`;
  try {
    await ffmpeg.writeFile(inName, toPlainU8(new Uint8Array(await source.arrayBuffer())));
    const code = await runFfmpeg(ffmpeg, ['-y', '-i', inName, '-ac', '1', '-b:a', '64k', 'clip.mp3'], abortSignal);
    if (code !== 0) return null;
    const blob = u8ToBlob((await ffmpeg.readFile('clip.mp3')) as Uint8Array, 'audio/mpeg');
    return blob.size > 100 ? blob : null;
  } catch (err) {
    if (err instanceof ExportCancelled) throw err;
    return null;
  } finally {
    await cleanupFiles(ffmpeg, [inName, 'clip.mp3']);
  }
}

/** Charakterbild wählen: hochgeladenes Bild → aufgenommenes Standbild → Platzhalter. */
async function avatarSourceFor(char: Character, clips: TimelineClip[]): Promise<Blob | null> {
  const uploaded = asBlob(char.avatarFile) || (!isPlaceholderAvatar(char.avatarUrl) ? await fetchBlob(char.avatarUrl) : null);
  if (uploaded) return uploaded;
  // Auto-Screenshot-Figuren: das erste aufgenommene Standbild der Figur ist ein echtes Bild
  const frame = clips.find((c) => c.dubCharacters[0] === char.name && c.imageUrl?.startsWith('data:image/'));
  if (frame) {
    const b = await fetchBlob(frame.imageUrl);
    if (b) return b;
  }
  return fetchBlob(char.avatarUrl);
}

/** Tonquelle einer Zeile. Ein importierter Clip-Ton (oft saubere Einzelstimme) passt nur,
 *  solange die Zeile nicht verschoben wurde — sonst wird aus dem Video neu geschnitten. */
function clipAudioFor(clip: TimelineClip, from: number, to: number, videoMedia?: MediaSource): Blob | null {
  const own = asBlob(clip.audioBlob);
  const unmoved = clip.audioStart == null || clip.audioEnd == null ||
    (Math.abs(clip.audioStart - clip.startTime) < 0.002 && Math.abs(clip.audioEnd - clip.endTime) < 0.002);
  if (own && unmoved) return own;
  if (videoMedia?.audioBuffer) {
    try { return audioBufferToWavBlob(sliceAudioBuffer(videoMedia.audioBuffer, from, to)); } catch { /* weiter */ }
  }
  return own;
}

export interface SynchronstudioExportResult {
  archive: Blob;
  videoFailed: boolean;
  oversize: boolean;
  missingAudioLines: number;
}

export async function exportSynchronstudioZip(
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMedia?: MediaSource,
  backingTrackMedia?: MediaSource,
  onProgress?: (progress: ZipExportProgress) => void,
  abortSignal?: AbortSignal
): Promise<SynchronstudioExportResult> {
  const check = () => {
    if (abortSignal?.aborted) throw new ExportCancelled();
  };
  let maxP = 0;
  const upd = (status: string, percent: number) => {
    maxP = Math.max(maxP, Math.round(percent));
    onProgress?.({ status, percent: Math.min(100, maxP) });
  };

  const sceneId = slugifySceneId(packInfo.sceneId || packInfo.title);
  const title = (packInfo.title || sceneId).trim();
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  const zip = new JSZip();
  let videoFailed = false;
  let oversize = false;
  let missingAudioLines = 0;

  if (!sorted.length) throw new Error('The timeline has no clips yet — add at least one line before exporting.');

  upd('Preparing…', 2);
  check();

  const usedNames = new Set<string>();
  sorted.forEach((c) => c.dubCharacters.forEach((n) => usedNames.add(n)));
  const roleChars = characters.filter((c) => usedNames.has(c.name));
  const rolesSource = roleChars.length ? roleChars : characters;
  const roleIndex = new Map<string, number>();
  rolesSource.forEach((c, i) => roleIndex.set(c.name, i));

  const ffmpeg = await tryGetFFmpeg((s) => upd(s, 4));
  check();

  // Avatars as real PNG (max. 256 px)
  upd('Adding avatars…', 8);
  const avatarPaths: Record<string, string> = {};
  const usedAvatarNames = new Set<string>();
  for (let i = 0; i < rolesSource.length; i++) {
    check();
    const char = rolesSource[i];
    let safe = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `role${i}`;
    while (usedAvatarNames.has(safe)) safe += `_${i}`;   // zwei Figuren mit gleichem Kurznamen
    usedAvatarNames.add(safe);
    const source = await avatarSourceFor(char, sorted);
    const png = source ? await toPngBlob(source, AVATAR_MAX) : null;
    if (png) {
      zip.file(`scenes/${sceneId}/${safe}.png`, png);
      avatarPaths[String(i)] = `scenes/${sceneId}/${safe}.png`;
    }
  }

  // Lines audio
  upd('Slicing voicelines…', 15);
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < sorted.length; i++) {
    check();
    const clip = sorted[i];
    const n = String(i + 1).padStart(2, '0');
    const who = clip.dubCharacters[0] || rolesSource[0]?.name || 'Role';
    const rid = roleIndex.has(who) ? roleIndex.get(who)! : 0;
    const t = +Math.max(0, clip.dubTimestamps?.[0] ?? clip.startTime).toFixed(3);
    const end = +Math.max(t + 0.2, clip.endTime).toFixed(3);
    const text = (clip.caption || '').replace(/[“”„]/g, '"').replace(/\s+/g, ' ').trim() || `(line ${n})`;
    const de = (clip.captionDe || text).replace(/[“”„]/g, '"').replace(/\s+/g, ' ').trim();

    // Das Spiel spielt das Original ab `t` — also auch ab dort schneiden, sonst ist es versetzt
    const source = clipAudioFor(clip, t, end, videoMedia);
    let orig: string | undefined;
    if (source) {
      const mp3 = ffmpeg ? await toMonoMp3(ffmpeg, source, abortSignal) : null;
      if (mp3) {
        orig = `scenes/${sceneId}/lines/${n}.mp3`;
        zip.file(orig, mp3);
      } else {
        orig = `scenes/${sceneId}/lines/${n}.${audioExt(source) === 'mp3' ? 'mp3' : 'wav'}`;
        zip.file(orig, source);
      }
    } else {
      missingAudioLines++;
    }

    const line: Record<string, unknown> = { t, end, chars: [rid], who, text, de };
    if (orig) line.orig = orig;   // nie auf eine Datei zeigen, die es nicht gibt
    lines.push(line);
    upd(`Line ${i + 1}/${sorted.length}…`, 15 + ((i + 1) / sorted.length) * 30);
  }

  // Video + backing
  check();
  upd('Muxing video + backing track…', 48);
  const videoBlob = await blobFromMedia(videoMedia);
  const backingBlob = await blobFromMedia(backingTrackMedia);
  let sceneMp4: Blob | null = null;
  if (videoBlob && ffmpeg) {
    try {
      sceneMp4 = await muxVideoWithBacking(
        ffmpeg, videoBlob, videoMedia?.name || '', backingBlob, backingTrackMedia?.name || '',
        (p, msg) => upd(msg, 48 + (p / 100) * 37),
        abortSignal
      );
    } catch (e) {
      if (e instanceof ExportCancelled) throw e;
      console.warn('Video mux failed', e);
    }
  }
  if (sceneMp4) {
    zip.file(`scenes/${sceneId}.mp4`, sceneMp4);
    oversize = sceneMp4.size > CDN_LIMIT_BYTES;
  } else if (videoBlob) {
    videoFailed = true;
    zip.file(`_source/${sceneId}_SOURCE.${videoExt(videoBlob, videoMedia?.name)}`, videoBlob);
    if (backingBlob) zip.file(`_source/${sceneId}_backing_track.${audioExt(backingBlob, backingTrackMedia?.name)}`, backingBlob);
  } else {
    videoFailed = true;
  }

  // Preview clip
  let previewBytes = 0;
  if (sceneMp4 && ffmpeg) {
    check();
    upd('Cutting preview clip…', 86);
    const firstT = Number(lines[0]?.t) || 0;
    const preview = await makePreview(ffmpeg, sceneMp4, Math.max(0, firstT - 0.5), abortSignal);
    if (preview) {
      zip.file(`previews/${sceneId}.mp4`, preview);
      previewBytes = preview.size;
    }
  }

  const roles = rolesSource.map((c, i) => ({
    id: i,
    name: c.name,
    pan: +panForIndex(i, rolesSource.length).toFixed(2),
    effect: 'none',
    gain: 1,
  }));

  const scene: Record<string, unknown> = {
    id: sceneId,
    title: `${title} (${roles.length} ${roles.length === 1 ? 'Rolle' : 'Rollen'})`,
    videoUrl: `scenes/${sceneId}.mp4`,
    avatars: avatarPaths,
    roles,
    lines,
    difficultyOverride: 'medium',
  };
  if (sceneMp4) scene.videoBytes = sceneMp4.size;
  if (previewBytes) {
    scene.previewUrl = `previews/${sceneId}.mp4`;
    scene.previewBytes = previewBytes;
  }

  zip.file('scene.json', JSON.stringify(scene, null, 2));
  zip.file(
    'README.txt',
    [
      'Synchronstudio scene export',
      '',
      '1. Unzip this archive into the root of the synchronstudio repo',
      `   (it contains scenes/${sceneId}.mp4, scenes/${sceneId}/ and previews/${sceneId}.mp4).`,
      '2. Add the object from scene.json to the list in scenes.json (comma between scenes).',
      `3. Add the new characters to AVATAR_CHARS in client.js (optional, for profile pictures).`,
      '4. Run:  node tools/sync-scene-index.cjs',
      '   The game only reads scenes-index.json + scenedata/ — without this step the scene does NOT show up.',
      '5. Raise APP_VERSION (client.js + index.html), add patch notes, commit & push.',
      '',
      `Scene id: ${sceneId}`,
      `Title: ${String(scene.title)}`,
      `Lines: ${lines.length}`,
      missingAudioLines ? `NOTE: ${missingAudioLines} line(s) have no original audio (no "orig" field).` : '',
      oversize
        ? `NOTE: scenes/${sceneId}.mp4 is ${(sceneMp4!.size / 1048576).toFixed(1)} MB — over the ~20 MB CDN limit. Add "scenes/${sceneId}.mp4" to OVERSIZE_MP4 in client.js or re-encode it smaller.`
        : '',
      videoFailed
        ? 'NOTE: The video could not be encoded in the browser — the source video and backing track are in _source/. Merge them with ffmpeg (-map 0:v:0 -map 1:a:0) before adding the scene.'
        : '',
      !previewBytes && sceneMp4 ? `NOTE: No preview clip — create previews/${sceneId}.mp4 (≤ 6 s, < 500 KB).` : '',
    ]
      .filter((l) => l !== '')
      .join('\n')
  );

  if (!packInfo.excludeDraftJson) {
    zip.file(
      '_draft_project.json',
      JSON.stringify(
        {
          packInfo: { ...packInfo, sceneId, iconBlob: undefined, fillerImageBlob: undefined },
          characters: characters.map((c) => ({
            ...c,
            avatarFile: undefined,
            avatarUrl: c.avatarUrl?.startsWith('blob:') ? undefined : c.avatarUrl,
          })),
          clips: sorted.map((c) => ({ ...c, audioBlob: undefined })),
        },
        null,
        2
      )
    );
  }

  check();
  upd('Compressing ZIP…', 92);
  try {
    // Video/MP3/PNG sind schon komprimiert — nur die Textdateien lohnen DEFLATE.
    const archive = await zip.generateAsync(
      { type: 'blob', compression: 'STORE', streamFiles: true },
      (meta) => {
        check();
        upd('Compressing ZIP…', 92 + meta.percent * 0.08);
      }
    );
    upd('Done!', 100);
    return { archive, videoFailed, oversize, missingAudioLines };
  } catch (e: any) {
    if (e instanceof ExportCancelled) throw e;
    console.error('JSZip generateAsync failed', e);
    throw new Error(
      e?.message
        ? `ZIP_FAILED: ${e.message}`
        : 'ZIP_FAILED: could not create the archive (file may be too large for the browser)'
    );
  }
}
