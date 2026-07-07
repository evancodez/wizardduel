# ⚡ Wizard Duel — Scribble Sorcery

First-person wizard dueling in the browser. **Hold left-click and scrawl a glyph in the air — release to cast.** Your rival sees your glyph forming in real time (and you see theirs), so every fight is a mind-game of reads, counters, and feints while the arena gets smashed to pieces around you.

Built with three.js + a hand-rolled [$1 unistroke recognizer](https://depts.washington.edu/acelab/proj/dollar/index.html). Multiplayer over PeerJS (WebRTC) — no backend, deploys as a static site.

## Play

```bash
npm install
npm run dev     # local dev at http://localhost:5173
npm run build   # static build in dist/
```

**Deploy:** import the repo on [Vercel](https://vercel.com) (framework: Vite) — or any static host. Multiplayer works out of the box via the public PeerJS broker.

## Controls

| Input | Action |
|---|---|
| **Hold LMB + move mouse** | paint a glyph with your view (release = cast **at your crosshair**) |
| **Right-click while drawing** | cancel — great for feints |
| WASD / Space | move / jump |
| Esc | pause / release mouse |

You keep aiming while you draw — the glyph hangs in the air where you started it, and wherever you're looking on release is where the spell goes. Drawing slows your feet, not your eyes. Sloppy glyphs are fine — the wand forgives.

## The spellbook

Simpler glyph = weaker spell. Harder glyph = scarier spell.

| Glyph | Spell | What it does | Countered by |
|---|---|---|---|
| — line | **Spark** | fast weak bolt, interrupts heals | shield, mirror |
| ○ circle | **Aegis** | bubble, soaks 30 dmg / 4s | stone (shatters it + stuns) |
| ∧ caret | **Mirror** | 1s ward that reflects projectiles ×1.2 | lightning (pierces), the Grip |
| ⩗ zigzag | **Lightning** | instant strike, **interrupts a rival mid-draw** | shield |
| △ triangle | **Ember** | fireball: splash + burns wizards, trees, banners | shield, mirror |
| □ square | **Stone Maul** | slow, huge, **cracks shields**, knocks back | mirror (lol), sidestep |
| ♡ heart | **Mend** | +26 HP channel — breaks if you take a hit | any fast poke |
| ◎ spiral | **Geist Grip** | seize the nearest rock, wreckage, **or wizard** and hurl it | shield |

## Modes

- **Duel the Circle** — a 4-wizard single-player ladder. Each master has their own style, spell tastes, and trash talk. They telegraph their glyphs just like players — and the later ones read *yours* and counter.
- **Multiplayer duel** — host gets a 4-letter rune, rival joins with it. Best of 3. You watch each other draw in real time.
- **Multiplayer co-op** — two wizards vs escalating waves of the Circle.

## The arena fights back

Rocks shatter into grabbable debris, trees catch fire and topple, banners burn to their frames, castle blocks tumble, scorch marks accumulate, and everything that breaks becomes ammo for the Geist Grip. Kills hit slow-mo. Screen shake is a settings slider, as is right and proper.

## Tech notes

- **Recognition** — $1 recognizer with bounded rotation invariance (±45°), aspect-aware scaling for thin strokes, plus shape-feature gates (corner count, closedness, total turning angle) as soft multipliers. Straight lines are pre-classified geometrically. Templates are generated procedurally (multiple start points + both directions per glyph).
- **Netcode** — each client owns its wizard (host owns AI): owners are authoritative for their own HP/position; casts and stroke points are replicated and every projectile is simulated on both ends for zero-latency feel. Arenas are seeded per room code so both peers build identical worlds.
- **Everything is procedural** — no art or audio assets: models are three.js primitives, SFX are synthesized WebAudio, the sky/cloth/scorch are little shaders and canvases.

Run the built-in smoke tests with `?autotest` in the URL (plus `&nettest` to exercise PeerJS).
