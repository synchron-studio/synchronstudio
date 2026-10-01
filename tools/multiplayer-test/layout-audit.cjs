// Läuft im Browser: Layout-Probleme der aktuell sichtbaren Ansicht sammeln
module.exports = () => {
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  const path = (el) => { const parts = []; while (el && el !== document.body && parts.length < 4) { parts.unshift(el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '')); if (el.id) break; el = el.parentElement; } return parts.join('>'); };
  // in einem horizontal scrollenden / abschneidenden Container? dann ok
  const clipped = (el) => { let p = el.parentElement; while (p && p !== document.body) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) return true; p = p.parentElement; } return false; };
  const out = { coarse: matchMedia('(pointer:coarse)').matches, vw, docScrollW: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > vw + 1, offenders: [], smallTargets: [], zoomInputs: [], textClipped: [] };
  const all = [...document.querySelectorAll('body *')].filter(el => !['SCRIPT', 'STYLE', 'svg', 'path', 'OPTION'].includes(el.tagName));
  for (const el of all) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((r.right > vw + 2 || r.left < -2) && cs.position !== 'fixed' && !clipped(el) && r.width < vw * 3) out.offenders.push(path(el) + ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
    if (el.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button]') && !el.disabled) {
      if ((r.height < 36 || r.width < 36) && !(el.type === 'checkbox' || el.type === 'radio' || el.type === 'range')) out.smallTargets.push(path(el) + ` ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.value || '').trim().slice(0, 14)}"`);
    }
    if (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), select, textarea') && parseFloat(cs.fontSize) < 16) out.zoomInputs.push(path(el) + ' ' + cs.fontSize);
    if (el.children.length === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none') out.textClipped.push(path(el) + ' "' + el.textContent.trim().slice(0, 20) + '"');
  }
  for (const k of ['offenders', 'smallTargets', 'zoomInputs', 'textClipped']) { out[k + 'N'] = out[k].length; out[k] = [...new Set(out[k])].slice(0, 12); }
  return out;
};
