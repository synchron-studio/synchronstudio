/**
 * Choicer Voicer modpack export (zusätzlich zum Synchronstudio-Szenen-Export).
 *
 * Aufbau des ZIPs (flach, wie Choicer-Voicer-Packs):
 *   _pack_info.ini                 Titel, Autoren, vorausgewählte Figuren
 *   _icon.png, _pack_filler_image.png
 *   dub_video.ogv | dub_video.mp4  Video MIT Originalstimmen (das Spiel spielt dazu den Backing-Track)
 *   _backing_track.<ext>           Musik/Effekte ohne Stimmen
 *   <NN_figur>.ini / .wav          pro Zeile: Metadaten + Stimmen-Schnipsel
 *   <figur>_avatar.png             Figurenbilder
 *   _draft_project.json            (optional) zum Wiederöffnen im Editor
 *
 * Die Zeilen-Schnipsel kommen bevorzugt aus der „Vocals only“-Spur (saubere Stimmen),
 * sonst aus dem Videoton — siehe lineAudio.ts.
 */
import JSZip from 'jszip';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { Character, MediaSource, PackInfo, TimelineClip } from '../types';
import { audioBufferToWavBlob, decodeAudioFile } from './audio';
import { cleanupFiles, clampProgress, terminateFFmpeg, tryGetFFmpeg } from './ffmpeg';
import { generateClipIni, generatePackInfoIni, reindexClipsByCharacter } from './ini';
import { clipAudioFor } from './lineAudio';
import { asBlob, fetchBlob, toPngBlob } from './media';
import { createAvatarSvgDataUrl } from './sampleData';
import { avatarSourceFor } from './ssExport';
import { ZipExportProgress } from './zipExporter';

class ExportCancelled extends Error {
  constructor() { super('EXPORT_CANCELLED'); }
}

export interface ChoicerVoicerExportResult {
  archive: Blob;
  videoFailed: boolean;
  videoFormat: 'ogv' | 'mp4' | 'none';
  missingAudioLines: number;
}

function safeKey(name: string, fallback: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function toPlainU8(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

function audioExt(blob: Blob, name = ''): string {
  const t = blob.type, n = name.toLowerCase();
  if (t.includes('wav') || n.endsWith('.wav')) return 'wav';
  if (t.includes('ogg') || n.endsWith('.ogg')) return 'ogg';
  if (t.includes('mp4') || t.includes('aac') || n.endsWith('.m4a')) return 'm4a';
  return 'mp3';
}

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

/** Videohöhe ohne FFmpeg lesen (0 = unbekannt / Browser kann das Format nicht). */
function videoHeight(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let done = false;
    const finish = (h: number) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(h);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => finish(v.videoHeight || 0);
    v.onerror = () => finish(0);
    setTimeout(() => finish(0), 8000);
    v.src = url;
  });
}

const SCALE_720P = "scale='trunc(min(1280,iw)/2)*2':-2";

/**
 * dub_video erzeugen. OGV (Theora/Vorbis) ist das, was Choicer Voicer abspielt — das
 * Kodieren läuft im Browser einkernig und dauert deshalb länger (Fortschritt wird angezeigt,
 * Abbrechen stoppt sofort). MP4 wird unverändert übernommen, wenn es schon ≤ 720p ist.
 */
async function prepareDubVideo(
  ffmpeg: FFmpeg | null,
  video: Blob,
  videoName: string,
  format: 'ogv' | 'mp4',
  onProgress: (p: number, msg: string) => void,
  abortSignal?: AbortSignal
): Promise<{ blob: Blob; ext: 'ogv' | 'mp4' } | null> {
  const isMp4 = /mp4|m4v/.test(video.type) || /\.(mp4|m4v)$/i.test(videoName);
  if (format === 'mp4' && isMp4) {
    const h = await videoHeight(video);
    if (h > 0 && h <= 720) {
      onProgress(100, 'Video is already MP4 at 720p or below — using it as is');
      return { blob: video, ext: 'mp4' };
    }
  }
  if (!ffmpeg) return isMp4 && format === 'mp4' ? { blob: video, ext: 'mp4' } : null;

  const inExt = (videoName.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const inName = `cv_in.${inExt}`;
  const outName = `dub_video.${format}`;
  const handler = ({ progress }: { progress: number }) => {
    const p = clampProgress(progress);
    onProgress(p * 100, `Encoding dub_video.${format}… ${Math.round(p * 100)}%`);
  };
  ffmpeg.on('progress', handler);
  try {
    await ffmpeg.writeFile(inName, toPlainU8(new Uint8Array(await video.arrayBuffer())));
    const codec = format === 'ogv'
      ? ['-c:v', 'libtheora', '-q:v', '7', '-c:a', 'libvorbis', '-q:a', '4']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
    const code = await runFfmpeg(ffmpeg, ['-y', '-i', inName, '-vf', SCALE_720P, '-ac', '2', ...codec, outName], abortSignal);
    if (code === 0) {
      const data = await ffmpeg.readFile(outName);
      const blob = new Blob([toPlainU8(data as Uint8Array)], { type: format === 'ogv' ? 'video/ogg' : 'video/mp4' });
      if (blob.size > 1000) return { blob, ext: format };
    }
    // Lieber das Original-MP4 mitgeben als gar kein Video
    return isMp4 ? { blob: video, ext: 'mp4' } : null;
  } finally {
    try { ffmpeg.off('progress', handler); } catch { /* egal */ }
    await cleanupFiles(ffmpeg, [inName, outName]);
  }
}

/** Beliebigen Tonclip als WAV — Choicer Voicer erwartet .wav je Zeile. */
async function ensureWav(blob: Blob): Promise<Blob | null> {
  if (audioExt(blob) === 'wav') return blob;
  try {
    return audioBufferToWavBlob(await decodeAudioFile(blob));
  } catch {
    return null;
  }
}

export async function exportChoicerVoicerPack(
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMedia: MediaSource | undefined,
  backingTrackMedia: MediaSource | undefined,
  vocalsMedia: MediaSource | undefined,
  onProgress?: (progress: ZipExportProgress) => void,
  abortSignal?: AbortSignal
): Promise<ChoicerVoicerExportResult> {
  const check = () => { if (abortSignal?.aborted) throw new ExportCancelled(); };
  let maxP = 0;
  const upd = (status: string, percent: number) => {
    maxP = Math.max(maxP, Math.round(percent));
    onProgress?.({ status, percent: Math.min(100, maxP) });
  };
  if (!clips.length) throw new Error('The timeline has no clips yet — add at least one line before exporting.');

  const zip = new JSZip();
  const format: 'ogv' | 'mp4' = packInfo.cvVideoFormat === 'mp4' ? 'mp4' : 'ogv';
  let videoFailed = false;
  let videoFormat: ChoicerVoicerExportResult['videoFormat'] = 'none';
  let missingAudioLines = 0;

  // Alle Figuren mit Zeilen gehören in preselected_dub_characters
  const allNames = Array.from(new Set([
    ...(packInfo.preselectedDubCharacters || []),
    ...characters.map((c) => c.name).filter(Boolean),
  ]));
  const iconFilename = packInfo.iconFilename || '_icon.png';
  const info: PackInfo = { ...packInfo, preselectedDubCharacters: allNames, iconFilename };

  upd('Writing pack info…', 3);
  zip.file('_pack_info.ini', generatePackInfoIni(info));

  // Icon (Pflicht bei Choicer Voicer) + Filler
  check();
  upd('Adding pack images…', 5);
  const iconSource = asBlob(packInfo.iconBlob) || (await fetchBlob(packInfo.iconUrl)) ||
    (await fetchBlob(createAvatarSvgDataUrl(packInfo.title || 'Pack', '#d97706')));
  const iconPng = iconSource ? await toPngBlob(iconSource, 512) : null;
  if (iconPng) zip.file(iconFilename.replace(/\.[a-z0-9]+$/i, '') + '.png', iconPng);
  if (!/\.png$/i.test(iconFilename)) info.iconFilename = iconFilename.replace(/\.[a-z0-9]+$/i, '') + '.png';
  zip.file('_pack_info.ini', generatePackInfoIni(info));   // mit korrigierter Icon-Endung

  const fillerSource = asBlob(packInfo.fillerImageBlob) || (await fetchBlob(packInfo.fillerImageUrl));
  if (fillerSource) {
    const fillerPng = await toPngBlob(fillerSource, 1280);
    if (fillerPng) zip.file('_pack_filler_image.png', fillerPng);
  }

  // Figurenbilder
  upd('Adding character avatars…', 8);
  const avatarFileOf = new Map<string, string>();
  const usedAvatarNames = new Set<string>();
  for (let i = 0; i < characters.length; i++) {
    check();
    const c = characters[i];
    let key = safeKey(c.name, `character_${i + 1}`);
    while (usedAvatarNames.has(key)) key += `_${i + 1}`;
    usedAvatarNames.add(key);
    const source = await avatarSourceFor(c, clips);
    const png = source ? await toPngBlob(source, 512) : null;
    if (png) {
      zip.file(`${key}_avatar.png`, png);
      avatarFileOf.set(c.name, `${key}_avatar.png`);
    }
  }

  // Zeilen: eindeutige Dateinamen (01_figur, 02_figur …) — doppelte Namen überschrieben sich früher
  const ordered = reindexClipsByCharacter(clips, characters);
  const usedBases = new Set<string>();
  const zeitFenster = (c: TimelineClip) => [c.startTime, c.endTime] as const;
  const exportedClips: TimelineClip[] = [];
  const ffmpeg = await tryGetFFmpeg((s) => upd(s, 10));
  check();
  for (let i = 0; i < ordered.length; i++) {
    check();
    const clip = { ...ordered[i] };
    const who = clip.dubCharacters[0] || 'clip';
    let base = (clip.filename || `${String(i + 1).padStart(2, '0')}_${safeKey(who, 'clip')}`).replace(/[\\/:*?"<>|]+/g, '_');
    while (usedBases.has(base.toLowerCase())) base += '_b';
    usedBases.add(base.toLowerCase());
    clip.filename = base;

    // Bild der Zeile: eigenes/aufgenommenes Bild, sonst das Figurenbild
    const clipImg = clip.imageUrl ? await fetchBlob(clip.imageUrl) : null;
    if (clipImg) {
      const png = await toPngBlob(clipImg, 640);
      let name = (clip.imageFilename && !/^default\.png$/i.test(clip.imageFilename) ? clip.imageFilename : `${base}.png`).replace(/\.[a-z0-9]+$/i, '') + '.png';
      if (usedAvatarNames.has(name.replace(/_avatar\.png$/i, '').toLowerCase()) || zip.file(name)) name = `${base}.png`;
      if (png) { zip.file(name, png); clip.imageFilename = name; }
    } else {
      clip.imageFilename = avatarFileOf.get(who) || 'default.png';
    }

    zip.file(`${base}.ini`, generateClipIni(clip, info.disableDubTimestamps));

    const [from, to] = zeitFenster(clip);
    const source = clipAudioFor(clip, from, to, { vocals: vocalsMedia, video: videoMedia });
    const wav = source ? await ensureWav(source) : null;
    if (wav) zip.file(`${base}.wav`, wav);
    else missingAudioLines++;

    exportedClips.push(clip);
    upd(`Line ${i + 1}/${ordered.length}…`, 12 + ((i + 1) / ordered.length) * 18);
  }

  // Backing-Track
  check();
  const backing = asBlob(backingTrackMedia?.file) || (await fetchBlob(backingTrackMedia?.url));
  if (backing) {
    upd('Adding backing track…', 32);
    zip.file(`_backing_track.${audioExt(backing, backingTrackMedia?.name)}`, backing);
  }

  // Video
  if (!packInfo.excludeVideo) {
    check();
    const video = asBlob(videoMedia?.file) || (await fetchBlob(videoMedia?.url));
    if (video) {
      upd(`Preparing dub_video.${format}…`, 35);
      const prepared = await prepareDubVideo(ffmpeg, video, videoMedia?.name || '', format,
        (p, msg) => upd(msg, 35 + (p / 100) * 55), abortSignal);
      if (prepared) {
        zip.file(`dub_video.${prepared.ext}`, prepared.blob);
        videoFormat = prepared.ext;
        if (prepared.ext !== format) videoFailed = true;
      } else {
        videoFailed = true;
      }
    } else {
      videoFailed = true;
    }
  }

  if (!packInfo.excludeDraftJson) {
    zip.file('_draft_project.json', JSON.stringify({
      packInfo: { ...info, iconBlob: undefined, fillerImageBlob: undefined, iconUrl: undefined, fillerImageUrl: undefined },
      characters: characters.map((c) => ({
        ...c,
        avatarFile: undefined,
        avatarFilename: avatarFileOf.get(c.name) || c.avatarFilename,
        avatarUrl: c.avatarUrl?.startsWith('blob:') ? undefined : c.avatarUrl,
      })),
      clips: exportedClips.map((c) => ({ ...c, audioBlob: undefined, imageUrl: c.imageUrl?.startsWith('blob:') ? undefined : c.imageUrl })),
    }, null, 2));
  }

  check();
  upd('Packing ZIP…', 92);
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }, (meta) => {
    check();
    upd('Packing ZIP…', 92 + meta.percent * 0.08);
  });
  upd('Done!', 100);
  return { archive, videoFailed, videoFormat, missingAudioLines };
}
