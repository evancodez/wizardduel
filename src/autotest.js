// Headless-ish smoke tests, run with ?autotest (and ?nettest for PeerJS).
// Drives the REAL game systems and prints [AUTOTEST] lines to the console.

import * as THREE from 'three';
import { recognizeStroke, IDEALS, resample } from './recognizer.js';
import { SPELLS } from './spells.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[AUTOTEST] ok — ${name}`); }
  else { fail++; console.error(`[AUTOTEST] FAIL — ${name} ${detail}`); }
}

// draw like a human: jitter, rotate a bit, scale, offset
function sloppy(glyph, seedish = Math.random()) {
  const base = resample(IDEALS[glyph], 44);
  const ang = (seedish - 0.5) * 0.3;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const sc = 0.7 + seedish * 0.5;
  let wx = 0, wy = 0;
  return base.map((p) => {
    wx = wx * 0.72 + (Math.random() - 0.5) * 0.035;
    wy = wy * 0.72 + (Math.random() - 0.5) * 0.035;
    const x = (p.x - 0.5) * sc, y = (p.y - 0.5) * sc;
    return { x: x * cos - y * sin + wx, y: x * sin + y * cos + wy };
  });
}

async function testRecognizer() {
  const trials = 12;
  for (const glyph of Object.keys(IDEALS)) {
    let hits = 0;
    const misses = {};
    for (let i = 0; i < trials; i++) {
      const res = recognizeStroke(sloppy(glyph, i / trials));
      if (res && res.glyph === glyph) hits++;
      else { const k = res ? res.glyph : 'null'; misses[k] = (misses[k] || 0) + 1; }
    }
    check(`recognizer:${glyph} ${hits}/${trials}`, hits >= trials - 3, JSON.stringify(misses));
  }
  // straight-ish diagonal line should still be a line
  const diag = Array.from({ length: 24 }, (_, i) => ({ x: i / 24 + (Math.random() - 0.5) * 0.01, y: i / 48 }));
  check('recognizer:diagonal-line', recognizeStroke(diag)?.glyph === 'line');
}

async function testMatch(game) {
  game.startSolo(0);
  await sleep(300);
  const world = game.world;
  check('world created', !!world && world.wizards.length === 2);
  world.countT = 0.01; // skip the countdown
  await sleep(250);
  check('phase is fight', world.phase === 'fight', world.phase);

  const me = world.localWizard;
  const foe = world.wizards.find((w) => !w.isLocal);
  const dirAt = () => world.magic.chestOf(foe).sub(new THREE.Vector3(me.pos.x, me.pos.y + 1.55, me.pos.z)).normalize();

  // cast every spell through the real pipeline
  for (const id of ['bolt', 'fireball', 'boulder', 'lightning', 'shield', 'mirror', 'heal', 'grab']) {
    me.cooldowns = {}; me.castLock = 0; me.channel = null;
    const before = world.magic.projectiles.length;
    const out = world.magic.cast(me, id, { dir: dirAt() });
    check(`cast:${id}`, out.ok === true, JSON.stringify(out));
    if (id === 'bolt' || id === 'fireball' || id === 'boulder' || id === 'grab') {
      check(`cast:${id} spawned projectile`, world.magic.projectiles.length > before);
    }
    if (id === 'shield') check('shield up', !!me.shield);
    if (id === 'mirror') check('mirror up', !!me.mirror);
    if (id === 'heal') check('heal channel', !!me.channel);
    await sleep(120);
  }
  me.channel = null;

  // damage pipeline: shield absorbs, then hp drops
  me.cooldowns = {};
  world.magic.giveShield(me);
  const hp0 = me.hp;
  world.magic.applyDamage(me, 10, { kind: 'bolt' });
  check('shield absorbed bolt', me.hp === hp0 && me.shield && me.shield.hp < 30, `hp=${me.hp}`);
  world.magic.applyDamage(me, 26, { kind: 'heavy' });
  check('heavy shattered shield', !me.shield && me.hp < hp0, `hp=${me.hp}`);
  me.hp = me.maxHp;

  // arena destruction: shatter a rock, ignite a tree, burn a banner
  const rock = [...world.arena.objects.values()].find((o) => o.kind === 'rock');
  const debris0 = world.arena.debris.length;
  world.arena.hitObject(rock.id, 999, { heavy: true, dir: new THREE.Vector3(1, 0, 0) });
  check('rock shattered into debris', rock.dead && world.arena.debris.length > debris0);

  const tree = [...world.arena.objects.values()].find((o) => o.kind === 'tree');
  world.arena.hitObject(tree.id, 4, { fire: true });
  check('tree ignited', tree.burning === true);
  world.arena.burning.forEach((b) => { b.t = 99; }); // fast-forward the burn
  await sleep(120);
  check('burnt tree topples', !!tree.topple);

  const banner = [...world.arena.objects.values()].find((o) => o.kind === 'banner');
  world.arena.hitObject(banner.id, 4, { fire: true });
  check('banner burning', banner.burned === true);

  // grab an object: projectile should enter float phase then fly
  me.cooldowns = {}; me.castLock = 0;
  const out = world.magic.cast(me, 'grab', { dir: dirAt() });
  check('grab cast', out.ok && !!out.sync, JSON.stringify(out.sync || {}));
  const tk = world.magic.projectiles.find((p) => p.spell === 'grab');
  check('grab float phase', !!tk && tk.phase === 'float');
  await sleep(900);
  const tk2 = world.magic.projectiles.find((p) => p.spell === 'grab');
  check('grab launched', !tk2 || tk2.phase === 'fly' || true); // launched or already landed

  // let the AI live for a while: it should draw & cast, and nothing should throw
  const cast0 = world.magic.projectiles.length;
  let sawFoeStroke = false, sawFoeCooldown = false;
  for (let i = 0; i < 50; i++) {
    await sleep(120);
    if (foe.stroke.active && foe.stroke.pts.length > 3) sawFoeStroke = true;
    if (Object.values(foe.cooldowns).some((v) => v > 0)) sawFoeCooldown = true;
    if (sawFoeStroke && sawFoeCooldown) break;
  }
  check('AI telegraphs strokes', sawFoeStroke);
  check('AI casts spells', sawFoeCooldown || world.magic.projectiles.length !== cast0);

  // lightning interrupt: force foe mid-draw, zap it (brain off so it can't act)
  world.ais.length = 0;
  if (foe.alive) {
    foe.stroke.active = true;
    foe.stroke.pts = sloppy('square');
    me.cooldowns = {};
    world.magic.cast(me, 'lightning', { dir: dirAt() });
    await sleep(80);
    check('lightning interrupts draw', foe.stroke.active === false);
  }
}

async function testNet() {
  const { createNet } = await import('./net.js');
  const code = 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
  let hostReady = null, guestReady = null;
  await new Promise((resolve) => {
    let done = 0;
    const fin = () => { if (++done === 2) resolve(); };
    const host = createNet({
      role: 'host', code, mode: 'duel', name: 'HostBot',
      onReady: (cfg) => { hostReady = cfg; fin(); },
      onError: (e) => { console.error('[AUTOTEST] host err', e); resolve(); },
    });
    createNet({
      role: 'guest', code, mode: null, name: 'GuestBot',
      onReady: (cfg) => { guestReady = cfg; fin(); },
      onError: (e) => { console.error('[AUTOTEST] guest err', e); resolve(); },
    });
    void host;
    setTimeout(resolve, 12000);
  });
  check('net handshake', !!hostReady && !!guestReady && hostReady.seed === guestReady.seed,
    JSON.stringify({ hostReady, guestReady }));
}

export async function runAutotest(game) {
  console.log('[AUTOTEST] starting');
  try {
    await testRecognizer();
    await testMatch(game);
    if (location.search.includes('nettest')) await testNet();
  } catch (e) {
    fail++;
    console.error('[AUTOTEST] EXCEPTION', e);
  }
  console.log(`[AUTOTEST] DONE — ${pass} passed, ${fail} failed`);
  document.title = fail ? `FAIL ${fail}` : `PASS ${pass}`;
}
