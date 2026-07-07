// Low-poly wizard built from primitives, plus the first-person hands rig.

import * as THREE from 'three';
import { clamp, damp } from './utils.js';

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95, metalness: 0, ...extra });

export function buildWizard({ robe = 0x8a2c2c, trim = 0xd8b45a, eyes = 0xffd76a } = {}) {
  const g = new THREE.Group();
  const cloth = flat(robe);
  const clothDark = flat(new THREE.Color(robe).multiplyScalar(0.72).getHex());
  const trimMat = flat(trim);

  const robeMesh = new THREE.Mesh(new THREE.ConeGeometry(0.58, 1.35, 7), cloth);
  robeMesh.position.y = 0.675;
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.09, 7), trimMat);
  belt.position.y = 0.95;
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.3, 7, 6), clothDark);
  hood.position.y = 1.52;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.22, 7, 6), flat(0x1c1522));
  face.position.set(0, 1.52, 0.12);
  const eyeGeo = new THREE.SphereGeometry(0.045, 5, 4);
  const eyeMat = new THREE.MeshBasicMaterial({ color: eyes });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.09, 1.55, 0.3);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.09, 1.55, 0.3);
  const hat = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.85, 7), cloth);
  cone.position.y = 0.46;
  cone.rotation.y = 0.4;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.56, 0.07, 8), clothDark);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.37, 0.1, 7), trimMat);
  band.position.y = 0.1;
  hat.add(brim, band, cone);
  hat.position.y = 1.74;
  hat.rotation.z = 0.06;

  const mkArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.36 * side, 1.18, 0.05);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.52, 5), cloth);
    arm.position.y = -0.26;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 5, 4), flat(0xe8c39a));
    hand.position.y = -0.55;
    pivot.add(arm, hand);
    pivot.rotation.z = -0.5 * side;
    return { pivot, hand };
  };
  const armL = mkArm(-1), armR = mkArm(1);

  const wand = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.62, 5), flat(0x4a3325));
  stick.position.y = 0.31;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4), new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
  tip.position.y = 0.62;
  wand.add(stick, tip);
  wand.position.y = -0.55;
  wand.rotation.x = Math.PI / 2.4;
  armR.pivot.add(wand);

  g.add(robeMesh, belt, hood, face, eyeL, eyeR, hat, armL.pivot, armR.pivot);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });

  const M = {
    group: g, hat, tip, eyeMat,
    bobT: Math.random() * 10,
    deadT: 0,
  };

  const _tipWorld = new THREE.Vector3();
  M.wandTipWorld = () => tip.getWorldPosition(_tipWorld);

  // pose driver — called every frame with the wizard's logical state
  M.animate = (dt, { moving = false, drawing = false, grabbed = false, dead = false, channeling = false } = {}) => {
    if (dead) {
      M.deadT = Math.min(M.deadT + dt * 2.2, 1);
      const t = M.deadT, e = 1 - (1 - t) * (1 - t);
      g.rotation.z = e * (Math.PI / 2 - 0.12);
      g.position.y = Math.max(g.position.y - 0.0, 0) - 0; // body pivots at feet
      hat.rotation.z = 0.06 + e * 1.4;
      hat.position.y = 1.74 + e * 0.25;
      return;
    }
    M.deadT = 0;
    g.rotation.z = 0;
    M.bobT += dt * (moving ? 9 : 2.2);
    const bob = Math.sin(M.bobT) * (moving ? 0.05 : 0.015);
    robeMesh.scale.y = 1 + bob * 0.5;
    hat.rotation.x = Math.sin(M.bobT * 0.7) * 0.04;
    if (grabbed) {
      g.rotation.x = Math.sin(M.bobT * 4) * 0.35;
      armL.pivot.rotation.z = 0.9 + Math.sin(M.bobT * 6) * 0.6;
      armR.pivot.rotation.z = -0.9 - Math.cos(M.bobT * 6) * 0.6;
      return;
    }
    g.rotation.x = damp(g.rotation.x, 0, 10, dt);
    const rTarget = drawing ? { z: -2.35, x: -0.45 } : channeling ? { z: -1.1, x: -0.9 } : { z: -0.5, x: 0 };
    const lTarget = drawing || channeling ? { z: 1.7, x: -0.5 } : { z: 0.5, x: 0 };
    armR.pivot.rotation.z = damp(armR.pivot.rotation.z, rTarget.z, 12, dt);
    armR.pivot.rotation.x = damp(armR.pivot.rotation.x, rTarget.x, 12, dt);
    armL.pivot.rotation.z = damp(armL.pivot.rotation.z, lTarget.z, 12, dt);
    armL.pivot.rotation.x = damp(armL.pivot.rotation.x, lTarget.x, 12, dt);
    tip.material.color.setHex(drawing ? 0xffffff : 0xffe9a8);
    const s = drawing ? 1.9 : 1;
    tip.scale.setScalar(damp(tip.scale.x, s, 10, dt));
  };

  return M;
}

// First-person view rig: hands + wand attached to the camera.
export function buildFirstPersonRig(camera, robe = 0x3b4b8f) {
  const root = new THREE.Group();
  camera.add(root);

  const sleeve = flat(robe);
  const skin = flat(0xe8c39a);

  const right = new THREE.Group();
  const rForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.42, 6), sleeve);
  rForearm.rotation.x = -1.1;
  rForearm.position.set(0, -0.1, 0.14);
  const rHand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), skin);
  const wand = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.5, 5), flat(0x4a3325));
  stick.position.y = 0.22;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
  tip.position.y = 0.47;
  wand.add(stick, tip);
  wand.rotation.x = -1.35;
  right.add(rForearm, rHand, wand);
  right.position.set(0.3, -0.32, -0.55);
  right.rotation.z = -0.15;

  const left = new THREE.Group();
  const lForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.4, 6), sleeve);
  lForearm.rotation.x = -1.2;
  lForearm.position.set(0, -0.12, 0.16);
  const lHand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 5), skin);
  lHand.scale.set(1, 0.8, 1.15);
  const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.09, 5), skin);
  thumb.position.set(0.07, 0.02, -0.02);
  thumb.rotation.z = -0.9;
  left.add(lForearm, lHand, thumb);
  left.position.set(-0.34, -0.42, -0.6);
  left.rotation.z = 0.2;

  root.add(right, left);

  const R = { root, tip, recoil: 0, bobT: 0 };
  const baseR = right.position.clone(), baseL = left.position.clone();
  const _v = new THREE.Vector3();
  R.wandTipWorld = () => tip.getWorldPosition(_v);
  R.kick = (amt = 1) => { R.recoil = Math.min(1.5, R.recoil + amt); };

  R.update = (dt, { moving = false, drawing = false, channeling = false } = {}) => {
    R.bobT += dt * (moving ? 11 : 3);
    R.recoil = Math.max(0, R.recoil - dt * 5);
    const bobY = Math.sin(R.bobT) * (moving ? 0.014 : 0.004);
    const bobX = Math.cos(R.bobT * 0.5) * (moving ? 0.008 : 0.002);
    // drawing: wand raised toward center, left palm lifted like the mockup
    const rx = drawing ? 0.17 : baseR.x;
    const ry = drawing ? -0.16 : baseR.y;
    const rz = drawing ? -0.52 : baseR.z;
    right.position.x = damp(right.position.x, rx + bobX, 14, dt);
    right.position.y = damp(right.position.y, ry + bobY + R.recoil * 0.09, 14, dt);
    right.position.z = damp(right.position.z, rz + R.recoil * 0.12, 14, dt);
    right.rotation.x = damp(right.rotation.x, (drawing ? 0.5 : 0) + R.recoil * 0.55, 14, dt);
    const lift = drawing || channeling;
    left.position.x = damp(left.position.x, lift ? -0.26 : baseL.x, 10, dt);
    left.position.y = damp(left.position.y, (lift ? -0.24 : baseL.y) + bobY, 10, dt);
    left.position.z = damp(left.position.z, lift ? -0.5 : baseL.z, 10, dt);
    left.rotation.x = damp(left.rotation.x, lift ? 0.9 : 0, 10, dt);
    tip.material.color.setHex(drawing ? 0xffffff : 0xffe9a8);
    tip.scale.setScalar(damp(tip.scale.x, drawing ? 1.8 : 1, 12, dt));
  };

  return R;
}
