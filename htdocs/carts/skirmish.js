// skirmish - a very small Red Alert flavoured tank battle on one HD frame.
// Left click selects a blue tank (shift adds), right click moves or attacks,
// a selects all, r restarts. Wrecks scorch the ground for good.

const TOP = 24, BLOCK = 16, RANGE = 220, SPEED = 1.6, BRIDGES = [300, 780];
const TEAM = [[60, 120, 255], [230, 60, 50]];
let s, terrain, solid, units, shots, over, rand;

const riverX = (y) => 960 + 140 * Math.sin(y / 170);

function lcg(seed) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function makeTerrain() {
  const r = lcg(4205260800 % 99991);
  terrain = new Uint8Array(uc.W * uc.H * 3);
  solid = new Uint8Array((uc.W / BLOCK) * Math.ceil(uc.H / BLOCK));
  const bw = uc.W / BLOCK;
  const rocks = Array.from({ length: 14 }, () => [r() * uc.W, TOP + r() * (uc.H - TOP), 30 + r() * 50]);
  for (let by = 0; by * BLOCK < uc.H; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const cx = bx * BLOCK + 8, cy = by * BLOCK + 8;
      const river = Math.abs(cx - riverX(cy)) < 36;
      const bridge = river && BRIDGES.some((b) => Math.abs(cy - b) < 24);
      const rock = rocks.some(([x, y, rad]) => Math.hypot(cx - x, cy - y) < rad);
      const v = r() * 18;
      let c = [44 + v, 96 + v * 1.5, 40 + v];
      if (bridge) c = [120 + v, 90 + v, 60];
      else if (river) c = [30, 70 + v, 150 + v * 2];
      else if (rock) c = [110 + v, 108 + v, 100 + v];
      solid[by * bw + bx] = (river && !bridge) || rock || cy < TOP ? 1 : 0;
      for (let y = by * BLOCK; y < Math.min(uc.H, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
          const o = (y * uc.W + x) * 3, n = ((x * 7 + y * 13) % 5) * 2;
          terrain[o] = c[0] + n; terrain[o + 1] = c[1] + n; terrain[o + 2] = c[2] + n;
        }
      }
    }
  }
}

const blocked = (x, y) => x < 8 || y < TOP + 8 || x >= uc.W - 8 || y >= uc.H - 8 ||
  solid[Math.floor(y / BLOCK) * (uc.W / BLOCK) + Math.floor(x / BLOCK)];

function restore(x, y, w, h) {
  x = Math.max(0, x | 0); y = Math.max(0, y | 0);
  w = Math.min(uc.W - x, w | 0); h = Math.min(uc.H - y, h | 0);
  if (w <= 0 || h <= 0) return;
  for (let r = 0; r < h; r++) {
    const o = ((y + r) * uc.W + x) * 3;
    s.data.set(terrain.subarray(o, o + w * 3), o);
  }
  s.touch(x, y, w, h);
}

function start() {
  makeTerrain();
  rand = lcg(7);
  s.data.set(terrain);
  s.touch(0, 0, uc.W, uc.H);
  units = [];
  shots = [];
  over = false;
  for (let i = 0; i < 6; i++) {
    units.push({ team: 0, x: 140 + (i % 2) * 60, y: 300 + i * 90, hp: 100, cd: 0, dir: 0, sel: false });
    units.push({ team: 1, x: 1780 - (i % 2) * 60, y: 300 + i * 90, hp: 100, cd: 0, dir: Math.PI, sel: false });
  }
}

function init(uc) {
  s = uc.frames[0];
  start();
}

const nearest = (u, team, max) => {
  let best = null, bd = max;
  for (const v of units) {
    const d = Math.hypot(v.x - u.x, v.y - u.y);
    if (v.team === team && d < bd) { best = v; bd = d; }
  }
  return best;
};

// Tanks on the wrong side of the river head for the nearest bridge first.
function steer(u, tx, ty) {
  const west = u.x < riverX(u.y);
  if (west === tx < riverX(ty)) return [tx, ty];
  const by = BRIDGES.reduce((a, b) => (Math.abs(b - u.y) + Math.abs(b - ty) < Math.abs(a - u.y) + Math.abs(a - ty) ? b : a));
  const near = riverX(by) + (west ? -60 : 60);
  if (Math.abs(u.x - near) > 4 || Math.abs(u.y - by) > 4) return [near, by];
  return [riverX(by) + (west ? 60 : -60), by];
}

function move(u, gx, gy) {
  const [tx, ty] = steer(u, gx, gy);
  if (Math.hypot(gx - u.x, gy - u.y) < 2) return true;
  const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
  if (d < 2) return false;
  u.dir = Math.atan2(dy, dx);
  const nx = u.x + (dx / d) * SPEED, ny = u.y + (dy / d) * SPEED;
  if (!blocked(nx, ny)) { u.x = nx; u.y = ny; }
  else if (!blocked(nx, u.y)) u.x = nx;
  else if (!blocked(u.x, ny)) u.y = ny;
  else return true;
  return false;
}

function drawUnit(u) {
  const [r, g, b] = TEAM[u.team], x = Math.round(u.x), y = Math.round(u.y);
  s.fill(x - 8, y - 8, 16, 16, r * 0.4, g * 0.4, b * 0.4);
  s.fill(x - 7, y - 7, 14, 14, r, g, b);
  for (let i = 3; i < 13; i++) s.fill(x + Math.cos(u.dir) * i - 1, y + Math.sin(u.dir) * i - 1, 3, 3, 30, 30, 30);
  s.fill(x - 8, y - 13, 16, 3, 0, 0, 0);
  s.fill(x - 8, y - 13, Math.max(1, (u.hp / 100) * 16), 3, u.hp > 40 ? 80 : 240, u.hp > 40 ? 230 : 80, 60);
  if (u.sel) {
    for (const [cx, cy] of [[-11, -16], [8, -16], [-11, 9], [8, 9]]) s.fill(x + cx, y + cy, 3, 3, 255, 240, 80);
  }
}

function explode(u) {
  const x = Math.round(u.x), y = Math.round(u.y);
  for (let dy = -14; dy <= 14; dy++) {
    for (let dx = -14; dx <= 14; dx++) {
      if (dx * dx + dy * dy > 196 || x + dx < 0 || y + dy < TOP || x + dx >= uc.W || y + dy >= uc.H) continue;
      const o = ((y + dy) * uc.W + x + dx) * 3, k = 0.35 + 0.4 * Math.hypot(dx, dy) / 14;
      terrain[o] *= k; terrain[o + 1] *= k; terrain[o + 2] *= k;
    }
  }
}

function hud() {
  s.fill(0, 0, uc.W, TOP, 20, 20, 28);
  const blue = units.filter((u) => u.team === 0).length, red = units.length - blue;
  s.text(8, 4, `SKIRMISH   BLUE ${blue}  RED ${red}      LEFT CLICK SELECT  RIGHT CLICK MOVE/ATTACK  A ALL  R RESTART`, 2, 230, 230, 230);
}

function tick(uc, t, input) {
  if (input.pressed.has('r')) start();
  if (input.pressed.has('a')) units.forEach((u) => { u.sel = u.team === 0; });

  for (const c of input.clicks) {
    const hit = units.find((u) => Math.abs(u.x - c.x) < 12 && Math.abs(u.y - c.y) < 12);
    if (c.button === 0) {
      if (!c.shift) units.forEach((u) => { u.sel = false; });
      if (hit && hit.team === 0) hit.sel = true;
    } else if (c.button === 2) {
      const mine = units.filter((u) => u.sel);
      mine.forEach((u, i) => {
        u.target = hit && hit.team === 1 ? hit : null;
        u.goal = u.target ? null : [c.x + ((i % 3) - 1) * 30, c.y + (Math.floor(i / 3) - 0.5) * 30];
      });
    }
  }

  for (const u of units) restore(u.x - 12, u.y - 17, 24, 30);
  for (const p of shots) restore(p.x - 2, p.y - 2, 5, 5);
  if (over) { units.forEach(drawUnit); return; }

  for (const u of units) {
    if (u.target && !units.includes(u.target)) u.target = null;
    if (u.team === 1 && !u.target && t % 60 === units.indexOf(u) % 60) {
      u.target = nearest(u, 0, 650);
      if (!u.target && !u.goal) u.goal = [1000 + rand() * 860, TOP + 40 + rand() * (uc.H - TOP - 80)];
    }
    const foe = u.target || nearest(u, 1 - u.team, RANGE);
    if (u.target) {
      if (Math.hypot(u.target.x - u.x, u.target.y - u.y) > RANGE * 0.8) move(u, u.target.x, u.target.y);
    } else if (u.goal && move(u, u.goal[0], u.goal[1])) u.goal = null;
    if (u.cd > 0) u.cd--;
    if (foe && u.cd === 0 && Math.hypot(foe.x - u.x, foe.y - u.y) < RANGE) {
      const a = Math.atan2(foe.y - u.y, foe.x - u.x);
      u.dir = a;
      shots.push({ x: u.x + Math.cos(a) * 14, y: u.y + Math.sin(a) * 14, vx: Math.cos(a) * 7, vy: Math.sin(a) * 7, team: u.team, life: 40 });
      u.cd = 40;
    }
  }

  shots = shots.filter((p) => {
    p.x += p.vx; p.y += p.vy;
    if (--p.life <= 0 || p.x < 0 || p.y < TOP || p.x >= uc.W || p.y >= uc.H) return false;
    const v = units.find((u) => u.team !== p.team && Math.abs(u.x - p.x) < 9 && Math.abs(u.y - p.y) < 9);
    if (v) { v.hp -= 20; return false; }
    return true;
  });
  for (const u of units.filter((v) => v.hp <= 0)) { explode(u); restore(u.x - 15, u.y - 15, 31, 31); }
  units = units.filter((u) => u.hp > 0);

  for (const p of shots) s.fill(p.x - 1, p.y - 1, 3, 3, 255, 220, 90);
  units.forEach(drawUnit);
  hud();
  const blue = units.some((u) => u.team === 0), red = units.some((u) => u.team === 1);
  if (!blue || !red) {
    over = true;
    const msg = blue ? 'BLUE WINS' : 'RED WINS';
    s.fill(560, 460, 800, 160, 10, 10, 20);
    s.text(960 - msg.length * 24, 500, msg, 8, ...TEAM[blue ? 0 : 1]);
    s.text(960 - 21 * 9, 580, 'PRESS R TO PLAY AGAIN', 3, 230, 230, 230);
  }
}
