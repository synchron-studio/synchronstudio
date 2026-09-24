// Alle Spielmodi mit mehreren echten Browserfenstern durchspielen.
// Aufruf: node scenarios.cjs            (alle)
//         ONLY=team3,duel node scenarios.cjs
const path = require('path');
const H = require('./harness.cjs');
const ALL = 'free3,match,br,duel,team3,teamleave,handoff,matchhandoff,pack,packogv,blind,daily,latejoin,kick,drop,ownvideo,ttt';
const which = (process.env.ONLY || ALL).split(',');
const results = [];
async function scenario(name, fn) {
  if (!which.includes(name)) return;
  const b = await H.launch();
  const t0 = Date.now();
  let pages = [];
  try {
    const out = await fn(b, (ps) => { pages = ps; });
    const probs = (await H.problems(pages)).filter(x => x.errors.length || x.log.length);
    results.push({ name, ok: true, sec: Math.round((Date.now() - t0) / 1000), out, probs });
  } catch (e) {
    const probs = await H.problems(pages).catch(() => []);
    const screens = await Promise.all(pages.map(p => H.screen(p).catch(() => '?')));
    const statuses = await Promise.all(pages.map(p => p.evaluate(() => [...document.querySelectorAll('.screen.active .status')].map(e => e.textContent).filter(Boolean).join(' | ')).catch(() => '?')));
    results.push({ name, ok: false, err: e.message.split('\n')[0], screens, statuses, probs });
  }
  console.log(JSON.stringify(results[results.length - 1], null, 1));
  await b.close();
}
async function freeRound(ps, host, sceneId, roles) {
  await H.hostLoadScene(host, sceneId);
  for (const p of ps.slice(1)) await p.waitForFunction((id) => scene && scene.id === id, sceneId, { timeout: 20000 });
  for (const [i, r] of roles.entries()) if (r != null) await H.pickRole(ps[i], r);
  for (const [i, r] of roles.entries()) if (r != null) await H.ready(ps[i]);
  await H.hostStart(host);
}
(async () => {
  // Freies Spiel: 3 Spieler, 2 Rollen → einer schaut zu; ein Spieler nimmt Zusatzrolle? (Szene mit 3 Rollen, 2 Sprecher: P0 nimmt 2 Rollen)
  await scenario('free3', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    await H.hostLoadScene(host, 'ghostweight');   // 3 Rollen
    await ps[1].waitForFunction(() => scene && scene.id, null, { timeout: 20000 });
    await H.pickRole(host, 0); await H.pickRole(host, 1); await H.pickRole(ps[1], 2);
    // P2 bleibt Zuschauer
    await H.ready(host); await H.ready(ps[1]);
    await H.hostStart(host);
    const res = await H.playNormalRound(ps, host, { rec: 2, stars: [5, 4, 3] });
    const ach = await H.achOf(host);
    // Nochmal: „Nochmal“ → Lobby
    return { res, achHost: ach, roles: await host.evaluate(() => players.map(p => p.name + ':' + rolesOfPlayer(p).join('+'))) };
  });
  // Match mit 2 Runden
  await scenario('match', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    await H.setMode(host, 'rounds');
    await host.selectOption('#set-rounds', '2');
    await H.sleep(500);
    const out = [];
    await H.hostStart(host, '#btn-start');
    for (let r = 1; r <= 2; r++) {
      await Promise.all(ps.map(p => p.waitForFunction(() => scene && document.getElementById('scene-card').style.display !== 'none', null, { timeout: 60000 })));
      await Promise.all(ps.map(p => H.ready(p)));
      await H.hostStart(host, '#btn-go-round');
      out.push(await H.playNormalRound(ps, host, { stars: [5, 3] }));
      await host.waitForSelector('#btn-next-round', { state: 'visible', timeout: 30000 });
      await host.click('#btn-next-round');
    }
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-final', 60000)));
    out.push('final: ' + (await host.textContent('#podium-stage')).replace(/\s+/g, ' ').trim().slice(0, 120));
    out.push({ achHost: await H.achOf(host), achGuest: await H.achOf(ps[1]) });
    return out;
  });
  // Battle Royale mit 3 Spielern
  await scenario('br', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    await H.setMode(host, 'elimination');
    await H.hostStart(host, '#btn-start');
    const out = [];
    for (let r = 1; r <= 2; r++) {
      const alive = await host.evaluate(() => players.filter(p => !p.eliminated).map(p => p.id));
      await Promise.all(ps.map(p => p.waitForFunction(() => scene && document.getElementById('scene-card').style.display !== 'none', null, { timeout: 60000 })));
      await Promise.all(ps.map(p => H.ready(p).catch(() => {})));
      await H.hostStart(host, '#btn-go-round');
      out.push(await H.playNormalRound(ps, host, { stars: [5, 4, 3] }));
      out.push('eliminated: ' + (await host.evaluate(() => players.filter(p => p.eliminated).map(p => p.name).join(','))));
      await host.waitForSelector('#btn-next-round', { state: 'visible', timeout: 30000 });
      await host.click('#btn-next-round');
    }
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-final', 60000)));
    out.push('final: ' + (await host.textContent('#podium-stage')).replace(/\s+/g, ' ').trim().slice(0, 120));
    return out;
  });
  // Duell: 3 Spieler, P1 vs P2, P0 (Host) stimmt ab
  await scenario('duel', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    await H.setMode(host, 'duell');
    await host.evaluate(() => { const i = sceneList.findIndex(s => s.id === 'ghostseven'); document.getElementById('duel-scene-select').value = String(i); });
    await host.click('#btn-duel-load-scene');
    await host.waitForSelector('#duel-pickers', { state: 'visible', timeout: 20000 });
    const ids = await host.evaluate(() => players.map(p => p.id));
    await host.selectOption('#duel-player-a', ids[1]); await host.selectOption('#duel-player-b', ids[2]);
    await host.click('#btn-duel-start');
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 90000 })));
    await Promise.all(ps.map(p => H.booth(p, 1)));
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 60000)));
    await host.waitForFunction(() => { const e = document.getElementById('btn-duel-play-start'); return e && e.offsetParent; }, null, { timeout: 60000 });
    await host.click('#btn-duel-play-start');
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-duel-vote', 120000)));
    await host.click('#btn-vote-b');
    await Promise.all(ps.map(p => p.waitForFunction(() => document.getElementById('duel-result').textContent.trim().length > 0, null, { timeout: 30000 })));
    const res = (await ps[2].textContent('#duel-result')).replace(/\s+/g, ' ').trim();
    await host.click('#btn-duel-back');
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-lobby', 20000)));
    return { res, achWinner: await H.achOf(ps[2]) };
  });
  // Team 2 gegen 1 (3 Spieler), Szene mit 3 Rollen
  await scenario('team3', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    await H.setMode(host, 'team');
    await host.waitForFunction(() => [...document.querySelectorAll('#team-scene-select option')].some(o => o.value === 'ghostweight'), null, { timeout: 20000 });
    await host.selectOption('#team-scene-select', 'ghostweight');
    await host.click('#btn-team-start');
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 90000 })));
    const roles = await host.evaluate(() => players.map(p => p.name + ':' + p.team + ':' + rolesOfPlayer(p).join('+')));
    await Promise.all(ps.map(p => H.booth(p, 1)));
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 60000)));
    await host.waitForFunction(() => { const e = document.getElementById('btn-duel-play-start'); return e && e.offsetParent; }, null, { timeout: 60000 });
    await host.click('#btn-duel-play-start');
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-duel-vote', 150000)));
    for (const p of ps) {
      for (const r of await p.$$('#team-vote-rows .raterow')) { const s = await r.$('.starbtn[data-n="3"]'); if (s) await s.click(); }
      await p.click('#btn-team-vote-submit');
    }
    await Promise.all(ps.map(p => p.waitForFunction(() => document.getElementById('duel-result').textContent.trim().length > 0, null, { timeout: 30000 })));
    return { roles, res: (await host.textContent('#duel-result')).replace(/\s+/g, ' ').trim() };
  });
  // Team: ein Spieler verlässt mitten in der Aufnahme den Raum → darf nicht hängen
  await scenario('teamleave', async (b, reg) => {
    const { ps, host } = await H.room(b, 4); reg(ps);
    await H.setMode(host, 'team');
    await host.waitForFunction(() => [...document.querySelectorAll('#team-scene-select option')].some(o => o.value === 'ghostseven'), null, { timeout: 20000 });
    await host.selectOption('#team-scene-select', 'ghostseven');
    await host.click('#btn-team-start');
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 90000 })));
    // P3 geht freiwillig
    await ps[3].evaluate(() => leaveRoom());
    const rest = ps.slice(0, 3); reg(ps);
    await Promise.all(rest.map(p => H.booth(p, 1)));
    await Promise.all(rest.map(p => H.waitScreen(p, 'scr-playback', 60000)));
    await host.waitForFunction(() => { const e = document.getElementById('btn-duel-play-start'); return e && e.offsetParent; }, null, { timeout: 60000 });
    await host.click('#btn-duel-play-start');
    await Promise.all(rest.map(p => H.waitScreen(p, 'scr-duel-vote', 120000)));
    for (const p of rest) {
      for (const r of await p.$$('#team-vote-rows .raterow')) { const s = await r.$('.starbtn[data-n="4"]'); if (s) await s.click(); }
      await p.click('#btn-team-vote-submit');
    }
    await Promise.all(rest.map(p => p.waitForFunction(() => document.getElementById('duel-result').textContent.trim().length > 0, null, { timeout: 30000 })));
    return (await host.textContent('#duel-result')).replace(/\s+/g, ' ').trim();
  });
  // Host gibt Host-Rolle ab; neuer (logischer) Host startet ein Team-Battle und führt die Runde
  await scenario('handoff', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    const g1id = await ps[1].evaluate(() => myId);
    await host.click(`.host-btn[data-hostgive="${g1id}"]`);
    await host.click('#btn-leave-confirm');
    await ps[1].waitForFunction(() => iAmLogicalHost(), null, { timeout: 20000 });
    const nh = ps[1];
    await H.setMode(nh, 'team');
    await nh.waitForFunction(() => document.getElementById('team-setup').style.display !== 'none', null, { timeout: 10000 });
    await nh.waitForFunction(() => document.querySelectorAll('#team-scene-select option').length > 1, null, { timeout: 30000 });
    await nh.selectOption('#team-scene-select', 'ghostseven');
    await nh.click('#btn-team-shuffle');
    await H.sleep(800);
    await nh.click('#btn-team-start');
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 90000 })));
    await Promise.all(ps.map(p => H.booth(p, 1)));
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 60000)));
    const ownerSeesStart = await host.evaluate(() => !!document.getElementById('btn-duel-play-start').offsetParent);
    await nh.waitForFunction(() => { const e = document.getElementById('btn-duel-play-start'); return e && e.offsetParent; }, null, { timeout: 60000 });
    await nh.click('#btn-duel-play-start');
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-duel-vote', 120000)));
    for (const p of ps) {
      for (const r of await p.$$('#team-vote-rows .raterow')) { const s = await r.$('.starbtn[data-n="5"]'); if (s) await s.click(); }
      await p.click('#btn-team-vote-submit');
    }
    await Promise.all(ps.map(p => p.waitForFunction(() => document.getElementById('duel-result').textContent.trim().length > 0, null, { timeout: 30000 })));
    const backVisible = await nh.evaluate(() => !!document.getElementById('btn-duel-back').offsetParent);
    await nh.click('#btn-duel-back');
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-lobby', 20000)));
    return { res: (await nh.textContent('#duel-result')).replace(/\s+/g, ' ').trim(), newHostSeesBack: backVisible, ownerSeesStart };
  });
  // Weitergegebener Host führt ein Match über 2 Runden bis zum Finale
  await scenario('matchhandoff', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    const g1id = await ps[1].evaluate(() => myId);
    await host.click(`.host-btn[data-hostgive="${g1id}"]`);
    await host.click('#btn-leave-confirm');
    const nh = ps[1];
    await nh.waitForFunction(() => iAmLogicalHost(), null, { timeout: 20000 });
    await nh.evaluate(async () => { await loadSceneList(); });
    await host.evaluate(() => { sceneList = sceneList.filter(s => (s.approxDur || 99) <= 16 && (s.roles || []).length <= 3); });
    await H.setMode(nh, 'rounds');
    await nh.selectOption('#set-rounds', '2');
    await H.sleep(800);
    await H.hostStart(nh, '#btn-start');
    const out = [];
    for (let r = 1; r <= 2; r++) {
      await Promise.all(ps.map(p => p.waitForFunction(() => scene && document.getElementById('scene-card').style.display !== 'none', null, { timeout: 60000 })));
      await Promise.all(ps.map(p => H.ready(p)));
      await H.hostStart(nh, '#btn-go-round');
      await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 120000 })));
      await Promise.all(ps.map(p => H.booth(p, 1)));
      await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 90000)));
      await nh.waitForFunction(() => { const e = document.getElementById('btn-prem-start'); return e && e.offsetParent && !e.disabled; }, null, { timeout: 90000 });
      await nh.click('#btn-prem-start');
      await Promise.all(ps.map(p => H.rateAll(p, 4)));
      await nh.waitForFunction(() => document.getElementById('rate-result').textContent.trim().length > 0, null, { timeout: 60000 });
      out.push('ownerSeesNext=' + await host.evaluate(() => !!document.getElementById('btn-next-round').offsetParent));
      await nh.waitForSelector('#btn-next-round', { state: 'visible', timeout: 30000 });
      await nh.click('#btn-next-round');
    }
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-final', 60000)));
    out.push('round=' + await host.evaluate(() => match.round));
    return out;
  });
  await scenario('pack', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    await host.click('#pack-mode');
    await Promise.all(ps.map(p => p.waitForSelector('#pack-card', { state: 'visible', timeout: 15000 })));
    for (const p of ps) await p.setInputFiles('#pack-file', path.join(H.ASSETS, 'pack_mp4.zip'));
    await Promise.all(ps.map(p => p.waitForFunction(() => /✅/.test(document.getElementById('pack-status').textContent), null, { timeout: 30000 })));
    await host.waitForFunction(() => scene && scene.lines && scene.lines.length, null, { timeout: 20000 });
    const speakers = await host.evaluate(() => players.filter(p => p.role != null).map(p => p.id));
    for (const p of ps) { const id = await p.evaluate(() => myId); if (speakers.includes(id)) await H.ready(p); }
    await H.hostStart(host);
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 60000 })));
    await Promise.all(ps.map(p => H.booth(p, 2)));
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 90000)));
    await host.waitForFunction(() => { const e = document.getElementById('btn-prem-start'); return e && e.offsetParent && !e.disabled; }, null, { timeout: 90000 });
    await host.click('#btn-prem-start');
    // Nur ein Sprecher → keine Sterne-Runde (Absicht) — auf das Premieren-Ende warten
    await host.waitForFunction(() => /Premiere|premiere|rating|Bewertung/.test(document.getElementById('play-status').textContent) && document.getElementById('play-video').ended, null, { timeout: 90000 }).catch(() => {});
    const endStatus = await host.textContent('#play-status');
    return { status: await ps[1].textContent('#pack-status'), endStatus, ach: await Promise.all(ps.map(H.achOf)) };
  });
  await scenario('packogv', async (b, reg) => {
    const p = await H.newPlayer(b, 'solo'); reg([p]);
    await H.onboard(p, 'Solo');
    await H.createRoom(p);
    await p.click('#pack-mode');
    await p.setInputFiles('#pack-file', path.join(H.ASSETS, 'pack_ogv.zip'));
    await p.waitForFunction(() => /Chrome/.test(document.getElementById('pack-status').textContent), null, { timeout: 20000 });
    return (await p.textContent('#pack-status')).replace(/\s+/g, ' ');
  });
  await scenario('blind', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    await host.check('#blind-mode');
    await freeRound(ps, host, 'ghostseven', [0, 1]);
    const blindBooth = await ps[1].evaluate(() => ({ blind: scene.blind, origBtn: (document.getElementById('btn-line-orig') || {}).disabled }));
    const res = await H.playNormalRound(ps, host);
    return { blindBooth, res, ach: await H.achOf(ps[1]) };
  });
  await scenario('daily', async (b, reg) => {
    const { ps, host } = await H.room(b, 2, { shortOnly: false }); reg(ps);
    await host.waitForSelector('#btn-daily-load', { state: 'visible', timeout: 20000 });
    const want = await host.evaluate(() => sceneOfTheDay().id);
    await host.click('#btn-daily-load');
    await ps[1].waitForFunction(() => scene && scene.id, null, { timeout: 30000 });
    const got = await ps[1].evaluate(() => scene.id);
    const badge = await host.evaluate(() => !!document.querySelector('#scene-grid .st-daily'));
    return { want, got, same: want === got, badgeInGrid: badge };
  });
  await scenario('latejoin', async (b, reg) => {
    const { ps, host, code } = await H.room(b, 2); reg(ps);
    await freeRound(ps, host, 'ghostseven', [0, 1]);
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-booth', 60000)));
    const late = await H.newPlayer(b, 'Late'); await H.onboard(late, 'Spaet');
    await H.joinRoom(late, code).catch(() => {});
    const all = [...ps, late]; reg(all);
    await H.sleep(3000);
    const lateScreen = await H.screen(late);
    const res = await H.playNormalRound(all, host);
    return { lateScreen, res };
  });
  await scenario('kick', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    const id2 = await ps[2].evaluate(() => myId);
    await host.click(`.kick-btn[data-kick="${id2}"]`);
    await host.click('#btn-leave-confirm');
    await ps[2].waitForFunction(() => document.querySelector('.screen.active')?.id === 'scr-start', null, { timeout: 20000 });
    await host.waitForFunction(() => players.length === 2, null, { timeout: 10000 });
    return { kickedMsg: await ps[2].textContent('#start-status'), left: await host.evaluate(() => players.map(p => p.name)) };
  });
  await scenario('drop', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    await freeRound(ps, host, 'ghostseven', [0, 1]);
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-booth', 60000)));
    // Gast: 1 Zeile aufnehmen, dann Verbindung kappt (kein absichtliches Verlassen)
    await ps[1].evaluate(() => { try { hostConn.close(); } catch (e) {} });
    await host.waitForFunction(() => players.some(p => p.offline), null, { timeout: 20000 }).catch(() => {});
    const sawOffline = await host.evaluate(() => players.some(p => p.offline));
    await ps[1].waitForFunction(() => hostConn && hostConn.open, null, { timeout: 60000 });
    await host.waitForFunction(() => players.length === 2 && !players.some(p => p.offline), null, { timeout: 30000 });
    const guestScreen = await H.screen(ps[1]);
    const res = await H.playNormalRound(ps, host);
    return { sawOffline, guestScreenAfterReconnect: guestScreen, res };
  });
  await scenario('ownvideo', async (b, reg) => {
    const { ps, host } = await H.room(b, 2); reg(ps);
    await host.setInputFiles('#file-video', path.join(H.ASSETS, 'test.webm'));
    await host.waitForSelector('#local-cfg', { state: 'visible', timeout: 15000 });
    await host.click('#btn-use-local');
    await ps[1].waitForFunction(() => scene && myVideoReady, null, { timeout: 60000 });
    await H.pickRole(host, 1); await H.pickRole(ps[1], 2);
    await H.ready(host); await H.ready(ps[1]);
    await H.hostStart(host);
    await Promise.all(ps.map(p => p.waitForFunction(() => ['scr-record', 'scr-booth', 'scr-wait'].includes(document.querySelector('.screen.active')?.id), null, { timeout: 60000 })));
    const scr = await Promise.all(ps.map(H.screen));
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 90000)));
    await host.waitForFunction(() => { const e = document.getElementById('btn-prem-start'); return e && e.offsetParent && !e.disabled; }, null, { timeout: 90000 });
    await host.click('#btn-prem-start');
    await Promise.all(ps.map(p => H.rateAll(p)));
    await host.waitForFunction(() => document.getElementById('rate-result').textContent.trim().length > 0, null, { timeout: 90000 });
    return { screens: scr, res: (await host.textContent('#rate-result')).replace(/\s+/g, ' ').trim() };
  });
  await scenario('ttt', async (b, reg) => {
    const { ps, host } = await H.room(b, 3); reg(ps);
    await H.hostLoadScene(host, 'ghostseven');
    await ps[1].waitForFunction(() => scene && scene.id, null, { timeout: 20000 });
    await H.pickRole(host, 0); await H.ready(host);
    await H.hostStart(host);
    await Promise.all([H.waitScreen(ps[1], 'scr-wait', 60000), H.waitScreen(ps[2], 'scr-wait', 60000)]);
    await ps[1].click('#btn-ttt-join'); await H.sleep(400);
    await ps[2].click('#btn-ttt-join'); await H.sleep(600);
    const move = async (p, i) => { await p.waitForSelector(`#ttt-board .tttcell[data-i="${i}"]:not([disabled])`, { timeout: 10000 }); await p.click(`#ttt-board .tttcell[data-i="${i}"]`); await H.sleep(500); };
    await move(ps[1], 0); await move(ps[2], 3); await move(ps[1], 1); await move(ps[2], 4); await move(ps[1], 2);
    const info = await ps[2].textContent('#ttt-info');
    // O versucht nach Xs Sieg trotzdem zu ziehen (früher möglich)
    await ps[2].evaluate(() => tttAction({ k: 'move', i: 5 }));
    await ps[2].evaluate(() => tttAction({ k: 'move', i: 99 }));
    await H.sleep(800);
    const board = await host.evaluate(() => ({ board: ttt.board.join(','), len: ttt.board.length, winner: ttt.winner, wins: JSON.stringify(mgWins) }));
    const ach = await H.achOf(ps[1]);
    // Klick-Battle kurz anstoßen
    await ps[1].click('#btn-cb-start').catch(() => {});
    await H.sleep(1500);
    // Host beendet seine Aufnahme → Premiere ohne Bewertung (nur 1 Sprecher)
    await H.booth(host, 1);
    await Promise.all(ps.map(p => H.waitScreen(p, 'scr-playback', 60000)));
    return { info, board, ach };
  });
  console.log('SUMMARY', results.map(r => r.name + ':' + (r.ok ? 'OK' : 'FAIL')).join(' '));
  process.exit(0);
})();
