// $1 Unistroke Recognizer (Wobbrock, Wilson, Li — UIST 2007), adapted:
//  - bounded rotation search (±45°) so N/Z-ish glyphs stay distinct
//  - aspect-preserving scale for thin strokes (lines) instead of scale-to-square
//  - shape-feature gates (closedness, corner count, total turning, self-intersection)
//    used as soft multipliers so sloppy drawings still pass
//  - straight-line precheck (a line is degenerate under $1 normalization)
// Stroke points are in "draw space": roughly [-1,1]², y-down.

import { GLYPH_TO_SPELL } from './spells.js';

const N = 64;               // resample count
const SIZE = 250;
const HALF_DIAG = 0.5 * Math.sqrt(2 * SIZE * SIZE);
const ANGLE_RANGE = Math.PI / 4;   // ±45°
const ANGLE_PRECISION = (2 * Math.PI) / 180;
const PHI = 0.5 * (-1 + Math.sqrt(5));

export const RECOGNIZE_THRESHOLD = 0.52;
export const GUESS_THRESHOLD = 0.45;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

// real mouse strokes have little "hooks" at press/release that poison the
// indicative angle — trim ~3.5% of path length off each end
function trimHooks(raw) {
  if (raw.length < 10) return raw;
  const pts = raw.slice();
  const cut = pathLength(pts) * 0.035;
  let acc = 0;
  while (pts.length > 8) {
    const d = dist(pts[0], pts[1]);
    if (acc + d > cut) break;
    acc += d; pts.shift();
  }
  acc = 0;
  while (pts.length > 8) {
    const d = dist(pts[pts.length - 2], pts[pts.length - 1]);
    if (acc + d > cut) break;
    acc += d; pts.pop();
  }
  return pts;
}

// light moving-average to knock down hand jitter before feature extraction
function smoothStroke(raw) {
  if (raw.length < 5) return raw;
  const out = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    out.push({
      x: (raw[i - 1].x + raw[i].x * 2 + raw[i + 1].x) / 4,
      y: (raw[i - 1].y + raw[i].y * 2 + raw[i + 1].y) / 4,
    });
  }
  out.push(raw[raw.length - 1]);
  return out;
}

export function resample(points, n = N) {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  const I = pathLength(pts) / (n - 1);
  if (I <= 1e-9) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= I && d > 0) {
      const t = (I - D) / d;
      const q = {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
      };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...out[out.length - 1] });
  out.length = n;
  return out;
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: Math.max(maxX - minX, 1e-9), h: Math.max(maxY - minY, 1e-9) };
}

function rotateBy(pts, angle) {
  const c = centroid(pts), cos = Math.cos(angle), sin = Math.sin(angle);
  return pts.map((p) => ({
    x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x,
    y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y,
  }));
}

function scaleAndTranslate(pts) {
  const b = bbox(pts);
  const thin = Math.min(b.w, b.h) / Math.max(b.w, b.h) < 0.22;
  const sx = thin ? SIZE / Math.max(b.w, b.h) : SIZE / b.w;
  const sy = thin ? SIZE / Math.max(b.w, b.h) : SIZE / b.h;
  const scaled = pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const c = centroid(scaled);
  return scaled.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

function indicativeAngle(pts) {
  const c = centroid(pts);
  return Math.atan2(c.y - pts[0].y, c.x - pts[0].x);
}

function processPoints(raw) {
  let pts = resample(raw, N);
  pts = rotateBy(pts, -indicativeAngle(pts));
  return scaleAndTranslate(pts);
}

function distanceAtAngle(pts, tmplPts, angle) {
  const rotated = rotateBy(pts, angle);
  let d = 0;
  for (let i = 0; i < rotated.length; i++) d += dist(rotated[i], tmplPts[i]);
  return d / rotated.length;
}

function distanceAtBestAngle(pts, tmplPts) {
  let a = -ANGLE_RANGE, b = ANGLE_RANGE;
  let x1 = PHI * a + (1 - PHI) * b, f1 = distanceAtAngle(pts, tmplPts, x1);
  let x2 = (1 - PHI) * a + PHI * b, f2 = distanceAtAngle(pts, tmplPts, x2);
  while (Math.abs(b - a) > ANGLE_PRECISION) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = PHI * a + (1 - PHI) * b; f1 = distanceAtAngle(pts, tmplPts, x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = (1 - PHI) * a + PHI * b; f2 = distanceAtAngle(pts, tmplPts, x2); }
  }
  return Math.min(f1, f2);
}

// ---------- stroke features (soft gates) ----------

function strokeFeatures(raw) {
  const b = bbox(raw);
  const scale = 1 / Math.max(b.w, b.h);
  const norm = raw.map((p) => ({ x: (p.x - b.minX) * scale, y: (p.y - b.minY) * scale }));
  const r32 = resample(norm, 32);
  const diag = Math.hypot(Math.max(b.w, b.h) * scale, Math.min(b.w, b.h) * scale);
  const closed = dist(r32[0], r32[31]) < 0.35 * diag;

  // corners: sharp direction changes away from endpoints. Threshold sits well
  // above a circle's per-window curvature (~35°) so round shapes stay cornerless.
  let corners = 0;
  let skip = 0;
  for (let i = 3; i < 29; i++) {
    if (skip > 0) { skip--; continue; }
    const v1x = r32[i].x - r32[i - 3].x, v1y = r32[i].y - r32[i - 3].y;
    const v2x = r32[i + 3].x - r32[i].x, v2y = r32[i + 3].y - r32[i].y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 0.03 || l2 < 0.03) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    if (cos < Math.cos((56 * Math.PI) / 180)) { corners++; skip = 4; }
  }

  // total signed turning (degrees)
  let turn = 0;
  for (let i = 2; i < 32; i++) {
    const ax = r32[i - 1].x - r32[i - 2].x, ay = r32[i - 1].y - r32[i - 2].y;
    const bx = r32[i].x - r32[i - 1].x, by = r32[i].y - r32[i - 1].y;
    if (Math.hypot(ax, ay) < 0.008 || Math.hypot(bx, by) < 0.008) continue;
    turn += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  turn = (turn * 180) / Math.PI;

  return { closed, corners, turn: Math.abs(turn) };
}

const GATES = {
  line: () => 0.5, // lines are caught by the straightness precheck
  circle: (f) => (f.closed && f.turn > 230 && f.turn < 520 && f.corners <= 2 ? 1 : 0.8),
  caret: (f) => (!f.closed && f.corners >= 1 && f.corners <= 2 && f.turn < 240 ? 1 : 0.8),
  zigzag: (f) => (!f.closed && f.corners >= 2 && f.corners <= 4 ? 1 : 0.8),
  triangle: (f) => (f.closed && f.corners >= 1 && f.corners <= 4 ? 1 : 0.82),
  square: (f) => (f.closed && f.corners >= 2 && f.corners <= 5 ? 1 : 0.82),
  heart: (f) => (f.closed && f.turn > 230 ? 1 : 0.82),
  spiral: (f) => (f.turn > 430 ? 1 : 0.6),
};

// ---------- glyph ideals & templates ----------

function samplePolyline(verts, n = N) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < verts.length; i++) {
    const d = Math.hypot(verts[i][0] - verts[i - 1][0], verts[i][1] - verts[i - 1][1]);
    segs.push(d); total += d;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    let t = (k / (n - 1)) * total, i = 0;
    while (i < segs.length - 1 && t > segs[i]) { t -= segs[i]; i++; }
    const f = segs[i] > 0 ? Math.min(t / segs[i], 1) : 0;
    out.push({
      x: verts[i][0] + f * (verts[i + 1][0] - verts[i][0]),
      y: verts[i][1] + f * (verts[i + 1][1] - verts[i][1]),
    });
  }
  return out;
}

function normalizeUnit(pts) {
  const b = bbox(pts);
  const s = 1 / Math.max(b.w, b.h);
  const ox = (1 - b.w * s) / 2, oy = (1 - b.h * s) / 2;
  return pts.map((p) => ({ x: (p.x - b.minX) * s + ox, y: (p.y - b.minY) * s + oy }));
}

function circlePts(dir = 1, startFrac = 0) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = (startFrac + (dir * i) / (N - 1)) * Math.PI * 2 - Math.PI / 2;
    out.push({ x: 0.5 + 0.46 * Math.cos(a), y: 0.5 + 0.46 * Math.sin(a) });
  }
  return out;
}

function polygonPts(verts, startIdx = 0, dir = 1) {
  const n = verts.length;
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(verts[(startIdx + dir * i + n * 8) % n]);
  return samplePolyline(ring);
}

function heartPts(dir = 1) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = (dir * i * Math.PI * 2) / (N - 1);
    out.push({ x: 16 * Math.sin(t) ** 3, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
  }
  return normalizeUnit(out);
}

function spiralPts(chir = 1, outward = true) {
  const turns = 1.8;
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const a = chir * t * turns * Math.PI * 2;
    const r = 0.06 + 0.94 * t;
    out.push({ x: 0.5 + 0.5 * r * Math.cos(a), y: 0.5 + 0.5 * r * Math.sin(a) });
  }
  return outward ? out : out.slice().reverse();
}

const TRI = [[0.5, 0.05], [0.94, 0.9], [0.06, 0.9]];
const SQ = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
const ZIG_A = [[0, 0.72], [0.33, 0.2], [0.66, 0.72], [1, 0.2]];
const ZIG_B = [[0.72, 0.02], [0.22, 0.5], [0.56, 0.52], [0.14, 0.98]];
const ZIG_W = [[0, 0.7], [0.25, 0.2], [0.5, 0.7], [0.75, 0.2], [1, 0.7]];
const CARET = [[0.06, 0.9], [0.5, 0.08], [0.94, 0.9]];

// people draw round, un-notched hearts too — blend heart toward circle
function chubbyHeartPts(dir = 1) {
  const h = heartPts(dir);
  const c = circlePts(dir, 0);
  return normalizeUnit(h.map((p, i) => ({ x: p.x * 0.72 + c[i].x * 0.28, y: p.y * 0.72 + c[i].y * 0.28 })));
}

// Canonical shapes used for AI stroke replay & the post-cast "snap" morph.
export const IDEALS = {
  line: samplePolyline([[0.02, 0.55], [0.98, 0.45]]),
  circle: circlePts(1, 0),
  caret: samplePolyline(CARET),
  zigzag: samplePolyline(ZIG_A),
  triangle: polygonPts(TRI, 0, 1),
  square: polygonPts(SQ, 0, 1),
  heart: heartPts(1),
  spiral: normalizeUnit(spiralPts(1, true)),
};

const TEMPLATES = [];
function addTemplate(glyph, pts) {
  TEMPLATES.push({ glyph, pts: processPoints(pts) });
}

(function buildTemplates() {
  for (const dir of [1, -1]) {
    for (let s = 0; s < 8; s++) addTemplate('circle', circlePts(dir, s / 8));
    for (let s = 0; s < 3; s++) addTemplate('triangle', polygonPts(TRI, s, dir));
    for (let s = 0; s < 4; s++) addTemplate('square', polygonPts(SQ, s, dir));
    addTemplate('heart', heartPts(dir));
    addTemplate('heart', chubbyHeartPts(dir));
    addTemplate('spiral', normalizeUnit(spiralPts(dir, true)));
    addTemplate('spiral', normalizeUnit(spiralPts(dir, false)));
    const rev = (v) => (dir === 1 ? v : v.slice().reverse());
    addTemplate('zigzag', samplePolyline(rev(ZIG_A)));
    addTemplate('zigzag', samplePolyline(rev(ZIG_B)));
    addTemplate('zigzag', samplePolyline(rev(ZIG_W)));
    addTemplate('caret', samplePolyline(rev(CARET)));
    addTemplate('line', samplePolyline(rev([[0, 0.5], [1, 0.5]])));
    addTemplate('line', samplePolyline(rev([[0.5, 0], [0.5, 1]])));
  }
})();

// ---------- public API ----------

// Returns { glyph, spell, score, second } or null if unrecognizable.
export function recognizeStroke(input, { partial = false } = {}) {
  if (!input || input.length < 6) return null;
  const raw = smoothStroke(partial ? input : trimHooks(input));
  if (raw.length < 6) return null;
  const len = pathLength(raw);
  if (len < 0.16) return null;

  // straight-line precheck
  const chord = dist(raw[0], raw[raw.length - 1]);
  if (chord > 0.62 * len && len > 0.28) {
    const x0 = raw[0], x1 = raw[raw.length - 1];
    const cl = Math.max(chord, 1e-9);
    let maxDev = 0;
    for (const p of raw) {
      const dev = Math.abs((x1.x - x0.x) * (x0.y - p.y) - (x0.x - p.x) * (x1.y - x0.y)) / cl;
      if (dev > maxDev) maxDev = dev;
    }
    if (maxDev < Math.max(0.11 * len, 0.02)) {
      return { glyph: 'line', spell: GLYPH_TO_SPELL.line, score: 0.95, second: null };
    }
  }

  const feats = strokeFeatures(raw);
  const cand = processPoints(raw);
  let best = null, second = null;
  const bestPerGlyph = {};
  for (const t of TEMPLATES) {
    const d = distanceAtBestAngle(cand, t.pts);
    let score = 1 - d / HALF_DIAG;
    score *= (GATES[t.glyph] || (() => 1))(feats);
    if (!(t.glyph in bestPerGlyph) || score > bestPerGlyph[t.glyph]) bestPerGlyph[t.glyph] = score;
  }
  for (const [glyph, score] of Object.entries(bestPerGlyph)) {
    if (!best || score > best.score) { second = best; best = { glyph, score }; }
    else if (!second || score > second.score) second = { glyph, score };
  }
  if (!best) return null;
  // near-ties between look-alike glyphs: let stroke features cast the vote
  if (second && best.score - second.score < 0.09) {
    const pref = pairPrefer(best.glyph, second.glyph, feats);
    if (pref && pref !== best.glyph) best = { glyph: pref, score: best.score };
  }
  const thresh = partial ? GUESS_THRESHOLD : RECOGNIZE_THRESHOLD;
  // accept below-threshold matches when they clearly beat the runner-up —
  // a decisive-but-sloppy glyph should cast, not fizzle
  const margin = second ? best.score - second.score : 1;
  const confident = !partial && best.score >= 0.44 && margin >= 0.07;
  if (best.score < thresh && !confident) return null;
  return { glyph: best.glyph, spell: GLYPH_TO_SPELL[best.glyph], score: best.score, second };
}

function pairPrefer(a, b, f) {
  const has = (x) => a === x || b === x;
  if (has('triangle') && has('square')) return f.corners >= 4 ? 'square' : f.corners <= 2 ? 'triangle' : null;
  if (has('circle') && has('heart')) return f.corners >= 1 ? 'heart' : 'circle';
  if (has('caret') && has('zigzag')) return f.corners >= 2 ? 'zigzag' : 'caret';
  if (has('circle') && has('spiral')) return f.turn > 430 ? 'spiral' : 'circle';
  return null;
}
