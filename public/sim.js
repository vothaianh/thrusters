// Thrusters gameplay core — physics, level generation, collisions and scoring.
// Shared by the browser (to play) and server.js (to replay a run and compute its score), so it must be
// bit-for-bit deterministic: seeded PRNG, fixed timestep, and only + - * / Math.floor/sqrt/min/max/abs
// (Math.sin differs between JS engines, so we use our own).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThrustersSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = 1;           // bump on any gameplay change (and the ?v= on the <script> tag)
const STEP = 1 / 240;        // seconds per simulation step
const MID = 300, HALF = 110, TOP = MID - HALF, BOT = MID + HALF;
const CAT_H = 13;            // half body height: center sits this far from the rail
const AHEAD = 3200;          // world generated ahead of the car (wider than any screen)
const BUFF_DUR = { nitro: 4, titan: 6 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sq = x => x * x;

// polynomial sine on [-π/2, π/2] after range reduction; error < 1e-7
const TAU = 6.283185307179586, PI = 3.141592653589793, HPI = 1.5707963267948966;
function sin(x) {
  x -= TAU * Math.floor(x / TAU + 0.5);
  if (x > HPI) x = PI - x; else if (x < -HPI) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800))))));
}

// mulberry32
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// emit(event, data) reports gameplay moments (flip, land, cell, buff, buffEnd, rocket, smash, shieldBreak, level, die)
// so the client can add particles and sound; the server passes nothing.
// demo: menu attract mode (slow scroll, no level, no scoring).
function create(seed, emit = () => {}, demo = false) {
  const random = prng(seed);
  const rand = (a, b) => a + random() * (b - a);
  const g = {
    steps: 0, t: 0, dead: false,
    dist: 0, speed: demo ? 300 : 380, grav: 4200, level: 0,
    score: 0, bonus: 0, combo: 0, comboT: 0, cells: 0,
    nextX: 700, lastBuffX: 0, buffer: 0, invuln: 0, nitroK: 0,
    buffs: { nitro: 0, titan: 0 },
    P: { y: BOT - CAT_H, vy: 0, dir: 1, grounded: true, shield: false },
    objs: [],
    press, step,
  };
  const P = g.P;

  function flipDistance() {
    const s = g.speed + 120, gr = 4200 * (s / 380);
    return s * Math.sqrt(2 * (2 * HALF - 2 * CAT_H) / gr);
  }
  const addSpike = (x, w, side) => g.objs.push({ t: 'spike', x, w, side });
  const addCell = (x, y) => g.objs.push({ t: 'cell', x, y, ph: random() * 6 });
  const railY = s => (s > 0 ? BOT - CAT_H : TOP + CAT_H);

  function generate() {
    while (g.nextX < g.dist + AHEAD) {
      const d = clamp(g.dist / 45000, 0, 1);
      const gap = flipDistance() + 70 + g.speed * 0.24;
      const r = random();
      const side = random() < 0.5 ? 1 : -1;

      if (g.dist > 1800 && g.nextX - g.lastBuffX > 4200 && random() < 0.09) { // random buff
        const kind = random() < 0.5 ? 'nitro' : 'titan';
        g.objs.push({ t: 'buff', kind, x: g.nextX + 40, y: MID + side * rand(0, 60), ph: random() * 6 });
        g.lastBuffX = g.nextX; g.nextX += gap;
        continue;
      }

      if (r < 0.28) { // single spike + reward cells on the safe rail
        const w = rand(60, 130 + 160 * d);
        addSpike(g.nextX, w, side);
        for (let x = 20; x < w; x += 44) addCell(g.nextX + x, railY(-side));
        g.nextX += w + gap * rand(1.0, 1.6);
      } else if (r < 0.52) { // zig-zag spikes, forced flips
        const n = 2 + Math.floor(rand(0, 1 + d * 3));
        let s = side;
        for (let i = 0; i < n; i++) {
          const w = rand(50, 100 + 60 * d);
          addSpike(g.nextX, w, s);
          g.nextX += w + gap * rand(1.0, 1.25 - d * 0.15);
          s = -s;
        }
        g.nextX += gap * 0.4;
      } else if (r < 0.7) { // saw in the middle: time your flip
        const amp = rand(10, 30 + 30 * d);
        g.objs.push({ t: 'saw', x: g.nextX + 30, y: MID, r: 22, amp, f: rand(1.5, 3 + d * 2), ph: rand(0, 6) });
        if (random() < 0.5 + d * 0.3) addSpike(g.nextX - 40, 140, side);
        g.nextX += 60 + gap * 1.2;
      } else if (r < 0.86) { // diagonal cell line: collect it mid-flip
        const fd = flipDistance(), from = railY(side), to = railY(-side);
        for (let i = 0; i <= 5; i++) {
          const k = i / 5;
          addCell(g.nextX + k * fd, lerp(from, to, k * k));
        }
        g.nextX += fd + gap * 0.8;
      } else if (r < 0.94 && g.dist > 3000) { // long spike tunnel with alternating saws
        const w = rand(220, 340);
        addSpike(g.nextX, w, side);
        g.objs.push({ t: 'saw', x: g.nextX + w / 2, y: MID, r: 20, amp: 18, f: 2.5, ph: 0 });
        g.nextX += w + gap * 1.3;
      } else { // rocket = thruster shield
        if (!P.shield && g.dist > 2500) g.objs.push({ t: 'rocket', x: g.nextX + 40, y: MID + side * 50 });
        else addCell(g.nextX + 40, MID);
        g.nextX += gap;
      }
    }
  }

  function flip() {
    P.dir *= -1;
    P.grounded = false;
    P.vy = P.dir * 140;
    g.buffer = 0;
    emit('flip');
  }

  // one button press, applied before the next step
  function press() {
    if (g.dead) return;
    if (!P.grounded) { g.buffer = 0.14; return; }
    flip();
  }

  function hit() {
    if (g.invuln > 0) return;
    if (P.shield) { P.shield = false; g.invuln = 1.0; emit('shieldBreak'); return; }
    g.dead = true;
    emit('die');
  }

  function obstacleHit(o, dx, y) {
    if (g.buffs.titan > 0) { // strength: plough straight through
      o.broken = true; g.bonus += 50;
      emit('smash', { dx, y });
    } else if (g.buffs.nitro <= 0) hit(); // nitro phases through hazards
  }

  function step() {
    if (g.dead) return;
    const dt = STEP;
    g.steps++;
    if (!demo) {
      g.t += dt;
      g.nitroK = lerp(g.nitroK, g.buffs.nitro > 0 ? 1 : 0, Math.min(1, dt * 4));
      g.speed = Math.min(380 + g.dist * 0.0115, 980) * (1 + 0.6 * g.nitroK);
      const lv = Math.floor(g.dist / 7000);
      if (lv > g.level) { g.level = lv; emit('level'); }
    }
    g.grav = 4200 * (g.speed / 380);
    g.dist += g.speed * dt;

    if (!P.grounded) {
      P.vy += g.grav * P.dir * dt;
      P.y += P.vy * dt;
      const target = P.dir > 0 ? BOT - CAT_H : TOP + CAT_H;
      if ((P.dir > 0 && P.y >= target) || (P.dir < 0 && P.y <= target)) {
        P.y = target; P.vy = 0; P.grounded = true;
        emit('land');
        if (g.buffer > 0) flip();
      }
    }
    g.buffer = Math.max(0, g.buffer - dt);
    g.invuln = Math.max(0, g.invuln - dt);
    if (demo) return;

    generate();
    for (const k in g.buffs) {
      if (g.buffs[k] <= 0) continue;
      g.buffs[k] -= dt;
      if (g.buffs[k] <= 0) { g.buffs[k] = 0; g.invuln = Math.max(g.invuln, 0.8); emit('buffEnd', k); }
    }
    if (g.buffs.nitro > 0) g.bonus += g.speed * dt / 10; // double distance points
    g.score = Math.floor(g.dist / 10 + g.bonus);
    g.comboT -= dt;
    if (g.comboT <= 0) g.combo = 0;

    // positions relative to the car (car at x = 0)
    const cy = P.y, hw = 22, hh = 9;
    for (const o of g.objs) {
      const rx = o.x - g.dist;
      if (o.broken) continue;
      if (o.t === 'spike') {
        if (rx + o.w < -hw || rx > hw) continue;
        const y0 = o.side > 0 ? BOT - 16 : TOP, y1 = o.side > 0 ? BOT : TOP + 16;
        if (rx + 5 < hw && rx + o.w - 5 > -hw && y0 < cy + hh && y1 > cy - hh) obstacleHit(o, 10, (y0 + y1) / 2);
      } else if (o.t === 'saw') {
        const oy = o.y + sin(g.t * o.f + o.ph) * o.amp;
        const nx = clamp(rx, -hw, hw), ny = clamp(oy, cy - hh, cy + hh);
        if (sq(nx - rx) + sq(ny - oy) < sq(o.r - 4)) obstacleHit(o, rx, oy);
      } else if (o.t === 'buff' && !o.got) {
        if (sq(rx) + sq(o.y + sin(g.t * 3 + o.ph) * 8 - cy) < 36 * 36) {
          o.got = true; g.buffs[o.kind] = BUFF_DUR[o.kind];
          emit('buff', o);
        }
      } else if (o.t === 'cell' && !o.got) {
        if (sq(rx) + sq(o.y - cy) < 28 * 28) {
          o.got = true; g.cells++;
          g.combo = Math.min(g.combo + 1, 20); g.comboT = 1.6;
          const pts = 10 * g.combo; g.bonus += pts;
          emit('cell', { o, pts });
        }
      } else if (o.t === 'rocket' && !o.got) {
        if (sq(rx) + sq(o.y + sin(g.t * 3) * 10 - cy) < 34 * 34) {
          o.got = true; P.shield = true;
          emit('rocket', o);
        }
      }
      if (g.dead) break;
    }
    g.objs = g.objs.filter(o => o.x + (o.w || 40) - g.dist > -400);
  }

  return g;
}

// Re-run a recorded game. inputs: sorted step indices at which the button was pressed.
// Returns the final state, or null if the inputs don't describe a game that ends exactly at `steps`.
// onPress(g) sees the state just before each press (the server uses it to profile how the run was played).
function replay(seed, inputs, steps, onPress) {
  const g = create(seed);
  let i = 0;
  while (!g.dead && g.steps < steps) {
    while (i < inputs.length && inputs[i] === g.steps) { if (onPress) onPress(g); g.press(); i++; }
    g.step();
  }
  return g.dead && g.steps === steps && i === inputs.length ? g : null;
}

return { VERSION, STEP, MID, HALF, TOP, BOT, CAT_H, BUFF_DUR, sin, create, replay };
});
