// Thrusters — static server + leaderboard/visitor API (PostgreSQL)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Pool } = require('pg');
const Sim = require('./public/sim.js');

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest']);

// ---------- database (PostgreSQL) ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', err => console.error('pg pool error', err));

let salt = '';
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS players (
      email TEXT PRIMARY KEY, name TEXT NOT NULL, best INTEGER NOT NULL DEFAULT 0,
      plays INTEGER NOT NULL DEFAULT 0, created TIMESTAMPTZ NOT NULL DEFAULT now(), updated TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS players_best ON players (best DESC, updated ASC);
    CREATE TABLE IF NOT EXISTS visitors (
      ip_hash TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE visitors ADD COLUMN IF NOT EXISTS country CHAR(2);
    ALTER TABLE players ADD COLUMN IF NOT EXISTS country CHAR(2);
    CREATE INDEX IF NOT EXISTS visitors_country ON visitors (country);
    -- which visitors (hashed IPs) each player has submitted scores from; many-to-many
    CREATE TABLE IF NOT EXISTS player_visitors (
      email TEXT NOT NULL REFERENCES players (email) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL REFERENCES visitors (ip_hash) ON DELETE CASCADE,
      plays INTEGER NOT NULL DEFAULT 1,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (email, ip_hash));
    CREATE INDEX IF NOT EXISTS player_visitors_ip ON player_visitors (ip_hash);
    -- a key kept in the player's browser; only its holder can rename the player
    ALTER TABLE players ADD COLUMN IF NOT EXISTS key_hash TEXT;
    -- hidden from the leaderboard (set by hand for cheaters)
    ALTER TABLE players ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;
    -- every game is a server-issued run; its score comes from replaying the inputs from its seed
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, seed BIGINT NOT NULL, ip_hash TEXT NOT NULL, automated BOOLEAN NOT NULL DEFAULT false,
      created TIMESTAMPTZ NOT NULL DEFAULT now(), finished TIMESTAMPTZ,
      email TEXT, steps INTEGER, inputs INTEGER, score INTEGER, verdict TEXT);
    CREATE INDEX IF NOT EXISTS runs_created ON runs (created);
    CREATE INDEX IF NOT EXISTS runs_email ON runs (email);
  `);
  await pool.query(`INSERT INTO meta (k, v) VALUES ('salt', $1) ON CONFLICT (k) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
  salt = (await pool.query(`SELECT v FROM meta WHERE k = 'salt'`)).rows[0].v;
}

const hash = s => crypto.createHmac('sha256', salt).update(s).digest('hex');
const playerId = email => hash('player:' + email).slice(0, 12);

async function topList() {
  const { rows } = await pool.query('SELECT email, name, best, country FROM players WHERE best > 0 AND NOT banned ORDER BY best DESC, updated ASC LIMIT 10');
  return rows.map(r => ({ id: playerId(r.email), name: r.name, score: r.best, country: r.country || null }));
}
async function visitorCount() {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM visitors')).rows[0].n;
}

// unfinished runs are only useful for a few hours
setInterval(() => {
  pool.query(`DELETE FROM runs WHERE finished IS NULL AND created < now() - interval '1 day'`).catch(err => console.error('run cleanup', err));
}, 3600e3).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => pool.end().finally(() => process.exit(0)));

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
// Only nginx can reach us (we bind 127.0.0.1); it resolves the real client IP from Cloudflare.
// ISO country code from Cloudflare (nginx only forwards it for requests that really came through Cloudflare).
// Cloudflare uses XX for unknown and T1 for Tor; store those as NULL.
function clientCountry(req) {
  const c = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : null;
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').trim();
}
function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return reject(Object.assign(new Error('too large'), { tooLarge: true }));
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const NAME_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,185}\.[^\s@]{2,}$/;
const lastSubmit = new Map(); // ip -> ms, simple rate limit
const runStarts = new Map(); // ip -> [window start ms, count]
setInterval(() => {
  const cut = Date.now() - 60000;
  for (const [k, t] of lastSubmit) if (t < cut) lastSubmit.delete(k);
  for (const [k, w] of runStarts) if (w[0] < cut) runStarts.delete(k);
}, 60000).unref();

const RUN_TTL = 3 * 3600;                      // seconds a run stays valid
const MAX_STEPS = 2 * 3600 / Sim.STEP;         // 2 hours of play
const MAX_INPUTS = 50000;
const RUNS_PER_MIN = 30;                       // per IP

// ---------- bot defences ----------
// Cloudflare Turnstile: every run needs a freshly solved (single-use) token (off unless both keys are set)
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';

async function verifyTurnstile(token, ip) {
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(8000),
  });
  return (await r.json()).success === true;
}

const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

// How a replayed run was played. Returns a verdict when it looks scripted, else null.
// - holds: ms each press was held. Automation tools press in ~0 ms and identically every time.
// - reaction: when a press flips the car, how far away the next hazard on its rail was. A script flips at
//   (almost) the same distance or time every time; people are tens of ms and many pixels apart.
// Thresholds are deliberately loose so real players are never caught.
function botVerdict(holds, ahead) {
  const known = holds.filter(h => h >= 0);
  if (known.length >= 8) {
    const sorted = [...known].sort((a, b) => a - b);
    if (sorted[sorted.length >> 1] < 10 || sorted[sorted.length - 1] - sorted[0] <= 3) return 'bot-input';
  }
  if (ahead.length >= 15) {
    if (sd(ahead.map(a => a.dx)) < 6 || sd(ahead.map(a => a.dt)) < 0.012) return 'bot-reaction';
  }
  return null;
}
// nearest hazard ahead of the car on the rail it's on (spikes on its side, saws anywhere)
function hazardAhead(g) {
  let best = Infinity;
  for (const o of g.objs) {
    if (o.broken) continue;
    const rx = o.x - g.dist;
    if (o.t === 'spike' && o.side === g.P.dir && rx + o.w > -22) best = Math.min(best, Math.max(0, rx));
    else if (o.t === 'saw' && rx > -22) best = Math.min(best, Math.max(0, rx));
  }
  return best;
}

// records the visitor (hashed IP + country) and returns its hash; `db` is the pool or a transaction client
async function upsertVisitor(db, req) {
  const ipHash = hash('ip:' + clientIp(req));
  await db.query(`INSERT INTO visitors (ip_hash, country) VALUES ($1, $2)
                  ON CONFLICT (ip_hash) DO UPDATE SET last_seen = now(), country = COALESCE(excluded.country, visitors.country)`,
                 [ipHash, clientCountry(req)]);
  return ipHash;
}

// ---------- API ----------
async function api(req, res, pathname) {
  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    return json(res, 200, { top: await topList(), visitors: await visitorCount() });
  }

  if (pathname === '/api/players' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const limit = Math.min(100, Math.max(1, parseInt(qs.get('limit'), 10) || 50));
    const offset = Math.min(1e6, Math.max(0, parseInt(qs.get('offset'), 10) || 0));
    const [{ rows }, total] = await Promise.all([
      pool.query(`SELECT email, name, best, country FROM players WHERE best > 0 AND NOT banned
                  ORDER BY best DESC, updated ASC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS n FROM players WHERE best > 0 AND NOT banned'),
    ]);
    return json(res, 200, {
      players: rows.map((r, i) => ({ rank: offset + i + 1, id: playerId(r.email), name: r.name, score: r.best, country: r.country || null })),
      total: total.rows[0].n,
    });
  }

  if (pathname === '/api/countries' && req.method === 'GET') {
    const { rows } = await pool.query('SELECT country, COUNT(*)::int AS n FROM visitors GROUP BY country ORDER BY n DESC, country');
    const known = rows.filter(r => r.country);
    return json(res, 200, {
      top: known.slice(0, 10).map(r => ({ code: r.country, visitors: r.n })),
      others: known.slice(10).reduce((a, r) => a + r.n, 0),
      unknown: rows.find(r => !r.country)?.n || 0,
      total: rows.reduce((a, r) => a + r.n, 0),
    });
  }

  if (pathname === '/api/visit' && req.method === 'POST') {
    await upsertVisitor(pool, req);
    return json(res, 200, { visitors: await visitorCount() });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return json(res, 200, { turnstile: TURNSTILE_SECRET ? TURNSTILE_SITEKEY : null });
  }

  // start a game: a single-use run with the level seed
  if (pathname === '/api/run' && req.method === 'POST') {
    const ip = clientIp(req), now = Date.now();
    const w = runStarts.get(ip);
    if (w && now - w[0] < 60000) { if (++w[1] > RUNS_PER_MIN) return json(res, 429, { error: 'Slow down' }); }
    else runStarts.set(ip, [now, 1]);
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
    if (TURNSTILE_SECRET) {
      let ok = false;
      try { ok = typeof body.token === 'string' && body.token.length < 4096 && await verifyTurnstile(body.token, ip); }
      catch (err) { console.error('turnstile verify', err.message); return json(res, 503, { error: 'Human check unavailable' }); }
      if (!ok) return json(res, 403, { error: 'Human check failed' });
    }
    const id = crypto.randomBytes(16).toString('hex'), seed = crypto.randomBytes(4).readUInt32LE(0);
    await pool.query('INSERT INTO runs (id, seed, ip_hash, automated) VALUES ($1, $2, $3, $4)',
                     [id, seed, hash('ip:' + ip), body.wd === true]);
    return json(res, 200, { id, seed, v: Sim.VERSION });
  }

  // finish a game: replay the inputs on the server; the client's own score is never trusted
  if (pathname === '/api/score' && req.method === 'POST') {
    const ip = clientIp(req), now = Date.now();
    if (now - (lastSubmit.get(ip) || 0) < 500) return json(res, 429, { error: 'Slow down' });
    lastSubmit.set(ip, now);

    let body;
    try { body = await readJson(req, 512 * 1024); } catch (e) { return json(res, e.tooLarge ? 413 : 400, { error: e.tooLarge ? 'Too large' : 'Bad JSON' }); }
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    const email = String(body.email || '').trim().toLowerCase();
    const runId = String(body.run || ''), steps = body.steps, inputs = body.inputs;
    const holds = Array.isArray(body.holds) ? body.holds : [];
    if (!NAME_RE.test(name)) return json(res, 400, { error: 'Username must be 2–16 letters, numbers, space, _ . -' });
    if (email.length > 254 || !EMAIL_RE.test(email)) return json(res, 400, { error: 'Invalid email' });
    if (body.v !== Sim.VERSION) return json(res, 409, { error: 'Game updated, reload the page' });
    if (!/^[0-9a-f]{32}$/.test(runId) || !Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS ||
        !Array.isArray(inputs) || inputs.length > MAX_INPUTS ||
        !inputs.every((s, i) => Number.isInteger(s) && s >= 0 && s < steps && (i === 0 || s >= inputs[i - 1])) ||
        holds.length !== inputs.length || !holds.every(h => Number.isInteger(h) && h >= -1 && h <= 10000)) {
      return json(res, 400, { error: 'Invalid run' });
    }

    // claim the run atomically, so it can't be submitted twice
    const { rows: [run] } = await pool.query(`
      UPDATE runs SET finished = now(), email = $2, steps = $3, inputs = $4 WHERE id = $1 AND finished IS NULL
      RETURNING seed, automated, EXTRACT(EPOCH FROM finished - created)::float8 AS age`, [runId, email, steps, inputs.length]);
    if (!run) return json(res, 400, { error: 'Run expired or already used' });
    const reject = async (verdict, error) => {
      await pool.query('UPDATE runs SET verdict = $2 WHERE id = $1', [runId, verdict]);
      console.warn(`run ${runId} rejected (${verdict}) for ${playerId(email)}: ${steps} steps, ${inputs.length} inputs`);
      return json(res, 422, { error });
    };
    if (run.age > RUN_TTL) return reject('expired', 'Run expired');
    if (run.automated) return reject('automated', 'Automated browser');
    // the run can't have taken less real time than game time (the game is created before it starts)
    if (run.age < steps * Sim.STEP - 0.5) return reject('too-fast', 'Run too fast');
    const ahead = [];
    const sim = Sim.replay(Number(run.seed), inputs, steps, g => {
      if (!g.P.grounded) return; // presses in mid-air are only buffered
      const dx = hazardAhead(g);
      if (dx < 600) ahead.push({ dx, dt: dx / g.speed });
    });
    if (!sim) return reject('replay', 'Replay check failed');
    const bot = botVerdict(holds, ahead);
    if (bot) return reject(bot, 'Bot-like input');
    const score = sim.score;
    await pool.query(`UPDATE runs SET verdict = 'ok', score = $2 WHERE id = $1`, [runId, score]);

    // the browser's key proves ownership of the player; without it scores still count but the name stays
    const key = /^[0-9a-f]{32}$/.test(body.key) ? body.key : crypto.randomBytes(16).toString('hex');
    const keyHash = hash('key:' + key);

    // player upsert (keeps best score atomically) + visitor + player<->visitor link, all in one transaction
    const db = await pool.connect();
    let prev, row;
    try {
      await db.query('BEGIN');
      prev = await db.query('SELECT best FROM players WHERE email = $1', [email]);
      ({ rows: [row] } = await db.query(`
        INSERT INTO players (email, name, best, plays, country, key_hash) VALUES ($1, $2, $3, 1, $4, $5)
        ON CONFLICT (email) DO UPDATE SET
          name = CASE WHEN players.key_hash IS NULL OR players.key_hash = excluded.key_hash THEN excluded.name ELSE players.name END,
          key_hash = COALESCE(players.key_hash, excluded.key_hash),
          best = GREATEST(players.best, excluded.best),
          plays = players.plays + 1, updated = now(), country = COALESCE(excluded.country, players.country)
        RETURNING best`, [email, name, score, clientCountry(req), keyHash]));
      const ipHash = await upsertVisitor(db, req);
      await db.query(`INSERT INTO player_visitors (email, ip_hash) VALUES ($1, $2)
                      ON CONFLICT (email, ip_hash) DO UPDATE SET plays = player_visitors.plays + 1, last_seen = now()`, [email, ipHash]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      db.release();
    }
    const rank = (await pool.query('SELECT COUNT(*)::int + 1 AS r FROM players WHERE best > $1 AND NOT banned', [row.best])).rows[0].r;
    return json(res, 200, {
      you: playerId(email), key, score, best: row.best, rank,
      newRecord: !prev.rows.length || score > prev.rows[0].best, top: await topList(),
    });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- static ----------
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500, err.code === 'ENOENT' ? 'Not Found' : 'Error');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      Vary: 'Accept-Encoding',
    };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      data = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad Request'); // fs throws on NUL, which used to crash the server
  if (pathname === '/healthz') return send(res, 200, 'ok', { 'Cache-Control': 'no-store' });
  if (pathname.startsWith('/api/')) {
    return api(req, res, pathname).catch(err => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    });
  }
  serveStatic(req, res, pathname);
});

initDb()
  .then(() => server.listen(PORT, HOST, () => console.log(`Thrusters running at http://${HOST}:${PORT} (postgres)`)))
  .catch(err => { console.error('database init failed', err); process.exit(1); });
