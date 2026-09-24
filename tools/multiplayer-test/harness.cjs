// Mehrspieler-Testumgebung (siehe README.md):
// - lokaler PeerJS-Server statt 0.peerjs.com, alle Spiel-Dateien aus dem Repo
// - Seite läuft unter der echten Adresse synchron-studio.github.io (per Routing), damit CDN-Logik greift
// - Szenen-MP4 werden für Chromium (ohne H.264) automatisch in WebM umgewandelt und zwischengespeichert
// - Mikro: Chromiums Fake-Gerät (Piepton)
// Playwright: lokal installiert oder global (in Claude-Cloud-Umgebungen ist es global vorhanden)
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
const { PeerServer } = require('peer');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const HERE = __dirname;
const CACHE = path.join(HERE, 'webm-cache');
const ASSETS = path.join(HERE, 'assets');
fs.mkdirSync(CACHE, { recursive: true });
const FFMPEG = path.join(HERE, 'node_modules/ffmpeg-static/ffmpeg');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/webm', '.webm': 'video/webm', '.woff2': 'font/woff2' };

function webmFor(file) {
  const key = file.replace(/[^a-z0-9]+/gi, '_') + '.webm';
  const out = path.join(CACHE, key);
  if (!fs.existsSync(out)) {
    cp.execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=320:-2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '48k', out]);
  }
  return out;
}

let server = null;
function startPeerServer(port = 9000) {
  if (server) return server;
  server = PeerServer({ port, host: '127.0.0.1', path: '/', allow_discovery: true });
  return server;
}

async function launch(opts = {}) {
  startPeerServer();
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights'],
    headless: true,
  });
  return browser;
}

const INIT = () => {
  // PeerJS auf den lokalen Server umbiegen
  let Real = null;
  Object.defineProperty(window, 'Peer', {
    configurable: true,
    get() { return Real; },
    set(v) {
      if (!v) { Real = v; return; }
      const Base = v;
      Real = function (id, options) {
        if (id && typeof id === 'object') { options = id; id = undefined; }
        const o = Object.assign({}, options || {}, { host: '127.0.0.1', port: 9000, path: '/', secure: false, config: { iceServers: [] } });
        return id !== undefined ? new Base(id, o) : new Base(o);
      };
      Real.prototype = Base.prototype;
      Object.assign(Real, Base);
    },
  });
  window.__errors = [];
  window.addEventListener('error', e => window.__errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', e => window.__errors.push('rej: ' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason)));
};

async function newPlayer(browser, name, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: opts.viewport || { width: 1280, height: 900 }, permissions: ['microphone'] });
  await ctx.addInitScript(INIT);
  if (opts.storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, opts.storage);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    let rel = null, cors = false;
    if (u.hostname === 'synchron-studio.github.io') rel = u.pathname.replace(/^\/synchronstudio\/?/, '') || 'index.html';
    else if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('synchronstudio@')) { rel = u.pathname.split(/synchronstudio@[^/]+\//)[1]; cors = true; }
    else if (u.hostname === 'raw.githubusercontent.com' && u.pathname.includes('/synchronstudio/')) { rel = u.pathname.split(/\/synchronstudio\/[^/]+\//)[1]; cors = true; }
    else if (u.hostname === 'unpkg.com' && u.pathname.includes('peerjs')) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(HERE, 'node_modules/peerjs/dist/peerjs.min.js')) });
    }
    else if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    if (rel == null) return route.fulfill({ status: 404, body: '' });
    let f = path.join(ROOT, decodeURIComponent(rel));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
    if (/\.mp4$/i.test(f)) f = webmFor(f);
    const headers = { 'content-type': types[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (cors) headers['access-control-allow-origin'] = '*';
    const body = fs.readFileSync(f);
    const range = route.request().headers()['range'];
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = +m[1], end = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
      headers['content-range'] = `bytes ${start}-${end}/${body.length}`;
      headers['accept-ranges'] = 'bytes';
      return route.fulfill({ status: 206, headers, body: body.subarray(start, end + 1) });
    }
    headers['accept-ranges'] = 'bytes';
    route.fulfill({ status: 200, headers, body });
  });
  const page = await ctx.newPage();
  page.__name = name;
  page.__log = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') page.__log.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => page.__log.push('pageerror: ' + (e.stack || e.message).slice(0, 500)));
  page.on('dialog', d => { page.__log.push('dialog: ' + d.message().slice(0, 120)); d.accept().catch(() => {}); });
  const lang = opts.lang || 'de';
  await page.goto('https://synchron-studio.github.io/synchronstudio/' + (opts.query || ''));
  return page;
}

// Mic-Setup + Profilbild + Name durchklicken
async function onboard(page, name) {
  await page.waitForSelector('#btn-mic-record');
  await skipTutorial(page);
  await page.click('#btn-mic-record');
  await page.waitForFunction(() => !document.querySelector('#btn-mic-done').disabled, null, { timeout: 20000 });
  await page.click('#btn-mic-done');
  await page.waitForSelector('#scr-avatar.active', { timeout: 10000 });
  await page.click('#btn-avatar-done');
  await page.waitForSelector('#scr-start.active', { timeout: 10000 });
  await page.fill('#in-name', name);
}
async function skipTutorial(page) {
  const b = await page.$('#tut-skip');
  if (b && await b.isVisible()) await b.click();
}

async function createRoom(page) {
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby.active', { timeout: 30000 });
  await page.waitForFunction(() => /^\d{5}$/.test(document.querySelector('#lobby-code').textContent.trim()), null, { timeout: 30000 });
  return (await page.textContent('#lobby-code')).trim();
}
async function joinRoom(page, code) {
  await page.fill('#in-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#scr-lobby.active', { timeout: 40000 });
}

function dump(page) {
  return page.evaluate(() => ({
    screen: document.querySelector('.screen.active')?.id,
    errors: window.__errors,
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { ASSETS, launch, newPlayer, onboard, createRoom, joinRoom, dump, sleep, skipTutorial, webmFor, ROOT };

// ── Spiel-Helfer ─────────────────────────────────────────────
async function screen(page) { return page.evaluate(() => document.querySelector('.screen.active')?.id); }
async function waitScreen(page, id, timeout = 60000) {
  await page.waitForFunction((id) => document.querySelector('.screen.active')?.id === id, id, { timeout });
}
async function hostLoadScene(page, sceneId) {
  await page.waitForFunction(() => typeof sceneList !== 'undefined' && sceneList.length > 0, null, { timeout: 30000 });
  await page.evaluate((id) => {
    const i = sceneList.findIndex(s => s.id === id);
    if (i < 0) throw new Error('scene not found ' + id);
    const sel = document.getElementById('scene-select');
    if (![...sel.options].some(o => o.value === String(i))) { const o = document.createElement('option'); o.value = String(i); sel.appendChild(o); }
    sel.value = String(i);
  }, sceneId);
  await page.click('#btn-load-scene');
  await page.waitForFunction(() => document.getElementById('scene-card').style.display !== 'none' && scene && scene.id, null, { timeout: 30000 });
}
async function pickRole(page, r) {
  await page.waitForSelector(`#role-list .rolebtn[data-r="${r}"]`, { timeout: 20000 });
  await page.click(`#role-list .rolebtn[data-r="${r}"]`);
}
async function ready(page) {
  await page.waitForFunction(() => !scene || !scene.videoUrl || myVideoReady, null, { timeout: 90000 });
  await page.click('#btn-ready');
  await page.waitForFunction(() => players.find(p => p.id === myId)?.ready, null, { timeout: 15000 });
}
async function hostStart(page, btn = '#btn-start') {
  await page.waitForFunction((b) => { const e = document.querySelector(b); return e && !e.disabled && e.offsetParent; }, btn, { timeout: 90000 });
  await page.click(btn);
}
// Booth: die ersten n Zeilen aufnehmen, Rest überspringen
async function booth(page, nRecord = 1, recMs = 1200) {
  const scr = await screen(page);
  if (scr !== 'scr-booth') return scr;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => ({ scr: document.querySelector('.screen.active')?.id, cur: curLine, n: myLines.length }));
    if (st.scr !== 'scr-booth') break;
    if (st.cur >= st.n) break;
    if (st.cur < nRecord) {
      await page.waitForFunction(() => !document.getElementById('btn-line-rec').disabled, null, { timeout: 60000 });
      await page.click('#btn-line-rec');
      await sleep(recMs);
      const still = await page.evaluate(() => lineRec && lineRec.state === 'recording');
      if (still) await page.click('#btn-line-rec');
      await page.waitForFunction(() => { const b = document.getElementById('btn-line-next'); return b && !b.disabled && b.offsetParent; }, null, { timeout: 30000 });
      await page.click('#btn-line-next');
    } else {
      await page.waitForFunction(() => { const b = document.getElementById('btn-line-skip'); return b && !b.disabled && b.offsetParent; }, null, { timeout: 30000 });
      await page.click('#btn-line-skip');
    }
    await sleep(150);
  }
  return screen(page);
}
async function rateAll(page, stars = 5) {
  await page.waitForFunction(() => document.getElementById('rate-card').style.display !== 'none', null, { timeout: 120000 });
  const rows = await page.$$('#rate-rows .raterow');
  for (const row of rows) { const b = await row.$(`.starbtn[data-n="${stars}"]`); if (b) await b.click(); }
  const sub = await page.$('#btn-rate-submit');
  if (sub && await sub.isVisible() && !(await sub.isDisabled())) await sub.click();
}
function problems(pages) {
  return Promise.all(pages.map(async p => ({ who: p.__name, errors: await p.evaluate(() => window.__errors).catch(() => ['<closed>']), log: p.__log.filter(l => !/status of 404|ERR_TUNNEL|ERR_CERT|fonts\.g|^dialog:/.test(l)) })));
}
Object.assign(module.exports, { screen, waitScreen, hostLoadScene, pickRole, ready, hostStart, booth, rateAll, problems });

// ── Szenario-Helfer ──────────────────────────────────────────
async function room(browser, n, opts = {}) {
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(await newPlayer(browser, 'P' + i, opts));
  await Promise.all(ps.map((p, i) => onboard(p, (opts.names && opts.names[i]) || ('Spieler' + i))));
  const code = await createRoom(ps[0]);
  for (const g of ps.slice(1)) await joinRoom(g, code);
  await ps[0].waitForFunction((n) => players.length === n, n, { timeout: 30000 });
  // Nur kurze Szenen für Zufallsauswahl (Tests sollen nicht Minuten-Premieren abspielen)
  if (opts.shortOnly !== false) await ps[0].evaluate(async () => { await loadSceneList(); sceneList = sceneList.filter(s => (s.approxDur || 99) <= 16 && (s.roles || []).length <= 3); });
  return { ps, code, host: ps[0] };
}
async function setMode(host, mode) {
  await host.click(`#mode-picker .mode-btn[data-mode="${mode}"]`);
  await sleep(800);
}
// Alle Spieler durch Kabine → Premiere → Bewertung (normale Runde)
async function playNormalRound(ps, host, { rec = 1, stars } = {}) {
  await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 120000 })));
  await Promise.all(ps.map(p => booth(p, rec)));
  await Promise.all(ps.map(p => waitScreen(p, 'scr-playback', 90000)));
  await host.waitForFunction(() => { const e = document.getElementById('btn-prem-start'); return e && e.offsetParent && !e.disabled; }, null, { timeout: 90000 });
  await host.click('#btn-prem-start');
  await Promise.all(ps.map((p, i) => rateAll(p, stars ? stars[i] : 5).catch(e => { throw new Error(p.__name + ' rate: ' + e.message); })));
  await host.waitForFunction(() => document.getElementById('rate-result').textContent.trim().length > 0, null, { timeout: 60000 });
  return (await host.textContent('#rate-result')).replace(/\s+/g, ' ').trim();
}
async function achOf(p) { return p.evaluate(() => Object.keys(achData.unlocked)); }
Object.assign(module.exports, { room, setMode, playNormalRound, achOf });
