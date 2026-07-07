// In-match HUD. Redesigned from the classic "giant corner bars" layout:
//  - your health: slim bar bottom-center, near your hands
//  - enemy health: floats over each enemy's head in the world + compact chips top-right
//  - spellbook: bottom-right card grid with glyphs, cooldown sweeps, live-guess highlight
//  - events: fading ticker top-left; speech bubbles over AI heads; damage floaters in-world

import * as THREE from 'three';
import { SPELLS, SPELL_ORDER } from './spells.js';
import { clamp, fmtTime } from './utils.js';

const $ = (id) => document.getElementById(id);

export function createHUD(world) {
  const H = { isDrawing: false };
  const els = {
    hud: $('hud'), timer: $('timerchip'), mode: $('modechip'), pips: $('roundpips'),
    ticker: $('ticker'), enemies: $('enemies'), hpfill: $('hpfill'), hpnum: $('hpnum'),
    spellcard: $('spellcard'), guess: $('guesschip'), crosshair: $('crosshair'),
    floaters: $('floaters'), announce: $('announce'), vignette: $('vignette'),
    healglow: $('healglow'), flash: $('flash'), hint: $('hint'), statusrow: $('statusrow'),
    heart: $('hpheart'),
  };

  const cards = {};
  const bubbles = [];
  let hintTime = 26, castCount = 0;
  let vign = 0, flashV = 0;
  const _v = new THREE.Vector3();

  function buildSpellCard() {
    els.spellcard.innerHTML = '';
    for (const id of SPELL_ORDER) {
      const s = SPELLS[id];
      const d = document.createElement('div');
      d.className = 'spell';
      d.innerHTML = `<svg viewBox="0 0 24 24"><path d="${s.icon}" style="stroke:${s.css}"/></svg><span class="sname">${s.name}</span><div class="cd"></div>`;
      els.spellcard.appendChild(d);
      cards[id] = { root: d, cd: d.querySelector('.cd') };
    }
  }

  H.show = () => { els.hud.classList.remove('hidden'); };
  H.hide = () => { els.hud.classList.add('hidden'); };

  H.bindMatch = () => {
    buildSpellCard();
    els.ticker.innerHTML = '';
    els.floaters.innerHTML = '';
    els.announce.innerHTML = '';
    els.enemies.innerHTML = '';
    els.statusrow.innerHTML = '';
    bubbles.length = 0;
    hintTime = 26; castCount = 0;
    els.hint.style.opacity = 1;
    for (const w of world.wizards) w.hudEl = null;
  };

  // ---------- world→screen ----------
  function project(pos3) {
    _v.copy(pos3).project(world.camera);
    if (_v.z > 1 || _v.z < -1) return null;
    return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight };
  }

  // ---------- pieces ----------
  H.ticker = (text, color = '#f2e9d8') => {
    const d = document.createElement('div');
    d.className = 'tick';
    d.textContent = text;
    d.style.color = color;
    els.ticker.prepend(d);
    requestAnimationFrame(() => d.classList.add('show'));
    while (els.ticker.children.length > 5) els.ticker.lastChild.remove();
    setTimeout(() => d.classList.add('fade'), 2600);
    setTimeout(() => d.remove(), 3700);
  };

  H.damageFloater = (pos3, amount, kind) => {
    const p = project(pos3);
    if (!p) return;
    const d = document.createElement('div');
    d.className = 'dmg';
    const colors = { fire: '#ff9d4d', zap: '#ffe66a', heavy: '#e8d9c2', heal: '#8fe08a', impact: '#c08bff' };
    d.style.color = colors[kind] || '#ffffff';
    d.textContent = kind === 'heal' ? `+${amount}` : `−${amount}`;
    d.style.left = `${p.x + (Math.random() - 0.5) * 30}px`;
    d.style.top = `${p.y - 10}px`;
    els.floaters.appendChild(d);
    setTimeout(() => d.remove(), 950);
  };

  H.speech = (wizard, text) => {
    const d = document.createElement('div');
    d.className = 'bubble';
    d.textContent = text;
    els.floaters.appendChild(d);
    bubbles.push({ el: d, wizard, t: 3 });
  };

  H.onCast = (spellId) => {
    const c = cards[spellId];
    if (c) { c.root.classList.remove('cast'); void c.root.offsetWidth; c.root.classList.add('cast'); }
    castCount++;
    world.stats.casts++;
  };

  H.denied = (spellId, reason) => {
    const c = cards[spellId];
    if (c) { c.root.classList.remove('denied'); void c.root.offsetWidth; c.root.classList.add('denied'); }
    H.ticker(reason === 'cooldown' ? `${SPELLS[spellId].name} is still recharging` : 'cannot cast yet', '#c9bfae');
  };

  H.setGuess = (spellId, score = 0) => {
    if (!spellId) {
      els.guess.classList.remove('on');
      for (const id in cards) cards[id].root.classList.remove('guess');
      return;
    }
    const s = SPELLS[spellId];
    els.guess.classList.add('on');
    els.guess.querySelector('path').setAttribute('d', s.icon);
    els.guess.querySelector('path').style.stroke = s.css;
    els.guess.querySelector('span').textContent = score > 0.68 ? s.name : `${s.name}?`;
    for (const id in cards) cards[id].root.classList.toggle('guess', id === spellId);
  };

  H.setDrawing = (on) => { H.isDrawing = on; if (!on) H.setGuess(null); };
  H.setCrosshairDrawing = (on) => els.crosshair.classList.toggle('drawing', on);

  H.announce = (big, sub = '', ms = 1600) => {
    els.announce.innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
    clearTimeout(H._annT);
    if (ms > 0) H._annT = setTimeout(() => { els.announce.innerHTML = ''; }, ms);
  };

  H.hurtFlash = () => { vign = Math.min(vign + 0.5, 1); };
  H.flash = (v) => { flashV = Math.max(flashV, v); };

  H.setModeChip = (text) => { els.mode.textContent = text; };
  H.setPips = (mine, theirs, need) => {
    let s = '';
    for (let i = 0; i < need; i++) s += i < mine ? '★' : '☆';
    s += ' · ';
    for (let i = 0; i < need; i++) s += i < theirs ? '★' : '☆';
    els.pips.textContent = need > 0 ? s : '';
  };

  function enemyChip(w) {
    const d = document.createElement('div');
    d.className = 'foechip chip';
    d.innerHTML = `<div class="dot" style="background:${w.cssColor || '#ff6a5e'}"></div><span class="fname">${w.name}</span><div class="fbar"><i></i></div>`;
    els.enemies.appendChild(d);
    return { root: d, bar: d.querySelector('i') };
  }

  // ---------- per-frame ----------
  H.update = (dt, rdt) => {
    const me = world.localWizard;
    // my hp
    if (me) {
      const f = clamp(me.hp / me.maxHp, 0, 1);
      els.hpfill.style.width = `${f * 100}%`;
      els.hpfill.classList.toggle('low', f < 0.3);
      els.hpnum.textContent = `${Math.ceil(me.hp)} / ${me.maxHp}`;
      els.heart.textContent = f < 0.3 ? '💔' : '🩵';
      // status icons
      let st = '';
      if (me.shield) st += `<div class="statusico" title="shielded">🛡</div>`;
      if (me.burning) st += `<div class="statusico" title="burning">🔥</div>`;
      if (me.channel) st += `<div class="statusico" title="mending">💚</div>`;
      if (els.statusrow._last !== st) { els.statusrow.innerHTML = st; els.statusrow._last = st; }
    }
    // timer
    els.timer.textContent = fmtTime(world.roundTimer ?? 0);
    els.timer.classList.toggle('urgent', (world.roundTimer ?? 999) < 20);

    // cooldown sweeps
    if (me) {
      for (const id in cards) {
        const cd = me.cooldowns[id] || 0;
        const frac = cd > 0 ? clamp(cd / SPELLS[id].cooldown, 0, 1) : 0;
        cards[id].cd.style.setProperty('--a', `${(1 - frac) * 360}deg`);
      }
    }

    // enemy chips & overhead bars
    for (const w of world.wizards) {
      if (w.isLocal) continue;
      const isEnemy = me ? world.enemiesOf(me).includes(w) : true;
      if (!w.hudEl) {
        const root = document.createElement('div');
        root.className = 'overhead';
        root.innerHTML = `<div class="oname">${w.name}</div><div class="obar"><i class="${isEnemy ? '' : 'ally'}"></i></div>`;
        els.floaters.appendChild(root);
        w.hudEl = { root, bar: root.querySelector('i'), chip: isEnemy ? enemyChip(w) : null };
      }
      const f = clamp(w.hp / w.maxHp, 0, 1);
      if (w.hudEl.chip) {
        w.hudEl.chip.bar.style.width = `${f * 100}%`;
        w.hudEl.chip.root.style.opacity = w.alive ? 1 : 0.35;
      }
      const p = w.alive ? project(_v.set(w.pos.x, w.pos.y + 2.7, w.pos.z)) : null;
      if (p) {
        w.hudEl.root.style.opacity = 1;
        w.hudEl.root.style.left = `${p.x}px`;
        w.hudEl.root.style.top = `${p.y}px`;
        w.hudEl.bar.style.width = `${f * 100}%`;
      } else {
        w.hudEl.root.style.opacity = 0;
      }
    }

    // speech bubbles
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.t -= rdt;
      const p = b.wizard.alive || b.t > 2.4 ? project(_v.set(b.wizard.pos.x, b.wizard.pos.y + 3.3, b.wizard.pos.z)) : null;
      if (b.t <= 0 || !p) { b.el.remove(); bubbles.splice(i, 1); continue; }
      b.el.style.left = `${p.x}px`;
      b.el.style.top = `${p.y}px`;
      b.el.style.opacity = Math.min(b.t / 0.4, 1);
    }

    // screen fx
    vign = Math.max(0, vign - rdt * 1.4);
    const lowHp = me && me.alive && me.hp / me.maxHp < 0.28 ? 0.4 + Math.sin(world.time * 4) * 0.1 : 0;
    els.vignette.style.opacity = Math.max(vign, lowHp);
    flashV = Math.max(0, flashV - rdt * 3.5);
    els.flash.style.opacity = flashV * 0.6;
    els.healglow.style.opacity = me && me.channel ? 0.8 : 0;

    // fade the controls hint
    if (hintTime > 0) {
      hintTime -= rdt;
      if (hintTime <= 0 || castCount >= 4) { els.hint.style.opacity = 0; hintTime = 0; }
    }
  };

  H.clearWizardUI = (w) => {
    if (w.hudEl) {
      w.hudEl.root.remove();
      w.hudEl.chip?.root.remove();
      w.hudEl = null;
    }
  };

  return H;
}
