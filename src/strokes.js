// Renders glyph strokes as glowing ribbons: yours floats in front of the
// camera; everyone else's floats over their wand, billboarded toward you —
// that's the telegraph you read to counter mid-draw.

import * as THREE from 'three';
import { resample, IDEALS } from './recognizer.js';

const MAX_PTS = 420;

// your own stroke lives on a screen-space canvas this far ahead of the camera
// (the hud pen cursor projects through the same constants)
export const LOCAL_DIST = 1.5;
export const LOCAL_SCALE = 0.62;

function makeRibbon(color, width) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX_PTS * 2 * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const idx = new Uint16Array((MAX_PTS - 1) * 6);
  for (let i = 0; i < MAX_PTS - 1; i++) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 950;
  mesh.frustumCulled = false;
  mesh.userData.width = width;
  return mesh;
}

function writeRibbon(mesh, pts, scale) {
  const geo = mesh.geometry;
  const arr = geo.attributes.position.array;
  const n = Math.min(pts.length, MAX_PTS);
  const w = mesh.userData.width;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[Math.min(i + 1, n - 1)];
    const r = pts[Math.max(i - 1, 0)];
    let dx = q.x - r.x, dy = q.y - r.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const px = -dy * w, py = dx * w;
    const x = p.x * scale, y = -p.y * scale;
    arr[i * 6] = x + px; arr[i * 6 + 1] = y + py; arr[i * 6 + 2] = 0;
    arr[i * 6 + 3] = x - px; arr[i * 6 + 4] = y - py; arr[i * 6 + 5] = 0;
  }
  geo.setDrawRange(0, n > 1 ? (n - 1) * 6 : 0);
  geo.attributes.position.needsUpdate = true;
}

export function createStrokes(world) {
  const entries = new Map(); // wizard.id -> entry
  const _white = new THREE.Color(0xffffff);
  const _tmp = new THREE.Color();

  function entryFor(w) {
    let e = entries.get(w.id);
    if (e) return e;
    const group = new THREE.Group();
    // dark ink halo behind the glow so glyphs read against bright sky;
    // the first-person stroke is much finer than the world telegraphs
    const ink = makeRibbon(0x0d0a18, w.isLocal ? 0.024 : 0.062);
    ink.material.blending = THREE.NormalBlending;
    ink.material.opacity = 0.5;
    ink.renderOrder = 948;
    const core = makeRibbon(0xffffff, w.isLocal ? 0.006 : 0.014);
    const glow = makeRibbon(0x88bbff, w.isLocal ? 0.016 : 0.04);
    glow.material.opacity = 0.3;
    group.add(ink, glow, core);
    if (w.isLocal) {
      ink.position.z = glow.position.z = core.position.z = -LOCAL_DIST;
      world.camera.add(group);
    } else {
      world.scene.add(group);
    }
    e = { group, core, glow, ink, morph: null, scale: w.isLocal ? LOCAL_SCALE : 1.05, fade: 0 };
    entries.set(w.id, e);
    return e;
  }

  const S = {};

  // recognized cast: snap the scribble to the ideal glyph, flash, dissolve
  S.flashCast = (w, glyph, colorHex) => {
    const e = entryFor(w);
    const src = w.stroke.pts.length >= 4 ? resample(w.stroke.pts, 48) : null;
    const ideal = IDEALS[glyph];
    if (!src || !ideal) { S.fizzle(w); return; }
    // map ideal (0..1 space) into the bbox of what was actually drawn
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of src) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const s = Math.max(maxX - minX, maxY - minY, 0.05);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const target = resample(ideal, 48).map((p) => ({ x: (p.x - 0.5) * s + cx, y: (p.y - 0.5) * s + cy }));
    e.morph = { src, target, t: 0, color: new THREE.Color(colorHex) };
  };

  S.fizzle = (w) => {
    const e = entryFor(w);
    e.fade = 0.35;
    e.core.material.color.set(0x777777);
    e.glow.material.color.set(0x444444);
  };

  S.clear = (w) => {
    const e = entries.get(w.id);
    if (e) {
      e.core.geometry.setDrawRange(0, 0);
      e.glow.geometry.setDrawRange(0, 0);
      e.ink.geometry.setDrawRange(0, 0);
      e.morph = null; e.fade = 0;
    }
  };

  S.remove = (w) => {
    const e = entries.get(w.id);
    if (e) { e.group.removeFromParent(); entries.delete(w.id); }
  };

  S.update = (dt) => {
    for (const w of world.wizards) {
      const e = entryFor(w);
      if (!w.isLocal) {
        // billboard others' strokes above their wand, facing the camera
        e.group.position.set(w.pos.x, w.pos.y + 2.2, w.pos.z);
        e.group.quaternion.copy(world.camera.quaternion);
        const d = world.camera.position.distanceTo(e.group.position);
        const k = Math.min(1 + d * 0.035, 2.4);
        e.group.scale.setScalar(k);
      }

      if (e.morph) {
        e.morph.t += dt * 6.5;
        const t = Math.min(e.morph.t, 1);
        const k = t * t * (3 - 2 * t);
        const pts = e.morph.src.map((p, i) => ({
          x: p.x + (e.morph.target[i].x - p.x) * k,
          y: p.y + (e.morph.target[i].y - p.y) * k,
        }));
        writeRibbon(e.core, pts, e.scale);
        writeRibbon(e.glow, pts, e.scale);
        writeRibbon(e.ink, pts, e.scale);
        e.core.material.color.lerpColors(_white, e.morph.color, k);
        e.glow.material.color.copy(e.morph.color);
        e.core.material.opacity = 1;
        e.glow.material.opacity = 0.5;
        if (e.morph.t > 1) { e.morph = null; e.fade = 0.3; }
        continue;
      }
      if (e.fade > 0) {
        e.fade -= dt;
        const k = Math.max(e.fade / 0.3, 0);
        e.core.material.opacity = k;
        e.glow.material.opacity = k * 0.4;
        e.ink.material.opacity = k * 0.5;
        if (e.fade <= 0) { S.clear(w); e.ink.material.opacity = 0.5; }
        continue;
      }
      if (w.stroke.active && w.stroke.pts.length > 1) {
        if (w.stroke.dirty) {
          w.stroke.dirty = false;
          writeRibbon(e.core, w.stroke.pts, e.scale);
          writeRibbon(e.glow, w.stroke.pts, e.scale);
          writeRibbon(e.ink, w.stroke.pts, e.scale);
        }
        _tmp.set(w.stroke.guessColor || 0xffffff);
        e.core.material.color.lerp(_tmp, 0.15);
        e.glow.material.color.set(0x88bbff).lerp(_tmp, 0.5);
        e.core.material.opacity = 0.95;
        e.glow.material.opacity = 0.32;
      } else if (!w.stroke.active) {
        e.core.geometry.setDrawRange(0, 0);
        e.glow.geometry.setDrawRange(0, 0);
        e.ink.geometry.setDrawRange(0, 0);
      }
    }
  };

  S.dispose = () => { for (const [, e] of entries) e.group.removeFromParent(); entries.clear(); };

  return S;
}
