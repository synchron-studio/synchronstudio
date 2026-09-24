import { Character, PackInfo, TimelineClip } from '../types';

/**
 * Generate SVG Data URL for character avatar placeholder
 */
export function createAvatarSvgDataUrl(name: string, bgColor = '#3b82f6', textColor = '#ffffff'): string {
  // Lokal erzeugt statt über api.dicebear.com: funktioniert offline, hängt an keinem
  // fremden Dienst und lässt sich beim Export zuverlässig in PNG umrechnen.
  const clean = String(name || '?').trim();
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  const letters = (parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase() || '?';
  const safe = (v: string) => v.replace(/[<>&"']/g, '');
  const bg = /^#[0-9a-f]{3,8}$/i.test(bgColor) ? bgColor : '#3b82f6';
  const fg = /^#[0-9a-f]{3,8}$/i.test(textColor) ? textColor : '#ffffff';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" data-ss-placeholder="1">` +
    `<rect width="256" height="256" rx="48" fill="${bg}"/>` +
    `<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Helvetica,sans-serif" font-size="104" font-weight="700" fill="${fg}">${safe(letters)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Automatisch erzeugter Platzhalter (alt: dicebear, neu: lokales SVG)? */
export function isPlaceholderAvatar(url?: string): boolean {
  if (!url) return true;
  return url.includes('dicebear') || (url.startsWith('data:image/svg+xml') && url.includes('data-ss-placeholder'));
}

export const SAMPLE_PACK_INFO: PackInfo = {
  title: 'Woody and Buzz Argue',
  iconFilename: 'ts.png',
  iconUrl: createAvatarSvgDataUrl('TS', '#3b82f6'),
  authors: ['Sticks456546'],
  readme: 'The Woody and Buzz argument scene from Toy Story. Optimized for Dub Mode scoring in The Choicer Voicer.',
  preselectedDubCharacters: ['Woody', 'Buzz'],
  fillerImageFilename: '_pack_filler_image.png',
  fillerImageUrl: createAvatarSvgDataUrl('CV', '#10b981'),
};

export const SAMPLE_CHARACTERS: Character[] = [
  {
    id: 'char_buzz',
    name: 'Buzz',
    avatarFilename: 'buzz.png',
    avatarUrl: createAvatarSvgDataUrl('Buzz', '#8b5cf6'),
    color: '#8b5cf6', // purple
  },
  {
    id: 'char_woody',
    name: 'Woody',
    avatarFilename: 'woody.png',
    avatarUrl: createAvatarSvgDataUrl('Woody', '#eab308'),
    color: '#eab308', // amber/yellow
  },
  {
    id: 'char_rex',
    name: 'Rex',
    avatarFilename: 'rex.png',
    avatarUrl: createAvatarSvgDataUrl('Rex', '#22c55e'),
    color: '#22c55e', // green
  },
];

export const SAMPLE_CLIPS: TimelineClip[] = [
  {
    id: 'clip_01_buzz',
    filename: '01_buzz',
    startTime: 0.0,
    endTime: 3.5,
    dubTimestamps: [0.520],
    dubCharacters: ['Buzz'],
    caption: '“According to my nava-computer, the atmosphere is breathable.”',
    imageFilename: 'buzz.png',
    imageUrl: createAvatarSvgDataUrl('Buzz', '#8b5cf6'),
    volume: 1,
  },
  {
    id: 'clip_02_woody',
    filename: '02_woody',
    startTime: 3.5,
    endTime: 7.8,
    dubTimestamps: [3.950],
    dubCharacters: ['Woody'],
    caption: '“You are a toy! You aren\'t the real Buzz Lightyear! You\'re an action figure!”',
    imageFilename: 'woody.png',
    imageUrl: createAvatarSvgDataUrl('Woody', '#eab308'),
    volume: 1,
  },
  {
    id: 'clip_03_buzz',
    filename: '03_buzz',
    startTime: 7.8,
    endTime: 12.2,
    dubTimestamps: [8.200],
    dubCharacters: ['Buzz'],
    caption: '“You are a sad, strange little man, and you have my pity. Farewell.”',
    imageFilename: 'buzz.png',
    imageUrl: createAvatarSvgDataUrl('Buzz', '#8b5cf6'),
    volume: 1,
  },
  {
    id: 'clip_04_woody',
    filename: '04_woody',
    startTime: 12.2,
    endTime: 17.0,
    dubTimestamps: [12.650],
    dubCharacters: ['Woody'],
    caption: '“Oh yeah? Well, good luck then! Good luck!”',
    imageFilename: 'woody.png',
    imageUrl: createAvatarSvgDataUrl('Woody', '#eab308'),
    volume: 1,
  },
];
