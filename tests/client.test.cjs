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
    return new Response(JSON.stringify({id:'aottraitor',lines:updatedLines}));
  };
  const first = {id:'aottraitor'}, second = {id:'aottraitor'};
  await w.ensureLines(first);
  await w.ensureLines(second);
  assert.deepEqual(requests, ['scenedata/aottraitor.json?v=' + w.release]);
  assert.equal(JSON.stringify(first.lines), JSON.stringify(updatedLines));
  assert.equal(second.lines, first.lines);
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

test('scene downloads are shared, invalid data is retryable, and newer selections win', async t => {
  const w = app(t, `usingSceneIndex=true; sceneList=[];
    window.loadLines=ensureSceneLines; window.choose=s=>prepareSceneSelection(s,'lobby-status',()=>true);`);
  let requests=0, complete;
  w.fetch=()=>{requests++;return new Promise(r=>complete=r);};
  const a={id:'old'}, b={id:'old'};
  const first=w.loadLines(a), duplicate=w.loadLines(b);
  assert.equal(requests,1);
  complete(new Response(JSON.stringify({id:'wrong',lines:[]})));
  assert.equal(await first,null);assert.equal(await duplicate,null);
  const pending=new Map();
  w.fetch=url=>new Promise(resolve=>pending.set(url.split('/')[1].split('.')[0],resolve));
  const old=w.choose({id:'old'}), latest=w.choose({id:'new'});
  const reply=id=>new Response(JSON.stringify({id,lines:[{t:0,end:1,chars:[1],text:id}]}));
  pending.get('new')(reply('new'));assert.equal(await latest,true);
  pending.get('old')(reply('old'));assert.equal(await old,false);
});

test('delegated host can load uncached scene and duel without undefined connection', async t => {
  const w=app(t, `isHost=true; usingSceneIndex=true; logicalHostKey='guest';
    players=[{id:'guest',key:'guest',name:'Guest'}];
    sceneList=[{id:'fresh',videoUrl:'test.mp4',roles:[{id:1,name:'Role'}]}];
    resetForNewRound=()=>{};showScene=()=>{};resetRoles=()=>{};
    broadcast=()=>{};broadcastState=()=>{};broadcastSettings=()=>{};queueOrStartBooth=()=>{};
    window.command=cmd=>handleHostCmd({cmd,sceneId:'fresh',roleId:1,aId:'guest',bId:'other'},players[0]);
    window.selected=()=>scene;`);
  w.fetch=async()=>new Response(JSON.stringify({id:'fresh',lines:[{t:0,end:1,chars:[1]}]}));
  await w.command('loadScene');assert.equal(w.selected().id,'fresh');
  await w.command('duelStart');assert.equal(w.selected().lines.length,1);
});

test('leaving clears decoded audio and aborts pending scene requests', t => {
  const w=app(t, `origCache.set('old',{});voiceTrackCache.set('old',{});
    window.oldSignal=sceneAudioController.signal;window.leave=leaveRoom;
    window.cacheSize=()=>origCache.size+voiceTrackCache.size;`);
  w.leave();assert.equal(w.oldSignal.aborted,true);assert.equal(w.cacheSize(),0);
});

test('failed recorded line receives its original replacement in the mix', async t => {
  const w=app(t, `scene={videoUrl:'test.mp4',roles:[{id:1,name:'Test'}],lines:[{t:0,end:2,chars:[1],orig:'original.mp3'}]};
    getCtx().decodeAudioData=async()=>{throw Error('broken recording');};
    getLineOrigBuffer=async()=>({duration:2});StudioReliability.waitMedia=async()=>{};
    window.load=()=>loadMix([{role:1,items:[{idx:0,startAt:0,buf:new ArrayBuffer(8)}]}]);
    window.items=()=>mixItems;`);
  await w.load();assert.equal(w.items().length,1);assert.equal(w.items()[0].isOrig,true);
});

test('full voice tracks fall back from CDN and share concurrent downloads', async t => {
  const w=app(t, `scene={voiceTrack:'scenes/voice.mp3'};window.voice=getVoiceTrack;`);
  const urls=[];
  w.fetch=async url=>{urls.push(url);return urls.length===1?new Response('',{status:503}):new Response(new Uint8Array([1,2,3]));};
  const [a,b]=await Promise.all([w.voice(),w.voice()]);
  assert.ok(a);assert.equal(a,b);assert.equal(urls.length,2);
  assert.ok(urls[1].startsWith('https://raw.githubusercontent.com/'));
});

test('duel originals use bounded concurrency and discard stale scene work', async t => {
  const w=app(t, `scene={roles:[],lines:Array.from({length:9},(_,i)=>({t:i,end:i+1,chars:[1],orig:'voice'+i}))};
    window.active=0;window.peak=0;
    getLineOrigBuffer=async()=>{window.active++;window.peak=Math.max(window.peak,window.active);
      await new Promise(r=>setTimeout(r,5));window.active--;return {duration:1};};
    window.decode=()=>decodeDuelData([]);window.cancel=clearSceneCaches;`);
  const items=await w.decode();assert.equal(items.length,9);assert.equal(w.peak,3);
  const stale=w.decode();w.cancel();assert.equal((await stale).length,0);
});

test('host handoff during loading prevents a stale scene command', async t => {
  const w=app(t, `isHost=true;usingSceneIndex=true;logicalHostKey='guest';scene=null;
    players=[{id:'guest',key:'guest'}];sceneList=[{id:'fresh',roles:[]}];
    window.command=()=>handleHostCmd({cmd:'loadScene',sceneId:'fresh'},players[0]);
    window.revoke=()=>{logicalHostKey='someone-else';};window.selected=()=>scene;`);
  let finish;w.fetch=()=>new Promise(r=>finish=r);
  const pending=w.command();w.revoke();
  finish(new Response(JSON.stringify({id:'fresh',lines:[{t:0,end:1,chars:[1]}]})));
  await pending;assert.equal(w.selected(),null);
});

test('a slow duel guest retains an early start command and starts only once', async t => {
  const w=app(t, `isHost=false;scene={videoUrl:'test.mp4',lines:[],roles:[]};
    window.started=0;playMix=()=>{window.started++;};waitCanPlay=async()=>{};
    decodeDuelData=()=>new Promise(r=>window.finishDecode=r);
    window.load=()=>loadDuelSequence([],[],{aId:'a',bId:'b'});
    window.go=()=>handleMsg({t:'duelPlayGo'},hostConn);
    window.cancel=clearSceneCaches;`);
  const pending=w.load();w.go();w.finishDecode([]);await delay(0);
  w.finishDecode([]);await pending;
  assert.equal(w.started,1);w.go();assert.equal(w.started,1);
  w.cancel();await delay(0);assert.equal(w.started,1);
});
