// Boot: settings, audio, menus, multiplayer flow, pause/pointer-lock glue.

import { createAudio } from './audio.js';
import { createGame } from './game.js';
import { createNet } from './net.js';
import { SPELLS, SPELL_ORDER } from './spells.js';
import { randomCode } from './utils.js';

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const settings = Object.assign(
  { sens: 1, vol: 0.6, shake: 1, name: '' },
  JSON.parse(localStorage.getItem('wzd-settings') || '{}'),
);
const saveSettings = () => localStorage.setItem('wzd-settings', JSON.stringify(settings));

const audio = createAudio();
audio.setVolume(settings.vol);

const game = createGame({ audio, settings });
window.__wd = { game, settings };

// ---------- menu plumbing ----------
const panels = ['home', 'mp', 'wait', 'howto', 'settings', 'pause', 'end', 'resume'];
function showPanel(name) {
  const menu = $('menu');
  if (!name) { menu.classList.add('hidden'); return; }
  menu.classList.remove('hidden');
  for (const p of panels) $(`panel-${p}`).classList.toggle('hidden', p !== name);
}

let net = null;         // pending or active connection
let inMatch = false;

function killNet() {
  if (net) { net.dispose(); net = null; }
}

function toMenu() {
  inMatch = false;
  killNet();
  game.quitToMenu();
  $('hud').classList.add('hidden');
  showPanel('home');
}

// ---------- home ----------
$('btn-solo').onclick = () => { audio.uiClick(); startSolo(0); };
$('btn-mp').onclick = () => { audio.uiClick(); $('mp-name').value = settings.name; showPanel('mp'); };
$('btn-howto').onclick = () => { audio.uiClick(); fillHowto(); showPanel('howto'); };
$('btn-settings').onclick = () => { audio.uiClick(); syncSettingsUI(); showPanel('settings'); };
$('btn-howto-back').onclick = () => showPanel('home');
$('btn-settings-back').onclick = () => { saveSettings(); showPanel('home'); };
$('btn-mp-back').onclick = () => { killNet(); showPanel('home'); };
$('btn-wait-back').onclick = () => { killNet(); showPanel('mp'); };

function startSolo(idx) {
  inMatch = true;
  showPanel(null);
  game.startSolo(idx);
}

// ---------- how to play ----------
function fillHowto() {
  const tbl = $('howto-glyphs');
  if (tbl.children.length) return;
  tbl.innerHTML = SPELL_ORDER.map((id) => {
    const s = SPELLS[id];
    return `<tr><td><svg viewBox="0 0 24 24"><path d="${s.icon}" style="stroke:${s.css}"/></svg></td>
      <td class="cname">${s.name}</td><td class="cdesc">${s.desc}</td></tr>`;
  }).join('');
}

// ---------- settings ----------
function syncSettingsUI() {
  $('set-sens').value = settings.sens;
  $('set-vol').value = settings.vol;
  $('set-shake').value = settings.shake;
  updateSettingLabels();
}
function updateSettingLabels() {
  $('set-sens-v').textContent = `×${(+settings.sens).toFixed(2)}`;
  $('set-vol-v').textContent = `${Math.round(settings.vol * 100)}%`;
  $('set-shake-v').textContent = settings.shake <= 0 ? 'off' : `×${(+settings.shake).toFixed(1)}`;
}
$('set-sens').oninput = (e) => { settings.sens = +e.target.value; updateSettingLabels(); };
$('set-vol').oninput = (e) => { settings.vol = +e.target.value; audio.setVolume(settings.vol); updateSettingLabels(); };
$('set-shake').oninput = (e) => { settings.shake = +e.target.value; updateSettingLabels(); };

// ---------- multiplayer ----------
function grabName() {
  settings.name = ($('mp-name').value || '').trim().slice(0, 12) || `Wizard${Math.floor(Math.random() * 90 + 10)}`;
  saveSettings();
  return settings.name;
}

function host(mode) {
  const name = grabName();
  killNet();
  $('mp-err').textContent = '';
  const code = randomCode(4);
  $('room-code').textContent = code;
  $('wait-title').textContent = mode === 'coop' ? 'Co-op circle open' : 'Duel circle open';
  showPanel('wait');
  net = createNet({
    role: 'host', code, mode, name,
    onReady: (cfg) => beginNetMatch('host', cfg),
    onPeerLeft: handlePeerLeft,
    onError: (e) => { $('mp-err').textContent = e; showPanel('mp'); killNet(); },
  });
}
$('btn-host-duel').onclick = () => { audio.uiClick(); host('duel'); };
$('btn-host-coop').onclick = () => { audio.uiClick(); host('coop'); };

$('btn-copy').onclick = () => {
  navigator.clipboard?.writeText($('room-code').textContent);
  $('btn-copy').textContent = 'Copied!';
  setTimeout(() => { $('btn-copy').textContent = 'Copy code'; }, 1200);
};

$('btn-join').onclick = () => {
  audio.uiClick();
  const code = ($('mp-code').value || '').trim().toUpperCase();
  if (code.length < 3) { $('mp-err').textContent = 'Enter the room rune first.'; return; }
  const name = grabName();
  killNet();
  $('mp-err').textContent = 'Seeking the circle…';
  net = createNet({
    role: 'guest', code, mode: null, name,
    onReady: (cfg) => beginNetMatch('guest', cfg),
    onPeerLeft: handlePeerLeft,
    onError: (e) => { $('mp-err').textContent = e; },
  });
};

function beginNetMatch(role, cfg) {
  inMatch = true;
  $('mp-err').textContent = '';
  showPanel(null);
  game.startNetMatch({ role, net, seed: cfg.seed, mode: cfg.mode || cfg.m || net.mode || 'duel', hostName: cfg.hostName, guestName: cfg.guestName });
}

function handlePeerLeft() {
  if (!inMatch) { $('mp-err').textContent = 'The other wizard vanished.'; showPanel('mp'); return; }
  inMatch = false;
  document.exitPointerLock?.();
  $('end-title').textContent = 'They vanished!';
  $('end-stats').textContent = 'Your rival\'s connection dissolved into mist.';
  for (const b of ['btn-next', 'btn-retry', 'btn-rematch']) $(b).classList.add('hidden');
  showPanel('end');
  killNet();
}

// ---------- match end ----------
game.onMatchEnd = (info) => {
  inMatch = false;
  $('end-title').textContent = info.ladderComplete ? 'THE CIRCLE IS BROKEN' : info.title;
  const st = info.stats;
  const lines = [];
  if (info.sub) lines.push(info.sub);
  lines.push(`glyphs cast: ${st.casts} · feints: ${st.feints}`);
  lines.push(`rocks smashed: ${st.rocks} · trees felled: ${st.trees} · banners burned: ${st.banners}`);
  lines.push(`reflects: ${st.reflects} · interrupts: ${st.interrupts} · shields shattered: ${st.shatters} · wizards yeeted: ${st.yeets}`);
  if (info.ladderComplete) lines.unshift('Every master of the Circle lies defeated. The meadow is yours (what\'s left of it).');
  $('end-stats').innerHTML = lines.join('<br>');
  $('btn-next').classList.toggle('hidden', !info.canNext);
  $('btn-retry').classList.toggle('hidden', !info.canRetry);
  $('btn-rematch').classList.toggle('hidden', !(info.canRematch && net && net.role === 'host'));
  showPanel('end');
};

$('btn-next').onclick = () => { audio.uiClick(); startSolo(game.ladderIndex + 1); };
$('btn-retry').onclick = () => { audio.uiClick(); startSolo(game.ladderIndex); };
$('btn-rematch').onclick = () => {
  audio.uiClick();
  inMatch = true;
  showPanel(null);
  game.rematch();
};
$('btn-end-menu').onclick = () => { audio.uiClick(); toMenu(); };

// ---------- pause / pointer lock ----------
$('btn-resume').onclick = () => resumeMatch();
$('btn-quit').onclick = () => toMenu();
$('btn-recapture').onclick = () => resumeMatch();
$('btn-recapture-quit').onclick = () => toMenu();

function resumeMatch() {
  showPanel(null);
  if (game.world) game.world.paused = false;
  game.world?.renderer.domElement.requestPointerLock?.();
}

document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  if (!inMatch) return;
  const world = game.world;
  if (!world) return;
  if (!locked && (world.phase === 'fight' || world.phase === 'countdown' || world.phase === 'wavebreak')) {
    if (!world.net) {
      world.paused = true;
      showPanel('pause');
    } else {
      showPanel('resume'); // can't pause a live opponent — just offer recapture
    }
  } else if (locked) {
    world.paused = false;
    showPanel(null);
  }
});

// keep the guest's "rematch pending" state sane: if host rematches, the world
// swap happens inside game.js; make sure our menu is hidden when it does.
const _origStart = game.startNetMatch.bind(game);
game.startNetMatch = (cfg) => { inMatch = true; showPanel(null); _origStart(cfg); };

// ---------- boot ----------
game.startAttract();
showPanel('home');

// dev harness: ?autotest runs headless checks against the real systems
if (location.search.includes('autotest')) {
  import('./autotest.js').then((m) => m.runAutotest(game, settings));
}
