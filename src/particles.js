// Pooled GPU point particles: one additive pool (sparks/magic/fire) and one
// alpha-blended pool (smoke/dust). Single draw call per pool.

import * as THREE from 'three';

const VERT = `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
varying vec3 vC; varying float vA;
void main() {
  vC = aColor; vA = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * (240.0 / -mv.z), 1.0, 120.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = (additive) => `
varying vec3 vC; varying float vA;
void main() {
  float d = distance(gl_PointCoord, vec2(0.5));
  float a = smoothstep(0.5, 0.14, d) * vA;
  if (a < 0.003) discard;
  gl_FragColor = ${additive ? 'vec4(vC * a, a)' : 'vec4(vC, a * 0.85)'};
}`;

function makePool(scene, max, additive) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const size = new Float32Array(max);
  const alpha = new Float32Array(max);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG(additive),
    transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  return {
    geo, max, n: 0,
    px: pos, col, size, alpha,
    vx: new Float32Array(max), vy: new Float32Array(max), vz: new Float32Array(max),
    life: new Float32Array(max), maxLife: new Float32Array(max),
    grav: new Float32Array(max), drag: new Float32Array(max),
    size0: new Float32Array(max), fadeIn: new Float32Array(max),
  };
}

export function createParticles(scene) {
  const add = makePool(scene, 4096, true);
  const nrm = makePool(scene, 2048, false);
  const emitters = [];
  const tmpColor = new THREE.Color();

  function spawnInto(p, o) {
    const i = p.n < p.max ? p.n++ : Math.floor(Math.random() * p.max);
    p.px[i * 3] = o.x; p.px[i * 3 + 1] = o.y; p.px[i * 3 + 2] = o.z;
    p.vx[i] = o.vx || 0; p.vy[i] = o.vy || 0; p.vz[i] = o.vz || 0;
    p.life[i] = p.maxLife[i] = o.life || 0.6;
    p.size0[i] = o.size || 0.3;
    p.grav[i] = o.gravity ?? 0;
    p.drag[i] = o.drag ?? 0.5;
    p.fadeIn[i] = o.fadeIn || 0;
    tmpColor.set(o.color ?? 0xffffff);
    p.col[i * 3] = tmpColor.r; p.col[i * 3 + 1] = tmpColor.g; p.col[i * 3 + 2] = tmpColor.b;
  }

  const P = {};
  P.spawn = (o) => spawnInto(o.smoke ? nrm : add, o);

  P.burst = (pos, { count = 12, color = 0xffcc66, speed = 6, size = 0.32, life = 0.55, gravity = 8, up = 2, smoke = false, drag = 1.5 } = {}) => {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, e = (Math.random() - 0.3) * Math.PI;
      const s = speed * (0.35 + Math.random() * 0.85);
      P.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * Math.cos(e) * s, vy: Math.abs(Math.sin(e)) * s + up, vz: Math.sin(a) * Math.cos(e) * s,
        life: life * (0.6 + Math.random() * 0.8), size: size * (0.7 + Math.random() * 0.7),
        color, gravity, smoke, drag,
      });
    }
  };

  P.dust = (pos, count = 10, color = 0x8a7a5e, size = 0.9) =>
    P.burst(pos, { count, color, speed: 3.5, size, life: 1.1, gravity: 1.2, smoke: true, up: 1.5, drag: 2 });
  P.smokePuff = (pos, count = 6, color = 0x444444) =>
    P.burst(pos, { count, color, speed: 1.6, size: 1.1, life: 1.6, gravity: -0.8, smoke: true, up: 1, drag: 1.5 });

  // continuous flame attached to a moving/static point
  P.addFireEmitter = (getPos, duration = 4, rate = 26, scale = 1) => {
    const e = { getPos, tleft: duration, rate, acc: 0, scale, dead: false };
    emitters.push(e);
    return e;
  };

  P.update = (dt) => {
    for (let k = emitters.length - 1; k >= 0; k--) {
      const e = emitters[k];
      e.tleft -= dt;
      if (e.dead || e.tleft <= 0) { emitters.splice(k, 1); continue; }
      e.acc += e.rate * dt;
      const pos = e.getPos();
      while (e.acc >= 1) {
        e.acc -= 1;
        const hot = Math.random();
        P.spawn({
          x: pos.x + (Math.random() - 0.5) * 0.7 * e.scale,
          y: pos.y + Math.random() * 0.4 * e.scale,
          z: pos.z + (Math.random() - 0.5) * 0.7 * e.scale,
          vx: (Math.random() - 0.5) * 0.8, vy: 1.6 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 0.8,
          life: 0.45 + Math.random() * 0.5, size: (0.35 + Math.random() * 0.45) * e.scale,
          color: hot > 0.6 ? 0xffd27a : hot > 0.25 ? 0xff8a3c : 0xe04b1f,
          gravity: -1.5, drag: 0.6,
        });
        if (Math.random() < 0.16) P.smokePuff({ x: pos.x, y: pos.y + 0.8 * e.scale, z: pos.z }, 1, 0x3a3a3a);
      }
    }
    for (const p of [add, nrm]) {
      for (let i = 0; i < p.n; i++) {
        p.life[i] -= dt;
        if (p.life[i] <= 0) {
          const j = --p.n;
          if (i !== j) {
            p.px[i * 3] = p.px[j * 3]; p.px[i * 3 + 1] = p.px[j * 3 + 1]; p.px[i * 3 + 2] = p.px[j * 3 + 2];
            p.vx[i] = p.vx[j]; p.vy[i] = p.vy[j]; p.vz[i] = p.vz[j];
            p.life[i] = p.life[j]; p.maxLife[i] = p.maxLife[j];
            p.size0[i] = p.size0[j]; p.grav[i] = p.grav[j]; p.drag[i] = p.drag[j]; p.fadeIn[i] = p.fadeIn[j];
            p.col[i * 3] = p.col[j * 3]; p.col[i * 3 + 1] = p.col[j * 3 + 1]; p.col[i * 3 + 2] = p.col[j * 3 + 2];
          }
          i--;
          continue;
        }
        const dr = Math.max(0, 1 - p.drag[i] * dt);
        p.vx[i] *= dr; p.vz[i] *= dr;
        p.vy[i] = p.vy[i] * dr - p.grav[i] * dt;
        p.px[i * 3] += p.vx[i] * dt;
        p.px[i * 3 + 1] += p.vy[i] * dt;
        p.px[i * 3 + 2] += p.vz[i] * dt;
        const t = p.life[i] / p.maxLife[i];
        const fin = p.fadeIn[i] > 0 ? Math.min(1, (p.maxLife[i] - p.life[i]) / p.fadeIn[i]) : 1;
        p.alpha[i] = Math.min(1, t * 1.8) * fin;
        p.size[i] = p.size0[i] * (0.5 + t * 0.7);
      }
      p.geo.setDrawRange(0, p.n);
      p.geo.attributes.position.needsUpdate = true;
      p.geo.attributes.aColor.needsUpdate = true;
      p.geo.attributes.aSize.needsUpdate = true;
      p.geo.attributes.aAlpha.needsUpdate = true;
    }
  };

  return P;
}
