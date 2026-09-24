#!/usr/bin/env node
/*
 * Baut scenes-index.json und scenedata/<id>.json aus scenes.json.
 *
 * Das Spiel lädt beim Start nur den schlanken Index und holt die Zeilen einer Szene
 * erst bei Bedarf aus scenedata/. Wer eine neue Szene nur in scenes.json einträgt,
 * sieht sie deshalb im Spiel NICHT. Nach jeder Änderung an scenes.json einmal:
 *
 *   node tools/sync-scene-index.cjs          → Dateien neu schreiben
 *   node tools/sync-scene-index.cjs --check  → nur prüfen (Exit-Code 1, wenn veraltet)
 *
 * Abgeleitete Felder: lineCount, difficultyPre (gleiche Formel wie sceneDifficulty()
 * im Spiel), approxDur (Ende der letzten Zeile), videoBytes (Dateigröße) und
 * previewBytes (Größe von previews/<id>.mp4). Katalog-Markierungen (catalogChange,
 * catalogChangedAt) bleiben aus dem bisherigen Index erhalten.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const sizeOf = (rel) => (exists(rel) ? fs.statSync(path.join(root, rel)).size : 0);

function difficultyPre(lines) {
  if (!lines.length) return null;
  const dur = Math.max(...lines.map((l) => l.end)) - Math.min(...lines.map((l) => l.t));
  const words = lines.reduce((sum, l) => sum + String(l.text || '').split(/\s+/).filter(Boolean).length, 0);
  const wps = words / Math.max(1, dur);
  const avgWin = lines.reduce((sum, l) => sum + (l.end - l.t), 0) / lines.length;
  const avgWords = words / lines.length;
  const score = wps * 1.4 - avgWin * 0.25 + avgWords * 0.05;
  return score < 2.0 ? 'easy' : score < 3.2 ? 'medium' : 'hard';
}

function buildEntry(scene, old) {
  const lines = Array.isArray(scene.lines) ? scene.lines : [];
  const derived = {
    lineCount: lines.length,
    difficultyPre: difficultyPre(lines),
    approxDur: lines.length ? Math.round(Math.max(...lines.map((l) => l.end)) * 10) / 10 : 0,
  };
  const entry = {};
  let inserted = false;
  for (const [key, value] of Object.entries(scene)) {
    if (key === 'lines') continue;
    if (key === 'videoBytes' && !inserted) { Object.assign(entry, derived); inserted = true; }
    entry[key] = value;
  }
  if (!inserted) Object.assign(entry, derived);
  // approxDur ist nur ein Richtwert — ältere Einträge wurden leicht anders gerundet.
  // Bei weniger als einer Sekunde Abweichung den bisherigen Wert behalten (kein Datei-Rauschen).
  if (old && Number.isFinite(old.approxDur) && Math.abs(old.approxDur - entry.approxDur) < 1) entry.approxDur = old.approxDur;

  const videoSize = sizeOf(scene.videoUrl || '');
  entry.videoBytes = videoSize || scene.videoBytes || (old && old.videoBytes) || 0;
  const previewUrl = scene.previewUrl || (exists(`previews/${scene.id}.mp4`) ? `previews/${scene.id}.mp4` : (old && old.previewUrl));
  if (previewUrl) {
    entry.previewUrl = previewUrl;
    entry.previewBytes = sizeOf(previewUrl) || scene.previewBytes || (old && old.previewBytes) || 0;
  }
  for (const key of ['catalogChange', 'catalogChangedAt']) {
    if (scene[key] == null && old && old[key] != null) entry[key] = old[key];
  }
  return entry;
}

function main() {
  const check = process.argv.includes('--check');
  const scenes = JSON.parse(read('scenes.json'));
  if (!Array.isArray(scenes)) throw new Error('scenes.json is not a list');
  const oldIndex = exists('scenes-index.json') ? JSON.parse(read('scenes-index.json')) : [];
  const oldById = new Map(oldIndex.map((s) => [s.id, s]));

  const ids = new Set();
  const problems = [];
  const writes = [];
  const index = scenes.map((scene) => {
    if (!scene || !scene.id) throw new Error('scene without id in scenes.json');
    if (ids.has(scene.id)) throw new Error('duplicate scene id: ' + scene.id);
    ids.add(scene.id);
    const dataRel = `scenedata/${scene.id}.json`;
    const data = JSON.stringify({ id: scene.id, lines: scene.lines || [] });
    writes.push([dataRel, data]);
    return buildEntry(scene, oldById.get(scene.id));
  });
  writes.push(['scenes-index.json', JSON.stringify(index)]);

  for (const [rel, content] of writes) {
    const current = exists(rel) ? read(rel) : null;
    // Inhalt vergleichen, nicht die Schreibweise (ältere Dateien haben z. B. 183.0 statt 183)
    let same = current === content;
    if (!same && current != null) {
      try { same = JSON.stringify(JSON.parse(current)) === content; } catch { same = false; }
    }
    if (same) continue;
    if (check) problems.push(rel);
    else fs.writeFileSync(path.join(root, rel), content);
  }
  if (check) {
    if (problems.length) {
      console.error('Out of date (run node tools/sync-scene-index.cjs):\n  ' + problems.join('\n  '));
      process.exit(1);
    }
    console.log(`scenes-index.json and ${ids.size} scenedata files are up to date.`);
  } else {
    console.log(`Wrote scenes-index.json (${index.length} scenes) and scenedata files.`);
  }
}

main();
