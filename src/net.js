// PeerJS networking. No backend: host opens a peer with a short room code,
// guest dials it. Each client owns its wizard (and the host owns all AI);
// owners are authoritative for their wizards' hp/position. Everyone simulates
// every projectile locally for instant feedback, and stroke points stream in
// real time so you can watch your rival draw.
//
// The world is created *after* the handshake, so the net binds to it late
// via N.bindWorld(world).

import Peer from 'peerjs';
import * as THREE from 'three';

const peerId = (code) => `wzrdduel-${code}`;

export function createNet({ role, code, mode, name, onReady, onPeerLeft, onError, onStatus }) {
  const N = { role, code, mode, connected: false, conn: null, peer: null, world: null };
  let stateTimer = 0;
  const _dir = new THREE.Vector3();
  const W = () => N.world;

  N.bindWorld = (world) => { N.world = world; };

  const peer = new Peer(role === 'host' ? peerId(code) : undefined, { debug: 0 });
  N.peer = peer;

  peer.on('error', (err) => {
    if (N.connected && (err.type === 'network' || err.type === 'disconnected')) return;
    onError?.(err.type === 'unavailable-id' ? 'That code is taken — host again for a fresh one.'
      : err.type === 'peer-unavailable' ? 'No summoning circle found for that code.'
      : `Connection trouble (${err.type || 'unknown'})`);
  });

  function wireConn(conn) {
    N.conn = conn;
    conn.on('data', onMessage);
    conn.on('close', () => { if (N.connected) { N.connected = false; onPeerLeft?.(); } });
    conn.on('error', () => { if (N.connected) { N.connected = false; onPeerLeft?.(); } });
  }

  if (role === 'host') {
    peer.on('open', () => onStatus?.('open'));
    peer.on('connection', (conn) => {
      if (N.conn) { conn.close(); return; }
      wireConn(conn);
    });
  } else {
    peer.on('open', () => {
      onStatus?.('dialing');
      const conn = peer.connect(peerId(code), { reliable: true });
      wireConn(conn);
      conn.on('open', () => send({ t: 'hi', name }));
    });
  }

  const send = (msg) => { if (N.conn && N.conn.open) N.conn.send(msg); };

  function onMessage(msg) {
    const world = W();
    switch (msg.t) {
      case 'hi': { // host receives guest hello → lock in the match
        const seed = (Math.random() * 0xffffffff) >>> 0;
        const cfg = { seed, mode, hostName: name, guestName: msg.name || 'Rival' };
        send({ t: 'start', ...cfg });
        N.connected = true;
        onReady?.(cfg);
        break;
      }
      case 'start': {
        N.connected = true;
        onReady?.(msg);
        break;
      }
      case 'st': {
        if (!world) break;
        for (const s of msg.w) {
          const w = world.wizardById(s.id);
          if (!w || world.ownsWizard(w)) continue;
          if (!w.netTarget) w.netTarget = { pos: new THREE.Vector3().copy(w.pos), yaw: w.yaw, pitch: 0 };
          w.netTarget.pos.set(s.p[0], s.p[1], s.p[2]);
          w.netTarget.yaw = s.y; w.netTarget.pitch = s.pi || 0;
          w.hp = s.hp;
          if (w.alive && !s.al) { w.alive = false; world.onDeath(w, null, true); }
          w.netFlags = { moving: s.mv, channeling: s.ch, grabbed: s.gr };
          // mirror the owner's grab state so targeting rules stay correct here
          if (s.gr && !w.grabbedBy) w.grabbedBy = { by: null, t: 0, phase: 'net' };
          else if (!s.gr && w.grabbedBy) w.grabbedBy = null;
          if (s.sh && !w.shield) world.magic.giveShield(w);
          if (!s.sh && w.shield) world.magic.popShield(w, false);
          if (!s.mi && w.mirror) { world.scene.remove(w.mirror.mesh); w.mirror = null; }
        }
        break;
      }
      case 'dr': {
        const w = world?.wizardById(msg.id);
        if (!w || world.ownsWizard(w)) break;
        if (msg.done) { w.stroke.active = false; w.stroke.pts = []; world.strokes.clear(w); }
        else {
          w.stroke.active = true;
          w.stroke.pts = msg.p.map(([x, y]) => ({ x, y }));
          w.stroke.dirty = true;
        }
        break;
      }
      case 'cast': {
        const w = world?.wizardById(msg.id);
        if (!w || !w.alive) break;
        w.stroke.active = false;
        _dir.set(msg.d[0], msg.d[1], msg.d[2]);
        world.magic.cast(w, msg.s, { dir: _dir, fromNet: true, sync: msg.sync });
        const spell = world.spells[msg.s];
        world.strokes.flashCast(w, spell.glyph, spell.color);
        break;
      }
      case 'dmg': {
        const w = world?.wizardById(msg.id);
        if (!w || world.ownsWizard(w)) break;
        const before = w.hp;
        w.hp = msg.hp;
        if (msg.a > 0 && before > msg.hp) world.hud.damageFloater(world.magic.chestOf(w), msg.a, msg.k);
        if (w.alive && msg.hp <= 0) { w.alive = false; world.onDeath(w, null, true); }
        break;
      }
      case 'ign': world?.arena.hitObject(msg.id, 1, { fire: true }, true); break;
      case 'taunt': {
        const w = world?.wizardById(msg.id);
        if (w) world.hud.speech(w, msg.text);
        break;
      }
      case 'round': world?.onNetRound?.(msg); break;
      case 'bye': N.connected = false; onPeerLeft?.(); break;
    }
  }

  // ---------- outgoing ----------
  N.sendDraw = (w, done = false) => {
    if (!N.connected) return;
    if (done) send({ t: 'dr', id: w.id, done: true });
    else send({ t: 'dr', id: w.id, p: w.stroke.pts.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]) });
  };

  N.sendCast = (w, spell, dir, sync) => {
    if (!N.connected) return;
    send({ t: 'cast', id: w.id, s: spell, d: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)], sync });
  };

  N.sendDamage = (w, amount, kind) => {
    if (!N.connected) return;
    send({ t: 'dmg', id: w.id, hp: Math.round(w.hp * 10) / 10, a: amount, k: kind });
  };

  N.sendTaunt = (w, text) => send({ t: 'taunt', id: w.id, text });
  N.sendRound = (data) => send({ t: 'round', ...data });
  N.sendIgnite = (id) => send({ t: 'ign', id });

  N.update = (rdt) => {
    if (!N.connected || !N.world) return;
    stateTimer -= rdt;
    if (stateTimer > 0) return;
    stateTimer = 1 / 15;
    const world = N.world;
    const bundle = [];
    for (const w of world.wizards) {
      if (!world.ownsWizard(w)) continue;
      bundle.push({
        id: w.id,
        p: [+w.pos.x.toFixed(2), +w.pos.y.toFixed(2), +w.pos.z.toFixed(2)],
        y: +w.yaw.toFixed(3), pi: +(w.pitch || 0).toFixed(3),
        hp: Math.round(w.hp * 10) / 10, al: w.alive,
        sh: !!w.shield, mi: !!w.mirror, ch: !!w.channel, gr: !!w.grabbedBy,
        mv: w.vel.lengthSq() > 0.5,
      });
    }
    if (bundle.length) send({ t: 'st', w: bundle });
  };

  N.dispose = () => {
    try { send({ t: 'bye' }); } catch { /* ignore */ }
    N.connected = false;
    setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 150);
  };

  return N;
}
