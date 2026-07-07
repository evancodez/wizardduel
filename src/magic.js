// Spell runtime: casting, projectiles, shields/mirrors/heals/grabs, damage.
// Authority rule for netplay: a client only applies damage to wizards it owns
// (its own wizard, or AI it hosts). Everyone simulates every projectile for
// visuals; owners report resulting hp via the net layer.

import * as THREE from 'three';
import { SPELLS } from './spells.js';
import { rockGeometry, ARENA_RADIUS } from './arena.js';
import { makeRng, clamp } from './utils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function createMagic(world) {
  const M = { projectiles: [] };
  const P = () => world.particles;

  const chestOf = (w, out = new THREE.Vector3()) => out.set(w.pos.x, w.pos.y + 1.15, w.pos.z);
  M.chestOf = chestOf;

  const eyeOf = (w, out = new THREE.Vector3()) => out.set(w.pos.x, w.pos.y + (w.eyeHeight ?? 1.55), w.pos.z);

  const forwardOf = (w, out = new THREE.Vector3()) =>
    out.set(-Math.sin(w.yaw) * Math.cos(w.pitch || 0), Math.sin(w.pitch || 0), -Math.cos(w.yaw) * Math.cos(w.pitch || 0));

  M.assistAim = (caster, dir) => {
    let best = null, bestAngle = 16 * (Math.PI / 180);
    for (const e of world.enemiesOf(caster)) {
      if (!e.alive) continue;
      chestOf(e, _v).sub(eyeOf(caster, _v2));
      const d = _v.length();
      if (d < 1 || d > 60) continue;
      const angle = _v.normalize().angleTo(dir);
      if (angle < bestAngle) { bestAngle = angle; best = _v.clone(); }
    }
    if (best) {
      const t = bestAngle < 9 * (Math.PI / 180) ? 0.92 : 0.5;
      dir.lerp(best, t).normalize();
    }
    return dir;
  };

  // ---------------- damage ----------------

  M.applyDamage = (victim, amount, { kind = 'bolt', attacker = null, silent = false } = {}) => {
    if (!victim.alive || world.phase !== 'fight') return;
    const owned = world.ownsWizard(victim);
    let dmg = amount;

    // shield interaction (cosmetic on non-owned copies, real on owned)
    if (victim.shield && kind !== 'burn') {
      if (kind === 'heavy') {
        M.shatterShield(victim);
        dmg = Math.round(amount * 0.5);
        victim.castLock = Math.max(victim.castLock || 0, 0.7);
        M.interruptDraw(victim);
      } else {
        victim.shield.hp -= amount;
        victim.shield.flash = 1;
        world.audio.shieldHit();
        P().burst(chestOf(victim, _v), { count: 6, color: 0x6ec3ff, speed: 4, size: 0.2, life: 0.35 });
        if (victim.shield.hp <= 0) M.popShield(victim, true);
        if (owned && victim.isLocal) world.hud.ticker('🛡 shield holding');
        return;
      }
    }

    if (!owned) {
      // visual feedback only; the owner's client applies real damage
      P().burst(chestOf(victim, _v), { count: 5, color: 0xffffff, speed: 3, size: 0.15, life: 0.3 });
      return;
    }

    victim.hp = clamp(victim.hp - dmg, 0, victim.maxHp);
    if (dmg > 0) {
      if (victim.channel) {
        victim.channel = null;
        world.audio.fizzle();
        if (victim.isLocal) world.hud.ticker('💔 heal broken!', '#ff6a5e');
        else world.hud.ticker(`${victim.name}'s heal broken!`, '#8fe08a');
      }
      if (kind === 'fire' && !victim.burning) victim.burning = { t: SPELLS.fireball.burnTime, dps: SPELLS.fireball.burnDps, acc: 0 };
      if (!silent) {
        world.hud.damageFloater(chestOf(victim, _v), dmg, kind);
        if (victim.isLocal) {
          world.shake(clamp(dmg / 26, 0.15, 0.6));
          world.hud.hurtFlash();
          world.audio.hurt();
        }
      }
      victim.hitReact = 0.25;
    }
    world.net?.sendDamage(victim, dmg, kind);
    if (victim.hp <= 0) {
      victim.alive = false;
      world.onDeath(victim, attacker);
    }
  };

  M.interruptDraw = (victim) => {
    if (victim.stroke && victim.stroke.active) {
      victim.stroke.active = false;
      victim.stroke.pts = [];
      victim.stroke.interrupted = 0.4;
      victim.castLock = Math.max(victim.castLock || 0, 0.6);
      if (victim.isLocal) { world.hud.ticker('⚡ your glyph was interrupted!', '#ffe66a'); world.shake(0.3); }
      else world.hud.ticker(`⚡ ${victim.name} interrupted!`, '#ffe66a');
      world.stats.interrupts++;
    }
    if (victim.ai) victim.ai.onInterrupted?.();
  };

  // ---------------- shield / mirror meshes ----------------

  function makeShieldMesh(color = 0x6ec3ff) {
    const g = new THREE.Group();
    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.25, 1),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    const fill = new THREE.Mesh(
      new THREE.SphereGeometry(1.18, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    g.add(wire, fill);
    return g;
  }

  M.giveShield = (w) => {
    M.popShield(w, false);
    const mesh = makeShieldMesh();
    world.scene.add(mesh);
    w.shield = { hp: SPELLS.shield.absorb, t: SPELLS.shield.duration, mesh, flash: 0 };
    world.audio.shieldUp();
  };

  M.popShield = (w, shattered) => {
    if (!w.shield) return;
    const pos = chestOf(w, _v.clone());
    world.scene.remove(w.shield.mesh);
    if (shattered) {
      P().burst(pos, { count: 26, color: 0x9fd4ff, speed: 9, size: 0.28, life: 0.7, gravity: 10 });
      world.audio.shatter();
    }
    w.shield = null;
  };

  M.shatterShield = (w) => {
    if (!w.shield) return;
    M.popShield(w, true);
    world.hud.ticker(w.isLocal ? '💥 YOUR SHIELD SHATTERED!' : `💥 ${w.name}'s shield shattered!`, '#ffd76a');
    world.slowmo(0.12);
    world.shake(0.4);
    world.stats.shatters++;
  };

  M.giveMirror = (w) => {
    if (w.mirror) world.scene.remove(w.mirror.mesh);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(1.05, 8),
      new THREE.MeshBasicMaterial({ color: 0xd8e6ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    world.scene.add(mesh);
    w.mirror = { t: SPELLS.mirror.duration, mesh };
    world.audio.mirrorUp();
  };

  // ---------------- casting ----------------

  // Returns { ok, sync? } — sync carries grab-target resolution for the net layer.
  M.cast = (caster, spellId, { dir = null, fromNet = false, sync = null, reflected = false } = {}) => {
    const spell = SPELLS[spellId];
    if (!spell) return { ok: false };
    if (!reflected && !fromNet) {
      if ((caster.cooldowns[spellId] || 0) > 0) return { ok: false, reason: 'cooldown' };
      if (caster.castLock > 0) return { ok: false, reason: 'locked' };
      caster.cooldowns[spellId] = spell.cooldown;
    }
    const aim = dir ? dir.clone().normalize() : forwardOf(caster, new THREE.Vector3());
    if (!fromNet && !reflected && !caster.ai && spell.kind !== 'shield' && spell.kind !== 'heal') M.assistAim(caster, aim);
    const origin = eyeOf(caster, new THREE.Vector3()).addScaledVector(aim, 0.7);
    let outSync = sync;

    switch (spellId) {
      case 'bolt': spawnBolt(caster, origin, aim, reflected); world.audio.castBolt(); break;
      case 'fireball': spawnFireball(caster, origin, aim, reflected); world.audio.castFire(); break;
      case 'boulder': spawnBoulder(caster, origin, aim, reflected); world.audio.castBoulder(); break;
      case 'lightning': castLightning(caster, aim); break;
      case 'shield': M.giveShield(caster); break;
      case 'mirror': M.giveMirror(caster); break;
      case 'heal':
        caster.channel = { t: 0, dur: spell.healTime, rate: spell.healAmount / spell.healTime };
        world.audio.healChime();
        break;
      case 'grab': outSync = castGrab(caster, aim, fromNet ? sync : null); break;
    }
    if (caster.isLocal) world.hud.onCast(spellId);
    return { ok: true, sync: outSync };
  };

  // ---------------- projectiles ----------------

  function baseProj(caster, origin, dirV, spell, mesh, opts = {}) {
    mesh.position.copy(origin);
    world.scene.add(mesh);
    const p = {
      spell: spell.id, kind: spell.kind, dmg: spell.dmg,
      casterId: caster.id, mesh, r: opts.r ?? 0.3,
      vel: dirV.clone().multiplyScalar(spell.speed * (opts.speedMul || 1)),
      gravity: opts.gravity ?? 0, life: opts.life ?? 4,
      reflected: opts.reflected || false, trailAcc: 0,
      onHit: opts.onHit || null, spin: opts.spin || null, emitter: opts.emitter || null,
    };
    M.projectiles.push(p);
    return p;
  }

  function spawnBolt(caster, origin, dir, reflected) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xbfefff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }));
    mesh.scale.set(1, 1, 2.6);
    baseProj(caster, origin, dir, SPELLS.bolt, mesh, { r: 0.28, life: 1.8, reflected });
  }

  function spawnFireball(caster, origin, dir, reflected) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff8a3c, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
    g.add(core, inner);
    const p = baseProj(caster, origin, dir, SPELLS.fireball, g, { r: 0.5, gravity: 2, life: 4, reflected });
    p.emitter = P().addFireEmitter(() => p.mesh.position, 99, 34, 0.7);
    p.onHit = (hitPos) => explodeFireball(p, hitPos);
  }

  function explodeFireball(p, at) {
    world.audio.boom(1);
    P().burst(at, { count: 26, color: 0xff9d4d, speed: 9, size: 0.4, life: 0.6, up: 3 });
    P().burst(at, { count: 12, color: 0xffe9b0, speed: 13, size: 0.25, life: 0.35 });
    P().smokePuff(at, 8, 0x3a3230);
    world.arena.scorch(at, 1.7);
    shakeByDistance(at, 0.5);
    // splash wizards (no friendly fire)
    const caster = world.wizardById(p.casterId);
    for (const w of world.wizards) {
      if (!w.alive || w.id === p.casterId || (caster && w.team === caster.team)) continue;
      const d = chestOf(w, _v).distanceTo(at);
      if (d < SPELLS.fireball.splash) {
        const fall = d < 1.4 ? 1 : 0.6;
        M.applyDamage(w, Math.round(p.dmg * fall), { kind: 'fire', attacker: world.wizardById(p.casterId) });
      }
    }
    // splash arena
    for (const obj of [...world.arena.objects.values()]) {
      const d = obj.pos.distanceTo(at);
      if (d < SPELLS.fireball.splash + obj.r) {
        world.arena.hitObject(obj.id, 10, { fire: true, dir: _dir.copy(obj.pos).sub(at).normalize() });
      }
    }
  }

  function spawnBoulder(caster, origin, dir, reflected) {
    const mesh = new THREE.Mesh(rockGeometry(makeRng((Math.random() * 1e9) >>> 0), 0.72), new THREE.MeshStandardMaterial({ color: 0xa79a86, flatShading: true, roughness: 1 }));
    mesh.castShadow = true;
    const p = baseProj(caster, origin, dir, SPELLS.boulder, mesh, {
      r: 0.8, gravity: 7, life: 5, reflected,
      spin: new THREE.Vector3(Math.random() * 6 - 3, 0, Math.random() * 6 - 3),
    });
    p.dropAsDebris = true;
    p.knockback = SPELLS.boulder.knockback;
  }

  function castLightning(caster, aim) {
    const from = eyeOf(caster, new THREE.Vector3()).addScaledVector(aim, 0.4);
    // prefer a wizard in the cone
    let victim = null, bestA = 13 * (Math.PI / 180);
    for (const e of world.enemiesOf(caster)) {
      if (!e.alive) continue;
      chestOf(e, _v).sub(from);
      const d = _v.length();
      if (d > 46) continue;
      const a = _v.normalize().angleTo(aim);
      if (a < bestA) { bestA = a; victim = e; }
    }
    let to;
    if (victim) to = chestOf(victim, new THREE.Vector3());
    else {
      to = from.clone().addScaledVector(aim, 34);
      // clip to ground
      if (to.y < 0.1) { const t = from.y / Math.max(from.y - to.y, 0.001); to.copy(from).lerp(to, Math.min(t, 1)); to.y = 0.1; }
      // strike destructibles near the line end
      let hitObj = null, hd = 2.2;
      for (const obj of world.arena.objects.values()) {
        const d = obj.pos.distanceTo(to);
        if (d < hd + obj.r) { hd = d; hitObj = obj; }
      }
      if (hitObj) {
        to.copy(hitObj.pos).y += 1;
        world.arena.hitObject(hitObj.id, 22, { fire: true, heavy: false, dir: aim });
      }
    }
    spawnLightningVisual(from, to);
    world.audio.lightning();
    world.arena.scorch(_v.set(to.x, 0, to.z), 1.1);
    shakeByDistance(to, 0.45);
    world.hud.flash(0.35);
    if (victim) {
      M.interruptDraw(victim);
      M.applyDamage(victim, SPELLS.lightning.dmg, { kind: 'zap', attacker: caster });
    }
  }

  function spawnLightningVisual(from, to) {
    const pts = [];
    const n = 9;
    const perp1 = new THREE.Vector3().subVectors(to, from).normalize();
    const perp2 = new THREE.Vector3(0, 1, 0).cross(perp1).normalize();
    const perp3 = perp1.clone().cross(perp2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = new THREE.Vector3().lerpVectors(from, to, t);
      if (i > 0 && i < n) {
        const j = Math.sin(t * Math.PI) * 0.9;
        p.addScaledVector(perp2, (Math.random() - 0.5) * 2 * j).addScaledVector(perp3, (Math.random() - 0.5) * 2 * j);
      }
      pts.push(p);
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.06, 4, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfff3a8, blending: THREE.AdditiveBlending, transparent: true, opacity: 1, depthWrite: false }));
    world.scene.add(mesh);
    const glow = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.2, 4, false),
      new THREE.MeshBasicMaterial({ color: 0xffe66a, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.35, depthWrite: false }));
    world.scene.add(glow);
    P().burst(to, { count: 14, color: 0xffe66a, speed: 7, size: 0.25, life: 0.4 });
    world.transients.push({ t: 0.22, tick: (k) => { mesh.material.opacity = 1 - k; glow.material.opacity = 0.35 * (1 - k); }, done: () => { world.scene.remove(mesh, glow); geo.dispose(); } });
  }

  // ---------------- grab ----------------

  function castGrab(caster, aim, netSync) {
    world.audio.castGrab();
    const eye = eyeOf(caster, new THREE.Vector3());
    let sync = netSync;
    if (!sync) {
      // resolve target: wizard in front & close → yeet the wizard
      let vict = null, bestA = 22 * (Math.PI / 180);
      for (const e of world.enemiesOf(caster)) {
        if (!e.alive || e.grabbedBy) continue;
        chestOf(e, _v).sub(eye);
        const d = _v.length();
        if (d > 13) continue;
        const a = _v.normalize().angleTo(aim);
        if (a < bestA) { bestA = a; vict = e; }
      }
      if (vict) sync = { wiz: vict.id };
      else {
        const g = world.arena.findGrabbable(caster.pos, 26);
        if (g) sync = { objId: g.id, objPos: [g.pos.x, g.pos.y, g.pos.z] };
        else {
          const at = caster.pos.clone().addScaledVector(_v.set(aim.x, 0, aim.z).normalize(), 3);
          sync = { rip: [at.x, at.z] };
        }
      }
    }

    if (sync.wiz) {
      const vict = world.wizardById(sync.wiz);
      if (vict && vict.alive) {
        if (vict.shield) {
          // shield blocks the grip
          world.audio.shieldHit();
          P().burst(chestOf(vict, _v), { count: 10, color: 0xc08bff, speed: 5, size: 0.25, life: 0.4 });
          world.hud.ticker('🛡 grip repelled by shield');
        } else {
          // only the victim's owner runs the lift/fling machine; other clients
          // mirror it via the net state flag
          if (world.ownsWizard(vict)) {
            vict.grabbedBy = { by: caster.id, t: 0, phase: 'lift', dir: aim.clone(), baseY: vict.pos.y };
            M.interruptDraw(vict);
          }
          if (vict.isLocal) world.hud.ticker('🌀 you are SEIZED!', '#c08bff');
          else world.hud.ticker(`🌀 ${vict.name} seized!`, '#c08bff');
        }
      }
      return sync;
    }

    let taken = null;
    if (sync.objId) {
      const ref = world.arena.resolveGrabRef(sync.objId);
      if (ref) {
        if (sync.objPos) ref.pos.set(sync.objPos[0], sync.objPos[1], sync.objPos[2]); // snap to caster's view of it
        taken = world.arena.takeGrabbable(ref);
      }
    }
    if (!taken) {
      const at = sync.rip ? _v.set(sync.rip[0], 0, sync.rip[1]) : caster.pos.clone().addScaledVector(aim, 3);
      taken = world.arena.ripRock({ x: at.x, z: at.z });
    }
    if (taken) {
      taken.mesh.castShadow = true;
      const p = {
        spell: 'grab', kind: 'heavy', dmg: SPELLS.grab.dmg, casterId: caster.id,
        mesh: taken.mesh, r: Math.max(taken.r, 0.45), vel: new THREE.Vector3(),
        gravity: 0, life: 8, phase: 'float', floatT: 0, aim: aim.clone(),
        spin: new THREE.Vector3(2, 3, 1), dropAsDebris: true, knockback: 8, trailColor: 0xc08bff, trailAcc: 0,
      };
      if (!taken.mesh.parent) world.scene.add(taken.mesh);
      M.projectiles.push(p);
    }
    return sync;
  }

  // ---------------- helpers ----------------

  function shakeByDistance(at, base) {
    const me = world.localWizard;
    if (!me) { world.shake(base * 0.6); return; }
    const d = me.pos.distanceTo(at);
    world.shake(base * clamp(1.6 - d / 18, 0.1, 1));
  }

  function impactFx(p, at) {
    const spell = SPELLS[p.spell];
    const color = spell ? spell.color : 0xffffff;
    P().burst(at, { count: 10, color, speed: 6, size: 0.25, life: 0.4 });
    if (p.kind === 'heavy') {
      P().dust(at, 12, 0x8a7a5e, 1);
      world.audio.thud();
      world.arena.scorch(_v.set(at.x, 0, at.z), 1.2);
      shakeByDistance(at, 0.45);
    }
  }

  function removeProj(p) {
    if (p.emitter) p.emitter.dead = true;
    const i = M.projectiles.indexOf(p);
    if (i >= 0) M.projectiles.splice(i, 1);
    if (!p.keepMesh) world.scene.remove(p.mesh);
  }

  function landAsDebris(p) {
    p.keepMesh = true;
    world.arena.addDebris(p.mesh, p.vel.clone().multiplyScalar(0.3), p.r * 0.9);
    removeProj(p);
  }

  // ---------------- update ----------------

  M.update = (dt) => {
    // wizard status effects
    for (const w of world.wizards) {
      for (const k in w.cooldowns) if (w.cooldowns[k] > 0) w.cooldowns[k] -= dt;
      if (w.castLock > 0) w.castLock -= dt;
      if (w.stroke.interrupted > 0) w.stroke.interrupted -= dt;
      if (w.hitReact > 0) w.hitReact -= dt;

      if (w.shield) {
        w.shield.t -= dt;
        chestOf(w, w.shield.mesh.position);
        const pulse = 1 + Math.sin(world.time * 6) * 0.03 + (w.shield.flash > 0 ? w.shield.flash * 0.15 : 0);
        w.shield.mesh.scale.setScalar(pulse);
        w.shield.flash = Math.max(0, (w.shield.flash || 0) - dt * 4);
        w.shield.mesh.rotation.y += dt * 0.7;
        if (w.shield.t <= 0) M.popShield(w, false);
      }
      if (w.mirror) {
        w.mirror.t -= dt;
        forwardOf(w, _dir);
        chestOf(w, w.mirror.mesh.position).addScaledVector(_dir.setY(0).normalize(), 1.25);
        w.mirror.mesh.lookAt(chestOf(w, _v));
        w.mirror.mesh.rotation.z += dt * 2;
        w.mirror.mesh.material.opacity = 0.25 + Math.sin(world.time * 14) * 0.12;
        if (w.mirror.t <= 0) { world.scene.remove(w.mirror.mesh); w.mirror = null; }
      }
      if (w.channel && w.alive) {
        w.channel.t += dt;
        if (world.ownsWizard(w)) {
          w.hp = clamp(w.hp + w.channel.rate * dt, 0, w.maxHp);
        }
        if (Math.random() < dt * 22) {
          P().spawn({
            x: w.pos.x + (Math.random() - 0.5) * 0.9, y: w.pos.y + Math.random() * 1.6, z: w.pos.z + (Math.random() - 0.5) * 0.9,
            vx: 0, vy: 1.6, vz: 0, life: 0.8, size: 0.2, color: 0x8fe08a, gravity: -1, drag: 0.2,
          });
        }
        if (w.channel.t >= w.channel.dur) { w.channel = null; if (w.isLocal) world.hud.ticker('💚 mended', '#8fe08a'); }
      }
      if (w.burning && w.alive) {
        w.burning.t -= dt;
        w.burning.acc += w.burning.dps * dt;
        if (Math.random() < dt * 16) {
          P().spawn({ x: w.pos.x, y: w.pos.y + 1 + Math.random(), z: w.pos.z, vx: 0, vy: 2, vz: 0, life: 0.5, size: 0.28, color: 0xff8a3c, gravity: -2, drag: 0.3 });
        }
        if (w.burning.acc >= 1) {
          const chunk = Math.floor(w.burning.acc);
          w.burning.acc -= chunk;
          M.applyDamage(w, chunk, { kind: 'burn', silent: true });
        }
        if (w.burning.t <= 0) w.burning = null;
      }
      // grabbed / flung state machine (owner-simulated; remote copies just lerp)
      if (w.grabbedBy && world.ownsWizard(w)) {
        const g = w.grabbedBy;
        g.t += dt;
        if (g.phase === 'lift') {
          w.pos.y = g.baseY + Math.min(g.t / 0.75, 1) * 3.4;
          w.vel.set(0, 0, 0);
          if (Math.random() < dt * 30) P().burst(chestOf(w, _v), { count: 1, color: 0xc08bff, speed: 2, size: 0.2, life: 0.4 });
          if (g.t >= 0.8) {
            g.phase = 'flung';
            const caster = world.wizardById(g.by);
            const dir = caster ? chestOf(w, _v).sub(eyeOf(caster, _v2)).setY(0).normalize() : g.dir.clone().setY(0).normalize();
            w.vel.copy(dir).multiplyScalar(19);
            w.vel.y = 5.5;
            w.flung = true;
            w.grabbedBy = null;
            world.audio.fling();
            world.stats.yeets++;
          }
        }
      }
    }

    // transient effects
    for (let i = world.transients.length - 1; i >= 0; i--) {
      const tr = world.transients[i];
      tr.age = (tr.age || 0) + dt;
      const k = Math.min(tr.age / tr.t, 1);
      tr.tick?.(k);
      if (k >= 1) { tr.done?.(); world.transients.splice(i, 1); }
    }

    // projectiles
    for (let i = M.projectiles.length - 1; i >= 0; i--) {
      const p = M.projectiles[i];
      p.life -= dt;
      if (p.life <= 0) { removeProj(p); continue; }

      if (p.phase === 'float') {
        // grabbed object rises toward the caster's aim anchor, then launches
        p.floatT += dt;
        const caster = world.wizardById(p.casterId);
        if (!caster || !caster.alive) { landAsDebris(p); continue; }
        const anchor = eyeOf(caster, _v).addScaledVector(forwardOf(caster, _v2), 2.4);
        anchor.y += 0.6;
        p.mesh.position.lerp(anchor, Math.min(dt * 6, 1));
        p.mesh.rotation.y += dt * 6;
        if (p.trailAcc !== undefined && (p.trailAcc += dt) > 0.03) {
          p.trailAcc = 0;
          P().spawn({ x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, vx: 0, vy: 0.5, vz: 0, life: 0.4, size: 0.24, color: 0xc08bff, drag: 1 });
        }
        if (p.floatT >= 0.6) {
          p.phase = 'fly';
          const dir = forwardOf(caster, new THREE.Vector3());
          M.assistAim(caster, dir);
          p.vel.copy(dir).multiplyScalar(SPELLS.grab.speed);
          p.gravity = 4;
          world.audio.fling();
        }
        continue;
      }

      p.vel.y -= (p.gravity || 0) * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.spin) {
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
      } else {
        p.mesh.lookAt(_v.copy(p.mesh.position).add(p.vel));
      }
      // spark trail
      if ((p.trailAcc += dt) > 0.035) {
        p.trailAcc = 0;
        const c = p.trailColor || (SPELLS[p.spell]?.color ?? 0xffffff);
        P().spawn({ x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, vx: 0, vy: 0, vz: 0, life: 0.3, size: 0.16, color: c, drag: 0 });
      }

      const pos = p.mesh.position;
      let dead = false;

      // out of bounds
      if (pos.length() > ARENA_RADIUS + 30 || pos.y < -3) { removeProj(p); continue; }

      // wizards (mirror check first; no friendly fire)
      const pCaster = world.wizardById(p.casterId);
      for (const w of world.wizards) {
        if (!w.alive || w.id === p.casterId || (pCaster && w.team === pCaster.team)) continue;
        chestOf(w, _v);
        const d = _v.distanceTo(pos);
        if (w.mirror && p.spell !== 'grab' && d < 2.1 && p.vel.dot(_v2.copy(_v).sub(pos)) > 0) {
          // reflected!
          const back = world.wizardById(p.casterId);
          const target = back ? chestOf(back, new THREE.Vector3()) : pos.clone().sub(p.vel);
          p.vel.copy(target.sub(pos).normalize()).multiplyScalar(p.vel.length() * 1.1);
          p.casterId = w.id;
          p.dmg = Math.round(p.dmg * 1.2);
          p.reflected = true;
          p.life = Math.max(p.life, 2.5);
          world.audio.reflect();
          world.hud.flash(0.2);
          P().burst(pos, { count: 12, color: 0xd8e6ff, speed: 6, size: 0.22, life: 0.4 });
          world.hud.ticker(w.isLocal ? '🪞 REFLECTED!' : `🪞 ${w.name} reflected it!`, '#d8e6ff');
          world.stats.reflects++;
          break;
        }
        if (d < 0.95 + p.r * 0.5) {
          impactFx(p, pos);
          if (p.knockback && world.ownsWizard(w)) {
            _dir.copy(p.vel).setY(0).normalize();
            w.vel.addScaledVector(_dir, p.knockback);
            w.vel.y += 4;
          }
          M.applyDamage(w, p.dmg, { kind: p.kind, attacker: world.wizardById(p.casterId) });
          if (p.kind === 'heavy') { world.slowmo(0.08); }
          if (p.onHit) p.onHit(pos.clone());
          removeProj(p);
          dead = true;
          break;
        }
      }
      if (dead) continue;

      // arena statics/destructibles
      const hitCol = world.arena.collideSphere(pos, p.r * 0.8);
      if (hitCol) {
        _dir.copy(p.vel).normalize();
        if (hitCol.objId) {
          world.arena.hitObject(hitCol.objId, p.kind === 'heavy' ? 40 : p.kind === 'fire' ? 14 : p.dmg,
            { dir: _dir.clone(), fire: p.kind === 'fire', heavy: p.kind === 'heavy' });
        }
        impactFx(p, pos);
        if (p.onHit) { p.onHit(pos.clone()); removeProj(p); }
        else if (p.dropAsDebris) landAsDebris(p);
        else removeProj(p);
        continue;
      }

      // ground
      if (pos.y - p.r * 0.5 <= 0.02) {
        pos.y = Math.max(pos.y, p.r * 0.5);
        if (p.onHit) { p.onHit(pos.clone()); removeProj(p); }
        else if (p.dropAsDebris) { impactFx(p, pos); landAsDebris(p); }
        else { impactFx(p, pos); removeProj(p); }
      }
    }
  };

  return M;
}
