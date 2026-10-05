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
 * Aufruf:  node tools/import-scene.cjs            (alle _import/*.zip)
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

function extract(zipFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-import-'));
  try {
    cp.execFileSync('unzip', ['-qq', '-o', zipFile, '-d', dir], { stdio: 'pipe' });
  } catch (e) {
    // unzip meldet z. B. bei Warnungen Exit-Code 1, entpackt aber trotzdem
    if (!fs.existsSync(path.join(dir, 'scene.json')) && !fs.readdirSync(dir).length) {
      throw new ImportError('Das ZIP ließ sich nicht öffnen (beschädigt oder kein ZIP).');
    }
  }
  // Liegt alles in einem Unterordner (z. B. „meine_szene/scene.json“)? Dann den nehmen.
  if (!fs.existsSync(path.join(dir, 'scene.json'))) {
    const subs = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isDirectory() && fs.existsSync(path.join(dir, n, 'scene.json')));
    if (subs.length === 1) return { dir: path.join(dir, subs[0]), cleanup: dir };
  }
  return { dir, cleanup: dir };
}

function inside(base, p) {
  const r = path.relative(base, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r);
}

function probeDuration(file) {
  if (!has('ffprobe')) return null;
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
function validate(dir) {
  const problems = [], notes = [];
  const sceneFile = path.join(dir, 'scene.json');
  if (!fs.existsSync(sceneFile)) {
    if (fs.existsSync(path.join(dir, '_pack_info.ini'))) throw new ImportError('Das ist ein Choicer-Voicer-Pack, kein Synchronstudio-Szenen-Export. Im Editor bitte „Export Scene (.zip)“ nehmen.');
    throw new ImportError('Im ZIP fehlt scene.json. Bitte im Szenen-Editor „Export Scene (.zip)“ benutzen und das ZIP unverändert hochladen.');
  }
  let scene;
  try { scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')); } catch { throw new ImportError('scene.json ist kaputt (kein gültiges JSON).'); }
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new ImportError('scene.json enthält keine Szene.');

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

  const videoBytes = fs.statSync(videoPath).size;
  if (videoBytes > MAX_FILE_BYTES) throw new ImportError(`Das Video ist ${(videoBytes / 1048576).toFixed(0)} MB groß — GitHub nimmt höchstens ~95 MB pro Datei.`);
  const lastEnd = Math.max(...lines.map(l => l.end));
  const dur = probeDuration(videoPath);
  if (dur != null && dur + 0.75 < lastEnd) throw new ImportError(`Das Video ist nur ${dur.toFixed(1)} s lang, die letzte Zeile endet aber bei ${lastEnd.toFixed(1)} s.`);

  // Alle Pfade in der Szene müssen im ZIP liegen — fehlende Original-Zeilen/Bilder werden weggelassen statt das Spiel zu brechen
  const files = new Map([[video, videoPath]]);
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

  const previewRel = `previews/${id}.mp4`;
  const previewAbs = path.join(dir, previewRel);
  let previewSrc = fs.existsSync(previewAbs) && fs.statSync(previewAbs).size < PREVIEW_MAX_BYTES ? previewAbs : null;
  if (!previewSrc) {
    const out = path.join(dir, '_preview_generated.mp4');
    makePreview(videoPath, out, Math.max(0, (lines[0] && lines[0].t || 0) - 0.5));
    previewSrc = out;
    notes.push('Vorschau-Clip fehlte oder war zu groß — wurde automatisch erzeugt.');
  }
  files.set(previewRel, previewSrc);
  scene.previewUrl = previewRel;
  scene.previewBytes = fs.statSync(previewSrc).size;
  scene.videoBytes = videoBytes;
  if (!scene.difficultyOverride) scene.difficultyOverride = 'medium';
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

function main() {
  const args = process.argv.slice(2);
  const zips = args.length ? args.map(a => path.resolve(a))
    : (fs.existsSync(IMPORT_DIR) ? fs.readdirSync(IMPORT_DIR).filter(n => /\.zip$/i.test(n)).map(n => path.join(IMPORT_DIR, n)) : []);
  const summary = ['## 🎬 Szenen-Import', ''];
  if (!zips.length) {
    summary.push('Keine ZIP-Dateien in `_import/` gefunden — nichts zu tun.');
    finish(summary, 0);
    return;
  }
  const imported = [], failed = [];
  for (const zip of zips) {
    const name = path.basename(zip);
    let tmp = null;
    try {
      const ex = extract(zip);
      tmp = ex.cleanup;
      const { scene, files, notes, videoBytes } = validate(ex.dir);
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
      imported.push({ zip, name, id: scene.id, title: scene.title, updated, lines: scene.lines.length, roles: scene.roles.length, notes, mb: videoBytes / 1048576 });
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : ('Unerwarteter Fehler: ' + (e && e.message || e));
      failed.push({ zip, name, msg });
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (imported.length) {
    cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync-scene-index.cjs')], { cwd: ROOT, stdio: 'inherit' });
    const v = bumpVersion(imported);
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
      if (inside(IMPORT_DIR, f.zip)) {
        fs.renameSync(f.zip, path.join(FAILED_DIR, f.name));
        fs.writeFileSync(path.join(FAILED_DIR, f.name.replace(/\.zip$/i, '') + ' - FEHLER.txt'),
          `Diese Szene wurde NICHT eingebaut.\n\nGrund:\n${f.msg}\n\nNach dem Beheben das ZIP einfach nochmal in den Ordner _import/ hochladen.\n`);
      }
      summary.push(`- **${f.name}**:`);
      for (const l of f.msg.split('\n')) summary.push(`  - ${l}`);
    }
    summary.push('', 'Die fehlerhaften ZIPs liegen jetzt in `_import/fehlgeschlagen/` (mit einer FEHLER.txt daneben).');
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
