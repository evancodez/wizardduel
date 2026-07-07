// Arena: seeded low-poly world + every reactive/destructible thing in it.
// Layout is deterministic per seed so multiplayer peers build identical arenas.

import * as THREE from 'three';
import { makeRng } from './utils.js';

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95, metalness: 0, ...extra });

export const ARENA_RADIUS = 31;

const CLOTH_VERT = `
uniform float uTime;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  float hang = 1.0 - uv.y;
  p.z += sin(uTime * 2.1 + hang * 3.2 + uv.x * 2.0) * 0.14 * hang;
  p.x += sin(uTime * 1.3 + hang * 2.0) * 0.05 * hang;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const CLOTH_FRAG = `
uniform float uBurn;
uniform vec3 uColor;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float n = hash(floor(vUv * 14.0));
  float d = uBurn * 1.4 - ((1.0 - vUv.y) * 0.7 + n * 0.4);
  if (d > 0.1) discard;
  vec3 col = uColor * (0.75 + 0.25 * vUv.y);
  // painted gold emblem ring
  float ring = abs(distance(vUv, vec2(0.5, 0.55)) - 0.16);
  col = mix(vec3(1.0, 0.84, 0.42), col, smoothstep(0.03, 0.05, ring));
  // glowing burn edge
  float edge = smoothstep(0.1, -0.12, d);
  col = mix(vec3(1.0, 0.45, 0.1) * 1.6, col, edge);
  gl_FragColor = vec4(col, 1.0);
}`;

const SKY_VERT = `
varying vec3 vPos;
void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
varying vec3 vPos;
void main() {
  float h = normalize(vPos).y;
  vec3 top = vec3(0.13, 0.32, 0.72);
  vec3 mid = vec3(0.35, 0.62, 0.89);
  vec3 hor = vec3(0.82, 0.90, 0.93);
  vec3 col = h > 0.25 ? mix(mid, top, smoothstep(0.25, 0.9, h)) : mix(hor, mid, smoothstep(-0.05, 0.25, h));
  gl_FragColor = vec4(col, 1.0);
}`;

let scorchTexCache = null;
function scorchTexture() {
  if (scorchTexCache) return scorchTexCache;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(12,8,6,0.95)');
  grad.addColorStop(0.55, 'rgba(20,14,10,0.7)');
  grad.addColorStop(1, 'rgba(20,14,10,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // ragged blotches so it reads hand-painted
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 30;
    g.fillStyle = `rgba(10,7,5,${0.15 + Math.random() * 0.3})`;
    g.beginPath();
    g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 4 + Math.random() * 9, 0, 7);
    g.fill();
  }
  scorchTexCache = new THREE.CanvasTexture(c);
  return scorchTexCache;
}

export function rockGeometry(rng, r) {
  const geo = new THREE.IcosahedronGeometry(r, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * rng.range(0.75, 1.25), p.getY(i) * rng.range(0.6, 1.1), p.getZ(i) * rng.range(0.75, 1.25));
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildArena(world, seed) {
  const rng = makeRng(seed);
  const scene = world.scene;
  const A = {
    seed,
    objects: new Map(),   // id -> destructible
    colliders: [],        // {type, pos, r, half?, h?, objId?}
    debris: [],           // physics chunks
    clouds: [],
    scorches: [],
    burning: [],          // {obj?, getPos, t, dur, emitter, onDone}
    onEvent: null,        // (type, id, data) => {} set by game for net broadcast
  };
  let oid = 0;
  const newId = () => `o${oid++}`;

  // ---------- lights, sky, ground ----------
  scene.fog = new THREE.Fog(0xa8cfe0, 70, 160);
  const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x6a8f4f, 0.85);
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  sun.position.set(28, 42, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -48;
  sun.shadow.camera.right = sun.shadow.camera.top = 48;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0005;
  scene.add(hemi, sun, sun.target);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 16, 10),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(sky);

  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xf4f6f8, fog: false });
  for (let i = 0; i < 10; i++) {
    const w = rng.range(7, 16);
    const cloud = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, w * rng.range(0.45, 0.7)), cloudMat);
    cloud.rotation.y = rng.range(0, Math.PI);
    cloud.position.set(rng.range(-120, 120), rng.range(34, 60), rng.range(-120, 120));
    cloud.userData.vx = rng.range(0.4, 1.1);
    scene.add(cloud);
    A.clouds.push(cloud);
  }

  const groundGeo = new THREE.PlaneGeometry(190, 190, 56, 56);
  groundGeo.rotateX(-Math.PI / 2);
  {
    const p = groundGeo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c = new THREE.Color(), base = new THREE.Color(0x5c9e44), alt = new THREE.Color(0x6fae4e), dry = new THREE.Color(0x8fa04f);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const d = Math.hypot(x, z);
      p.setY(i, (rng() - 0.5) * (d < 8 ? 0.12 : 0.4) + (d > 55 ? (d - 55) * 0.12 : 0));
      const m = rng();
      c.copy(base).lerp(m > 0.6 ? alt : dry, rng() * 0.55);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // grass tufts
  {
    const tuftGeo = new THREE.ConeGeometry(0.09, 0.5, 4);
    const tuftMat = flat(0x3f7a33);
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 130);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < 130; i++) {
      const a = rng() * Math.PI * 2, d = 4 + rng() * 27;
      v.set(Math.cos(a) * d, 0.2, Math.sin(a) * d);
      q.setFromEuler(new THREE.Euler(rng.range(-0.2, 0.2), rng() * 3, rng.range(-0.2, 0.2)));
      s.setScalar(rng.range(0.7, 1.6));
      m.compose(v, q, s);
      tufts.setMatrixAt(i, m);
    }
    scene.add(tufts);
  }

  // ---------- helpers ----------
  function addCollider(c) { A.colliders.push(c); return c; }
  function registerObject(obj) { A.objects.set(obj.id, obj); return obj; }
  const emit = (type, id, data) => { if (A.onEvent) A.onEvent(type, id, data); };

  // ---------- perimeter cliffs ----------
  const cliffMat = flat(0x8a8f96);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng.range(-0.06, 0.06);
    const d = ARENA_RADIUS + 3.5 + rng.range(0, 3);
    const r = rng.range(2.2, 4.2);
    const rock = new THREE.Mesh(rockGeometry(rng, r), cliffMat);
    rock.position.set(Math.cos(a) * d, r * rng.range(0.15, 0.4), Math.sin(a) * d);
    rock.rotation.y = rng() * Math.PI;
    rock.castShadow = rock.receiveShadow = true;
    scene.add(rock);
  }

  // ---------- ruined castle (north edge) ----------
  const stoneMat = flat(0x9aa0a8);
  const stoneDark = flat(0x7d838c);
  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  function castleBlock(x, y, z, sx, sy, sz, { loose = false } = {}) {
    const mesh = new THREE.Mesh(blockGeo, rng() > 0.5 ? stoneMat : stoneDark);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rng.range(-0.04, 0.04);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const id = newId();
    const collider = addCollider({ type: 'box', pos: mesh.position, half: new THREE.Vector3(sx / 2, sy / 2, sz / 2), objId: loose ? id : null });
    if (loose) {
      registerObject({ id, kind: 'block', mesh, pos: mesh.position, r: Math.max(sx, sy, sz) * 0.6, hp: 24, collider, grabbable: true });
    }
    return mesh;
  }
  {
    const cz = -(ARENA_RADIUS - 5), cx = 0;
    // broken wall line
    for (let i = -4; i <= 4; i++) {
      if (Math.abs(i) === 1) continue; // gate gap
      const h = 2 + Math.abs(Math.sin(i * 2.3)) * 2.2;
      castleBlock(cx + i * 2.6, h / 2, cz, 2.5, h, 1.6);
      if (h > 3 && rng() > 0.35) castleBlock(cx + i * 2.6, h + 0.55, cz, 1.5, 1.1, 1.2, { loose: true });
    }
    // two towers
    for (const tx of [-12.5, 12.5]) {
      const th = tx < 0 ? 7 : 9;
      for (let lvl = 0; lvl < th / 1.6; lvl++) {
        castleBlock(cx + tx, lvl * 1.6 + 0.8, cz + 0.4, 3.1 - lvl * 0.12, 1.6, 3.1 - lvl * 0.12);
      }
      for (let c = 0; c < 3; c++) {
        castleBlock(cx + tx + (c - 1) * 1.05, th + 0.55, cz + 0.4, 0.8, 1.1, 0.9, { loose: true });
      }
    }
    // fallen rubble in front
    for (let i = 0; i < 7; i++) {
      const rock = new THREE.Mesh(rockGeometry(rng, rng.range(0.5, 1)), stoneDark);
      rock.position.set(cx + rng.range(-13, 13), 0.3, cz + rng.range(2, 6));
      rock.castShadow = true;
      scene.add(rock);
      const id = newId();
      registerObject({ id, kind: 'smallrock', mesh: rock, pos: rock.position, r: 0.8, hp: 18, grabbable: true,
        collider: addCollider({ type: 'sphere', pos: rock.position, r: 0.8, objId: id }) });
    }
  }

  // ---------- trees ----------
  const trunkMat = flat(0x6e4a2f);
  function addTree(x, z, scale = 1) {
    const id = newId();
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28 * scale, 0.4 * scale, 2.2 * scale, 6), trunkMat);
    trunk.position.y = 1.1 * scale;
    g.add(trunk);
    const leafMat = flat(0x3d6b35);
    const levels = 3;
    for (let i = 0; i < levels; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry((1.7 - i * 0.42) * scale, 1.7 * scale, 7), leafMat);
      cone.position.y = (2.2 + i * 1.15) * scale;
      g.add(cone);
    }
    g.position.set(x, 0, z);
    g.rotation.y = rng() * Math.PI;
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(g);
    registerObject({
      id, kind: 'tree', mesh: g, pos: g.position, r: 1.9 * scale, scale, hp: 26, leafMat, burning: false, fallen: false,
      collider: addCollider({ type: 'cylinder', pos: g.position, r: 0.42 * scale, h: 5.5 * scale, objId: id }),
    });
  }
  for (let i = 0; i < 13; i++) {
    const a = rng() * Math.PI * 2, d = 12 + rng() * 17;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (z < -(ARENA_RADIUS - 11) && Math.abs(x) < 16) continue; // keep castle clear
    addTree(x, z, rng.range(0.8, 1.5));
  }

  // ---------- rocks ----------
  const rockMat = flat(0x939aa4);
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2, d = 7 + rng() * 20;
    const r = rng.range(1.1, 2);
    const mesh = new THREE.Mesh(rockGeometry(rng, r), rockMat);
    mesh.position.set(Math.cos(a) * d, r * 0.45, Math.sin(a) * d);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const id = newId();
    registerObject({ id, kind: 'rock', mesh, pos: mesh.position, r: r * 1.05, hp: 34,
      collider: addCollider({ type: 'sphere', pos: mesh.position, r: r * 0.95, objId: id }) });
  }
  for (let i = 0; i < 8; i++) {
    const a = rng() * Math.PI * 2, d = 5 + rng() * 22;
    const r = rng.range(0.45, 0.75);
    const mesh = new THREE.Mesh(rockGeometry(rng, r), rockMat);
    mesh.position.set(Math.cos(a) * d, r * 0.5, Math.sin(a) * d);
    mesh.castShadow = true;
    scene.add(mesh);
    const id = newId();
    registerObject({ id, kind: 'smallrock', mesh, pos: mesh.position, r: r + 0.25, hp: 16, grabbable: true,
      collider: addCollider({ type: 'sphere', pos: mesh.position, r, objId: id }) });
  }

  // ---------- banners ----------
  function addBanner(x, z, color) {
    const id = newId();
    const g = new THREE.Group();
    const woodMat = flat(0x7a4a28);
    const post1 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 4.6, 5), woodMat);
    post1.position.set(-1.1, 2.3, 0);
    const post2 = post1.clone(); post2.position.x = 1.1;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 5), flat(0xa03c2e));
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 4.4;
    const clothMat = new THREE.ShaderMaterial({
      vertexShader: CLOTH_VERT, fragmentShader: CLOTH_FRAG,
      uniforms: { uTime: { value: 0 }, uBurn: { value: 0 }, uColor: { value: new THREE.Color(color) } },
      side: THREE.DoubleSide,
    });
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.6, 8, 12), clothMat);
    cloth.position.y = 3.05;
    g.add(post1, post2, bar, cloth);
    g.position.set(x, 0, z);
    g.lookAt(0, 0, 0);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(g);
    registerObject({ id, kind: 'banner', mesh: g, cloth, clothMat, pos: g.position, r: 2, hp: 10, burned: false });
  }
  addBanner(20, 14, 0x2c4fa3);
  addBanner(-20, 14, 0x2c4fa3);
  addBanner(16, -18, 0xa03c2e);
  addBanner(-16, -18, 0xa03c2e);

  // ---------- scorch decals ----------
  const scorchMat = new THREE.MeshBasicMaterial({ map: scorchTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  A.scorch = (pos, size = 1.6) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, size * 2), scorchMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI;
    m.position.set(pos.x, 0.03 + A.scorches.length * 0.0012, pos.z);
    scene.add(m);
    A.scorches.push(m);
    if (A.scorches.length > 60) {
      const old = A.scorches.shift();
      scene.remove(old);
      old.geometry.dispose();
    }
  };

  // ---------- debris physics ----------
  let debrisId = 0;
  A.addDebris = (mesh, vel, r, { grabbable = true, life = Infinity } = {}) => {
    const d = {
      id: `d${world.netTag || 'L'}${debrisId++}`, mesh, r,
      vel: vel.clone(),
      angVel: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      sleep: false, grabbable, life,
    };
    A.debris.push(d);
    if (A.debris.length > 110) {
      const old = A.debris.shift();
      scene.remove(old.mesh);
    }
    return d;
  };

  function shatterRock(obj, dir, chunks = 7) {
    scene.remove(obj.mesh);
    if (obj.collider) A.colliders.splice(A.colliders.indexOf(obj.collider), 1);
    obj.dead = true;
    const baseR = obj.r * 0.42;
    for (let i = 0; i < chunks; i++) {
      const r = baseR * (0.5 + Math.random() * 0.7);
      const m = new THREE.Mesh(rockGeometry(makeRng((seed + i * 977) >>> 0), r), obj.mesh.material);
      m.castShadow = true;
      m.position.copy(obj.pos).add(new THREE.Vector3((Math.random() - 0.5) * obj.r, Math.random() * obj.r * 0.7, (Math.random() - 0.5) * obj.r));
      scene.add(m);
      const v = new THREE.Vector3((Math.random() - 0.5) * 6, 3 + Math.random() * 5, (Math.random() - 0.5) * 6);
      if (dir) v.addScaledVector(dir, 4 + Math.random() * 3);
      A.addDebris(m, v, r);
    }
    world.particles.dust(obj.pos, 14, 0x8d939c, 1.1);
    world.particles.burst(obj.pos, { count: 10, color: 0xcfd4da, speed: 8, size: 0.2, life: 0.5 });
    world.audio.rockCrack();
    world.shake(obj.kind === 'rock' ? 0.35 : 0.2);
    world.stats.rocks++;
  }

  function dislodgeBlock(obj, impulse) {
    obj.dead = true;
    if (obj.collider) A.colliders.splice(A.colliders.indexOf(obj.collider), 1);
    A.objects.delete(obj.id);
    const v = impulse ? impulse.clone() : new THREE.Vector3(0, 4, 0);
    v.y = Math.max(v.y, 3.5);
    const d = A.addDebris(obj.mesh, v, obj.r);
    d.id = obj.id; // keep the deterministic id so peers can still reference it
    world.particles.dust(obj.pos, 10, 0xa8adb5, 1);
    world.audio.thud();
    world.shake(0.25);
    world.stats.rocks++;
  }

  function toppleTree(obj, dir) {
    if (obj.fallen) return;
    obj.fallen = true;
    obj.dead = true;
    if (obj.collider) A.colliders.splice(A.colliders.indexOf(obj.collider), 1);
    const d = dir && dir.lengthSq() > 0.01 ? dir.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
    obj.topple = { t: 0, axis: new THREE.Vector3(-d.z, 0, d.x), done: false };
    world.particles.burst(new THREE.Vector3(obj.pos.x, 2.5 * obj.scale, obj.pos.z), { count: 16, color: 0x3d6b35, speed: 5, size: 0.35, life: 0.8, smoke: true });
    world.stats.trees++;
  }

  function igniteObject(obj) {
    if (obj.kind === 'tree' && !obj.burning && !obj.fallen) {
      obj.burning = true;
      const top = () => new THREE.Vector3(obj.pos.x, 3.4 * obj.scale, obj.pos.z);
      const e = world.particles.addFireEmitter(top, 4.2, 30, obj.scale);
      A.burning.push({ obj, t: 0, dur: 3.8, emitter: e, onDone: () => toppleTree(obj, new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5)) });
      emit('ignite', obj.id, {});
    } else if (obj.kind === 'banner' && !obj.burned) {
      obj.burned = true;
      const at = () => new THREE.Vector3(obj.pos.x, 2.6, obj.pos.z);
      const e = world.particles.addFireEmitter(at, 2.8, 22, 0.9);
      A.burning.push({ obj, t: 0, dur: 2.6, emitter: e, isBanner: true });
      world.stats.banners++;
      emit('ignite', obj.id, {});
    }
  }

  // Damage a destructible. `opts.dir` = impulse direction, `opts.fire` = ignites,
  // `opts.heavy` = knocks blocks/trees immediately.
  A.hitObject = (id, dmg, opts = {}, fromNet = false) => {
    const obj = A.objects.get(id);
    if (!obj || obj.dead) return;
    obj.hp -= dmg;
    if (!fromNet) emit('hit', id, { dmg, dir: opts.dir ? [opts.dir.x, opts.dir.y, opts.dir.z] : null, fire: !!opts.fire, heavy: !!opts.heavy });
    if (opts.fire) igniteObject(obj);
    switch (obj.kind) {
      case 'rock':
      case 'smallrock':
        if (obj.hp <= 0) { shatterRock(obj, opts.dir, obj.kind === 'rock' ? 7 : 4); A.objects.delete(id); }
        else { world.particles.burst(obj.pos, { count: 5, color: 0xcfd4da, speed: 4, size: 0.15, life: 0.4 }); }
        break;
      case 'block':
        if (obj.hp <= 0 || opts.heavy) dislodgeBlock(obj, opts.dir ? opts.dir.clone().multiplyScalar(7) : null);
        break;
      case 'tree':
        if (opts.heavy || obj.hp <= 0) toppleTree(obj, opts.dir);
        break;
      case 'banner':
        if (opts.fire || dmg >= 12) igniteObject(obj);
        break;
    }
  };

  A.applyRemoteHit = (id, data) => {
    const dir = data.dir ? new THREE.Vector3(data.dir[0], data.dir[1], data.dir[2]) : null;
    A.hitObject(id, data.dmg, { dir, fire: data.fire, heavy: data.heavy }, true);
  };

  // rip a fresh rock out of the ground (Geist Grip fallback ammo)
  A.ripRock = (pos) => {
    const r = 0.55;
    const m = new THREE.Mesh(rockGeometry(makeRng((Math.random() * 1e9) >>> 0), r), rockMat);
    m.castShadow = true;
    m.position.set(pos.x, -0.3, pos.z);
    scene.add(m);
    A.scorch(pos, 0.9);
    world.particles.dust(pos, 12, 0x6b5a3e, 0.9);
    world.audio.thud();
    return { mesh: m, r };
  };

  A.findGrabbable = (pos, maxDist = 26) => {
    let best = null, bestD = maxDist;
    for (const obj of A.objects.values()) {
      if (!obj.grabbable || obj.dead) continue;
      const d = obj.pos.distanceTo(pos);
      if (d < bestD) { bestD = d; best = { type: 'obj', id: obj.id, pos: obj.pos, r: obj.r }; }
    }
    for (const d of A.debris) {
      if (!d.grabbable || d.r < 0.22) continue;
      const dd = d.mesh.position.distanceTo(pos);
      if (dd < bestD) { bestD = dd; best = { type: 'debris', id: d.id, pos: d.mesh.position, r: d.r }; }
    }
    return best;
  };

  // remove a grabbable from the sim and hand its mesh to the spell system
  A.takeGrabbable = (ref) => {
    if (ref.type === 'obj') {
      const obj = A.objects.get(ref.id);
      if (!obj || obj.dead) return null;
      obj.dead = true;
      A.objects.delete(ref.id);
      if (obj.collider) A.colliders.splice(A.colliders.indexOf(obj.collider), 1);
      return { mesh: obj.mesh, r: Math.min(obj.r, 0.9) };
    }
    const i = A.debris.findIndex((d) => d.id === ref.id);
    if (i < 0) return null;
    const d = A.debris.splice(i, 1)[0];
    return { mesh: d.mesh, r: d.r };
  };

  A.resolveGrabRef = (id) => {
    if (A.objects.has(id)) { const o = A.objects.get(id); return { type: 'obj', id, pos: o.pos, r: o.r }; }
    const d = A.debris.find((x) => x.id === id);
    return d ? { type: 'debris', id, pos: d.mesh.position, r: d.r } : null;
  };

  // sphere vs static colliders — used by movement and projectiles
  const _cv = new THREE.Vector3();
  A.collideSphere = (pos, r, out) => {
    for (const c of A.colliders) {
      if (c.type === 'sphere') {
        const dx = pos.x - c.pos.x, dy = pos.y - c.pos.y, dz = pos.z - c.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz, rr = r + c.r;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 1e-5;
          if (out) out.set(dx / d, dy / d, dz / d).multiplyScalar(rr - d);
          return c;
        }
      } else if (c.type === 'cylinder') {
        const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z;
        if (pos.y - r > c.pos.y + c.h) continue;
        const d2 = dx * dx + dz * dz, rr = r + c.r;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 1e-5;
          if (out) out.set(dx / d, 0, dz / d).multiplyScalar(rr - d);
          return c;
        }
      } else {
        // AABB (castle blocks are near-axis-aligned)
        _cv.set(
          Math.max(c.pos.x - c.half.x, Math.min(pos.x, c.pos.x + c.half.x)),
          Math.max(c.pos.y - c.half.y, Math.min(pos.y, c.pos.y + c.half.y)),
          Math.max(c.pos.z - c.half.z, Math.min(pos.z, c.pos.z + c.half.z)),
        );
        const dx = pos.x - _cv.x, dy = pos.y - _cv.y, dz = pos.z - _cv.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-5;
          if (out) out.set(dx / d, dy / d, dz / d).multiplyScalar(r - d);
          return c;
        }
      }
    }
    return null;
  };

  // ---------- per-frame update ----------
  let clothTime = 0;
  A.update = (dt) => {
    clothTime += dt;
    for (const obj of A.objects.values()) {
      if (obj.kind === 'banner') obj.clothMat.uniforms.uTime.value = clothTime;
    }
    for (const c of A.clouds) {
      c.position.x += c.userData.vx * dt;
      if (c.position.x > 130) c.position.x = -130;
    }
    // burning timers
    for (let i = A.burning.length - 1; i >= 0; i--) {
      const b = A.burning[i];
      b.t += dt;
      if (b.isBanner) {
        b.obj.clothMat.uniforms.uBurn.value = Math.min(b.t / b.dur, 1);
        if (b.t > b.dur) { b.obj.mesh.remove(b.obj.cloth); A.burning.splice(i, 1); A.scorch(b.obj.pos, 1.2); }
      } else {
        // tree: char the foliage
        b.obj.leafMat.color.lerp(new THREE.Color(0x2a2018), Math.min(dt * 1.2, 1));
        if (Math.random() < dt * 2) world.audio.burnLoopTick();
        if (b.t > b.dur) { A.burning.splice(i, 1); b.emitter.dead = true; if (b.onDone) b.onDone(); A.scorch(b.obj.pos, 2.2); }
      }
    }
    // toppling trees
    for (const obj of A.objects.values()) {
      if (obj.topple && !obj.topple.done) {
        obj.topple.t += dt * 1.4;
        const t = Math.min(obj.topple.t, 1);
        obj.mesh.setRotationFromAxisAngle(obj.topple.axis, t * t * (Math.PI / 2 - 0.06));
        if (t >= 1) {
          obj.topple.done = true;
          world.particles.dust(obj.pos, 16, 0x8a7a5e, 1.3);
          world.audio.thud();
          world.shake(0.3);
        }
      }
    }
    // debris
    for (let i = A.debris.length - 1; i >= 0; i--) {
      const d = A.debris[i];
      if (d.life !== Infinity) {
        d.life -= dt;
        if (d.life <= 0) { scene.remove(d.mesh); A.debris.splice(i, 1); continue; }
      }
      if (d.sleep) continue;
      d.vel.y -= 20 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.angVel.x * dt;
      d.mesh.rotation.y += d.angVel.y * dt;
      d.mesh.rotation.z += d.angVel.z * dt;
      if (d.mesh.position.y < d.r * 0.6) {
        d.mesh.position.y = d.r * 0.6;
        if (Math.abs(d.vel.y) > 3) world.particles.dust(d.mesh.position, 3, 0x8a7a5e, 0.6);
        d.vel.y *= -0.32;
        d.vel.x *= 0.6; d.vel.z *= 0.6;
        d.angVel.multiplyScalar(0.55);
        if (d.vel.lengthSq() < 0.35) { d.sleep = true; d.vel.set(0, 0, 0); }
      }
    }
  };

  return A;
}
