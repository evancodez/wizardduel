// Spell definitions — the single source of truth for the counter web.
// Glyph difficulty scales with power: line < circle < caret < zigzag < triangle < square < heart < spiral.

export const SPELLS = {
  bolt: {
    id: 'bolt', name: 'Spark', glyph: 'line', color: 0x9fe8ff, css: '#9fe8ff',
    dmg: 7, speed: 48, cooldown: 0.9, kind: 'bolt',
    icon: 'M3 13 L21 10',
    desc: 'Quick zap. Weak, but interrupts a healer. Blocked by shield, mirrored back.',
  },
  shield: {
    id: 'shield', name: 'Aegis', glyph: 'circle', color: 0x6ec3ff, css: '#6ec3ff',
    dmg: 0, cooldown: 5, kind: 'shield', absorb: 30, duration: 4,
    icon: 'M12 3.5 A8.5 8.5 0 1 0 12.2 3.5',
    desc: 'Bubble that soaks 30 damage for 4s. Stone SHATTERS it and stuns you.',
  },
  mirror: {
    id: 'mirror', name: 'Mirror', glyph: 'caret', color: 0xd8e6ff, css: '#d8e6ff',
    dmg: 0, cooldown: 4, kind: 'mirror', duration: 1.05,
    icon: 'M4 18 L12 5 L20 18',
    desc: 'Brief ward that hurls projectiles back at the sender. Lightning pierces it.',
  },
  lightning: {
    id: 'lightning', name: 'Lightning', glyph: 'zigzag', color: 0xffe66a, css: '#ffe66a',
    dmg: 13, cooldown: 4.5, kind: 'zap',
    icon: 'M3 16 L8.5 8 L14 15 L20 7',
    desc: 'Instant strike. INTERRUPTS a rival mid-draw and pierces mirrors. Shield stops it.',
  },
  fireball: {
    id: 'fireball', name: 'Ember', glyph: 'triangle', color: 0xff9d4d, css: '#ff9d4d',
    dmg: 17, speed: 30, cooldown: 3.5, kind: 'fire', splash: 3.2, burnDps: 2.5, burnTime: 2.4,
    icon: 'M12 4 L21 19 L3 19 Z',
    desc: 'Roaring fireball — splash damage, sets wizards and the arena alight.',
  },
  boulder: {
    id: 'boulder', name: 'Stone Maul', glyph: 'square', color: 0xb9a68c, css: '#b9a68c',
    dmg: 26, speed: 21, cooldown: 6.5, kind: 'heavy', knockback: 11,
    icon: 'M5 5 L19 5 L19 19 L5 19 Z',
    desc: 'Slow, devastating boulder. Cracks shields, batters castles, flattens fools.',
  },
  heal: {
    id: 'heal', name: 'Mend', glyph: 'heart', color: 0x8fe08a, css: '#8fe08a',
    dmg: 0, cooldown: 9, kind: 'heal', healAmount: 26, healTime: 2.6,
    icon: 'M12 20 C 4 13 5 5.5 12 9 C 19 5.5 20 13 12 20',
    desc: 'Channel to restore 26 HP. Any hit breaks the channel — heal behind cover.',
  },
  grab: {
    id: 'grab', name: 'Geist Grip', glyph: 'spiral', color: 0xc08bff, css: '#c08bff',
    dmg: 22, speed: 33, cooldown: 7, kind: 'heavy', wizardDmg: 14,
    icon: 'M12 12 C 13.6 10.8 13.5 8.9 11.9 8.3 C 9.6 7.4 7.4 9.4 7.8 12 C 8.3 15.3 11.8 17 14.8 15.7 C 18.6 14.1 19.4 9.3 16.9 6.2',
    desc: 'Seize the nearest rock, wreckage — or WIZARD — and hurl it. Blocked by shield, ignores mirrors.',
  },
};

export const SPELL_ORDER = ['bolt', 'shield', 'mirror', 'lightning', 'fireball', 'boulder', 'heal', 'grab'];

// glyph id -> spell id
export const GLYPH_TO_SPELL = {};
for (const s of Object.values(SPELLS)) GLYPH_TO_SPELL[s.glyph] = s.id;

export const HEAVY_KINDS = new Set(['heavy']); // shatters shields
