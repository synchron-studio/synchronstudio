const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

test('all indexed scenes have metadata, valid timings and existing asset paths', () => {
  // Git's index also works in a sparse checkout where media files are not downloaded.
  const files = new Set(execFileSync('git', ['ls-files', '-z'], {cwd:root, encoding:'utf8'}).split('\0'));
  const read = name => JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
  const scenes = read('scenes-index.json');
  const ids = new Set();
  const missing = new Set();
  const walk = value => {
    if (typeof value === 'string' && /^(scenes|previews)\//.test(value) && !files.has(value)) missing.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const scene of scenes) {
    assert.ok(scene.videoBytes > 0, 'missing download size: ' + scene.id);
    assert.ok(scene.previewBytes > 0 && scene.previewBytes < 500000, 'preview size: ' + scene.id);
    assert.ok(scene.previewUrl.startsWith('previews/'), 'missing preview: ' + scene.id);
    assert.ok(!ids.has(scene.id), 'duplicate scene ID: ' + scene.id);
    ids.add(scene.id);
    const data = read('scenedata/' + scene.id + '.json');
    for (const line of data.lines || []) {
      assert.ok(Number.isFinite(line.t) && line.end > line.t, 'invalid timing: ' + scene.id);
    }
    walk(scene); walk(data);
  }
  walk(read('scenes.json'));
  assert.deepEqual([...missing], [], 'missing scene assets');
});

test('scenes-index.json and scenedata/ are in sync with scenes.json', () => {
  // Wer eine Szene nur in scenes.json einträgt, sieht sie im Spiel nicht — das fängt dieser Test ab.
  execFileSync(process.execPath, [path.join(root, 'tools', 'sync-scene-index.cjs'), '--check'], { cwd: root, stdio: 'pipe' });
});
