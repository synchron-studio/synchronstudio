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

test('scene import: editor ZIP is built in, bad ZIPs are rejected with a reason', (t) => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-import-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const f of ['scenes.json', 'scenes-index.json', 'client.js', 'index.html']) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  fs.cpSync(path.join(root, 'scenedata'), path.join(tmp, 'scenedata'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tools'));
  for (const f of ['sync-scene-index.cjs', 'import-scene.cjs']) fs.copyFileSync(path.join(root, 'tools', f), path.join(tmp, 'tools', f));
  fs.mkdirSync(path.join(tmp, '_import'));
  // ZIPs mit Python bauen (überall vorhanden, wo die Tests laufen)
  const mkzip = (name, id) => {
    const scene = { id, title: 'Import Test (1 Rolle)', videoUrl: `scenes/${id}.mp4`, avatars: { 0: `scenes/${id}/hero.png` },
      roles: [{ id: 0, name: 'Hero', pan: 0, effect: 'none', gain: 1 }],
      lines: [{ t: 0.5, end: 2, chars: [0], who: 'Hero', text: 'Hi', de: 'Hallo', orig: `scenes/${id}/lines/01.mp3` }] };
    const py = `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('scene.json', json.dumps(json.loads(sys.argv[2])))
z.writestr('scenes/${id}.mp4', b'x'*2048)
z.writestr('scenes/${id}/hero.png', b'png')
z.writestr('scenes/${id}/lines/01.mp3', b'mp3')
z.writestr('previews/${id}.mp4', b'p'*1024)
z.close()`;
    execFileSync('python3', ['-c', py, path.join(tmp, '_import', name), JSON.stringify(scene)]);
  };
  mkzip('good.zip', 'importtest_scene');
  mkzip('default-name.zip', 'newscene');
  let code = 0;
  try { execFileSync(process.execPath, [path.join(tmp, 'tools', 'import-scene.cjs')], { cwd: tmp, env: { ...process.env, SS_ROOT: tmp, SS_NO_TRANSLATE: '1', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' }, stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1, 'a failed ZIP makes the run fail (red in GitHub)');
  const scenes = JSON.parse(fs.readFileSync(path.join(tmp, 'scenes.json'), 'utf8'));
  const added = scenes.find(s => s.id === 'importtest_scene');
  assert.ok(added && added.imported && added.catalogChange === 'new');
  assert.ok(!scenes.some(s => s.id === 'newscene'));
  for (const f of ['scenes/importtest_scene.mp4', 'scenes/importtest_scene/hero.png', 'scenes/importtest_scene/lines/01.mp3', 'previews/importtest_scene.mp4', 'scenedata/importtest_scene.json'])
    assert.ok(fs.existsSync(path.join(tmp, f)), 'copied: ' + f);
  const client = fs.readFileSync(path.join(tmp, 'client.js'), 'utf8');
  const v = /const APP_VERSION = "([^"]+)"/.exec(client)[1];
  assert.ok(client.includes(`{ v: "${v}", items: [\n    "🎬 Neue Szene: Import Test"`), 'patch note for the new version');
  assert.ok(fs.readFileSync(path.join(tmp, 'index.html'), 'latin1').includes(`client.js?v=${v}`));
  assert.ok(!fs.existsSync(path.join(tmp, '_import', 'good.zip')), 'imported ZIP removed');
  assert.ok(fs.existsSync(path.join(tmp, '_import', 'fehlgeschlagen', 'default-name.zip')));
  assert.match(fs.readFileSync(path.join(tmp, '_import', 'fehlgeschlagen', 'default-name - FEHLER.txt'), 'utf8'), /Standardname/);
});

test('scene import: GameBanana links in _import/links.txt are downloaded and built in', async (t) => {
  const os = require('node:os');
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-import-gb-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const f of ['scenes.json', 'scenes-index.json', 'client.js', 'index.html']) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  fs.cpSync(path.join(root, 'scenedata'), path.join(tmp, 'scenedata'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tools'));
  for (const f of ['sync-scene-index.cjs', 'import-scene.cjs']) fs.copyFileSync(path.join(root, 'tools', f), path.join(tmp, 'tools', f));
  fs.mkdirSync(path.join(tmp, '_import'));
  const id = 'gbtest_scene';
  const scene = { id, title: 'GB Test (1 Rolle)', videoUrl: `scenes/${id}.mp4`, avatars: {},
    roles: [{ id: 0, name: 'Hero', pan: 0, effect: 'none', gain: 1 }],
    lines: [{ t: 0.5, end: 2, chars: [0], who: 'Hero', text: 'Hi', de: 'Hallo' }] };
  const zipPath = path.join(tmp, 'pack.zip');
  execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('Pack/scene.json', sys.argv[2])
z.writestr('Pack/scenes/${id}.mp4', b'x'*2048)
z.writestr('Pack/previews/${id}.mp4', b'p'*1024)
z.close()`, zipPath, JSON.stringify(scene)]);
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/Mod/111')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ _sName: 'GB Test', _aFiles: [{ _idRow: 5, _sFile: 'gb_test.zip', _sDownloadUrl: `http://127.0.0.1:${srv.address().port}/dl/5` }, { _idRow: 6, _sFile: 'readme.txt', _sDownloadUrl: 'x' }] })); }
    if (req.url === '/dl/5') return res.end(fs.readFileSync(zipPath));
    res.statusCode = 404; res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  fs.writeFileSync(path.join(tmp, '_import', 'links.txt'), 'https://gamebanana.com/mods/111\nhttps://example.com/nope\n');
  const code = await new Promise(r => execFile(process.execPath, [path.join(tmp, 'tools', 'import-scene.cjs')],
    { cwd: tmp, env: { ...process.env, SS_ROOT: tmp, SS_NO_TRANSLATE: '1', SS_GB_API: `http://127.0.0.1:${srv.address().port}/api`, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' } },
    (e) => r(e ? e.code : 0)));
  assert.equal(code, 1, 'the bad link makes the run red');
  const scenes = JSON.parse(fs.readFileSync(path.join(tmp, 'scenes.json'), 'utf8'));
  assert.ok(scenes.some(s => s.id === id && s.imported), 'downloaded pack built in');
  assert.ok(fs.existsSync(path.join(tmp, 'scenes', id + '.mp4')));
  assert.ok(!fs.existsSync(path.join(tmp, '_import', 'links.txt')), 'link list cleared');
  assert.ok(!fs.readdirSync(path.join(tmp, '_import', 'fehlgeschlagen')).some(n => /\.zip$/i.test(n)), 'downloads are never stored in the repo');
});
