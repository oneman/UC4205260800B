// life - Conway's Game of Life on one HD frame.
// The board is the pixels: on start the cart reads the cells back out of its
// frame, so a saved instance keeps the game where it was left.
// Keys: space pause, r random, c clear, g glider gun. Click toggles a cell.

const CELL = 8, TOP = 16, CW = 240, CH = 133;
const ALIVE = [120, 255, 160], DEAD = [10, 18, 28];
let s, grid, next, paused = false, gen = 0;

function drawCell(i) {
  const x = (i % CW) * CELL, y = TOP + Math.floor(i / CW) * CELL, c = grid[i] ? ALIVE : DEAD;
  s.fill(x, y, CELL - 1, CELL - 1, c[0], c[1], c[2]);
}

function redraw() {
  s.fill(0, TOP, uc.W, uc.H - TOP, 0, 0, 0);
  for (let i = 0; i < grid.length; i++) drawCell(i);
}

function randomize() {
  for (let i = 0; i < grid.length; i++) grid[i] = Math.random() < 0.18 ? 1 : 0;
  gen = 0;
}

function gliderGun(ox, oy) {
  const rows = [
    '........................O...........',
    '......................O.O...........',
    '............OO......OO............OO',
    '...........O...O....OO............OO',
    'OO........O.....O...OO..............',
    'OO........O...O.OO....O.O...........',
    '..........O.....O.......O...........',
    '...........O...O....................',
    '............OO......................',
  ];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { grid[(oy + y) * CW + ox + x] = ch === 'O' ? 1 : 0; }));
}

function init(uc) {
  s = uc.frames[0];
  grid = new Uint8Array(CW * CH);
  next = new Uint8Array(CW * CH);
  let seen = false;
  for (let i = 0; i < grid.length; i++) {
    const [r, g, b] = s.get((i % CW) * CELL + 3, TOP + Math.floor(i / CW) * CELL + 3);
    if (r || g || b) seen = true;
    grid[i] = g > 128 ? 1 : 0;
  }
  if (!seen) { randomize(); gliderGun(4, 4); }
  redraw();
}

function step() {
  for (let y = 0; y < CH; y++) {
    const up = ((y + CH - 1) % CH) * CW, mid = y * CW, down = ((y + 1) % CH) * CW;
    for (let x = 0; x < CW; x++) {
      const l = (x + CW - 1) % CW, r = (x + 1) % CW;
      const n = grid[up + l] + grid[up + x] + grid[up + r] + grid[mid + l] + grid[mid + r] +
        grid[down + l] + grid[down + x] + grid[down + r];
      next[mid + x] = n === 3 || (n === 2 && grid[mid + x]) ? 1 : 0;
    }
  }
  for (let i = 0; i < grid.length; i++) {
    if (next[i] !== grid[i]) { grid[i] = next[i]; drawCell(i); }
  }
  gen++;
}

function tick(uc, t, input) {
  if (input.pressed.has(' ')) paused = !paused;
  if (input.pressed.has('r')) { randomize(); redraw(); }
  if (input.pressed.has('c')) { grid.fill(0); gen = 0; redraw(); }
  if (input.pressed.has('g')) { gliderGun(4, 4); redraw(); }
  for (const c of input.clicks) {
    const cx = Math.floor(c.x / CELL), cy = Math.floor((c.y - TOP) / CELL);
    if (cy < 0 || cy >= CH) continue;
    grid[cy * CW + cx] ^= 1;
    drawCell(cy * CW + cx);
  }
  if (!paused) step();
  let pop = 0;
  for (let i = 0; i < grid.length; i++) pop += grid[i];
  s.fill(0, 0, uc.W, TOP, 24, 24, 40);
  s.text(6, 1, `LIFE  GEN ${gen}  POP ${pop}${paused ? '  PAUSED' : ''}    SPACE PAUSE  R RANDOM  C CLEAR  G GLIDER GUN  CLICK TOGGLE`, 2, 200, 220, 255);
}
