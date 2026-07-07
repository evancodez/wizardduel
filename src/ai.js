// AI wizards: they draw glyphs stroke-by-stroke (so you can read and counter
// them), read YOUR partial strokes to counter you, and talk trash.

import * as THREE from 'three';
import { SPELLS } from './spells.js';
import { recognizeStroke, IDEALS, resample } from './recognizer.js';
import { stepWizardPhysics } from './player.js';
import { clamp } from './utils.js';

const GLYPH_COST = { line: 0.5, circle: 0.65, caret: 0.62, zigzag: 0.75, triangle: 0.85, square: 1.0, heart: 1.15, spiral: 1.3 };

export const PERSONALITIES = {
  pip: {
    id: 'pip', name: 'Pip the Apprentice', robe: 0x4e8f4a, trim: 0xd8b45a, eyes: 0xbfe8ff, hp: 70,
    drawTime: 1.6, decide: [1.3, 2.1], react: 0.25, aimErr: 13, dodge: 0.12, healAt: 0.3, range: [9, 15],
    weights: { bolt: 3.2, fireball: 2.2, lightning: 0.3, shield: 0.8, boulder: 0.2, heal: 0.5, mirror: 0.1, grab: 0.15 },
    lines: {
      intro: ['I-I\'ve been practicing!', 'Master says I\'m ready. Probably.', 'Please be gentle?'],
      hit: ['Ha! Sorry! But ha!', 'It worked! It actually worked!', 'Did you see that?!'],
      hurt: ['Ow ow ow!', 'That stings!', 'Mercy? No? Okay.'],
      shatter: ['Oops — wrong rune!', 'My bubble!!'],
      win: ['Wait, I WON?', 'Master will be so proud!'],
      lose: ['I knew this was a bad idea…', 'Back to the library…'],
      idle: ['Which one summons the shield again?', 'Nice weather for a duel.', '*mumbles incantations*'],
    },
  },
  bramble: {
    id: 'bramble', name: 'Bramblebeard', robe: 0x6a5a34, trim: 0x8fae4e, eyes: 0xc9ff9a, hp: 100,
    drawTime: 1.1, decide: [0.7, 1.2], react: 0.5, aimErr: 7, dodge: 0.35, healAt: 0.35, range: [11, 18],
    weights: { bolt: 1.4, fireball: 1.2, lightning: 0.8, shield: 1.4, boulder: 2.4, heal: 0.8, mirror: 0.5, grab: 2.6 },
    lines: {
      intro: ['The forest bites back.', 'You tread on my moss.', 'Stones remember, wanderer.'],
      hit: ['My rocks disagree with you.', 'The earth votes no.', 'Timber.'],
      hurt: ['Bah! Bark and bone!', 'You scuffed my beard.'],
      shatter: ['Pebbles and pity!', 'That was quality granite!'],
      win: ['Compost for the garden.', 'The meadow keeps the score.'],
      lose: ['Even oaks fall…', 'The moss… grows cold…'],
      idle: ['These trees took CENTURIES.', '*chews a twig judgmentally*', 'Mind the banners. Or don\'t.'],
    },
  },
  cinder: {
    id: 'cinder', name: 'Cinderwick', robe: 0xa8422c, trim: 0xffd76a, eyes: 0xffb35c, hp: 110,
    drawTime: 0.95, decide: [0.55, 1.0], react: 0.6, aimErr: 5.5, dodge: 0.45, healAt: 0.25, range: [8, 14],
    weights: { bolt: 1.8, fireball: 3.4, lightning: 1.4, shield: 0.8, boulder: 0.8, heal: 0.5, mirror: 0.7, grab: 0.6 },
    lines: {
      intro: ['Everything burns!', 'Warm yet? You will be.', 'I do love kindling.'],
      hit: ['Crispy!', 'Smell that? Victory. And smoke.', 'Stay warm!'],
      hurt: ['You DARE dampen me?!', 'Cute spark. Mine\'s bigger.'],
      shatter: ['Glass cannon! Emphasis on glass!', 'Shattered AND toasted!'],
      win: ['Ashes to ashes!', 'Another one well-done.'],
      lose: ['Extinguished…? Impossible…', 'I\'ll be back… with more fire…'],
      idle: ['That tree? Flammable. That rock? We\'ll see.', '*juggles a flame*', 'Hurry up, my kettle\'s on.'],
    },
  },
  vex: {
    id: 'vex', name: 'Grand Magus Vex', robe: 0x5b3a8f, trim: 0xffd76a, eyes: 0xe0b3ff, hp: 120,
    drawTime: 0.72, decide: [0.4, 0.75], react: 0.85, aimErr: 3, dodge: 0.65, healAt: 0.45, range: [10, 17],
    weights: { bolt: 1.6, fireball: 1.8, lightning: 2.0, shield: 1.2, boulder: 1.4, heal: 1.2, mirror: 1.6, grab: 1.6 },
    lines: {
      intro: ['I saw this duel in a dream. You lose.', 'Predictable.', 'Do try to surprise me.'],
      hit: ['As foreseen.', 'You drew that BADLY.', 'Yawn.'],
      hurt: ['Interesting. Do it again — if you can.', 'A scratch. A lucky one.'],
      shatter: ['That trick won\'t work twice.', 'Noted. Countered. Forgotten.'],
      win: ['The Circle remains unbroken.', 'Study harder. Come back never.'],
      lose: ['Im…possible. The glyphs… lied…', 'You… actually surprised me.'],
      idle: ['I\'ve already countered your next three spells.', '*checks nails*', 'Your stance is wrong, by the way.'],
    },
  },
};

const COUNTERS = {
  bolt: ['shield', 'mirror'],
  fireball: ['shield', 'mirror'],
  lightning: ['shield'],
  boulder: ['mirror', 'dodge'],
  grab: ['shield'],
  heal: ['lightning', 'bolt'],
  shield: ['boulder', 'grab'],
  mirror: ['lightning', 'wait'],
};

const _v = new THREE.Vector3();

export function createAI(world, wizard, personality, difficulty = 0.5) {
  const P = personality;
  const AI = { wizard, personality: P, difficulty };
  wizard.ai = AI;
  wizard.name = P.name;

  const drawSpeed = 1 / (P.drawTime * (1.45 - difficulty * 0.65));
  const reactProb = clamp(P.react * (0.4 + difficulty * 0.9), 0, 0.95);
  const aimErr = (P.aimErr * (1.4 - difficulty * 0.9) * Math.PI) / 180;

  let decideT = 1 + Math.random();
  let readT = 0.2;
  let strafeDir = Math.random() > 0.5 ? 1 : -1;
  let strafeT = 2;
  let idleTauntT = 8 + Math.random() * 8;
  let tauntCooldown = 0;
  let plan = null;      // {spell, path, t, dur}
  let lastReadGuess = null;
  let waitOut = 0;      // don't shoot while enemy mirror is up

  AI.say = (category) => {
    if (tauntCooldown > 0) return;
    const lines = P.lines[category];
    if (!lines) return;
    tauntCooldown = 4;
    const line = lines[Math.floor(Math.random() * lines.length)];
    world.hud.speech(wizard, line);
    world.audio.taunt();
    world.net?.sendTaunt(wizard, line); // co-op guests hear the trash talk too
  };

  AI.onInterrupted = () => { plan = null; AI.say('hurt'); };

  function target() {
    let best = null, bestD = 1e9;
    for (const e of world.enemiesOf(wizard)) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(wizard.pos);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function ready(spellId) { return (wizard.cooldowns[spellId] || 0) <= 0; }

  function beginDraw(spellId) {
    if (!ready(spellId) || wizard.castLock > 0 || plan) return false;
    const glyph = SPELLS[spellId].glyph;
    const ideal = resample(IDEALS[glyph], 40);
    // jitter so each AI scrawl looks hand-drawn
    const wob = 0.03 + (1 - difficulty) * 0.05;
    let ox = 0, oy = 0;
    const path = ideal.map((p, i) => {
      ox = ox * 0.7 + (Math.random() - 0.5) * wob;
      oy = oy * 0.7 + (Math.random() - 0.5) * wob;
      return { x: (p.x - 0.5) * 1.5 + ox, y: (p.y - 0.5) * 1.5 + oy };
    });
    plan = { spell: spellId, path, t: 0, dur: GLYPH_COST[glyph] / drawSpeed };
    wizard.stroke.active = true;
    wizard.stroke.pts = [path[0]];
    wizard.stroke.dirty = true;
    wizard.stroke.guessColor = null;
    return true;
  }

  function castPlanned() {
    const spellId = plan.spell;
    plan = null;
    wizard.stroke.active = false;
    const t = target();
    const dir = new THREE.Vector3(0, 0, -1);
    if (t) {
      world.magic.chestOf(t, _v);
      // lead projectiles a touch at higher difficulty
      if (SPELLS[spellId].speed && difficulty > 0.4) {
        const tt = _v.distanceTo(wizard.pos) / SPELLS[spellId].speed;
        _v.addScaledVector(t.vel, tt * difficulty * 0.7);
      }
      dir.copy(_v.sub(new THREE.Vector3(wizard.pos.x, wizard.pos.y + 1.55, wizard.pos.z))).normalize();
      // aim error
      const err = aimErr * (Math.random() * 0.5 + 0.5);
      const axis = new THREE.Vector3().randomDirection();
      dir.applyAxisAngle(axis, err).normalize();
    }
    const out = world.magic.cast(wizard, spellId, { dir });
    if (out.ok) {
      world.strokes.flashCast(wizard, SPELLS[spellId].glyph, SPELLS[spellId].color);
      world.net?.sendCast(wizard, spellId, dir, out.sync);
    } else {
      world.strokes.fizzle(wizard);
    }
  }

  function pickAttack(t) {
    const w = { ...P.weights };
    // situational tweaks
    if (t.shield) { w.boulder = (w.boulder || 0) + 4; w.grab = (w.grab || 0) + 3; w.bolt = 0.2; w.fireball *= 0.3; w.lightning = 0.1; }
    if (t.mirror || waitOut > 0) { w.fireball *= 0.15; w.bolt *= 0.15; w.boulder *= 0.15; w.grab = (w.grab || 0) + 2; w.lightning = (w.lightning || 0) + 2.5; }
    if (t.channel) { w.lightning = (w.lightning || 0) + 5; w.bolt = (w.bolt || 0) + 3; }
    if (wizard.hp < wizard.maxHp * P.healAt) w.heal = (w.heal || 0) + 3.5;
    if (wizard.hp > wizard.maxHp * 0.9) w.heal = 0;
    w.shield = (w.shield || 0) * (wizard.shield ? 0 : 1);
    w.mirror = (w.mirror || 0) * (wizard.mirror ? 0 : 1);
    const entries = Object.entries(w).filter(([id, wt]) => wt > 0 && ready(id));
    if (!entries.length) return null;
    let total = 0;
    for (const [, wt] of entries) total += wt;
    let r = Math.random() * total;
    for (const [id, wt] of entries) { r -= wt; if (r <= 0) return id; }
    return entries[entries.length - 1][0];
  }

  // read the enemy's partial stroke and counter it
  function tryCounter(t) {
    if (!t.stroke.active || t.stroke.pts.length < 8) { lastReadGuess = null; return false; }
    const res = recognizeStroke(t.stroke.pts, { partial: true });
    if (!res || res.score < 0.6) return false;
    if (res.spell === lastReadGuess) return false; // already reacted to this read
    lastReadGuess = res.spell;
    if (Math.random() > reactProb) return false;
    const counters = COUNTERS[res.spell] || [];
    for (const c of counters) {
      if (c === 'dodge') { strafeDir = Math.random() > 0.5 ? 1 : -1; strafeT = 0.8; return false; }
      if (c === 'wait') { waitOut = 1.3; return false; }
      if (ready(c) && !wizard.stroke.active) {
        if (beginDraw(c)) {
          if (Math.random() < 0.35) AI.say('idle');
          return true;
        }
      }
    }
    return false;
  }

  AI.update = (dt) => {
    if (!wizard.alive) return;
    tauntCooldown -= dt;
    waitOut -= dt;
    if (world.phase !== 'fight') {
      wizard.stroke.active = false;
      plan = null;
      stepWizardPhysics(world, wizard, dt, { x: 0, z: 0 });
      wizard.model.animate(dt, { moving: false });
      return;
    }
    const t = target();

    // --- drawing in progress: replay the glyph path ---
    if (plan) {
      plan.t += dt;
      const frac = clamp(plan.t / plan.dur, 0, 1);
      const want = Math.max(2, Math.floor(frac * plan.path.length));
      while (wizard.stroke.pts.length < want) {
        wizard.stroke.pts.push(plan.path[wizard.stroke.pts.length]);
        wizard.stroke.dirty = true;
      }
      world.net?.sendDraw(wizard);
      if (frac >= 1) { world.net?.sendDraw(wizard, true); castPlanned(); }
    } else if (wizard.castLock <= 0 && !wizard.channel && !wizard.grabbedBy && !wizard.flung && t) {
      // --- decide ---
      readT -= dt;
      if (readT <= 0) { readT = 0.16; tryCounter(t); }
      decideT -= dt;
      if (decideT <= 0 && !plan) {
        decideT = P.decide[0] + Math.random() * (P.decide[1] - P.decide[0]);
        decideT *= 1.3 - difficulty * 0.45;
        const spell = pickAttack(t);
        if (spell) beginDraw(spell);
      }
    }

    // --- movement: orbit target within preferred range, dodge sometimes ---
    let wx = 0, wz = 0, jump = false;
    if (t && !wizard.grabbedBy) {
      strafeT -= dt;
      if (strafeT <= 0) { strafeT = 1.2 + Math.random() * 2.4; if (Math.random() < 0.6) strafeDir *= -1; }
      _v.set(t.pos.x - wizard.pos.x, 0, t.pos.z - wizard.pos.z);
      const d = _v.length() || 1;
      _v.divideScalar(d);
      const [rMin, rMax] = P.range;
      let approach = 0;
      if (d > rMax) approach = 1;
      else if (d < rMin) approach = -1;
      wx = _v.x * approach + -_v.z * strafeDir;
      wz = _v.z * approach + _v.x * strafeDir;
      // dodge incoming projectiles
      for (const p of world.magic.projectiles) {
        if (p.casterId === wizard.id || p.phase === 'float') continue;
        const toMe = _v.set(wizard.pos.x - p.mesh.position.x, 0, wizard.pos.z - p.mesh.position.z);
        const dist = toMe.length();
        if (dist < 14 && p.vel.dot(toMe) > 0 && Math.random() < P.dodge * difficulty * dt * 22) {
          strafeDir = Math.random() > 0.5 ? 1 : -1;
          strafeT = Math.max(strafeT, 0.5);
          if (Math.random() < 0.3) jump = true;
        }
      }
      // face the target
      wizard.yaw = Math.atan2(-(t.pos.x - wizard.pos.x), -(t.pos.z - wizard.pos.z));
      wizard.pitch = 0;
    }
    const speedMul = (wizard.stroke.active ? 0.45 : wizard.channel ? 0.55 : 1) * (0.75 + difficulty * 0.3);
    stepWizardPhysics(world, wizard, dt, { x: wx, z: wz, jump, speedMul });

    // idle taunts
    idleTauntT -= dt;
    if (idleTauntT <= 0) { idleTauntT = 9 + Math.random() * 9; if (Math.random() < 0.6) AI.say('idle'); }

    // drive the puppet
    wizard.model.group.position.copy(wizard.pos);
    wizard.model.group.rotation.y = wizard.yaw + Math.PI;
    wizard.model.animate(dt, {
      moving: Math.hypot(wx, wz) > 0.1,
      drawing: wizard.stroke.active,
      grabbed: !!wizard.grabbedBy,
      channeling: !!wizard.channel,
      dead: !wizard.alive,
    });
  };

  return AI;
}
