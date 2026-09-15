const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function app(t, exports = '') {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://synchron-studio.github.io/synchronstudio/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const w = dom.window;
  t.after(() => { w.close(); assert.deepEqual(errors, [], 'no uncaught client startup errors'); });
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (target, key) => target[key] ?? (() => {})
  });
  w.HTMLMediaElement.prototype.load = function () {};
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = async function () {};
  w.URL.createObjectURL = () => 'blob:test-video';
  w.URL.revokeObjectURL = () => {};
  w.Blob = Blob;
  w.TextEncoder = TextEncoder;
  w.fetch = async url => {
    if (String(url).includes('scenes-index')) return { ok: true, json: async () => [] };
    throw new Error('Unexpected test fetch: ' + url);
  };
  class Peer { on() {} destroy() {} }
  w.Peer = Peer;
  w.MediaRecorder = class {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(stream) { if (!stream) throw Error('Missing stream'); this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  };
  w.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 1 }); }
  };
  w.eval(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'reliability.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'client.js'), 'utf8') + '\n' + exports);
  return w;
}

test('whole client starts with Safari recording format support', t => {
  const w = app(t, 'window.testMime = pickMime(); window.testVersion = APP_VERSION; window.latestPatch = PATCH_NOTES[0].v;');
  assert.equal(w.testMime, 'audio/mp4');
  assert.ok(w.document.getElementById('patchnotes-btn').textContent.includes(w.testVersion));
  assert.equal(w.latestPatch, w.testVersion);
  assert.ok(w.document.querySelector('script[src^="client.js?"]').src.endsWith('v=' + w.testVersion));
  assert.ok(w.document.querySelector('script[src^="reliability.js?"]').src.endsWith('v=' + w.testVersion));
});

test('scene updates refresh dialogue timings and reuse them within the release', async t => {
  const w = app(t, `usingSceneIndex = true; sceneList = [];
    window.ensureLines = ensureSceneLines; window.release = APP_VERSION;`);
  const requests = [];
  const updatedLines = [{t:130.365,end:137.482,chars:[0],text:'Updated scene'}];
  w.fetch = async url => {
    requests.push(url);
    return {ok:true,json:async()=>({id:'aottraitor',lines:updatedLines})};
  };
  const first = {id:'aottraitor'}, second = {id:'aottraitor'};
  await w.ensureLines(first);
  await w.ensureLines(second);
  assert.deepEqual(requests, ['scenedata/aottraitor.json?v=' + w.release]);
  assert.equal(first.lines, updatedLines);
  assert.equal(second.lines, updatedLines);
});

test('a broken peer does not prevent broadcasting to other players', t => {
  const w = app(t, `window.run = () => {
    let received = 0;
    conns.set('broken', {open: true, send() {throw Error('closed during send');}});
    conns.set('healthy', {open: true, send() {received++;}});
    broadcast({t: 'state'}); return received;
  };`);
  assert.equal(w.run(), 1);
});

test('ended mobile microphone tracks trigger reacquisition', async t => {
  const w = app(t, `window.run = async () => {
    let calls = 0;
    micStream = {getAudioTracks: () => [{readyState:'ended'}]};
    buildMic = async () => { calls++; return true; };
    await ensureMic();
    micStream = {getAudioTracks: () => [{readyState:'live'}]};
    await ensureMic(); return calls;
  };`);
  assert.equal(await w.run(), 1);
});

test('continuous progress broadcasts at regular intervals', async t => {
  const w = app(t, `window.count = 0;
    renderPlayers = renderBoothPlayers = checkStartable = checkAllDone = () => {};
    broadcast = () => window.count++;
    window.tick = () => broadcastState({throttle:true});`);
  for (let i = 0; i < 9; i++) { w.tick(); await delay(60); }
  assert.ok(w.count >= 1, 'frequent events must not postpone the first broadcast forever');
});

test('scene switch aborts the old download without starting fallback', async t => {
  const w = app(t, `renderPlayers = renderBoothPlayers = checkStartable = () => {};
    window.signals = [];
    fetchVideoAsBlob = (url, progress, signal) => new Promise((resolve, reject) => {
      window.signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled','AbortError')));
    });
    window.start = beginSceneVideoLoad;
    window.clear = clearSceneVideoState;`);
  w.start('https://example.com/old.mp4');
  w.start('https://example.com/new.mp4');
  assert.equal(w.signals[0].aborted, true);
  assert.equal(w.signals[1].aborted, false);
  w.clear();
  await delay(0);
  assert.equal(w.signals[1].aborted, true);
  assert.equal(w.signals.length, 2);
});

test('mobile playback waits for an explicit tap after NotAllowedError', async t => {
  const w = app(t, 'window.playMediaForTest = playMedia;');
  const video = w.document.getElementById('booth-video');
  let attempts = 0;
  video.play = () => ++attempts === 1
    ? Promise.reject(new w.DOMException('Autoplay blocked', 'NotAllowedError')) : Promise.resolve();
  let completed = false;
  const waiting = w.playMediaForTest(video).then(() => { completed = true; });
  await delay(0);
  assert.equal(completed, false);
  const button = w.document.querySelector('.media-tap-overlay button');
  assert.ok(button);
  button.click();
  await waiting;
  assert.equal(attempts, 2);
  assert.equal(w.document.querySelector('.media-tap-overlay'), null);
});

test('local transfer yields under backpressure and snapshots its source', async t => {
  const w = app(t, `window.sent = [];
    scene = {title:'first'}; localVideoBuf = new Uint8Array(50000).fill(7).buffer;
    window.conn = {open:true, bufferSize:1, dataChannel:{bufferedAmount:0}, send:msg => window.sent.push(msg)};
    window.startTransfer = () => sendLocalVideo(window.conn);
    window.switchScene = () => {scene = {title:'second'}; localVideoBuf = new ArrayBuffer(90000);};`);
  w.startTransfer();
  await delay(10);
  assert.equal(w.sent.length, 1, 'only metadata while queue is full');
  w.switchScene();
  w.conn.bufferSize = 0;
  await delay(65);
  assert.equal(w.sent.length, 1, 'old transfer must not send the new file');
});

test('stale and invalid video packets cannot corrupt the active transfer', t => {
  const w = app(t, `renderPlayers = renderBoothPlayers = renderRoles = checkStartable = () => {};
    window.startRx = startVideoReceive; window.chunk = receiveVideoChunk;
    window.rxState = () => ({offset:rxOff, active:!!rxBuf});`);
  w.startRx({ size: 10, scene: {title: 'test'}, transferId: 'new' });
  w.chunk(new ArrayBuffer(5), 'old', 0);
  assert.equal(w.rxState().offset, 0);
  w.chunk(new ArrayBuffer(5), 'new', 0);
  assert.equal(w.rxState().offset, 5);
  w.chunk(new ArrayBuffer(6), 'new', 5);
  assert.equal(w.rxState().active, false);
});

test('simultaneous original previews share a single download', async t => {
  const w = app(t, `window.calls = 0;
    StudioReliability.downloadBlob = async () => { window.calls++; return new Blob(['audio']); };
    window.original = getLineOrigBuffer;`);
  const [a, b] = await Promise.all([w.original({orig:'test.mp3'}), w.original({orig:'test.mp3'})]);
  assert.equal(w.calls, 1);
  assert.equal(a, b);
});

test('a downloaded blob is not ready until the browser can decode the video', async t => {
  const w = app(t, `renderPlayers = renderBoothPlayers = checkStartable = () => {};
    StudioReliability.waitMedia = () => Promise.reject(Error('unsupported codec'));
    window.begin = beginSceneVideoLoad; window.ready = () => myVideoReady;`);
  w.begin('blob:unsupported');
  await delay(0);
  assert.equal(w.ready(), false);
  assert.ok(w.document.querySelector('#lobby-status button'), 'retry is visible');
});

test('premiere video failures do not send a ready acknowledgement', async t => {
  const w = app(t, `scene = {roles:[], lines:[], videoUrl:'test.mp4'};
    window.progress = [];
    reportPremLoad = (pct, ready) => window.progress.push({pct,ready});
    StudioReliability.waitMedia = () => Promise.reject(Error('unsupported codec'));
    window.load = () => loadMix([]);`);
  assert.equal(await w.load(), false);
  assert.ok(w.progress.length > 0);
  assert.ok(w.progress.every(p => !p.ready));
  assert.ok(w.document.querySelector('#play-status button'));
});

test('realtime recorder never starts if video playback fails', async t => {
  const w = app(t, `scene = {roles:[{id:1,name:'Tester'}],videoUrl:'test.mp4'};
    myId = 'guest'; players = [{id:'guest',role:1}];
    ensureMic = async () => true;
    recStream = () => ({});
    countdown = async () => {};
    StudioReliability.waitMedia = async () => {};
    playMedia = async () => {throw Error('unsupported playback');};
    window.started = 0;
    MediaRecorder.prototype.start = function() { window.started++; this.state='recording'; };
    window.record = startRealtime;`);
  await w.record();
  assert.equal(w.started, 0);
  assert.ok(w.document.querySelector('#rec-status button'));
  assert.equal(w.document.getElementById('onair').classList.contains('live'), false);
});

test('local video finishes intact after the peer queue drains', async t => {
  const w = app(t, `window.sent = [];
    scene = {title:'first'}; localVideoBuf = new Uint8Array(50000).fill(7).buffer;
    window.conn = {open:true, bufferSize:1, dataChannel:{bufferedAmount:0}, send:msg => window.sent.push(msg)};
    window.startTransfer = () => sendLocalVideo(window.conn);`);
  w.startTransfer();
  await delay(10);
  w.conn.bufferSize = 0;
  for (let i = 0; i < 100 && w.sent.length < 5; i++) await delay(10);
  const chunks = w.sent.filter(msg => msg.t === 'videoChunk');
  assert.equal(chunks.length, 4);
  assert.equal(chunks.reduce((n,msg)=>n+msg.buf.byteLength,0),50000);
  assert.ok(chunks.every(msg => new Uint8Array(msg.buf).every(b=>b===7)));
  assert.deepEqual(Array.from(chunks,msg=>msg.offset),[0,16384,32768,49152]);
});

test('reusing the cached scene video does not revoke its blob URL', async t => {
  const w = app(t, `renderPlayers = renderBoothPlayers = checkStartable = () => {};
    fetchedVideoBlobUrl = videoBlobUrl = 'blob:cached';
    StudioReliability.waitMedia = async () => {};
    window.revoked = [];
    URL.revokeObjectURL = url => window.revoked.push(url);
    window.reuse = () => beginSceneVideoLoad('blob:cached');
    window.ready = () => myVideoReady;`);
  w.reuse();
  await delay(0);
  assert.equal(w.revoked.length, 0);
  assert.equal(w.ready(), true);
});

test('voice recording uses explicit speech bitrates for Opus and AAC', t => {
  const w = app(t, `recStream = () => ({});
    window.settings = [];
    window.preferred = 'audio/webm;codecs=opus';
    window.MediaRecorder = class {
      static isTypeSupported(m) {return m === window.preferred;}
      constructor(stream,options) {window.settings.push(options);}
    };
    window.record = voiceRecorder;`);
  w.record();
  w.preferred = 'audio/mp4';
  w.record();
  assert.equal(w.settings[0].audioBitsPerSecond, 64000);
  assert.equal(w.settings[1].audioBitsPerSecond, 96000);
});

test('direct video fallback discards an unusable downloaded blob', async t => {
  const w = app(t, `renderPlayers = renderBoothPlayers = checkStartable = () => {};
    scene = {videoUrl:'https://example.com/video.mp4'};
    fetchVideoAsBlob = async () => 'blob:bad-download';
    let attempts = 0;
    StudioReliability.waitMedia = async () => { if (++attempts === 1) throw Error('bad blob'); };
    window.begin = () => beginSceneVideoLoad(scene.videoUrl);
    window.source = sceneVideoSrc;
    window.ready = () => myVideoReady;`);
  w.begin();
  await delay(0);
  assert.equal(w.ready(), true);
  assert.equal(w.source(), 'https://example.com/video.mp4');
});

test('shared original chorus gain is preserved in normal and duel mixes', async t => {
  const w = app(t, `scene = {videoUrl:'test.mp4',roles:[],lines: Array.from({length:5}, (_,i) => ({t:0,end:2,chars:[i+1],orig:'chorus.mp3',origGain:0.2}))};
    getLineOrigBuffer = async () => ({duration:2});
    StudioReliability.waitMedia = async () => {};
    window.load = () => loadMix([]);
    window.duel = () => decodeDuelData([]);
    window.items = () => mixItems;
    window.originalGain = originalLineGain;`);
  await w.load();
  const normal = w.items();
  const duel = await w.duel();
  for (const mix of [normal, duel]) {
    assert.equal(mix.length, 5);
    assert.ok(mix.every(item => item.isOrig && item.boost === 0.2));
    assert.equal(mix.reduce((sum,item)=>sum+item.boost,0),1);
  }
  assert.equal(w.originalGain({}),1);
  assert.equal(w.originalGain({origGain:Infinity}),1);
});
