// Match orchestration: owns the render loop, world lifecycle, phases,
// modes (solo ladder / duel / co-op waves / menu attract), juice timing.

import * as THREE from 'three';
import { buildArena } from './arena.js';
import { createParticles } from './particles.js';
import { createMagic } from './magic.js';
import { createStrokes } from './strokes.js';
import { createHUD } from './hud.js';
import { createPlayer } from './player.js';
import { createAI, PERSONALITIES } from './ai.js';
import { buildWizard, buildFirstPersonRig } from './wizardModel.js';
import { SPELLS } from './spells.js';
import { clamp, damp, angleLerp, noise1, makeRng } from './utils.js';

export const LADDER = ['pip', 'bramble', 'cinder', 'vex'];
const ROUND_TIME = 180;

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.map && !m.map.userData?.shared) m.map.dispose?.();
        m.dispose?.();
      }
    }
  });
}

export function createGame({ audio, settings }) {
  const G = { onMatchEnd: null, onPointerLost: null, world: null, mode: null };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.getElementById('app').appendChild(renderer.domElement);
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    if (G.world) {
      G.world.camera.aspect = innerWidth / innerHeight;
      G.world.camera.updateProjectionMatrix();
    }
  });

  function lockPointer() {
    try {
      const r = renderer.domElement.requestPointerLock?.();
      r?.catch?.(() => { /* needs a user gesture; harmless in tests */ });
    } catch { /* ignore */ }
  }

  // ---------------- world lifecycle ----------------

  function makeWorld(seed) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 400);
    scene.add(camera);
    const world = {
      scene, camera, renderer, audio, settings,
      time: 0, timeScale: 1, slowmoT: 0, phase: 'idle', paused: false,
      roundTimer: ROUND_TIME, trauma: 0, fovKick: 0,
      wizards: [], transients: [], stats: { casts: 0, rocks: 0, trees: 0, banners: 0, reflects: 0, interrupts: 0, shatters: 0, yeets: 0, feints: 0 },
      spells: SPELLS, net: null, netTag: 'L',
      localWizard: null, player: null, fpRig: null, ais: [],
      onNetRound: null,
    };
    world.wizardById = (id) => world.wizards.find((w) => w.id === id);
    world.enemiesOf = (w) => world.wizards.filter((o) => o.team !== w.team);
    world.ownsWizard = (w) => w.isLocal || (!!w.ai && !w.netRemote);
    world.shake = (t) => { world.trauma = Math.min(1, world.trauma + t * settings.shake); };
    world.slowmo = (t) => { world.slowmoT = Math.max(world.slowmoT, t); };
    world.particles = createParticles(scene);
    world.arena = buildArena(world, seed);
    world.magic = createMagic(world);
    world.strokes = createStrokes(world);
    world.hud = createHUD(world);
    world.onDeath = (victim, attacker, fromNet) => onDeath(world, victim, attacker, fromNet);
    return world;
  }

  function teardownWorld() {
    const w = G.world;
    if (!w) return;
    w.player?.dispose();
    w.net?.dispose();
    disposeScene(w.scene);
    G.world = null;
  }

  function makeWizard(world, { id, name, pos, yaw = 0, team, hp = 100, personality = null, isLocal = false, netRemote = false }) {
    const wiz = {
      id, name, team, isLocal, netRemote,
      pos: pos.clone(), vel: new THREE.Vector3(), yaw, pitch: 0,
      hp, maxHp: hp, alive: true,
      shield: null, mirror: null, channel: null, burning: null, grabbedBy: null, flung: false,
      castLock: 0, hitReact: 0,
      stroke: { active: false, pts: [], dirty: false, interrupted: 0, guess: null, guessColor: null },
      cooldowns: {}, ai: null, model: null, personality,
      cssColor: personality ? `#${new THREE.Color(PERSONALITIES[personality].robe).getHexString()}` : '#6ec3ff',
      eyeHeight: 1.55,
    };
    if (!isLocal) {
      const p = personality ? PERSONALITIES[personality] : { robe: 0x3b6ea8, trim: 0x8fd0ff, eyes: 0xbfe8ff };
      wiz.model = buildWizard({ robe: p.robe, trim: p.trim, eyes: p.eyes });
      wiz.model.group.position.copy(pos);
      world.scene.add(wiz.model.group);
    }
    world.wizards.push(wiz);
    return wiz;
  }

  // ---------------- shared flow ----------------

  function resetWizardForRound(world, w, pos, yaw) {
    w.pos.copy(pos); w.vel.set(0, 0, 0);
    w.yaw = yaw; w.pitch = 0;
    w.hp = w.maxHp; w.alive = true;
    w.netTarget = null;
    world.magic.popShield(w, false);
    if (w.mirror) { world.scene.remove(w.mirror.mesh); w.mirror = null; }
    w.channel = null; w.burning = null; w.grabbedBy = null; w.flung = false;
    w.castLock = 0; w.cooldowns = {};
    w.stroke.active = false; w.stroke.pts = [];
    world.strokes.clear(w);
    if (w.model) {
      w.model.deadT = 0;
      w.model.group.rotation.set(0, w.yaw + Math.PI, 0);
      w.model.group.position.copy(pos);
      w.model.hat.rotation.z = 0.06;
      w.model.hat.position.y = 1.74;
    }
  }

  function spawnSpots(world, mode) {
    if (mode === 'coop') {
      return { players: [new THREE.Vector3(-2.5, 0, 17), new THREE.Vector3(2.5, 0, 17)], yaw: 0 };
    }
    return { a: new THREE.Vector3(0, 0, 13.5), b: new THREE.Vector3(0, 0, -13.5) };
  }

  function beginCountdown(world, sub = '') {
    world.phase = 'countdown';
    world.countT = 3.3;
    world.roundTimer = ROUND_TIME;
    world.hud.announce('ready…', sub, 1000);
  }

  // per-frame phase driver
  function phaseTick(world, dt, rdt) {
    if (world.phase === 'countdown') {
      const before = Math.ceil(world.countT);
      world.countT -= rdt;
      const now = Math.ceil(world.countT);
      if (now !== before && now > 0) {
        world.hud.announce(String(now), '', 800);
        audio.uiClick();
      }
      if (world.countT <= 0) {
        world.phase = 'fight';
        world.hud.announce('FIGHT!', '', 900);
        audio.horn();
      }
    } else if (world.phase === 'fight') {
      const isAuthority = !world.net || world.net.role === 'host';
      world.roundTimer -= dt;
      if (world.roundTimer <= 0 && isAuthority && G.mode !== 'coop' && G.mode !== 'attract') {
        // timeout: highest hp takes it
        const [a, b] = world.wizards;
        if (G.mode === 'solo') {
          world.phase = 'matchend';
          world.hud.announce('TIME!', '', 1500);
          endMatchSolo(world, a.hp >= b.hp);
        } else {
          const winner = a.hp === b.hp ? null : a.hp > b.hp ? a : b;
          endRound(world, winner, true);
        }
      }
    }
  }

  // ---------------- death & round flow ----------------

  function deathFx(world, victim) {
    const at = victim.pos.clone();
    world.particles.burst(new THREE.Vector3(at.x, at.y + 1.2, at.z), { count: 30, color: 0xffffff, speed: 7, size: 0.3, life: 0.8 });
    world.particles.smokePuff(new THREE.Vector3(at.x, at.y + 0.8, at.z), 10, 0x333333);
    world.arena.scorch(at, 1.8);
    world.audio.boom(0.8);
    world.slowmo(1.1);
    world.fovKick = 1;
    world.shake(0.6);
  }

  function onDeath(world, victim, attacker, fromNet) {
    deathFx(world, victim);
    world.hud.ticker(victim.isLocal ? '☠ you fell!' : `☠ ${victim.name} falls!`, '#ffd76a');
    if (victim.ai) victim.ai.say('lose');

    if (G.mode === 'attract') {
      world.transients.push({ t: 2.6, done: () => {
        if (G.mode !== 'attract') return;
        const spot = new THREE.Vector3((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20);
        resetWizardForRound(world, victim, spot, Math.random() * 6);
      } });
      return;
    }
    if (world.phase !== 'fight') return;

    if (G.mode === 'solo') {
      endMatchSolo(world, !victim.isLocal);
    } else if (G.mode === 'duel') {
      const isHost = world.net?.role === 'host';
      if (isHost || !world.net) {
        const winner = world.wizards.find((w) => w !== victim);
        endRound(world, winner, false);
      }
      // guest waits for the host's roundend message
    } else if (G.mode === 'coop') {
      coopOnDeath(world, victim);
    }
  }

  function endRound(world, winner, timeout) {
    world.phase = 'roundend';
    const msg = { phase: 'roundend', winnerId: winner ? winner.id : null, timeout };
    applyRound(world, msg);
    world.net?.sendRound(msg);
    // schedule next
    world.transients.push({ t: 2.6, done: () => {
      if (G.mode !== 'duel') return;
      const s = G.duelScore;
      if (s.a >= 2 || s.b >= 2) {
        const meWon = (world.net?.role === 'host' ? s.a : s.b) >= 2;
        const m2 = { phase: 'matchend', scores: { ...s } };
        applyRound(world, m2);
        world.net?.sendRound(m2);
        void meWon;
      } else {
        const m2 = { phase: 'nextround' };
        applyRound(world, m2);
        world.net?.sendRound(m2);
      }
    } });
  }

  function applyRound(world, msg) {
    if (msg.phase === 'roundend') {
      world.phase = 'roundend';
      const winner = msg.winnerId ? world.wizardById(msg.winnerId) : null;
      if (G.mode === 'duel') {
        if (winner) {
          const hostWon = winner.id === 'P0';
          G.duelScore[hostWon ? 'a' : 'b']++;
        }
        const myScore = world.net?.role === 'host' ? G.duelScore.a : G.duelScore.b;
        const theirScore = world.net?.role === 'host' ? G.duelScore.b : G.duelScore.a;
        world.hud.setPips(myScore, theirScore, 2);
        world.hud.announce(
          msg.timeout ? 'TIME!' : winner?.isLocal ? 'ROUND WON!' : 'ROUND LOST',
          winner ? `${winner.name} takes the round` : 'dead even', 2200);
        if (winner?.isLocal) audio.victory(); else audio.defeat();
      }
    } else if (msg.phase === 'nextround') {
      const spots = spawnSpots(world, 'duel');
      const p0 = world.wizardById('P0'), p1 = world.wizardById('P1');
      resetWizardForRound(world, p0, spots.a, 0);
      resetWizardForRound(world, p1, spots.b, Math.PI);
      beginCountdown(world, `round ${G.duelScore.a + G.duelScore.b + 1}`);
    } else if (msg.phase === 'matchend') {
      world.phase = 'matchend';
      const meWon = (world.net?.role === 'host' ? msg.scores.a : msg.scores.b) >= 2;
      finishMatch(world, { result: meWon ? 'win' : 'lose', title: meWon ? 'VICTORY' : 'DEFEATED', canRematch: true });
    } else if (msg.phase === 'wave') {
      coopSpawnWaveFromRoster(world, msg);
    } else if (msg.phase === 'wavebreak') {
      world.phase = 'wavebreak';
      world.hud.announce(`WAVE ${msg.n} CLEARED`, 'catch your breath…', 2400);
      audio.victory();
      coopReviveAndHeal(world);
    } else if (msg.phase === 'coopend') {
      world.phase = 'matchend';
      finishMatch(world, { result: 'coop', title: 'THE CIRCLE PREVAILS', sub: `waves survived: ${msg.waves}`, canRematch: false });
    } else if (msg.phase === 'rematchGo') {
      // host restarted the duel — follow with the same connection
      const net = world.net;
      world.net = null; // survive teardown
      G.startNetMatch({ role: net.role, net, seed: msg.seed, mode: 'duel', hostName: msg.hostName, guestName: msg.guestName });
    }
  }

  function endMatchSolo(world, playerWon) {
    world.phase = 'matchend';
    const foe = PERSONALITIES[LADDER[G.ladderIndex]];
    finishMatch(world, {
      result: playerWon ? 'win' : 'lose',
      title: playerWon ? 'VICTORY' : 'DEFEATED',
      sub: playerWon ? `${foe.name} yields!` : `${foe.name} stands over you`,
      canNext: playerWon && G.ladderIndex < LADDER.length - 1,
      canRetry: !playerWon,
      ladderComplete: playerWon && G.ladderIndex === LADDER.length - 1,
    });
  }

  function finishMatch(world, info) {
    if (info.result === 'win' || info.result === 'coop') audio.victory();
    else if (info.result === 'lose') audio.defeat();
    setTimeout(() => {
      document.exitPointerLock?.();
      G.onMatchEnd?.({ ...info, stats: { ...world.stats } });
    }, 1900);
  }

  // ---------------- co-op waves ----------------

  function coopRosterFor(n) {
    const count = Math.min(1 + Math.floor((n - 1) / 2), 3);
    const pool = n < 3 ? ['pip', 'bramble'] : n < 5 ? ['bramble', 'cinder', 'pip'] : ['cinder', 'vex', 'bramble'];
    const roster = [];
    for (let i = 0; i < count; i++) {
      const pers = pool[(n + i) % pool.length];
      roster.push({
        id: `A${n}_${i}`,
        pers,
        diff: clamp(0.22 + n * 0.075, 0.2, 0.95),
        hp: Math.round(PERSONALITIES[pers].hp * (0.7 + n * 0.05)),
      });
    }
    return roster;
  }

  function coopSpawnWaveFromRoster(world, msg) {
    G.wave = msg.n;
    world.hud.setModeChip(`wave ${msg.n}`);
    world.hud.announce(`WAVE ${msg.n}`, msg.roster.map((r) => PERSONALITIES[r.pers].name).join(' · '), 2200);
    audio.horn();
    const isHost = !world.net || world.net.role === 'host';
    msg.roster.forEach((r, i) => {
      const pos = new THREE.Vector3((i - (msg.roster.length - 1) / 2) * 6, 0, -19);
      const w = makeWizard(world, { id: r.id, name: PERSONALITIES[r.pers].name, pos, yaw: Math.PI, team: 'B', hp: r.hp, personality: r.pers, netRemote: !isHost });
      if (isHost) {
        w.ai = createAI(world, w, PERSONALITIES[r.pers], r.diff);
        world.ais.push(w.ai);
        setTimeout(() => w.ai?.say('intro'), 800 + i * 600);
      }
    });
    world.phase = 'fight';
    world.roundTimer = 999;
  }

  function coopReviveAndHeal(world) {
    for (const w of world.wizards) {
      if (w.team !== 'A') continue;
      if (!w.alive && world.ownsWizard(w)) {
        w.alive = true;
        w.hp = Math.round(w.maxHp * 0.5);
        w.pos.set((Math.random() - 0.5) * 6, 0, 15);
        world.hud.ticker(w.isLocal ? '✨ you are revived!' : `✨ ${w.name} revived!`, '#8fe08a');
      } else if (w.alive && world.ownsWizard(w)) {
        w.hp = clamp(w.hp + w.maxHp * 0.4, 0, w.maxHp);
      }
    }
  }

  function coopOnDeath(world, victim) {
    const isHost = !world.net || world.net.role === 'host';
    if (victim.team === 'B') {
      // clean up the fallen AI after the topple animation
      world.transients.push({ t: 3, done: () => {
        if (victim.model) { victim.model.group.visible = false; }
        world.hud.clearWizardUI(victim);
        world.strokes.remove(victim);
        const i = world.wizards.indexOf(victim);
        if (i >= 0) world.wizards.splice(i, 1);
        if (victim.ai) world.ais.splice(world.ais.indexOf(victim.ai), 1);
      } });
      if (isHost) {
        const foesLeft = world.wizards.filter((w) => w.team === 'B' && w.alive && w !== victim).length;
        if (foesLeft === 0) {
          const msg = { phase: 'wavebreak', n: G.wave };
          applyRound(world, msg);
          world.net?.sendRound(msg);
          world.transients.push({ t: 5, done: () => {
            if (G.mode !== 'coop' || world.phase === 'matchend') return;
            const next = { phase: 'wave', n: G.wave + 1, roster: coopRosterFor(G.wave + 1) };
            applyRound(world, next);
            world.net?.sendRound(next);
          } });
        }
      }
    } else if (isHost) {
      const alliesLeft = world.wizards.filter((w) => w.team === 'A' && w.alive && w !== victim).length;
      if (alliesLeft === 0) {
        const msg = { phase: 'coopend', waves: Math.max(0, G.wave - 1) };
        applyRound(world, msg);
        world.net?.sendRound(msg);
      } else {
        world.hud.ticker('hold out until the wave ends!', '#ffd76a');
      }
    }
  }

  // ---------------- mode starters ----------------

  function commonStart(world) {
    G.world = world;
    world.arena.onEvent = (type, id) => { if (type === 'ignite') world.net?.sendIgnite(id); };
    world.hud.bindMatch();
    world.hud.show();
  }

  G.startAttract = () => {
    teardownWorld();
    G.mode = 'attract';
    const world = makeWorld((Math.random() * 1e9) >>> 0);
    G.world = world;
    world.phase = 'fight';
    world.roundTimer = 9999;
    const a = makeWizard(world, { id: 'D0', name: 'Pip the Apprentice', pos: new THREE.Vector3(-9, 0, 4), yaw: -Math.PI / 2, team: 'A', hp: 90, personality: 'pip' });
    const b = makeWizard(world, { id: 'D1', name: 'Cinderwick', pos: new THREE.Vector3(9, 0, -4), yaw: Math.PI / 2, team: 'B', hp: 90, personality: 'cinder' });
    a.ai = createAI(world, a, PERSONALITIES.pip, 0.55);
    b.ai = createAI(world, b, PERSONALITIES.cinder, 0.55);
    world.ais.push(a.ai, b.ai);
    world.hud.hide();
  };

  G.startSolo = (ladderIndex = 0) => {
    teardownWorld();
    G.mode = 'solo';
    G.ladderIndex = ladderIndex;
    const pers = PERSONALITIES[LADDER[ladderIndex]];
    const world = makeWorld((Math.random() * 1e9) >>> 0);
    commonStart(world);
    const spots = spawnSpots(world, 'solo');
    const me = makeWizard(world, { id: 'P0', name: settings.name || 'You', pos: spots.a, yaw: 0, team: 'A', hp: 100, isLocal: true });
    world.localWizard = me;
    world.fpRig = buildFirstPersonRig(world.camera);
    world.player = createPlayer(world, me);
    const foe = makeWizard(world, { id: 'E0', name: pers.name, pos: spots.b, yaw: Math.PI, team: 'B', hp: pers.hp, personality: pers.id });
    foe.ai = createAI(world, foe, pers, [0.2, 0.42, 0.62, 0.85][ladderIndex] ?? 0.6);
    world.ais.push(foe.ai);
    world.hud.setModeChip(`trial ${ladderIndex + 1} of ${LADDER.length} — ${pers.name}`);
    world.hud.setPips(0, 0, 0);
    beginCountdown(world, `${pers.name} approaches`);
    setTimeout(() => foe.ai?.say('intro'), 1200);
    lockPointer();
  };

  G.startNetMatch = ({ role, net, seed, mode, hostName, guestName }) => {
    teardownWorld();
    G.mode = mode;
    G.duelScore = { a: 0, b: 0 };
    G.wave = 0;
    const world = makeWorld(seed >>> 0);
    world.net = net;
    world.netTag = role === 'host' ? 'H' : 'G';
    net.bindWorld?.(world);
    commonStart(world);
    world.onNetRound = (msg) => applyRound(world, msg);

    const myId = role === 'host' ? 'P0' : 'P1';
    const otherId = role === 'host' ? 'P1' : 'P0';
    const myName = role === 'host' ? hostName : guestName;
    const otherName = role === 'host' ? guestName : hostName;
    const spots = mode === 'coop' ? spawnSpots(world, 'coop') : spawnSpots(world, 'duel');
    const myPos = mode === 'coop' ? spots.players[role === 'host' ? 0 : 1] : role === 'host' ? spots.a : spots.b;
    const otherPos = mode === 'coop' ? spots.players[role === 'host' ? 1 : 0] : role === 'host' ? spots.b : spots.a;
    const myYaw = mode === 'coop' ? 0 : role === 'host' ? 0 : Math.PI;
    const otherYaw = mode === 'coop' ? 0 : role === 'host' ? Math.PI : 0;

    const me = makeWizard(world, { id: myId, name: myName, pos: myPos, yaw: myYaw, team: 'A', hp: 100, isLocal: true });
    world.localWizard = me;
    world.fpRig = buildFirstPersonRig(world.camera);
    world.player = createPlayer(world, me);
    const other = makeWizard(world, {
      id: otherId, name: otherName, pos: otherPos, yaw: otherYaw,
      team: mode === 'coop' ? 'A' : 'B', hp: 100, netRemote: true,
    });
    other.cssColor = '#ff6a5e';

    if (mode === 'duel') {
      world.hud.setModeChip(`duel — ${otherName}`);
      world.hud.setPips(0, 0, 2);
      beginCountdown(world, `${otherName} stands ready`);
    } else {
      world.hud.setModeChip('co-op — the circle attacks');
      world.hud.setPips(0, 0, 0);
      world.roundTimer = 999;
      world.phase = 'wavebreak';
      world.hud.announce('STAND TOGETHER', 'the first wave comes…', 2400);
      if (role === 'host') {
        world.transients.push({ t: 3.2, done: () => {
          const msg = { phase: 'wave', n: 1, roster: coopRosterFor(1) };
          applyRound(world, msg);
          net.sendRound(msg);
        } });
      }
    }
    lockPointer();
  };

  G.rematch = () => {
    // host restarts with a fresh seed; guest follows via the start flow in main.js
    if (G.mode !== 'duel' || !G.world?.net) return;
    const net = G.world.net;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const cfg = { role: net.role, net, seed, mode: 'duel', hostName: net.role === 'host' ? settings.name : G.world.wizardById('P0').name, guestName: net.role === 'host' ? G.world.wizardById('P1').name : settings.name };
    net.sendRound({ phase: 'rematchGo', seed, hostName: cfg.hostName, guestName: cfg.guestName });
    G.world.net = null; // keep the connection alive through teardown
    G.startNetMatch(cfg);
  };

  G.quitToMenu = () => {
    document.exitPointerLock?.();
    G.startAttract();
  };

  // ---------------- main loop ----------------

  let last = performance.now();
  let shakeT = 0;

  function frame(now) {
    const rdt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const world = G.world;
    if (!world) return;

    // slow-mo envelope
    world.slowmoT = Math.max(0, world.slowmoT - rdt);
    const targetTs = world.slowmoT > 0 ? 0.22 : 1;
    if (audio.ready && !!world._ducked !== (targetTs < 1)) { world._ducked = targetTs < 1; audio.setDuck(world._ducked); }
    world.timeScale = damp(world.timeScale, targetTs, 8, rdt);
    const dt = world.paused ? 0 : rdt * world.timeScale;
    world.time += dt;

    if (!world.paused) {
      phaseTick(world, dt, rdt);
      world.player?.update(dt === 0 ? 0 : Math.max(dt, 0.0001));
      for (const ai of world.ais) ai.update(dt);
      // remote wizards: interpolate toward last net state
      for (const w of world.wizards) {
        if (w.netRemote && w.netTarget) {
          w.pos.lerp(w.netTarget.pos, Math.min(1, dt * 13));
          w.yaw = angleLerp(w.yaw, w.netTarget.yaw, Math.min(1, dt * 13));
          w.pitch = w.netTarget.pitch;
          if (w.model) {
            w.model.group.position.copy(w.pos);
            w.model.group.rotation.y = w.yaw + Math.PI;
            w.model.animate(dt, {
              moving: !!w.netFlags?.moving, drawing: w.stroke.active,
              grabbed: !!w.netFlags?.grabbed, channeling: !!w.netFlags?.channeling, dead: !w.alive,
            });
          }
        } else if (!w.isLocal && !w.alive && w.model) {
          w.model.animate(dt, { dead: true });
        }
      }
      world.magic.update(dt);
      world.arena.update(dt);
      world.strokes.update(dt);
      world.particles.update(dt);
      world.net?.update(rdt);
      world.hud.update(dt, rdt);
    }

    // attract mode camera orbit
    if (G.mode === 'attract') {
      const t = now / 1000;
      world.camera.position.set(Math.cos(t * 0.07) * 21, 6.5 + Math.sin(t * 0.13) * 1.5, Math.sin(t * 0.07) * 21);
      world.camera.lookAt(0, 2, 0);
    }
    // local player death cam: sink to the grass
    const me = world.localWizard;
    if (me && !me.alive) {
      world.camera.position.y = damp(world.camera.position.y, 0.5, 3, rdt);
      world.camera.rotation.z = damp(world.camera.rotation.z, 0.35, 3, rdt);
    }

    // screen shake + fov kick
    world.trauma = Math.max(0, world.trauma - rdt * 1.6);
    shakeT += rdt * 24;
    const sh = world.trauma * world.trauma * 0.05;
    world.camera.rotation.x += noise1(shakeT) * sh;
    world.camera.rotation.y += noise1(shakeT + 57) * sh;
    world.camera.rotation.z += noise1(shakeT + 131) * sh * 0.6;
    world.fovKick = Math.max(0, world.fovKick - rdt * 2.2);
    const fov = 75 - (world.slowmoT > 0 ? 7 : 0) + world.fovKick * 6;
    if (Math.abs(world.camera.fov - fov) > 0.1) {
      world.camera.fov = damp(world.camera.fov, fov, 8, rdt);
      world.camera.updateProjectionMatrix();
    }

    renderer.render(world.scene, world.camera);
  }
  function loop(now) {
    requestAnimationFrame(loop);
    frame(now);
  }
  requestAnimationFrame(loop);
  // rAF stalls in hidden tabs (multiplayer hosts alt-tab; test harnesses too) —
  // keep the sim ticking at a low rate so peers and timers don't freeze
  setInterval(() => {
    if (performance.now() - last > 200) frame(performance.now());
  }, 100);

  return G;
}
