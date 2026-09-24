import { Character, PackInfo, TimelineClip } from '../types';
import localforage from 'localforage';

export interface SavedProject {
  id: string;
  title: string;
  updatedAt: number;
  packInfo: PackInfo;
  characters: Character[];
  clips: TimelineClip[];
  duration?: number;
  videoMediaName?: string;
  videoMediaUrl?: string;
  backingTrackName?: string;
  backingTrackUrl?: string;
}

const STORAGE_KEY_CURRENT = 'cvmodmaker_current_project';
const STORAGE_KEY_PROJECTS = 'cvmodmaker_saved_projects';

// Initialize a specific localforage instance for media files to keep them separate from other DBs
export const mediaStorage = localforage.createInstance({
  name: 'cvmodmaker_media_storage'
});

export async function saveMediaFileToStorage(projectId: string, type: 'video' | 'backingTrack', file: File | Blob) {
  try {
    await mediaStorage.setItem(`${projectId}_${type}`, file);
  } catch (err) {
    console.error(`Failed to save ${type} to IndexedDB:`, err);
  }
}

export async function loadMediaFileFromStorage(projectId: string, type: 'video' | 'backingTrack'): Promise<File | Blob | null> {
  try {
    const file = await mediaStorage.getItem<File | Blob>(`${projectId}_${type}`);
    return file || null;
  } catch (err) {
    console.error(`Failed to load ${type} from IndexedDB:`, err);
    return null;
  }
}

export async function deleteMediaFilesFromStorage(projectId: string) {
  try {
    await mediaStorage.removeItem(`${projectId}_video`);
    await mediaStorage.removeItem(`${projectId}_backingTrack`);
  } catch (err) {
    console.error(`Failed to delete media for ${projectId} from IndexedDB:`, err);
  }
}

/** Große data:-URLs (Bilder) kosten viel vom ~5-MB-Speicher des Browsers. */
const BIG_DATA_URL = 150_000;

function trySetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function saveActiveProjectLocally(
  projectId: string,
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMediaName?: string,
  backingTrackName?: string,
  videoMediaUrl?: string,
  backingTrackUrl?: string,
  duration?: number
): SavedProject {
  // Clean temporary blob object URLs while keeping persistent data/http URLs
  const sanitizeUrl = (url?: string, defaultFallback?: string) => {
    if (!url) return defaultFallback;
    if (url.startsWith('blob:')) return defaultFallback;
    return url;
  };

  const cleanPackInfo: PackInfo = {
    ...packInfo,
    iconBlob: undefined,
    fillerImageBlob: undefined,
    iconUrl: sanitizeUrl(packInfo.iconUrl),
    fillerImageUrl: sanitizeUrl(packInfo.fillerImageUrl),
  };

  // Dateien (File/Blob) lassen sich nicht als JSON speichern — sie wurden zu einem leeren
  // Objekt {}, und nach dem Neuladen brach der Export an genau diesem "Bild" ab.
  const cleanCharacters = characters.map((c) => ({
    ...c,
    avatarFile: undefined,
    avatarUrl: sanitizeUrl(c.avatarUrl) as string,
  }));

  const cleanClips = clips.map((c) => ({
    ...c,
    audioBlob: undefined,
    imageUrl: sanitizeUrl(c.imageUrl),
  }));

  const project: SavedProject = {
    id: projectId,
    title: cleanPackInfo.title || 'Untitled Dub Modpack',
    updatedAt: Date.now(),
    packInfo: cleanPackInfo,
    characters: cleanCharacters,
    clips: cleanClips,
    duration: duration || undefined,
    videoMediaName,
    videoMediaUrl: sanitizeUrl(videoMediaUrl),
    backingTrackName,
    backingTrackUrl: sanitizeUrl(backingTrackUrl),
  };

  // Automatisch aufgenommene Standbilder lassen sich jederzeit neu erzeugen — die als
  // Erstes weglassen, wenn der Speicher knapp wird.
  const withoutRegenerableFrames = (p: SavedProject): SavedProject => ({
    ...p,
    clips: p.clips.map((c) =>
      c.capturedAtTime !== undefined && c.imageUrl?.startsWith('data:') ? { ...c, imageUrl: undefined, capturedAtTime: undefined } : c
    ),
  });
  const withoutBigImages = (p: SavedProject): SavedProject => ({
    ...withoutRegenerableFrames(p),
    clips: withoutRegenerableFrames(p).clips.map((c) =>
      c.imageUrl && c.imageUrl.length > BIG_DATA_URL ? { ...c, imageUrl: undefined } : c
    ),
  });

  const existingList = getSavedProjectsList().filter((p) => p.id !== project.id);
  // In der Liste nur schlanke Kopien — die vollständige Fassung steht unter STORAGE_KEY_CURRENT
  const slim = withoutBigImages(project);

  const attempts: Array<[SavedProject, SavedProject[]]> = [
    [project, [slim, ...existingList.map(withoutBigImages)].slice(0, 10)],
    [withoutRegenerableFrames(project), [slim, ...existingList.map(withoutBigImages)].slice(0, 5)],
    [slim, [slim]],
  ];
  let saved = false;
  for (const [current, list] of attempts) {
    if (trySetItem(STORAGE_KEY_CURRENT, JSON.stringify(current)) && trySetItem(STORAGE_KEY_PROJECTS, JSON.stringify(list))) {
      saved = true;
      break;
    }
  }
  if (!saved) console.warn('Could not save project to localStorage (storage full).');

  return project;
}

export function getActiveProjectFromStorage(): SavedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CURRENT);
    if (!raw) return null;
    return JSON.parse(raw) as SavedProject;
  } catch {
    return null;
  }
}

export function getSavedProjectsList(): SavedProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (!raw) return [];
    return JSON.parse(raw) as SavedProject[];
  } catch {
    return [];
  }
}

export function deleteSavedProject(id: string): void {
  try {
    const list = getSavedProjectsList();
    const updated = list.filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(updated));

    const current = getActiveProjectFromStorage();
    if (current && current.id === id) {
      localStorage.removeItem(STORAGE_KEY_CURRENT);
    }
    
    // Also cleanup media files from IndexedDB
    deleteMediaFilesFromStorage(id).catch(console.error);
  } catch (err) {
    console.warn('Error deleting project from storage:', err);
  }
}
