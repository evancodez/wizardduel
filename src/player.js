// First-person controller: pointer-lock look, WASD movement, and the core
// mechanic — hold LMB to draw a glyph, release to cast. Shared wizard physics
// lives here too (AI reuses it).

import * as THREE from 'three';
import { recognizeStroke, RECOGNIZE_THRESHOLD } from './recognizer.js';
import { SPELLS } from './spells.js';
import { ARENA_RADIUS } from './arena.js';
import { clamp } from './utils.js';

const GRAV = 22, SPEED = 8, ACCEL = 55, JUMP = 8;
const _push = new THREE.Vector3();
const _cpos = new THREE.Vector3();

// Physics shared by player + AI wizards. Returns grounded.
export function stepWizardPhysics(world, w, dt, wish = { x: 0, z: 0, jump: false, speedMul: 1 }) {
  if (w.grabbedBy) return false; // magic.js drives lifted wizards
  const controllable = !w.flung;
  const grounded = w.pos.y <= 0.001;
  if (controllable) {
    const target = Math.hypot(wish.x, wish.z) > 0 ? SPEED * (wish.speedMul ?? 1) : 0;
    let wx = 0, wz = 0;
    if (target > 0) { const l = Math.hypot(wish.x, wish.z); wx = (wish.x / l) * target; wz = (wish.z / l) * target; }
    const k = Math.min((grounded ? ACCEL : ACCEL * 0.3) * dt, 1) / Math.max(target, SPEED);
    w.vel.x += (wx - w.vel.x) * Math.min(k * SPEED, 1);
    w.vel.z += (wz - w.vel.z) * Math.min(k * SPEED, 1);
    if (grounded && wish.jump && w.vel.y <= 0.01) w.vel.y = JUMP;
  }
  w.vel.y -= GRAV * dt;
  w.pos.addScaledVector(w.vel, dt);
  if (w.pos.y <= 0) {
    w.pos.y = 0;
    if (w.vel.y < -9) { world.particles.dust(w.pos, 6, 0x8a7a5e, 0.8); }
    w.vel.y = 0;
    if (w.flung) {
      w.flung = false;
      world.particles.dust(w.pos, 14, 0x8a7a5e, 1.1);
      world.audio.thud();
      world.shake(w.isLocal ? 0.5 : 0.25);
      if (world.ownsWizard(w)) world.magic.applyDamage(w, SPELLS.grab.wizardDmg, { kind: 'impact' });
    }
  }
  // collide with arena statics at knee + chest heights
  for (const hy of [0.5, 1.3]) {
    _cpos.set(w.pos.x, w.pos.y + hy, w.pos.z);
    if (world.arena.collideSphere(_cpos, 0.55, _push)) {
      w.pos.x += _push.x; w.pos.z += _push.z;
      if (_push.y > 0.01 && w.vel.y < 0) w.vel.y = 0;
    }
  }
  const d = Math.hypot(w.pos.x, w.pos.z);
  if (d > ARENA_RADIUS) {
    w.pos.x *= ARENA_RADIUS / d;
    w.pos.z *= ARENA_RADIUS / d;
  }
  return w.pos.y <= 0.001;
}

// radians of view sweep → draw-space units (recognizer is scale-invariant;
// this just keeps min-length thresholds meaningful)
const DRAW_SCALE = 2.2;

export function createPlayer(world, wizard) {
  const PL = { wizard, keys: {}, strokeStart: { yaw: 0, pitch: 0 }, guessTimer: 0, netDrawTimer: 0, sens: world.settings.sens };
  const dom = world.renderer.domElement;
  wizard.isLocal = true;

  const locked = () => document.pointerLockElement === dom;
  PL.locked = locked;

  const canAct = () =>
    world.phase === 'fight' && wizard.alive && !wizard.grabbedBy && !wizard.flung && locked() && !world.paused;

  function startDraw() {
    if (!canAct() || wizard.castLock > 0 || wizard.channel) return;
    wizard.stroke.active = true;
    wizard.stroke.pts = [{ x: 0, y: 0 }];
    wizard.stroke.dirty = true;
    wizard.stroke.guess = null;
    wizard.stroke.guessColor = null;
    // the pen is your crosshair: the glyph canvas is anchored to the view
    // direction where the stroke began, and you paint it by looking
    PL.strokeStart.yaw = wizard.yaw;
    PL.strokeStart.pitch = wizard.pitch;
    wizard.stroke.anchor = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(wizard.pitch, wizard.yaw, 0, 'YXZ'));
    world.hud.setDrawing(true);
  }

  function cancelDraw(feint = true) {
    if (!wizard.stroke.active) return;
    wizard.stroke.active = false;
    wizard.stroke.pts = [];
    world.strokes.clear(wizard);
    world.hud.setDrawing(false);
    world.hud.setGuess(null);
    world.net?.sendDraw(wizard, true);
    if (feint) world.stats.feints++;
  }

  function finishDraw() {
    if (!wizard.stroke.active) return;
    wizard.stroke.active = false;
    world.hud.setDrawing(false);
    world.hud.setGuess(null);
    const pts = wizard.stroke.pts;
    world.net?.sendDraw(wizard, true);
    const res = recognizeStroke(pts);
    if (!res) {
      world.strokes.fizzle(wizard);
      world.audio.fizzle();
      world.hud.ticker('✏️ fizzle — glyph unclear', '#c9bfae');
      return;
    }
    const spell = SPELLS[res.spell];
    // aim from yaw/pitch, not the camera quaternion — the camera may carry
    // screen-shake at the instant of release
    const dir = new THREE.Vector3(
      -Math.sin(wizard.yaw) * Math.cos(wizard.pitch),
      Math.sin(wizard.pitch),
      -Math.cos(wizard.yaw) * Math.cos(wizard.pitch),
    );
    const out = world.magic.cast(wizard, res.spell, { dir });
    if (!out.ok) {
      world.strokes.fizzle(wizard);
      world.audio.fizzle();
      world.hud.denied(res.spell, out.reason);
      return;
    }
    world.strokes.flashCast(wizard, res.glyph, spell.color);
    world.fpRig.kick(spell.kind === 'heavy' ? 1.2 : 0.7);
    world.net?.sendCast(wizard, res.spell, dir, out.sync);
  }

  // ---- input listeners (removed on dispose) ----
  const onMouseDown = (e) => {
    if (!locked()) return;
    if (e.button === 0) startDraw();
    else if (e.button === 2 && wizard.stroke.active) { cancelDraw(); world.audio.uiClick(); }
  };
  const onMouseUp = (e) => { if (e.button === 0) finishDraw(); };
  const onMouseMove = (e) => {
    if (!locked() || world.paused) return;
    const mx = clamp(e.movementX, -60, 60), my = clamp(e.movementY, -60, 60);
    // the view ALWAYS follows the mouse — you keep aiming mid-draw, and
    // wherever you release is where the spell fires
    wizard.yaw -= mx * 0.0022 * PL.sens;
    wizard.pitch = clamp(wizard.pitch - my * 0.0022 * PL.sens, -1.35, 1.35);
    if (wizard.stroke.active) {
      // stroke point = angular offset from where the draw began (unbounded —
      // sweep as far as you like)
      const x = (PL.strokeStart.yaw - wizard.yaw) * DRAW_SCALE;
      const y = (PL.strokeStart.pitch - wizard.pitch) * DRAW_SCALE;
      const pts = wizard.stroke.pts;
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last.x, y - last.y) > 0.014) {
        pts.push({ x, y });
        wizard.stroke.dirty = true;
        if (pts.length % 6 === 0) world.audio.drawTick();
      }
    }
  };
  const onKey = (e) => {
    if (e.repeat) return;
    PL.keys[e.code] = e.type === 'keydown';
  };
  const onCtx = (e) => e.preventDefault();

  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);
  document.addEventListener('contextmenu', onCtx);

  PL.dispose = () => {
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKey);
    document.removeEventListener('contextmenu', onCtx);
  };

  PL.update = (dt) => {
    PL.sens = world.settings.sens;
    // interrupted externally (lightning) — make sure UI resets
    if (wizard.stroke.interrupted > 0 && wizard.stroke.active === false && world.hud.isDrawing) {
      world.hud.setDrawing(false);
      world.hud.setGuess(null);
    }

    // live recognition of the partial stroke
    if (wizard.stroke.active) {
      PL.guessTimer -= dt;
      if (PL.guessTimer <= 0) {
        PL.guessTimer = 0.09;
        const res = recognizeStroke(wizard.stroke.pts, { partial: true });
        wizard.stroke.guess = res?.spell || null;
        wizard.stroke.guessColor = res && res.score > 0.62 ? SPELLS[res.spell].color : null;
        world.hud.setGuess(res?.spell || null, res?.score || 0);
      }
      PL.netDrawTimer -= dt;
      if (PL.netDrawTimer <= 0) { PL.netDrawTimer = 0.07; world.net?.sendDraw(wizard); }
      if (!canAct()) cancelDraw(false);
    }

    // movement input
    let wx = 0, wz = 0;
    if (canAct() || (locked() && world.phase === 'fight')) {
      const f = (PL.keys.KeyW ? 1 : 0) - (PL.keys.KeyS ? 1 : 0);
      const s = (PL.keys.KeyD ? 1 : 0) - (PL.keys.KeyA ? 1 : 0);
      const sin = Math.sin(wizard.yaw), cos = Math.cos(wizard.yaw);
      wx = -sin * f + cos * s;
      wz = -cos * f - sin * s;
    }
    const speedMul = wizard.stroke.active ? 0.6 : wizard.channel ? 0.55 : 1;
    const moving = Math.hypot(wx, wz) > 0.1;
    stepWizardPhysics(world, wizard, dt, { x: wx, z: wz, jump: !!PL.keys.Space && canAct(), speedMul });

    // camera follows (game.js drives the fallen-wizard death cam instead)
    if (wizard.alive) {
      world.camera.position.set(wizard.pos.x, wizard.pos.y + 1.62, wizard.pos.z);
      world.camera.rotation.set(wizard.pitch, wizard.yaw, 0, 'YXZ');
      if (wizard.grabbedBy) {
        world.camera.rotation.z = Math.sin(world.time * 9) * 0.12;
      }
    }
    world.fpRig.update(dt, { moving, drawing: wizard.stroke.active, channeling: !!wizard.channel });
    world.hud.setCrosshairDrawing(wizard.stroke.active);
  };

  return PL;
}
