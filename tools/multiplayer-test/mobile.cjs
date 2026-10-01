// Handy/Tablet-Check: alle Einzelspieler-Ansichten auf mehreren Geräten (Touch-Emulation)
// misst seitliches Überlaufen, zu kleine Tippflächen, iOS-Zoom-Fallen, abgeschnittenen Text.
// Aufruf: node mobile.cjs   (DEVS="iPhone SE,iPad Mini" für eine Auswahl)
// Achtung: keine fullPage-Screenshots — die schalten in Playwright die Touch-Emulation ab.
const H = require('./harness.cjs');
const { devices } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const audit = require('./layout-audit.cjs');
const OUT = __dirname + '/mobile-shots/';
require('fs').mkdirSync(OUT, { recursive: true });
const DEVS = (process.env.DEVS || 'iPhone SE,iPhone 13,Pixel 7,iPad Mini,iPad Pro 11,Pixel 7 landscape,iPhone 13 landscape').split(',');
const report = {};
(async () => {
  const b = await H.launch();
  for (const name of DEVS) {
    const dev = devices[name];
    const tag = name.replace(/\s+/g, '_');
    const p = await H.newPlayer(b, tag, { device: { ...dev, defaultBrowserType: undefined } });
    const r = report[name] = {};
    const shot = async (k) => { await H.sleep(600); r[k] = await p.evaluate(audit); await p.screenshot({ path: OUT + tag + '__' + k + '.png', fullPage: false }); };
    try {
      await p.waitForSelector('#tut-overlay', { state: 'visible', timeout: 10000 });
      await shot('tutorial');
      await p.click('#tut-skip');
      await shot('mic');
      await p.click('#btn-mic-record');
      await p.waitForFunction(() => !document.querySelector('#btn-mic-done').disabled, null, { timeout: 20000 });
      await p.click('#btn-mic-done');
      await p.waitForSelector('#scr-avatar.active');
      await shot('avatar');
      await p.click('#btn-avatar-done');
      await p.waitForSelector('#scr-start.active');
      await p.fill('#in-name', 'Testspieler');
      await p.waitForFunction(() => document.getElementById('daily-card').style.display !== 'none', null, { timeout: 15000 }).catch(() => {});
      await shot('start');
      await p.click('#scr-start .ach-open'); await shot('achievements'); await p.click('#btn-ach-close');
      const pn = await p.$('#patchnotes-btn'); if (pn && await pn.isVisible()) { await pn.click(); await shot('patchnotes'); await p.keyboard.press('Escape'); await H.sleep(300); const close = await p.$('#patchnotes-close, .patchnotes-close, [data-close-patchnotes]'); if (close && await close.isVisible()) await close.click(); }
      await p.evaluate(() => { document.querySelectorAll('[id*=patch]').forEach(e => { if (getComputedStyle(e).position === 'fixed' && e.id !== 'patchnotes-btn') e.style.display = 'none'; }); });
      await H.createRoom(p);
      await p.evaluate(async () => { await loadSceneList(); });
      await shot('lobby_free');
      await H.hostLoadScene(p, 'ghostweight');
      await shot('lobby_scene');
      for (const m of ['rounds', 'duell', 'team']) { await p.click(`#mode-picker .mode-btn[data-mode="${m}"]`); await shot('lobby_' + m); }
    } catch (e) { r.error = e.message.split('\n')[0]; }
    r.problems = (await H.problems([p]))[0];
    await p.context().close();
    console.log(name, JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && v.vw ? { overflowX: v.overflowX, offenders: v.offendersN, small: v.smallTargetsN, zoom: v.zoomInputsN, clip: v.textClippedN } : v]))));
  }
  require('fs').writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
  await b.close(); process.exit(0);
})();
