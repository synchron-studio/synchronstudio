import JSZip from 'jszip';
import { Character, MediaSource, PackInfo, TimelineClip } from '../types';
import { parsePackInfoIni, parseClipIni } from './ini';
import { createAvatarSvgDataUrl } from './sampleData';
import { decodeAudioFile } from './audio';

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const AUDIO_TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/ogg' };
const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', ogv: 'video/ogg', webm: 'video/webm', mov: 'video/quicktime' };

function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}
function baseNameOf(path: string): string {
  return path.split('/').pop() || path;
}
/** Echte Länge eines Tonclips — vorher bekam jeder importierte Clip pauschal 2 Sekunden. */
async function audioDuration(blob: Blob): Promise<number> {
  try {
    const buf = await decodeAudioFile(blob);
    return buf.duration;
  } catch {
    return 0;
  }
}
async function fileFromZip(entry: JSZip.JSZipObject, typeMap: Record<string, string>, fallbackType: string): Promise<File> {
  const blob = await entry.async('blob');
  const name = baseNameOf(entry.name);
  return new File([blob], name, { type: typeMap[extOf(name)] || fallbackType });
}

export interface DraftState {
  packInfo: PackInfo;
  characters: Character[];
  clips: TimelineClip[];
  videoMedia?: MediaSource;
  backingTrackMedia?: MediaSource;
  missingFiles?: string[];
}

const PRESET_COLORS = [
  '#8b5cf6', // purple
  '#eab308', // amber
  '#22c55e', // green
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#f97316', // orange
  '#06b6d4', // cyan
];

function cleanCharKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function formatCharNameFromFilename(filename: string): string {
  const nameWithoutExt = filename.split('/').pop()?.replace(/\.[^/.]+$/, '') || filename;
  const clean = nameWithoutExt.replace(/[-_]+/g, ' ').trim();
  return clean.replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function importDraftZip(file: File): Promise<DraftState> {
  // Check if file is a .cvmmd or .json Choicer Voicer Draft file
  if (file.name.endsWith('.cvmmd') || file.name.endsWith('.json')) {
    const text = await file.text();
    const parsed = JSON.parse(text);

    const packInfo: PackInfo = parsed.packInfo || {
      title: parsed.title || file.name.replace(/\.(cvmmd|json)$/i, ''),
      iconFilename: '_icon.png',
      authors: ['YourName'],
      readme: '',
      preselectedDubCharacters: [],
    };

    const characters: Character[] = (parsed.characters || []).map((c: any, idx: number) => ({
      ...c,
      id: c.id || `char_${idx + 1}`,
      avatarUrl: c.avatarUrl || createAvatarSvgDataUrl(c.name || 'Character'),
      originalFilename: c.avatarPath?.split(/[/\\]/).pop(),
    }));

    const clips: TimelineClip[] = (parsed.clips || []).map((clip: any, idx: number) => ({
      ...clip,
      id: clip.id || `clip_${idx + 1}`,
      volume: clip.volume ?? 1,
    }));

    const draftState: DraftState = {
      packInfo,
      characters,
      clips,
    };

    const missingFiles: string[] = [];

    if (parsed.videoMediaName || parsed.videoPath) {
      const vName = parsed.videoMediaName || parsed.videoPath?.split(/[/\\]/).pop() || 'dub_video.mp4';
      missingFiles.push(vName);
      draftState.videoMedia = {
        type: 'video',
        name: vName,
        duration: parsed.duration || 20,
      };
    }

    if (parsed.backingTrackName || parsed.backingTrackPath) {
      const bName = parsed.backingTrackName || parsed.backingTrackPath?.split(/[/\\]/).pop() || '_backing_track.wav';
      missingFiles.push(bName);
      draftState.backingTrackMedia = {
        type: 'audio',
        name: bName,
        duration: parsed.duration || 20,
      };
    }

    // Also push character avatars and clip images? The user said "ask for all files that were not found"
    // Since it's a draft file, we can just say the main media files. Actually, let's include characters avatar paths too if they had one.
    if (parsed.characters) {
      parsed.characters.forEach((c: any) => {
        // If it has an avatarPath, it means a local file was used and needs to be re-uploaded.
        // Even if we provide a dicebear fallback later, we should ask for the original file.
        if (c.avatarPath) {
          missingFiles.push(c.avatarPath.split(/[/\\]/).pop());
        }
      });
    }

    if (parsed.packInfo) {
      const icon = parsed.packInfo.iconFilename || parsed.packInfo.iconPath;
      if (icon && !parsed.packInfo.iconUrl && parsed.packInfo.hasCustomIcon) {
        const iconName = icon.split(/[/\\]/).pop();
        if (iconName && !missingFiles.includes(iconName)) {
          missingFiles.push(iconName);
        }
      }

      const filler = parsed.packInfo.fillerImageFilename || parsed.packInfo.fillerImagePath;
      if (filler && !parsed.packInfo.fillerImageUrl && parsed.packInfo.hasCustomFiller) {
        const fillerName = filler.split(/[/\\]/).pop();
        if (fillerName && !missingFiles.includes(fillerName)) {
          missingFiles.push(fillerName);
        }
      }
    }

    if (parsed.clips) {
      parsed.clips.forEach((c: any) => {
        const clipImg = c.originalImageFilename || c.imageFilename;
        if (clipImg && clipImg !== 'default.png' && !c.imageUrl) {
          const imgName = clipImg.split(/[/\\]/).pop();
          if (imgName && !missingFiles.includes(imgName)) {
            missingFiles.push(imgName);
          }
        }
      });
    }

    draftState.missingFiles = missingFiles.filter(Boolean);

    return draftState;
  }

  const zip = await JSZip.loadAsync(file);

  const draftFile = zip.file('_draft_project.json');

  // Ohne Projektdatei: Szenen-Export (scene.json) oder Choicer-Voicer-Pack lesen.
  // Vorher brach der Import hier ab — der Pack-Leser weiter unten war nie erreichbar.
  if (!draftFile) {
    const sceneFile = zip.file('scene.json');
    if (sceneFile) return await parseSceneJsonZip(zip, JSON.parse(await sceneFile.async('string')));
    const hasClipMeta = Object.keys(zip.files).some((k) => /\.(ini|txt)$/i.test(k) && !baseNameOf(k).startsWith('_'));
    if (hasClipMeta) return await parseStandardModpackZip(zip, file.name);
    throw new Error('This ZIP is not a Synchronstudio export or Choicer Voicer pack (no _draft_project.json, scene.json or clip .ini files).');
  }

  const draftText = await draftFile.async('string');
  const draftState = JSON.parse(draftText) as DraftState;

  // 1. Re-hydrate Pack Info images
  if (draftState.packInfo) {
    const iconFilename = draftState.packInfo.iconFilename || '_icon.png';
    const iconZipFile = zip.file(iconFilename) || zip.file('_icon.png') || zip.file('icon.png');
    if (iconZipFile) {
      const blob = await iconZipFile.async('blob');
      draftState.packInfo.iconBlob = blob;
      draftState.packInfo.iconUrl = URL.createObjectURL(blob);
      draftState.packInfo.hasCustomIcon = true;
    }

    const fillerFilename = draftState.packInfo.fillerImageFilename || '_pack_filler_image.png';
    const fillerZipFile = zip.file(fillerFilename) || zip.file('_pack_filler_image.png');
    if (fillerZipFile) {
      const blob = await fillerZipFile.async('blob');
      draftState.packInfo.fillerImageBlob = blob;
      draftState.packInfo.fillerImageUrl = URL.createObjectURL(blob);
      draftState.packInfo.hasCustomFiller = true;
    }
  }

  // Ensure draftState.characters is initialized
  if (!draftState.characters) {
    draftState.characters = [];
  }

  // 2. Re-hydrate existing Character Avatars
  const loadedCharKeys = new Set<string>();

  for (let i = 0; i < draftState.characters.length; i++) {
    const char = draftState.characters[i];
    loadedCharKeys.add(cleanCharKey(char.name));

    const safeName = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const ext = char.avatarFilename?.split('.').pop() || 'png';
    const charFilename = `${safeName}_avatar.${ext}`;
    char.avatarFilename = charFilename;

    let charZipFile = zip.file(charFilename) || zip.file(char.avatarFilename || '');

    if (!charZipFile) {
      const keyName = cleanCharKey(char.name);
      // Nur den Dateinamen vergleichen, nicht den Ordner — Szenen-Exporte legen die
      // Bilder unter scenes/<id>/ ab, und dort wurden sie vorher nie gefunden.
      const matchingKey = Object.keys(zip.files).find((k) => {
        if (zip.files[k].dir || !IMAGE_RE.test(k)) return false;
        const cleanK = cleanCharKey(baseNameOf(k).replace(IMAGE_RE, '').replace(/_avatar$/i, ''));
        return !!cleanK && (cleanK === keyName || cleanK.startsWith(keyName) || keyName.startsWith(cleanK));
      });
      if (matchingKey) charZipFile = zip.file(matchingKey);
    }

    if (charZipFile) {
      const blob = await charZipFile.async('blob');
      char.avatarUrl = URL.createObjectURL(blob);
      char.avatarFilename = `${safeName}_avatar.${charZipFile.name.split('.').pop() || 'png'}`;
    } else if (!char.avatarUrl || char.avatarUrl.startsWith('blob:')) {
      char.avatarUrl = createAvatarSvgDataUrl(char.name, char.color || PRESET_COLORS[i % PRESET_COLORS.length]);
    }
  }

    // 3. Scan preselectedDubCharacters for any missing characters
    const preselected = draftState.packInfo?.preselectedDubCharacters || [];
    for (const name of preselected) {
      const key = cleanCharKey(name);
      if (name && !loadedCharKeys.has(key)) {
        loadedCharKeys.add(key);

        let avatarFilename = `${key}.png`;
        let avatarUrl = '';

        const matchingKey = Object.keys(zip.files).find((k) => {
          if (zip.files[k].dir) return false;
          const kLower = k.toLowerCase();
          return (
            cleanCharKey(kLower).includes(key) &&
            (kLower.endsWith('.png') || kLower.endsWith('.jpg') || kLower.endsWith('.jpeg') || kLower.endsWith('.webp'))
          );
        });

        if (matchingKey && zip.files[matchingKey]) {
          avatarFilename = matchingKey;
          const blob = await zip.files[matchingKey].async('blob');
          avatarUrl = URL.createObjectURL(blob);
        } else {
          avatarUrl = createAvatarSvgDataUrl(name, PRESET_COLORS[draftState.characters.length % PRESET_COLORS.length]);
        }

        draftState.characters.push({
          id: `char_${draftState.characters.length + 1}_${key}`,
          name,
          avatarFilename,
          avatarUrl,
          color: PRESET_COLORS[draftState.characters.length % PRESET_COLORS.length],
        });
      }
    }

    // 4. Scan zip image files for any extra character avatar files not yet loaded
    const knownNonCharImages = new Set<string>();
    if (draftState.packInfo?.iconFilename) knownNonCharImages.add(draftState.packInfo.iconFilename.toLowerCase());
    if (draftState.packInfo?.fillerImageFilename) knownNonCharImages.add(draftState.packInfo.fillerImageFilename.toLowerCase());
    knownNonCharImages.add('_icon.png');
    knownNonCharImages.add('icon.png');
    knownNonCharImages.add('_pack_filler_image.png');

    if (draftState.clips) {
      for (const clip of draftState.clips) {
        if (clip.imageFilename) knownNonCharImages.add(clip.imageFilename.toLowerCase());
      }
    }

    const zipImageKeys = Object.keys(zip.files).filter((k) => {
      if (zip.files[k].dir) return false;
      const lk = k.toLowerCase();
      if (knownNonCharImages.has(lk)) return false;
      if (lk.startsWith('_pack_') || lk.startsWith('_draft_')) return false;
      return lk.endsWith('.png') || lk.endsWith('.jpg') || lk.endsWith('.jpeg') || lk.endsWith('.webp') || lk.endsWith('.gif');
    });

    for (const imgKey of zipImageKeys) {
      const derivedName = formatCharNameFromFilename(imgKey);
      const key = cleanCharKey(derivedName);
      if (key && !loadedCharKeys.has(key)) {
        loadedCharKeys.add(key);
        const blob = await zip.files[imgKey].async('blob');
        const avatarUrl = URL.createObjectURL(blob);
        draftState.characters.push({
          id: `char_${draftState.characters.length + 1}_${key}`,
          name: derivedName,
          avatarFilename: imgKey,
          avatarUrl,
          color: PRESET_COLORS[draftState.characters.length % PRESET_COLORS.length],
        });
      }
    }

    // 5. Re-hydrate Clips (Audio & Custom Images)
    if (draftState.clips) {
      const sceneId = draftState.packInfo?.sceneId || '';
      const ordered = [...draftState.clips].sort((a, b) => a.startTime - b.startTime);
      for (const clip of draftState.clips) {
        const baseName = clip.filename || clip.id;
        const n = String(ordered.indexOf(clip) + 1).padStart(2, '0');
        // Modpack-Format (<name>.wav) oder Szenen-Export (scenes/<id>/lines/NN.mp3, alt: <id>/lines/NN.mp3)
        const audioFile = zip.file(`${baseName}.wav`) || zip.file(`${clip.id}.wav`) ||
          (sceneId ? (zip.file(`scenes/${sceneId}/lines/${n}.mp3`) || zip.file(`scenes/${sceneId}/lines/${n}.wav`) ||
            zip.file(`${sceneId}/lines/${n}.mp3`) || zip.file(`${sceneId}/lines/${n}.wav`)) : null);
        if (audioFile) {
          clip.audioBlob = await fileFromZip(audioFile, AUDIO_TYPES, 'audio/wav');
          clip.audioStart = clip.startTime;
          clip.audioEnd = clip.endTime;
        }

        if (clip.imageFilename) {
          const imgZipFile = zip.file(clip.imageFilename);
          if (imgZipFile) {
            const blob = await imgZipFile.async('blob');
            clip.imageUrl = URL.createObjectURL(blob);
          }
        }
      }
    }

    // 6. Re-hydrate Video File (Vorschau-Clips unter previews/ sind NICHT das Szenenvideo)
    const videoZipFile = findVideo(zip);
    if (videoZipFile) {
      const vFile = await fileFromZip(videoZipFile, VIDEO_TYPES, 'video/mp4');
      draftState.videoMedia = {
        type: 'video',
        file: vFile,
        name: vFile.name,
        url: URL.createObjectURL(vFile),
        duration: 20,
      };
    }

    // 7. Re-hydrate Backing Track
    const backingZipFile = findBacking(zip);
    if (backingZipFile) {
      const bFile = await fileFromZip(backingZipFile, AUDIO_TYPES, 'audio/wav');
      draftState.backingTrackMedia = {
        type: 'audio',
        file: bFile,
        name: bFile.name,
        url: URL.createObjectURL(bFile),
        duration: 20,
      };
    }

    return draftState;
}

function findVideo(zip: JSZip): JSZip.JSZipObject | null {
  const files = Object.values(zip.files).filter((f) => !f.dir && /\.(mp4|m4v|ogv|webm|mov)$/i.test(f.name));
  return zip.file('dub_video.mp4') || zip.file('dub_video.ogv') ||
    files.find((f) => /^scenes\/[^/]+\.mp4$/i.test(f.name)) ||
    files.find((f) => /_SOURCE\./i.test(f.name)) ||
    files.find((f) => !f.name.startsWith('previews/')) || null;
}

function findBacking(zip: JSZip): JSZip.JSZipObject | null {
  return zip.file('_backing_track.wav') || zip.file('_backing_track.mp3') ||
    Object.values(zip.files).find((f) => !f.dir && /(^|\/)(_backing_track|[^/]*_backing_track)\.[a-z0-9]+$/i.test(f.name)) || null;
}

/** Szenen-Export ohne Projektdatei (nur scene.json + Dateien) wieder öffnen. */
async function parseSceneJsonZip(zip: JSZip, scene: any): Promise<DraftState> {
  const roles: Array<{ id: number; name: string }> = Array.isArray(scene?.roles) ? scene.roles : [];
  const lines: any[] = Array.isArray(scene?.lines) ? scene.lines : [];
  const title = String(scene?.title || 'Imported Scene').replace(/\s*\(\d+\s*(Rollen|Rolle|roles|role)\)\s*$/i, '');
  const packInfo: PackInfo = {
    title,
    sceneId: scene?.id || undefined,
    iconFilename: '_icon.png',
    authors: ['Synchronstudio'],
    readme: 'Synchronstudio scene',
    preselectedDubCharacters: roles.map((r) => r.name),
  };

  const characters: Character[] = [];
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i];
    const color = PRESET_COLORS[i % PRESET_COLORS.length];
    const avatarPath = scene?.avatars?.[String(r.id)];
    const entry = avatarPath ? zip.file(avatarPath) || zip.file(String(avatarPath).replace(/^scenes\//, '')) : null;
    const avatarUrl = entry ? URL.createObjectURL(await entry.async('blob')) : createAvatarSvgDataUrl(r.name, color);
    characters.push({
      id: `char_${i + 1}_${cleanCharKey(r.name)}`,
      name: r.name,
      avatarFilename: `${cleanCharKey(r.name) || 'role' + i}_avatar.png`,
      avatarUrl,
      color,
    });
  }
  const nameOfRole = (id: number) => roles.find((r) => r.id === id)?.name || roles[0]?.name || 'Voice';

  const clips: TimelineClip[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = Number(l.t) || 0;
    const end = Math.max(t + 0.2, Number(l.end) || t + 2);
    const who = Array.isArray(l.chars) && l.chars.length ? nameOfRole(l.chars[0]) : (l.who || nameOfRole(0));
    const audioEntry = l.orig ? zip.file(l.orig) || zip.file(String(l.orig).replace(/^scenes\//, '')) : null;
    const clip: TimelineClip = {
      id: `clip_${i + 1}_${Date.now()}`,
      filename: `${String(i + 1).padStart(2, '0')}_${cleanCharKey(who) || 'clip'}`,
      startTime: Number(t.toFixed(3)),
      endTime: Number(end.toFixed(3)),
      dubTimestamps: [Number(t.toFixed(3))],
      dubCharacters: [who],
      caption: String(l.text || ''),
      captionDe: l.de && l.de !== l.text ? String(l.de) : undefined,
      volume: 1,
    };
    if (audioEntry) {
      clip.audioBlob = await fileFromZip(audioEntry, AUDIO_TYPES, 'audio/mpeg');
      clip.audioStart = clip.startTime;
      clip.audioEnd = clip.endTime;
    }
    clips.push(clip);
  }

  const state: DraftState = { packInfo, characters, clips };
  const video = findVideo(zip);
  if (video) {
    const vFile = await fileFromZip(video, VIDEO_TYPES, 'video/mp4');
    state.videoMedia = { type: 'video', file: vFile, name: vFile.name, url: URL.createObjectURL(vFile), duration: 20 };
  }
  const backing = findBacking(zip);
  if (backing) {
    const bFile = await fileFromZip(backing, AUDIO_TYPES, 'audio/mpeg');
    state.backingTrackMedia = { type: 'audio', file: bFile, name: bFile.name, url: URL.createObjectURL(bFile), duration: 20 };
  }
  return state;
}

async function parseStandardModpackZip(zip: JSZip, fileTitle: string): Promise<DraftState> {
  // 1. Pack Info
  const packInfoIniFile = zip.file('_pack_info.ini');
  let packInfo: PackInfo = {
    title: fileTitle.replace(/\.zip$/i, ''),
    iconFilename: '_icon.png',
    authors: ['Anonymous'],
    readme: '',
    preselectedDubCharacters: [],
  };

  if (packInfoIniFile) {
    const text = await packInfoIniFile.async('string');
    const parsed = parsePackInfoIni(text);
    packInfo = { ...packInfo, ...parsed };
  }

  // Load Pack Icon
  const iconZipFile = zip.file(packInfo.iconFilename) || zip.file('_icon.png') || zip.file('icon.png');
  if (iconZipFile) {
    const blob = await iconZipFile.async('blob');
    packInfo.iconBlob = blob;
    packInfo.iconUrl = URL.createObjectURL(blob);
  }

  // Load Filler Image
  const fillerZipFile = zip.file(packInfo.fillerImageFilename || '_pack_filler_image.png');
  if (fillerZipFile) {
    const blob = await fillerZipFile.async('blob');
    packInfo.fillerImageBlob = blob;
    packInfo.fillerImageUrl = URL.createObjectURL(blob);
  }

  // 2. Read Clip INI files (manche Packs nutzen .txt statt .ini — oder mischen beides)
  const iniFiles = Object.keys(zip.files).filter(
    (k) => !zip.files[k].dir && /\.(ini|txt)$/i.test(k) && !baseNameOf(k).startsWith('_') &&
      !/(^|\/)__MACOSX\//.test(k) && !/readme/i.test(baseNameOf(k))
  );
  iniFiles.sort();

  const clips: TimelineClip[] = [];
  let currentTimeTracker = 0;

  for (let i = 0; i < iniFiles.length; i++) {
    const iniFileName = iniFiles[i];
    const baseName = iniFileName.replace(/\.(ini|txt)$/i, '');
    const iniFile = zip.file(iniFileName);
    if (!iniFile) continue;

    const text = await iniFile.async('string');
    const parsedClip = parseClipIni(text);
    if (!parsedClip.dubCharacters?.length && !parsedClip.caption) continue;   // keine Clip-Datei

    // Look for matching audio file
    const wavFile = ['wav', 'mp3', 'ogg', 'm4a', 'opus'].map((e) => zip.file(`${baseName}.${e}`)).find(Boolean) || null;
    let audioBlob: Blob | undefined = undefined;
    let clipDuration = 2.0;

    if (wavFile) {
      audioBlob = await fileFromZip(wavFile, AUDIO_TYPES, 'audio/wav');
      const d = await audioDuration(audioBlob);
      if (d > 0.1) clipDuration = d;
    }

    const timestamp = parsedClip.dubTimestamps?.[0] ?? currentTimeTracker;
    const startTime = timestamp;
    const endTime = startTime + clipDuration;

    currentTimeTracker = endTime + 0.5;

    // Custom clip image
    let imageUrl: string | undefined = undefined;
    if (parsedClip.imageFilename) {
      const imgZipFile = zip.file(parsedClip.imageFilename);
      if (imgZipFile) {
        const b = await imgZipFile.async('blob');
        imageUrl = URL.createObjectURL(b);
      }
    }

    clips.push({
      id: `clip_${i + 1}_${baseName}`,
      filename: baseName,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      dubTimestamps: parsedClip.dubTimestamps || [startTime],
      dubCharacters: parsedClip.dubCharacters || ['Unknown'],
      caption: parsedClip.caption || '',
      imageFilename: parsedClip.imageFilename,
      imageUrl,
      audioBlob,
      audioStart: audioBlob ? Number(startTime.toFixed(3)) : undefined,
      audioEnd: audioBlob ? Number(endTime.toFixed(3)) : undefined,
      volume: 1,
    });
  }

  // 3. Collect ALL Character Names & Avatar Files
  const charMap = new Map<string, { name: string; avatarFilename?: string }>();

  // A) Add from packInfo.preselectedDubCharacters
  if (packInfo.preselectedDubCharacters) {
    for (const name of packInfo.preselectedDubCharacters) {
      if (!name) continue;
      const key = cleanCharKey(name);
      if (!charMap.has(key)) {
        charMap.set(key, { name });
      }
    }
  }

  // B) Add from clips
  clips.forEach((c) => {
    c.dubCharacters.forEach((name) => {
      if (!name) return;
      const key = cleanCharKey(name);
      if (!charMap.has(key)) {
        charMap.set(key, { name });
      }
    });
  });

  // C) Add from any leftover image files in the ZIP
  const knownNonCharImages = new Set<string>();
  if (packInfo.iconFilename) knownNonCharImages.add(packInfo.iconFilename.toLowerCase());
  if (packInfo.fillerImageFilename) knownNonCharImages.add(packInfo.fillerImageFilename.toLowerCase());
  knownNonCharImages.add('_icon.png');
  knownNonCharImages.add('icon.png');
  knownNonCharImages.add('_pack_filler_image.png');
  clips.forEach((c) => {
    if (c.imageFilename) knownNonCharImages.add(c.imageFilename.toLowerCase());
  });

  const zipImageKeys = Object.keys(zip.files).filter((k) => {
    if (zip.files[k].dir) return false;
    const lk = k.toLowerCase();
    if (knownNonCharImages.has(lk)) return false;
    if (lk.startsWith('_pack_') || lk.startsWith('_draft_')) return false;
    return lk.endsWith('.png') || lk.endsWith('.jpg') || lk.endsWith('.jpeg') || lk.endsWith('.webp') || lk.endsWith('.gif');
  });

  for (const imgKey of zipImageKeys) {
    const derivedName = formatCharNameFromFilename(imgKey);
    const key = cleanCharKey(derivedName);
    if (!charMap.has(key)) {
      charMap.set(key, { name: derivedName, avatarFilename: imgKey });
    } else {
      // If character was already added by name, assign this avatar image if not already set
      const existing = charMap.get(key)!;
      if (!existing.avatarFilename) {
        existing.avatarFilename = imgKey;
      }
    }
  }

  // 4. Construct Character Objects
  const characters: Character[] = [];
  let charIndex = 0;

  for (const [key, item] of charMap.entries()) {
    let avatarFilename = item.avatarFilename || `${key}.png`;
    let avatarUrl = '';

    let matchingKey = avatarFilename && zip.file(avatarFilename) ? avatarFilename : undefined;

    if (!matchingKey) {
      matchingKey = Object.keys(zip.files).find((k) => {
        if (zip.files[k].dir) return false;
        const lk = k.toLowerCase();
        return (
          cleanCharKey(lk).includes(key) &&
          (lk.endsWith('.png') || lk.endsWith('.jpg') || lk.endsWith('.jpeg') || lk.endsWith('.webp'))
        );
      });
    }

    if (matchingKey && zip.files[matchingKey]) {
      avatarFilename = matchingKey;
      const b = await zip.files[matchingKey].async('blob');
      avatarUrl = URL.createObjectURL(b);
    } else {
      avatarUrl = createAvatarSvgDataUrl(item.name, PRESET_COLORS[charIndex % PRESET_COLORS.length]);
    }

    characters.push({
      id: `char_${charIndex + 1}_${key}`,
      name: item.name,
      avatarFilename,
      avatarUrl,
      color: PRESET_COLORS[charIndex % PRESET_COLORS.length],
    });

    charIndex++;
  }

  // 5. Video Media
  let videoMedia: MediaSource | undefined = undefined;
  const videoZipFile = findVideo(zip);
  if (videoZipFile) {
    const vFile = await fileFromZip(videoZipFile, VIDEO_TYPES, 'video/mp4');
    videoMedia = {
      type: 'video',
      file: vFile,
      name: vFile.name,
      url: URL.createObjectURL(vFile),
      duration: Math.max(20, Math.ceil(currentTimeTracker)),
    };
  }

  // 6. Backing Track
  let backingTrackMedia: MediaSource | undefined = undefined;
  const backingZipFile = findBacking(zip);
  if (backingZipFile) {
    const bFile = await fileFromZip(backingZipFile, AUDIO_TYPES, 'audio/wav');
    backingTrackMedia = {
      type: 'audio',
      file: bFile,
      name: bFile.name,
      url: URL.createObjectURL(bFile),
      duration: 20,
    };
  }

  return {
    packInfo,
    characters,
    clips,
    videoMedia,
    backingTrackMedia,
  };
}
