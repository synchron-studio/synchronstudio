#!/usr/bin/env node
/*
 * Szenen-Import: ZIPs aus dem Szenen-Editor („Export Scene (.zip)“) automatisch einbauen.
 *
 * Ablauf (läuft normalerweise in GitHub Actions, siehe .github/workflows/import-scenes.yml):
 *   1. ZIP in den Ordner _import/ hochladen
 *   2. dieses Skript prüft das ZIP, kopiert Video / Bilder / Original-Zeilen / Vorschau an die
 *      richtigen Stellen, trägt die Szene in scenes.json ein (oder ersetzt sie bei gleicher ID),
 *      ergänzt Profilbilder + CDN-Ausnahme, baut den Szenen-Index neu, zählt die Version hoch
 *      und schreibt Patch Notes
 *   3. erfolgreich importierte ZIPs werden gelöscht; fehlerhafte wandern nach
 *      _import/fehlgeschlagen/ — mit einer .txt daneben, die erklärt, was nicht passt
 *
 * Aufruf:  node tools/import-scene.cjs            (alle _import/*.zip|rar|7z + Links aus _import/links.txt)
 *          node tools/import-scene.cjs a.zip b.zip
 * Exit-Code 1, wenn mindestens ein ZIP nicht importiert werden konnte.
 * Zusammenfassung (Markdown) geht nach stdout und — falls gesetzt — nach $GITHUB_STEP_SUMMARY.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const ROOT = process.env.SS_ROOT || path.join(__dirname, '..');
const IMPORT_DIR = path.join(ROOT, '_import');
const FAILED_DIR = path.join(IMPORT_DIR, 'fehlgeschlagen');
const CDN_LIMIT_BYTES = 19.5 * 1024 * 1024;   // jsDelivr liefert größere Dateien nicht aus
const MAX_FILE_BYTES = 95 * 1024 * 1024;      // GitHub nimmt keine Dateien über 100 MB an
const PREVIEW_MAX_BYTES = 500000;

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const today = () => new Date().toISOString().slice(0, 10);
const has = (cmd) => { try { cp.execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };

class ImportError extends Error {}

// Jede Archiv-Datei, auch Teile mehrteiliger Archive (x.7z.001, x.part2.rar, x.z01 …)
const ARCHIVE_RE = /(\.(zip|rar|7z)(\.\d{2,3})?|\.z\d\d|\.r\d\d)$/i;
const ARCHIVE_TOOLS = (zipFile, dir) => [
  ['7zz', ['x', '-y', '-bd', '-o' + dir, zipFile]],          // aktuelles 7-Zip (kann RAR5)
  ['7z', ['x', '-y', '-bd', '-o' + dir, zipFile]],
  ['unrar', ['x', '-o+', '-idq', zipFile, dir + '/']],
  ['unar', ['-q', '-f', '-o', dir, zipFile]],
];
/** Mit welcher Datei fängt ein (ggf. mehrteiliges) Archiv an? Nur die wird entpackt, 7z holt die Teile dazu. */
function isFirstArchive(n) {
  let m;
  if ((m = /part0*(\d+)\.rar$/i.exec(n))) return +m[1] === 1;          // auch „…minutespart1.rar“
  if ((m = /\.(zip|rar|7z)\.(\d{2,3})$/i.exec(n))) return +m[2] === 1;
  return /\.(zip|rar|7z)$/i.test(n);
}

function extract(zipFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-import-'));
  // Geteiltes ZIP (x.zip + x.z01 …) kann unzip nicht — dann auch 7z
  const isZip = /\.zip$/i.test(zipFile) && !fs.existsSync(zipFile.replace(/\.zip$/i, '.z01'));
  // ZIP mit unzip; RAR/7z (so liegen viele GameBanana-Packs vor) mit 7z, sonst unar
  const tries = isZip ? [['unzip', ['-qq', '-o', zipFile, '-d', dir]], ...ARCHIVE_TOOLS(zipFile, dir)] : ARCHIVE_TOOLS(zipFile, dir);
  const errs = [];
  for (const [cmd, args] of tries) {
    try { cp.execFileSync(cmd, args, { stdio: 'pipe', maxBuffer: 1 << 26 }); if (fs.readdirSync(dir).length) break; }
    catch (e) {
      // unzip meldet z. B. bei Warnungen Exit-Code 1, entpackt aber trotzdem
      if (fs.readdirSync(dir).length) break;
      errs.push(`${cmd}: ${e.code === 'ENOENT' ? 'nicht installiert' : String(e.stderr || e.stdout || e.message).trim().split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 200)}`);
    }
  }
  if (!fs.readdirSync(dir).length) {
    // Was ist das eigentlich? (z. B. eine HTML-Fehlerseite statt des Archivs)
    let kind = '';
    try { kind = cp.execFileSync('file', ['-b', zipFile], { encoding: 'utf8' }).trim(); } catch {}
    const size = (() => { try { return (fs.statSync(zipFile).size / 1048576).toFixed(1) + ' MB'; } catch { return '?'; } })();
    throw new ImportError(`Das Archiv ließ sich nicht öffnen (beschädigt oder kein ${isZip ? 'ZIP' : 'RAR/7z'}).\nDatei: ${path.basename(zipFile)}, ${size}${kind ? ', Typ: ' + kind : ''}\n${errs.join('\n')}`);
  }
  // Liegt alles in einem Unterordner (z. B. „meine_szene/scene.json“ oder ein Choicer-Voicer-Pack
  // „Reze s Conspiracy Lesson/_pack_info.ini“)? Dann den nehmen.
  const looksLikeScene = (d) => fs.existsSync(path.join(d, 'scene.json')) || isChoicerPack(d);
  if (!looksLikeScene(dir)) {
    // auch mehrfach verschachtelt („szene/Szene - Titel/_pack_info.ini“) — bis 4 Ebenen tief suchen
    const hits = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      for (const n of fs.readdirSync(d)) {
        if (n.startsWith('__MACOSX') || n.startsWith('.')) continue;
        const p = path.join(d, n);
        if (!fs.statSync(p).isDirectory()) continue;
        if (looksLikeScene(p)) hits.push(p); else walk(p, depth + 1);
      }
    };
    walk(dir, 1);
    // Mehrere Packs in einem Archiv (z. B. „lustige Clips“-Sammlung) → jedes wird eine eigene Szene
    if (hits.length) return { dirs: hits.sort(), cleanup: dir };
  }
  return { dirs: [dir], cleanup: dir };
}

function inside(base, p) {
  const r = path.relative(base, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r);
}

/** Video-Codec der ersten Bildspur (h264, hevc, vp9 …) — leer, wenn nicht bestimmbar. */
function probeVideoCodec(file) {
  try {
    const out = cp.execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    if (out) return out.split(/\s+/)[0].toLowerCase();
  } catch { /* kein ffprobe */ }
  try { cp.execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: 'pipe' }); }
  catch (e) { const m = /Video:\s*([a-z0-9_]+)/i.exec(String(e.stderr || '')); if (m) return m[1].toLowerCase(); }
  return '';
}
function probeDuration(file) {
  if (!has('ffprobe')) {
    if (!has('ffmpeg')) return null;
    // Fallback: „Duration: 00:01:10.17“ aus der ffmpeg-Ausgabe lesen
    let txt = '';
    try { cp.execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { txt = String(e.stderr || ''); }
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
  }
  try {
    const out = cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    const d = parseFloat(out);
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

function makePreview(video, out, startAt) {
  if (!has('ffmpeg')) throw new ImportError('Im ZIP fehlt die Vorschau (previews/<id>.mp4) und ffmpeg ist nicht verfügbar, um sie zu erzeugen.');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const attempt = (crf, width) => cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, startAt)), '-i', video, '-t', '6',
    '-vf', `scale='min(${width},iw)':-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', out], { stdio: 'pipe' });
  attempt(30, 426);
  if (fs.statSync(out).size >= PREVIEW_MAX_BYTES) attempt(36, 320);
  if (fs.statSync(out).size >= PREVIEW_MAX_BYTES) throw new ImportError('Die Vorschau wurde zu groß (über 500 KB) — das Video ist ungewöhnlich detailreich.');
}

/** Prüft scene.json + Dateien, liefert die bereinigte Szene und die zu kopierenden Dateien. */
function validate(dir, opts = {}) {
  const problems = [], notes = [];
  const sceneFile = path.join(dir, 'scene.json');
  if (!fs.existsSync(sceneFile)) {
    throw new ImportError('Im ZIP wurde weder ein Szenen-Export (scene.json) noch ein Choicer-Voicer-Pack (_pack_info.ini, dub_video, Zeilen-.txt) gefunden. Bitte das ZIP aus dem Szenen-Editor oder das Pack unverändert hochladen.');
  }
  let scene;
  try { scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')); } catch { throw new ImportError('scene.json ist kaputt (kein gültiges JSON).'); }
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new ImportError('scene.json enthält keine Szene.');
  // „als <id>“ in links.txt: diese Szene ersetzt eine bestehende (z. B. neue deutsche Fassung)
  if (opts.forceId && scene.id !== opts.forceId) {
    const oldId = String(scene.id || ''), nid = opts.forceId;
    const mv = (a, b) => { if (oldId && fs.existsSync(path.join(dir, a)) && !fs.existsSync(path.join(dir, b))) { fs.mkdirSync(path.dirname(path.join(dir, b)), { recursive: true }); fs.renameSync(path.join(dir, a), path.join(dir, b)); } };
    mv(`scenes/${oldId}.mp4`, `scenes/${nid}.mp4`);
    mv(`scenes/${oldId}`, `scenes/${nid}`);
    mv(`previews/${oldId}.mp4`, `previews/${nid}.mp4`);
    const fix = (v) => typeof v === 'string' && oldId ? v.split(`scenes/${oldId}/`).join(`scenes/${nid}/`).replace(`scenes/${oldId}.mp4`, `scenes/${nid}.mp4`).replace(`previews/${oldId}.mp4`, `previews/${nid}.mp4`) : v;
    scene.id = nid;
    scene.videoUrl = `scenes/${nid}.mp4`;
    if (scene.previewUrl) scene.previewUrl = fix(scene.previewUrl);
    if (scene.avatars) for (const k of Object.keys(scene.avatars)) scene.avatars[k] = fix(scene.avatars[k]);
    for (const l of scene.lines || []) if (l && l.orig) l.orig = fix(l.orig);
    notes.push(`Ersetzt die Szene \`${nid}\` (Szenen-ID aus dem ZIP war \`${oldId || '—'}\`).`);
  }

  const id = String(scene.id || '');
  if (!/^[a-z0-9_]{2,60}$/.test(id)) problems.push(`Szenen-ID „${id}“ ist ungültig (nur Kleinbuchstaben, Ziffern und _).`);
  if (/^(newscene|new_scene|scene|szene|test|untitled)$/.test(id)) problems.push(`Die Szene heißt noch „${id}“ (Standardname). Bitte im Szenen-Editor unter „Pack Settings“ einen eigenen Titel / eine eigene Szenen-ID vergeben — sonst überschreiben sich verschiedene Szenen gegenseitig.`);
  if (!scene.title || typeof scene.title !== 'string') problems.push('Die Szene hat keinen Titel.');
  const roles = Array.isArray(scene.roles) ? scene.roles : [];
  if (!roles.length) problems.push('Die Szene hat keine Rollen/Figuren.');
  const roleIds = new Set(roles.map(r => r && r.id));
  roles.forEach((r, i) => { if (!r || typeof r.name !== 'string' || !r.name.trim()) problems.push(`Rolle ${i + 1} hat keinen Namen.`); });
  const lines = Array.isArray(scene.lines) ? scene.lines : [];
  if (!lines.length) problems.push('Die Szene hat keine Zeilen (Clips auf der Timeline).');
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l || !Number.isFinite(l.t) || !Number.isFinite(l.end) || !(l.end > l.t)) problems.push(`Zeile ${n}: ungültige Zeiten (Start ${l && l.t}, Ende ${l && l.end}).`);
    if (!l || !Array.isArray(l.chars) || !l.chars.length || !l.chars.every(c => roleIds.has(c))) problems.push(`Zeile ${n}: keiner gültigen Figur zugeordnet.`);
    if (l && l.text != null && typeof l.text !== 'string') problems.push(`Zeile ${n}: Text ist kein Text.`);
  });

  const video = `scenes/${id}.mp4`;
  if (scene.videoUrl !== video) problems.push(`videoUrl muss „${video}“ sein (ist „${scene.videoUrl}“).`);
  const videoPath = path.join(dir, video);
  if (!fs.existsSync(videoPath)) {
    if (fs.existsSync(path.join(dir, '_source'))) problems.push('Das Video konnte im Browser nicht umgewandelt werden (im ZIP liegt nur _source/). Bitte nochmal im Editor exportieren (Chrome/Edge) oder Elias/Claude Bescheid geben.');
    else problems.push(`Im ZIP fehlt das Szenen-Video ${video}.`);
  }
  if (problems.length) throw new ImportError(problems.join('\n'));

  let videoPath2 = videoPath;
  let videoBytes = fs.statSync(videoPath).size;
  // Viele Browser (Firefox, ältere Chrome/Windows) spielen HEVC/H.265, VP9-in-MP4 usw. nicht ab →
  // in H.264 umwandeln, Qualität so hoch, dass man praktisch keinen Unterschied sieht (CRF 18).
  // Auch nötig, wenn die Datei für GitHub zu groß ist; dann Schritt für Schritt etwas kleiner.
  const vcodec = probeVideoCodec(videoPath);
  if ((vcodec && vcodec !== 'h264') || videoBytes > MAX_FILE_BYTES) {
    if (!has('ffmpeg')) throw new ImportError(`Das Video (${vcodec || '?'}, ${(videoBytes / 1048576).toFixed(0)} MB) müsste umgewandelt werden, aber ffmpeg fehlt.`);
    const tmpV = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-vid-'));
    const outV = path.join(tmpV, 'scene.mp4');
    let done = false;
    for (const crf of [18, 20, 22, 24, 26]) {
      ffmpegRun(['-i', videoPath, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outV], 'Das Video');
      if (fs.statSync(outV).size <= MAX_FILE_BYTES) { done = true; notes.push(`Video von ${vcodec || 'unbekannt'} (${(videoBytes / 1048576).toFixed(0)} MB) in H.264 umgewandelt — Qualitätsstufe CRF ${crf} (${crf <= 20 ? 'praktisch kein sichtbarer Unterschied' : 'leicht komprimiert'}), jetzt ${(fs.statSync(outV).size / 1048576).toFixed(1)} MB.`); break; }
    }
    if (!done) throw new ImportError(`Das Video ist auch nach dem Umwandeln noch über 95 MB — bitte kürzer schneiden oder in kleinerer Auflösung exportieren.`);
    videoPath2 = outV;
    videoBytes = fs.statSync(outV).size;
  }
  const lastEnd = Math.max(...lines.map(l => l.end));
  const dur = probeDuration(videoPath2);
  if (dur != null && dur + 0.75 < lastEnd) throw new ImportError(`Das Video ist nur ${dur.toFixed(1)} s lang, die letzte Zeile endet aber bei ${lastEnd.toFixed(1)} s.`);

  // Alle Pfade in der Szene müssen im ZIP liegen — fehlende Original-Zeilen/Bilder werden weggelassen statt das Spiel zu brechen
  const files = new Map([[video, videoPath2]]);
  const want = (p, what, drop) => {
    if (typeof p !== 'string' || !p.startsWith(`scenes/${id}/`)) { drop(); notes.push(`${what}: Pfad „${p}“ liegt nicht unter scenes/${id}/ — weggelassen.`); return; }
    const abs = path.join(dir, p);
    if (!inside(dir, abs) || !fs.existsSync(abs)) { drop(); notes.push(`${what}: Datei „${p}“ fehlt im ZIP — weggelassen.`); return; }
    files.set(p, abs);
  };
  const avatars = scene.avatars && typeof scene.avatars === 'object' ? scene.avatars : {};
  for (const k of Object.keys(avatars)) want(avatars[k], `Bild für Rolle ${k}`, () => { delete avatars[k]; });
  scene.avatars = avatars;
  lines.forEach((l, i) => { if (l.orig != null) want(l.orig, `Original-Ton Zeile ${i + 1}`, () => { delete l.orig; }); });
  // Ältere Editor-Exporte enthielten teils fast unhörbar leise Zeilen — hier auf hörbaren Pegel bringen
  let louder = 0;
  const normDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-norm-'));
  lines.forEach((l, i) => {
    const src = l.orig && files.get(l.orig);
    if (!src || !has('ffmpeg')) return;
    try {
      const r = cp.spawnSync('ffmpeg', ['-hide_banner', '-i', src, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const peak = +((/max_volume: (-?[\d.]+) dB/.exec(r.stderr || '') || [])[1]);
      if (!Number.isFinite(peak) || peak > -6) return;
      const gain = Math.min(20, -1 - peak);
      const dst = path.join(normDir, `line_${i}.mp3`);
      ffmpegRun(['-i', src, '-ac', '1', '-af', `volume=${gain.toFixed(1)}dB`, '-c:a', 'libmp3lame', '-b:a', '64k', dst], `Zeile ${i + 1}`);
      files.set(l.orig, dst); louder++;
    } catch { /* Original behalten */ }
  });
  if (louder) notes.push(`${louder} zu leise Original-Zeile(n) lauter gemacht.`);

  const previewRel = `previews/${id}.mp4`;
  const previewAbs = path.join(dir, previewRel);
  let previewSrc = fs.existsSync(previewAbs) && fs.statSync(previewAbs).size < PREVIEW_MAX_BYTES ? previewAbs : null;
  if (!previewSrc) {
    const out = path.join(dir, '_preview_generated.mp4');
    makePreview(videoPath2, out, Math.max(0, (lines[0] && lines[0].t || 0) - 0.5));
    previewSrc = out;
    notes.push('Vorschau-Clip fehlte oder war zu groß — wurde automatisch erzeugt.');
  }
  files.set(previewRel, previewSrc);
  scene.previewUrl = previewRel;
  scene.previewBytes = fs.statSync(previewSrc).size;
  scene.videoBytes = videoBytes;
  if (!scene.difficultyOverride) scene.difficultyOverride = 'medium';
  autoTranslate(lines, notes);
  if (lines.some(l => !l.orig)) notes.push(`${lines.filter(l => !l.orig).length} Zeile(n) ohne Original-Ton — dort gibt es kein „Original anhören“.`);
  return { scene, files, notes, videoBytes };
}

// ── Änderungen an Repo-Dateien (textgenau, damit die Diffs klein bleiben) ──
function objectSpan(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('scenes.json: Ende des Eintrags nicht gefunden');
}
/** Vor dem Kopieren: eine von Hand eingebaute Szene mit gleicher ID darf ein Upload nie überschreiben. */
function checkIdFree(scene) {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes.json'), 'utf8'));
  const old = list.find(s => s && s.id === scene.id);
  if (old && !old.imported) throw new ImportError(`Es gibt schon eine (von Hand eingebaute) Szene mit der ID „${scene.id}“ — die wird nicht überschrieben. Bitte im Editor eine andere Szenen-ID / einen anderen Titel vergeben.`);
}
function upsertScene(scene) {
  // Neue Versionsnummer für alle Dateien der Szene → Browser/CDN laden nach dem Ersetzen garantiert neu
  scene.assetsVersion = Date.now().toString(36);
  const file = path.join(ROOT, 'scenes.json');
  let text = fs.readFileSync(file, 'utf8');
  const list = JSON.parse(text);
  const old = list.find(s => s && s.id === scene.id);
  const exists = !!old;
  scene.imported = true;
  scene.catalogChange = exists ? 'updated' : 'new';
  scene.catalogChangedAt = today();
  const json = JSON.stringify(scene);
  if (exists) {
    const marker = text.indexOf(`{"id":${JSON.stringify(scene.id)}`);
    if (marker < 0) {
      // ungewöhnlich formatiert → notfalls komplett neu schreiben
      text = JSON.stringify(list.map(s => (s.id === scene.id ? scene : s))) + '\n';
    } else {
      text = text.slice(0, marker) + json + text.slice(objectSpan(text, marker));
    }
  } else {
    const end = text.lastIndexOf(']');
    text = text.slice(0, end).replace(/\s*$/, '') + ',' + json + text.slice(end);
  }
  JSON.parse(text);   // Sicherheitsnetz
  fs.writeFileSync(file, text);
  return exists;
}
function plainTitle(title) { return String(title).replace(/\s*\(\d+\s*(Rolle|Rollen|roles?)\)\s*$/i, '').trim(); }
function updateClientJs(scene, oversize) {
  const file = path.join(ROOT, 'client.js');
  let s = fs.readFileSync(file, 'utf8');
  // Profilbilder
  const start = s.indexOf('const AVATAR_CHARS = [');
  if (start >= 0) {
    const end = s.indexOf('\n];', start);
    const add = [];
    for (const [rid, img] of Object.entries(scene.avatars || {})) {
      if (s.includes(`img: ${JSON.stringify(img)}`)) continue;
      const role = (scene.roles || []).find(r => String(r.id) === String(rid));
      add.push(`  { img: ${JSON.stringify(img)}, label: ${JSON.stringify((role ? role.name : rid) + ' · ' + plainTitle(scene.title))} },`);
    }
    if (add.length && end > start) s = s.slice(0, end) + '\n' + add.join('\n') + s.slice(end);
  }
  // CDN-Ausnahme für große Videos
  const entry = `"scenes/${scene.id}.mp4"`;
  const setStart = s.indexOf('const OVERSIZE_MP4 = new Set([');
  if (setStart >= 0) {
    const setEnd = s.indexOf(']);', setStart);
    const block = s.slice(setStart, setEnd);
    if (oversize && !block.includes(entry)) {
      s = s.slice(0, setEnd) + `  ${entry}, // ${(scene.videoBytes / 1048576).toFixed(1)} MB (automatisch importiert)\n` + s.slice(setEnd);
    } else if (!oversize && block.includes(entry)) {
      s = s.slice(0, setStart) + block.split('\n').filter(l => !l.includes(entry)).join('\n') + s.slice(setEnd);
    }
  }
  fs.writeFileSync(file, s);
}
function bumpVersion(imported) {
  const cfile = path.join(ROOT, 'client.js'), hfile = path.join(ROOT, 'index.html');
  let c = fs.readFileSync(cfile, 'utf8');
  const m = /const APP_VERSION = "(\d+)\.(\d+)\.(\d+)";/.exec(c);
  if (!m) throw new Error('APP_VERSION nicht gefunden');
  const oldV = `${m[1]}.${m[2]}.${m[3]}`, newV = `${m[1]}.${m[2]}.${+m[3] + 1}`;
  c = c.replace(m[0], `const APP_VERSION = "${newV}";`);
  const de = imported.map(x => JSON.stringify(`🎬 ${x.updated ? 'Szene aktualisiert' : 'Neue Szene'}: ${plainTitle(x.title)}`));
  const en = imported.map(x => JSON.stringify(`🎬 ${x.updated ? 'Scene updated' : 'New scene'}: ${plainTitle(x.title)}`));
  const note = `const PATCH_NOTES = [\n  { v: "${newV}", items: [\n    ${de.join(',\n    ')}\n  ], itemsEn: [\n    ${en.join(',\n    ')}\n  ]},\n`;
  if (!c.includes('const PATCH_NOTES = [\n')) throw new Error('PATCH_NOTES nicht gefunden');
  c = c.replace('const PATCH_NOTES = [\n', note);
  fs.writeFileSync(cfile, c);
  // index.html hat gemischte Zeilenenden — nur die Versionsnummern tauschen, sonst nichts anfassen
  const h = fs.readFileSync(hfile);
  const out = Buffer.from(h.toString('latin1').split(`?v=${oldV}`).join(`?v=${newV}`), 'latin1');
  fs.writeFileSync(hfile, out);
  return newV;
}

// ═════════════════════════════════════════════════════════════
// CHOICER-VOICER-PACKS (Ordner mit _pack_info.ini, dub_video.ogv/.mp4, _backing_track.*,
// pro Zeile NNN_Figur.txt/.ini + .wav + Bild) automatisch ins Synchronstudio-Format bringen —
// genau wie die bisherigen Packs von Hand: Video = Bild aus dub_video + Ton NUR aus dem
// Backing-Track (nie die Originalstimmen), Original-Zeilen als MP3, Figurenbilder 160 px.
// ═════════════════════════════════════════════════════════════
const AUDIO_EXT = ['.wav', '.mp3', '.ogg', '.m4a', '.opus', '.flac'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
function isChoicerPack(dir) {
  try {
    const names = fs.readdirSync(dir).map(n => n.toLowerCase());
    return names.includes('_pack_info.ini') || (names.some(n => /^dub_video\.(ogv|mp4|webm|mov|mkv)$/.test(n)) && names.some(n => /\.(txt|ini)$/.test(n)));
  } catch { return false; }
}
function parseIni(text) {
  const out = {};
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (/^\[.*\]$/.test(v)) {
      try { out[m[1]] = JSON.parse(v); } catch {
        out[m[1]] = v.slice(1, -1).split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
      }
    } else out[m[1]] = v.replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"');
  }
  return out;
}
function slugify(t, max = 40) {
  return String(t).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '') || 'szene';
}
/** CV-Untertitel spieltauglich machen: (VFX: …) raus, 'Betonungs'-Anführungszeichen raus. */
function cleanCaption(c) {
  let t = String(c || '');
  // Manche Packs schreiben den Sprecher davor: „[Isagi] "Text"“ — der Name steht im Spiel ohnehin daneben
  // (auch kaputt zitiert: „"[Light] "Text“)
  t = t.replace(/^\s*["“]?\s*\[[^\]]{1,60}\]\s*/, '');
  if ((t.match(/"/g) || []).length % 2 === 1) t = t.replace(/^\s*"/, '').replace(/"\s*$/, '');
  t = t.replace(/\(\s*VFX:[^)]*\)/gi, ' ');
  // „(Guessing (VFX …)“ → nach dem Entfernen offene Klammer schließen
  const open = (t.match(/\(/g) || []).length, close = (t.match(/\)/g) || []).length;
  if (open > close) t = t.replace(/\(([^()]*)$/, '($1)').replace(/\(([^()]*?)\s+\)$/, '($1)');
  // 'Wort' → Wort (aber Apostrophe wie That's / we're / musn't bleiben)
  t = t.replace(/(^|[^A-Za-z0-9])'([^']+?)'(?=$|[^A-Za-z0-9]|s\b)/g, '$1$2');
  t = t.replace(/-([!?.,])/g, '$1');
  // CV schreibt schnell gesprochene Wortgruppen mit Bindestrich („and-Taylor-Swift's“, „to-be“) —
  // ab drei Teilen oder nach kurzen Füllwörtern sind das Leerzeichen; echte Bindestrichwörter bleiben.
  const SMALL = new Set(['i', 'to', 'how', 'for', 'and', 'the', 'a', 'in', 'of', 'not', 'you', 'be', 'it', 'is', 'we', 'my', 'all', 'up', 'so', 'or', 'at', 'on', 'me', 'he', 'she', 'do']);
  t = t.replace(/[A-Za-z']+(?:-[A-Za-z']+)+/g, (w) => {
    const parts = w.split('-');
    return (parts.length >= 3 || SMALL.has(parts[0].toLowerCase())) ? parts.join(' ') : w;
  });
  t = t.replace(/[“”„]/g, '"').replace(/\s+([!?.,])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/\*([^*]+)\*/g, '($1)');                       // *grunts* → (grunts)
  const m = /^"([^"]*)"$/.exec(t); if (m) t = m[1].trim();         // ganzer Satz in Anführungszeichen
  return t;
}
/** Starke VFX-Angaben auf einen Spiel-Effekt abbilden (leichter Raumhall bleibt weg). */
function vfxEffect(c) {
  const m = /VFX:([^)]*)/i.exec(String(c || ''));
  if (!m) return null;
  const val = (name) => { const r = new RegExp('(\\d+)\\s*%\\s*' + name, 'i').exec(m[1]); return r ? +r[1] : 0; };
  const cand = [['chorus', val('Mod')], ['hall', val('Space')], ['echo', val('Echo')], ['radio', val('Radio')], ['telefon', val('Phone')]];
  cand.sort((a, b) => b[1] - a[1]);
  return cand[0][1] >= 30 ? cand[0][0] : null;
}
function ffmpegRun(args, what) {
  if (!has('ffmpeg')) throw new ImportError('ffmpeg fehlt — ohne geht die Umwandlung des Packs nicht.');
  try { cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new ImportError(`${what} konnte nicht umgewandelt werden: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
}
function convertChoicerPack(dir, takenIds) {
  const all = fs.readdirSync(dir);
  const find = (re) => all.find(n => re.test(n));
  const info = fs.existsSync(path.join(dir, '_pack_info.ini')) ? parseIni(fs.readFileSync(path.join(dir, '_pack_info.ini'), 'utf8')) : {};
  const rawTitle = String(info.title || path.basename(dir)).replace(/[.…]+$/, '').trim().replace(/\s+-\s+/, ' — ');
  const videoName = find(/^dub_video\.(ogv|mp4|webm|mov|mkv)$/i);
  if (!videoName) throw new ImportError('Im Pack fehlt dub_video (.ogv/.mp4).');
  const backingName = find(/^_backing_track\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i);

  // Zeilen einsammeln
  const metas = [];
  for (const n of all) {
    if (!/\.(txt|ini)$/i.test(n) || /^_pack_info\.ini$/i.test(n) || /^readme/i.test(n)) continue;
    const d = parseIni(fs.readFileSync(path.join(dir, n), 'utf8'));
    const ts = Array.isArray(d.dub_timestamps) ? d.dub_timestamps.map(Number).filter(Number.isFinite) : [];
    const chars = Array.isArray(d.dub_characters) ? d.dub_characters.map(String).filter(Boolean) : [];
    if (!ts.length || !chars.length) continue;
    const base = n.replace(/\.(txt|ini)$/i, '');
    const audio = AUDIO_EXT.map(e => base + e).find(f => all.includes(f));
    const image = (d.image && all.includes(d.image)) ? d.image : IMAGE_EXT.map(e => base + e).find(f => all.includes(f));
    metas.push({ base, t: ts[0], chars, caption: d.caption || '', audio, image });
  }
  if (!metas.length) throw new ImportError('Im Pack wurden keine Zeilen gefunden (.txt/.ini mit dub_timestamps und dub_characters).');
  metas.sort((a, b) => a.t - b.t || a.base.localeCompare(b.base));

  const videoSrc = path.join(dir, videoName);
  const videoDur = probeDuration(videoSrc);
  if (!videoDur) throw new ImportError('Die Länge des Videos ließ sich nicht bestimmen (Video beschädigt?).');

  // ID: aus dem Titel; ist sie von einer Hand-Szene belegt, eine freie Variante nehmen
  let id = slugify(rawTitle);
  for (let k = 2; takenIds.get(id) === 'manual'; k++) id = slugify(rawTitle, 36) + '_' + k;

  // Ohne _backing_track: der Videoton enthält die Originalstimmen. Dann den Videoton nehmen, ihn aber
  // genau an den Zeilen-Stellen stumm schalten — Hintergrund zwischen den Zeilen bleibt, Originalstimmen
  // laufen nie unter den eigenen Aufnahmen mit.
  const videoHasAudio = (() => { try { cp.execFileSync('ffmpeg', ['-hide_banner', '-i', videoSrc], { stdio: 'pipe' }); } catch (e) { return /Audio:/.test(String(e.stderr || '')); } return false; })();
  for (const m of metas) { const d = m.audio ? probeDuration(path.join(dir, m.audio)) : null; m.dur = d && d > 0.2 ? d : null; }

  const segs = splitSegments(metas, videoDur);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cv-'));
  const results = segs.map(([a, b], k) => {
    const part = segs.length > 1 ? { k: k + 1, n: segs.length } : null;
    const segMetas = metas.filter(m => m.t >= a && m.t < b);
    const pid = part ? `${id.slice(0, 50)}_teil${part.k}` : id;
    const pTitle = part ? `${rawTitle} — Teil ${part.k}/${part.n}` : rawTitle;
    const r = buildCvScene({ dir, metas: segMetas, allMetas: metas, a, b, id: pid, rawTitle: pTitle, avatarDir: part ? id : pid,
      videoSrc, backingName, videoHasAudio, out: fs.mkdtempSync(path.join(out, 'p')), long: !!part });
    if (part && part.k === 1) r.notes.push(`Das Pack ist ${Math.round(videoDur / 60)} Minuten lang — aufgeteilt in ${part.n} Szenen à ca. ${Math.round(videoDur / part.n / 60)} Minuten (geschnitten in Sprechpausen), damit die Qualität gut bleibt und GitHub die Videos annimmt.`);
    r.cleanup = out;
    return r;
  });
  return results;
}

// Packs über 16 Minuten (z. B. ein ganzer Kampf) werden in Teile von ~10 Minuten geschnitten.
// Geschnitten wird in der längsten Sprechpause nahe der Zielstelle — nie mitten in einer Zeile.
const SPLIT_OVER_SEC = 16 * 60, PART_TARGET_SEC = 10 * 60;
function splitSegments(metas, dur) {
  if (dur <= SPLIT_OVER_SEC) return [[0, dur]];
  const n = Math.ceil(dur / PART_TARGET_SEC);
  const cuts = [];
  for (let k = 1; k < n; k++) {
    const target = dur * k / n;
    let best = null;
    for (let i = 0; i + 1 < metas.length; i++) {
      const gs = metas[i].t + (metas[i].dur || 2) + 0.15, ge = metas[i + 1].t - 0.15;
      if (ge - gs < 0.3) continue;
      const mid = (gs + ge) / 2, dist = Math.abs(mid - target);
      if (dist > 150) continue;
      const score = Math.min(ge - gs, 4) - dist / 40;
      if (!best || score > best.score) best = { score, cut: mid };
    }
    cuts.push(best ? best.cut : target);
  }
  const edges = [0, ...cuts.filter((c, i, a) => c > 30 && (i === 0 || c - a[i - 1] > 60)), dur];
  const segs = [];
  for (let i = 0; i + 1 < edges.length; i++) segs.push([+edges[i].toFixed(3), +edges[i + 1].toFixed(3)]);
  // Teile ohne eine einzige Zeile sind keine spielbaren Szenen
  return segs.filter(([a, b]) => metas.some(m => m.t >= a && m.t < b));
}

function buildCvScene({ dir, metas, allMetas, a, b, id, rawTitle, avatarDir, videoSrc, backingName, videoHasAudio, out, long }) {
  const notes = [];
  const len = b - a;
  const files = new Map();
  // Rollen in Reihenfolge des ersten Auftritts
  const roleNames = [];
  for (const m of metas) for (const c of m.chars) if (!roleNames.includes(c)) roleNames.push(c);
  const roles = roleNames.map((name, i) => ({ id: i, name, pan: +(roleNames.length <= 1 ? 0 : -0.35 + 0.7 * i / (roleNames.length - 1)).toFixed(2), effect: 'none', gain: 1 }));

  // Video: Bild aus dub_video, Ton aus dem Backing-Track (bzw. Videoton mit stummen Zeilen-Stellen)
  const mp4 = path.join(out, 'scene.mp4');
  const muteWindows = (!backingName && videoHasAudio)
    ? metas.map(m => [Math.max(0, m.t - a - 0.06), m.t - a + (m.dur || 2) + 0.06]) : [];
  const seek = a > 0 ? ['-ss', a.toFixed(3)] : [];
  const encode = (width, crf, maxKbps) => {
    let audioIn, audioMap, af = 'apad';
    if (backingName) { audioIn = [...seek, '-i', path.join(dir, backingName)]; audioMap = '1:a:0'; }
    else if (videoHasAudio) {
      audioIn = []; audioMap = '0:a:0';
      const cond = muteWindows.map(([x, y]) => `between(t,${x.toFixed(3)},${y.toFixed(3)})`).join('+') || '0';
      af = `volume=enable='${cond}':volume=0,apad`;
    } else { audioIn = ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']; audioMap = '1:a:0'; }
    const rate = maxKbps ? ['-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps * 2}k`] : [];
    ffmpegRun([...seek, '-i', videoSrc, ...audioIn, '-map', '0:v:0', '-map', audioMap, '-t', len.toFixed(3),
      '-vf', `scale='min(${width},iw)':-2`, '-c:v', 'libx264', '-preset', long ? 'veryfast' : 'fast', '-crf', String(crf), ...rate, '-pix_fmt', 'yuv420p',
      '-af', af, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', mp4], 'Das Video');
  };
  // Obergrenze, damit die Datei sicher unter GitHubs 100 MB bleibt (mit Reserve)
  const capKbps = Math.max(350, Math.min(4000, Math.floor((88 * 1048576 * 8 / len - 128000) / 1000)));
  if (long) {
    progress(`Wandle ${rawTitle} um (${Math.round(len / 60)} min Video)`);
    encode(1280, 23, capKbps);
  } else {
    encode(1280, 27);
    if (fs.statSync(mp4).size > CDN_LIMIT_BYTES) encode(1280, 30);
    if (fs.statSync(mp4).size > CDN_LIMIT_BYTES) encode(854, 30);
  }
  if (fs.statSync(mp4).size > MAX_FILE_BYTES) encode(1280, 28, capKbps);
  if (fs.statSync(mp4).size > MAX_FILE_BYTES) encode(854, 30, Math.floor(capKbps * 0.8));
  if (!backingName) notes.push(videoHasAudio
    ? 'Im Pack fehlte _backing_track — als Hintergrund dient der Videoton, an den Stellen der Zeilen stummgeschaltet (sonst wären die Originalstimmen zu hören). Mit einem Backing-Track (Ton ohne Stimmen) klingt es besser.'
    : 'Im Pack fehlte _backing_track und das Video hat keinen Ton — die Szene läuft ohne Hintergrundton.');
  files.set(`scenes/${id}.mp4`, mp4);

  // Figurenbilder: Bild der ersten Zeile jeder Figur, 160 px breit (bei Teilen gemeinsam genutzt)
  const avatars = {};
  for (const r of roles) {
    const m = metas.find(x => x.chars[0] === r.name && x.image) || allMetas.find(x => x.chars[0] === r.name && x.image);
    if (!m) continue;
    const rel = `scenes/${avatarDir}/${slugify(r.name, 30)}.png`;
    const dst = path.join(out, `avatar_${r.id}.png`);
    try { ffmpegRun(['-i', path.join(dir, m.image), '-vf', 'scale=160:-2', '-frames:v', '1', dst], `Bild ${m.image}`); files.set(rel, dst); avatars[r.id] = rel; }
    catch { notes.push(`Bild für ${r.name} konnte nicht umgewandelt werden — Platzhalter wird angezeigt.`); }
  }

  // Zeilen: Original-Ton als Mono-MP3, Ende = Start + Länge des Tons
  let noAudio = 0, fxLines = 0;
  const pad = metas.length >= 100 ? 3 : 2;
  const lines = metas.map((m, i) => {
    const nn = String(i + 1).padStart(pad, '0');
    let orig;
    if (m.audio) {
      const dst = path.join(out, `line_${nn}.mp3`);
      ffmpegRun(['-i', path.join(dir, m.audio), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', dst], `Zeile ${m.base}`);
      orig = `scenes/${id}/lines/${nn}.mp3`;
      files.set(orig, dst);
    } else noAudio++;
    const t = m.t - a;
    const next = metas[i + 1];
    let end = t + (m.dur || (next ? Math.min(4, next.t - m.t) : 3));
    end = Math.min(end, len);
    if (!(end > t + 0.2)) end = Math.min(len, t + 1);
    const text = cleanCaption(m.caption) || '…';
    const line = { t: +t.toFixed(3), end: +end.toFixed(3), chars: m.chars.map(c => roleNames.indexOf(c)), who: m.chars.join(' & '), text, de: text };
    if (orig) line.orig = orig;
    const fx = vfxEffect(m.caption);
    if (fx) { line.effect = fx; fxLines++; }
    return line;
  });
  if (lines.some(l => !(l.end > l.t))) throw new ImportError('Mindestens eine Zeile liegt hinter dem Videoende — passen dub_timestamps und Video zusammen?');
  if (noAudio) notes.push(`${noAudio} Zeile(n) ohne Original-Ton (.wav) — dort gibt es kein „Original anhören“.`);
  if (fxLines) notes.push(`${fxLines} Zeile(n) mit starkem VFX bekommen den passenden Stimmeffekt (Hall/Echo/Chorus).`);
  notes.push('Choicer-Voicer-Pack automatisch umgewandelt.');
  lines.forEach(l => { l.de = ''; });
  autoTranslate(lines, notes);

  const scene = {
    id, title: `${rawTitle} (${roles.length} ${roles.length === 1 ? 'Rolle' : 'Rollen'})`, videoUrl: `scenes/${id}.mp4`,
    avatars, roles, lines,
  };
  const previewRel = `previews/${id}.mp4`;
  const preview = path.join(out, 'preview.mp4');
  makePreview(mp4, preview, Math.max(0, lines[0].t - 0.5));
  files.set(previewRel, preview);
  scene.previewUrl = previewRel;
  scene.previewBytes = fs.statSync(preview).size;
  const videoBytes = fs.statSync(mp4).size;
  scene.videoBytes = videoBytes;
  return { scene, files, notes, videoBytes, cleanup: out };
}

// ═════════════════════════════════════════════════════════════
// ÜBERSETZUNG Deutsch ↔ Englisch (maschinell, beim Import)
// Fehlt bei Zeilen die deutsche Fassung (oder ist sie identisch mit dem Original), wird sie
// automatisch erzeugt. Sind die Zeilen auf Deutsch geschrieben, wird umgekehrt Englisch erzeugt.
// Dienste: Google (inoffizieller Endpunkt), sonst MyMemory. Klappt beides nicht, bleibt der
// Originaltext stehen und die Zusammenfassung sagt Bescheid. SS_NO_TRANSLATE=1 schaltet ab.
// ═════════════════════════════════════════════════════════════
const DE_WORDS = ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'wir', 'ein', 'eine', 'zu', 'mit', 'auf', 'für', 'was', 'wie', 'dass', 'mein', 'dein', 'sie', 'es', 'bin', 'bist', 'hast', 'habe', 'noch', 'schon', 'jetzt', 'hier', 'nur', 'auch'];
const EN_WORDS = ['the', 'and', 'is', 'not', 'i', 'you', 'we', 'a', 'to', 'with', 'on', 'for', 'what', 'how', 'that', 'my', 'your', 'are', 'am', 'have', 'it', 'this', 'just', 'now', 'here', 'only', 'too', 'do', "don't", "i'm", "it's"];
function detectLang(text) {
  const words = String(text).toLowerCase().match(/[a-zäöüß']+/g) || [];
  let de = 0, en = 0;
  for (const w of words) { if (DE_WORDS.includes(w)) de++; if (EN_WORDS.includes(w)) en++; }
  if (/[äöüß]/i.test(text)) de += 2;
  return de > en ? 'de' : 'en';
}
function curlGet(url, params) {
  const args = ['-sS', '--fail', '--max-time', '25', '-G', url];
  for (const [k, v] of Object.entries(params)) args.push('--data-urlencode', `${k}=${v}`);
  return cp.execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
}
function googleTranslate(text, from, to) {
  const data = JSON.parse(curlGet('https://translate.googleapis.com/translate_a/single', { client: 'gtx', sl: from === 'en' ? 'auto' : from, tl: to, dt: 't', q: text }));
  const out = (data[0] || []).map(x => x[0]).join('');
  if (!out.trim()) throw new Error('leere Antwort');
  return out;
}
function myMemoryTranslate(text, from, to) {
  const data = JSON.parse(curlGet('https://api.mymemory.translated.net/get', { q: text, langpair: `${from}|${to}` }));
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out || (data.responseStatus && +data.responseStatus !== 200) || /MYMEMORY WARNING/i.test(out)) throw new Error('MyMemory: ' + (data && data.responseDetails || 'Fehler'));
  return out;
}
/** Übersetzt eine Liste von Zeilen; gibt null zurück, wenn kein Dienst erreichbar war. */
function translateLines(texts, from, to) {
  if (process.env.SS_NO_TRANSLATE) return null;
  if (process.env.SS_TRANSLATE_MOCK) return texts.map(t => `[${to}] ${t}`);
  if (!texts.length) return [];
  // 1) In Häppchen zu 40 Zeilen (durch Zeilenumbruch getrennt) — lange Szenen sprengen sonst die URL-Länge
  {
    const res = [];
    for (let i = 0; i < texts.length; i += 40) {
      const chunk = texts.slice(i, i + 40);
      try {
        const joined = googleTranslate(chunk.join('\n'), from, to).split('\n').map(x => x.trim());
        if (joined.length !== chunk.length || !joined.every(Boolean)) break;
        res.push(...joined);
      } catch { break; }
    }
    if (res.length === texts.length) return res;
  }
  // 2) Zeile für Zeile, erst Google, dann MyMemory
  const out = [];
  for (const t of texts) {
    let r = null;
    for (const fn of [googleTranslate, myMemoryTranslate]) {
      try { r = fn(t, from, to).trim(); if (r) break; } catch {}
    }
    if (!r) return out.length ? out.concat(texts.slice(out.length).map(() => null)) : null;
    out.push(r);
  }
  return out;
}
/** Ergänzt fehlende Sprachfassungen in den Zeilen einer Szene (text = Original/Englisch, de = Deutsch). */
function autoTranslate(lines, notes) {
  const need = lines.filter(l => l && typeof l.text === 'string' && l.text.trim() && (!l.de || l.de.trim() === l.text.trim()));
  if (!need.length) return;
  const src = need.map(l => l.text);
  const lang = detectLang(src.join(' '));
  if (lang === 'de') {
    const en = translateLines(src, 'de', 'en');
    let n = 0;
    need.forEach((l, i) => { l.de = l.text; if (en && en[i]) { l.text = en[i]; n++; } });
    notes.push(n ? `Zeilen waren auf Deutsch — englische Fassung automatisch übersetzt (${n} Zeilen, maschinell).` : 'Englische Übersetzung war gerade nicht möglich (Übersetzungsdienst nicht erreichbar) — Zeilen bleiben vorerst nur deutsch.');
  } else {
    const de = translateLines(src, 'en', 'de');
    let n = 0;
    need.forEach((l, i) => { if (de && de[i]) { l.de = de[i]; n++; } else l.de = l.text; });
    notes.push(n ? `Deutsche Fassung automatisch übersetzt (${n} Zeilen, maschinell).` : 'Deutsche Übersetzung war gerade nicht möglich (Übersetzungsdienst nicht erreichbar) — auf Deutsch steht vorerst der englische Text.');
  }
}

// _import/links.txt: GameBanana-Links (eine pro Zeile) → Dateien herunterladen und wie hochgeladene
// Archive behandeln. Heruntergeladenes wird nie gespeichert (kann > 100 MB sein) — nur das Ergebnis.
const LINKS_FILE = path.join(IMPORT_DIR, 'links.txt');
let linksConsumed = false;
function curl(args) {
  // Große Teile (mehrere 100 MB) brauchen Zeit — bis zu 1 h pro Datei, bei Abbruch dort weitermachen
  return cp.execFileSync('curl', ['-fsSL', '--retry', '5', '--retry-delay', '10', '--retry-all-errors', '-C', '-', '-m', '3600', '-A', 'Mozilla/5.0 (Synchronstudio-Import)', ...args], { maxBuffer: 1 << 26 });
}
/**
 * GameBanana-„Requests“ (gamebanana.com/requests/…) sind Anfragen — die eigentliche Szene ist der Mod,
 * der die Anfrage erfüllt. Diese Mods heraussuchen und wie normale Mod-Links behandeln.
 */
function expandRequests(lines, failed, summary) {
  const out = [];
  for (const raw of lines) {
    const rm = /gamebanana\.com\/requests\/(\d+)/i.exec(raw);
    if (!rm) { out.push(raw); continue; }
    const asM = /\s+(?:als|as)\s+([a-z0-9_]{2,60})\s*$/i.exec(raw);
    const base = process.env.SS_GB_API || 'https://gamebanana.com/apiv11';
    const ids = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        if (v._sModelName === 'Mod' && v._idRow) ids.add(String(v._idRow));
        return Object.values(v).forEach(walk);
      }
      if (typeof v === 'string') for (const x of v.matchAll(/gamebanana\.com\/mods\/(\d+)/gi)) ids.add(x[1]);
    };
    let name = '';
    for (const url of [`${base}/Request/${rm[1]}/ProfilePage`, `${base}/Request/${rm[1]}/Submissions?_nPage=1&_nPerpage=15`, `${base}/Request/${rm[1]}/Fulfillments?_nPage=1&_nPerpage=15`]) {
      try { const j = JSON.parse(curl([url]).toString('utf8')); name = name || j._sName || ''; walk(j); } catch (e) { /* Endpunkt gibt es evtl. nicht */ }
    }
    if (!ids.size) {
      // Notfalls die Webseite selbst nach Mod-Links durchsuchen
      try { walk(curl([`https://gamebanana.com/requests/${rm[1]}`]).toString('utf8')); } catch (e) { /* egal */ }
    }
    if (!ids.size) { failed.push({ name: `GameBanana-Anfrage ${rm[1]}`, msg: `Zur Anfrage „${name || rm[1]}“ wurde (noch) kein fertiger Mod mit Download gefunden — eine Anfrage ist nur ein Wunsch; erst wenn jemand die Szene gebaut und hochgeladen hat, gibt es etwas zum Einbauen.` }); continue; }
    summary.push(`- GameBanana-Anfrage ${rm[1]} „${name || '?'}“ → Mod ${[...ids].join(', ')}`);
    for (const id of ids) out.push(`https://gamebanana.com/mods/${id}` + (asM ? ` als ${asM[1]}` : ''));
  }
  return out;
}
function fetchLinks(failed, summary) {
  if (!fs.existsSync(LINKS_FILE)) return [];
  const lines = expandRequests(fs.readFileSync(LINKS_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')), failed, summary);
  const out = [];
  for (const raw of lines) {
    // „<link> als <szenen-id>“: die Szene im Paket ersetzt die bestehende Szene mit dieser ID
    const asM = /\s+(?:als|as)\s+([a-z0-9_]{2,60})\s*$/i.exec(raw);
    const forceId = asM ? asM[1].toLowerCase() : null;
    const line = asM ? raw.slice(0, asM.index).trim() : raw;
    // Google Drive (für große Dateien): „Jeder mit dem Link“ muss freigegeben sein
    const dm = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^#]*id=)([\w-]{20,})/i.exec(line) || /drive\.usercontent\.google\.com\/[^#]*[?&]id=([\w-]{20,})/i.exec(line);
    if (dm) {
      const fid = dm[1];
      summary.push(`- Google Drive ${fid}${forceId ? ` → ersetzt \`${forceId}\`` : ''}`);
      out.push({ name: `Google Drive ${fid}`, link: raw, totalMb: 0, forceId, prepare: () => {
        const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-dl-'));
        const dest = path.join(dlDir, `drive_${fid}.zip`);
        progress(`Lade Google-Drive-Datei ${fid}`);
        try { curl(['-o', dest, `${process.env.SS_DRIVE_BASE || 'https://drive.usercontent.google.com'}/download?id=${encodeURIComponent(fid)}&export=download&confirm=t`]); }
        catch (e) { throw new ImportError(`Download von Google Drive fehlgeschlagen — ist die Datei für „Jeder mit dem Link“ freigegeben? (${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 160)})`); }
        // Drive liefert bei fehlender Freigabe eine HTML-Seite statt der Datei
        const head = fs.readFileSync(dest).subarray(0, 4).toString('latin1');
        if (!head.startsWith('PK') && !head.startsWith('Rar!') && !head.startsWith('7z')) throw new ImportError('Google Drive hat keine Datei geliefert, sondern eine Webseite — bitte die Freigabe auf „Jeder mit dem Link“ stellen.');
        const ext = head.startsWith('Rar!') ? '.rar' : head.startsWith('7z') ? '.7z' : '.zip';
        if (ext !== '.zip') fs.renameSync(dest, dest.replace(/\.zip$/, ext));
        return { dlDir, firsts: [dest.replace(/\.zip$/, ext)] };
      } });
      continue;
    }
    const m = line.match(/gamebanana\.com\/(?:mods|dl)\/(\d+)/i);
    if (!m) { failed.push({ name: line, msg: 'Kein GameBanana- oder Google-Drive-Link erkannt (z. B. https://gamebanana.com/mods/712967 oder https://drive.google.com/file/d/…/view).' }); continue; }
    const api = (process.env.SS_GB_API || 'https://gamebanana.com/apiv11') + `/Mod/${m[1]}?_csvProperties=_sName,_aFiles,_aAlternateFileSources`;
    try {
      const info = JSON.parse(curl([api]).toString('utf8'));
      const all = info._aFiles || [];
      summary.push(`- GameBanana ${m[1]} „${info._sName || '?'}“: ${all.map(f => `${f._sFile} (${((f._nFilesize || 0) / 1048576).toFixed(0)} MB)`).join(', ') || 'keine Dateien'}`);
      const files = all.filter(f => ARCHIVE_RE.test(f._sFile || '') && f._sDownloadUrl);
      if (!files.length) {
        const alt = (info._aAlternateFileSources || []).map(x => x._sUrl).filter(Boolean);
        throw new ImportError(`Auf GameBanana gibt es zu „${info._sName || m[1]}“ keine ZIP/RAR/7z-Datei zum Herunterladen.` + (alt.length ? ` Die Datei liegt woanders: ${alt.join(' ')}` : ''));
      }
      const name = info._sName || 'GameBanana ' + m[1];
      const totalMb = files.reduce((n, f) => n + (f._nFilesize || 0), 0) / 1048576;
      // Erst beim Verarbeiten laden (spart Platz: nie alle Mods gleichzeitig auf der Platte).
      // Alle Dateien eines Mods landen im selben Ordner — so findet 7z die Teile mehrteiliger Archive.
      out.push({ name, link: raw, totalMb, forceId, prepare: () => {
        const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-dl-'));
        for (const f of files) {
          const safe = path.basename(f._sFile).replace(/[^\w.\- ]+/g, '_');
          progress(`Lade ${f._sFile} (${((f._nFilesize || 0) / 1048576).toFixed(0)} MB) — ${name}`);
          try { curl(['-o', path.join(dlDir, safe), f._sDownloadUrl]); }
          catch (e) { throw new ImportError(`Download von ${f._sFile} (${((f._nFilesize || 0) / 1048576).toFixed(0)} MB) fehlgeschlagen: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200)}`); }
        }
        const firsts = fs.readdirSync(dlDir).filter(isFirstArchive).map(n => path.join(dlDir, n));
        if (!firsts.length) throw new ImportError('Heruntergeladen, aber kein Anfang eines Archivs gefunden (Teil 1 fehlt?).');
        return { dlDir, firsts };
      } });
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : `Download von GameBanana fehlgeschlagen (${line}): ${String(e && e.message || e).split('\n')[0]}`;
      failed.push({ name: `GameBanana ${m[1]}`, msg });
    }
  }
  // Liste leeren — sonst würde jeder Lauf dieselben Packs nochmal holen
  fs.rmSync(LINKS_FILE, { force: true });
  linksConsumed = true;
  // Kleine Mods zuerst: die sind schnell drin, das 44-Minuten-Monster kommt zuletzt
  return out.sort((x, y) => x.totalMb - y.totalMb);
}

/** Fortschritt im GitHub-Log sichtbar machen (erscheint als Hinweis am Lauf, auch wenn er abbricht). */
function progress(msg) {
  const t = new Date().toISOString().slice(11, 19);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Szenen-Import ${t}::${msg.replace(/[\r\n]+/g, ' ')}`);
  else console.log(`[${t}] ${msg}`);
}
/**
 * SS_COMMIT_EACH=1 (GitHub): jede fertig eingebaute Szene sofort testen, speichern und veröffentlichen.
 * Sonst ginge bei einem Abbruch (Zeitlimit) alles verloren, was bis dahin schon fertig war.
 */
function commitNow(batch) {
  const run = (cmd, args) => cp.execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync-scene-index.cjs')], { cwd: ROOT, stdio: 'inherit' });
  const v = bumpVersion(batch);
  run('git', ['add', '-A']);
  try { run('npm', ['test', '--silent']); }
  catch (e) {
    // Test rot → diese Szenen wieder raus, Rest bleibt unberührt
    run('git', ['reset', '-q', '--hard', 'HEAD']);
    run('git', ['clean', '-fdq', '--', 'scenes', 'previews', 'scenedata']);
    fs.rmSync(LINKS_FILE, { force: true });
    throw new ImportError('Nach dem Einbauen schlug der Spiel-Test fehl — die Szene wurde wieder entfernt.');
  }
  const commit = () => run('git', ['-c', 'user.name=Szenen-Import', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-q', '-m', `Szenen-Import: ${batch.map(x => x.id).join(', ')}`]);
  commit();
  let pushed = false;
  for (let i = 0; i < 3 && !pushed; i++) {
    try { run('git', ['pull', '-q', '--rebase', 'origin', 'main']); run('git', ['push', '-q', 'origin', 'HEAD:main']); pushed = true; }
    catch {
      // Meist: jemand hat inzwischen scenes.json/client.js geändert (anderer Import, Hand-Änderung).
      // Dann nicht zusammenflicken, sondern die Szenen auf dem neuesten Stand frisch eintragen.
      try { run('git', ['rebase', '--abort']); } catch { /* war kein Rebase offen */ }
      const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-keep-'));
      for (const x of batch) for (const r of x.rels || []) {
        const src = path.join(ROOT, r);
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(keep, r)), { recursive: true }); fs.copyFileSync(src, path.join(keep, r)); }
      }
      run('git', ['fetch', '-q', 'origin', 'main']);
      run('git', ['reset', '-q', '--hard', 'origin/main']);
      if (linksConsumed) fs.rmSync(LINKS_FILE, { force: true });
      for (const x of batch) {
        for (const r of x.rels || []) {
          const src = path.join(keep, r);
          if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(ROOT, r)), { recursive: true }); fs.copyFileSync(src, path.join(ROOT, r)); }
        }
        upsertScene(x.scene);
        updateClientJs(x.scene, x.oversize);
      }
      fs.rmSync(keep, { recursive: true, force: true });
      cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync-scene-index.cjs')], { cwd: ROOT, stdio: 'inherit' });
      bumpVersion(batch);
      run('git', ['add', '-A']);
      run('npm', ['test', '--silent']);
      commit();
      cp.execFileSync('sleep', ['3']);
    }
  }
  if (!pushed) throw new Error('Speichern auf GitHub (git push) fehlgeschlagen');
  try { run('gh', ['workflow', 'run', 'deploy-pages.yml', '--ref', 'main']); } catch { /* Website kommt spätestens am Ende */ }
  progress(`Gespeichert & veröffentlicht (Version ${v}): ${batch.map(x => plainTitle(x.title)).join(', ')}`);
  return v;
}

function main() {
  const t0 = Date.now();
  const budgetMin = +process.env.SS_TIME_BUDGET_MIN || 0;
  const args = process.argv.slice(2);
  const preFailed = [];
  const summary = ['## 🎬 Szenen-Import', ''];
  const gbInfo = [];
  const zips = args.length ? args.map(a => ({ zip: path.resolve(a), name: path.basename(a) }))
    : [...(fs.existsSync(IMPORT_DIR) ? fs.readdirSync(IMPORT_DIR).filter(isFirstArchive).map(n => ({ zip: path.join(IMPORT_DIR, n), name: n })) : []),
      ...fetchLinks(preFailed, gbInfo)];
  if (gbInfo.length) summary.push('### 📥 GameBanana', '', ...gbInfo, '');
  if (!zips.length && !preFailed.length) {
    summary.push('Keine ZIP-Dateien in `_import/` gefunden — nichts zu tun.');
    finish(summary, 0);
    return;
  }
  const imported = [], failed = preFailed;
  const install = (zip, name, result) => {
    const { scene, files, notes, videoBytes } = result;
    checkIdFree(scene);
    for (const [target, src] of files) {
      const dest = path.join(ROOT, target);
      if (!inside(ROOT, dest)) throw new ImportError(`Ungültiger Dateipfad ${target}.`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const oversize = videoBytes > CDN_LIMIT_BYTES;
    const updated = upsertScene(scene);
    updateClientJs(scene, oversize);
    if (oversize) notes.push(`Video ist ${(videoBytes / 1048576).toFixed(1)} MB (über 20 MB) — wird über GitHub statt über das CDN geladen, lädt also etwas langsamer.`);
    imported.push({ zip, name, id: scene.id, title: scene.title, updated, lines: scene.lines.length, roles: scene.roles.length, notes, mb: videoBytes / 1048576,
      scene, oversize, rels: [...files.keys()] });
  };
  const processArchive = (zip, name, downloaded, opts = {}) => {
    let ex = null;
    try {
      ex = extract(zip);
      for (const dir of ex.dirs) {
        const packName = ex.dirs.length > 1 ? `${name} → ${path.basename(dir)}` : name;
        let cleanup = null;
        try {
          if (!fs.existsSync(path.join(dir, 'scene.json')) && isChoicerPack(dir)) {
            const taken = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes.json'), 'utf8')).map(x => [x.id, x.imported ? 'imported' : 'manual']));
            const results = convertChoicerPack(dir, taken);
            cleanup = results[0] && results[0].cleanup;
            for (const r of results) install(zip, packName, r);
          } else install(zip, packName, validate(dir, opts));
        } catch (e) {
          const msg = e instanceof ImportError ? e.message : ('Unerwarteter Fehler: ' + (e && e.message || e));
          failed.push({ zip, name: packName, msg, downloaded: !!downloaded, partOf: ex.dirs.length > 1 });
        } finally {
          if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
        }
      }
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : ('Unerwarteter Fehler: ' + (e && e.message || e));
      failed.push({ zip, name, msg, downloaded: !!downloaded });
    } finally {
      if (ex) fs.rmSync(ex.cleanup, { recursive: true, force: true });
    }
  };
  const commitEach = !!process.env.SS_COMMIT_EACH;
  let versionNow = null;
  const flush = () => {
    const batch = imported.filter(x => !x.committed);
    if (!commitEach || !batch.length) return;
    try { versionNow = commitNow(batch); batch.forEach(x => { x.committed = true; x.version = versionNow; }); }
    catch (e) {
      for (const x of batch) { imported.splice(imported.indexOf(x), 1); failed.push({ zip: x.zip, name: x.name, msg: e.message, downloaded: true }); }
    }
  };
  const leftover = [];
  for (const job of zips) {
    // Zeit fast um → restliche Links für den nächsten Lauf aufheben (der Ablauf startet ihn selbst)
    if (budgetMin && job.link && (Date.now() - t0) / 60000 > budgetMin) { leftover.push(job.link); continue; }
    progress(`Starte: ${job.name}${job.totalMb ? ` (${job.totalMb.toFixed(0)} MB)` : ''}`);
    if (!job.prepare) { processArchive(job.zip, job.name, null); flush(); continue; }
    let dl = null;
    try {
      dl = job.prepare();
      for (const f of dl.firsts) processArchive(f, dl.firsts.length > 1 ? `${job.name} (${path.basename(f)})` : job.name, dl.dlDir, { forceId: job.forceId });
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : `Download fehlgeschlagen: ${String(e && e.message || e).split('\n')[0]}`;
      failed.push({ name: job.name, msg, downloaded: true });
    } finally {
      if (dl) fs.rmSync(dl.dlDir, { recursive: true, force: true });
    }
    flush();
  }
  if (leftover.length) {
    fs.writeFileSync(LINKS_FILE, leftover.join('\n') + '\n');
    summary.push(`⏳ Zeit für diesen Lauf aufgebraucht — ${leftover.length} Link(s) kommen im nächsten Lauf dran (startet automatisch).`, '');
  }
  if (imported.length) {
    const rest = imported.filter(x => !x.committed);
    let v = versionNow;
    if (rest.length) {
      cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync-scene-index.cjs')], { cwd: ROOT, stdio: 'inherit' });
      v = bumpVersion(rest);
    }
    for (const x of imported) if (inside(IMPORT_DIR, x.zip)) fs.rmSync(x.zip, { force: true });
    summary.push(`### ✅ Eingebaut (Version ${v})`, '');
    for (const x of imported) {
      summary.push(`- **${plainTitle(x.title)}** (\`${x.id}\`) — ${x.updated ? 'aktualisiert' : 'neu'}, ${x.roles} ${x.roles === 1 ? "Rolle" : "Rollen"}, ${x.lines} Zeilen, Video ${x.mb.toFixed(1)} MB`);
      for (const n of x.notes) summary.push(`  - ℹ️ ${n}`);
    }
    summary.push('');
  }
  if (failed.length) {
    fs.mkdirSync(FAILED_DIR, { recursive: true });
    summary.push('### ❌ Nicht eingebaut', '');
    for (const f of failed) {
      const local = f.zip && inside(IMPORT_DIR, f.zip) && fs.existsSync(f.zip);
      if (local) fs.renameSync(f.zip, path.join(FAILED_DIR, path.basename(f.zip)));
      if (local || !f.zip || f.downloaded || f.partOf) {
        fs.writeFileSync(path.join(FAILED_DIR, f.name.replace(ARCHIVE_RE, '').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) + ' - FEHLER.txt'),
          `Diese Szene wurde NICHT eingebaut.\n\nGrund:\n${f.msg}\n\nNach dem Beheben das ZIP (bzw. den Link in _import/links.txt) einfach nochmal hochladen.\n`);
      }
      summary.push(`- **${f.name}**:`);
      for (const l of f.msg.split('\n')) summary.push(`  - ${l}`);
    }
    summary.push('', 'Die Gründe stehen auch in `_import/fehlgeschlagen/` (fehlerhafte hochgeladene ZIPs liegen dort mit einer FEHLER.txt daneben).');
  }
  finish(summary, failed.length ? 1 : 0);
}
function finish(summary, code) {
  const text = summary.join('\n') + '\n';
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `failed=${code ? 'true' : 'false'}\n`);
  process.exitCode = code;
}

main();
