// Thrusters — static server + leaderboard/visitor API (PostgreSQL)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Pool } = require('pg');

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
  `);
  await pool.query(`INSERT INTO meta (k, v) VALUES ('salt', $1) ON CONFLICT (k) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
  salt = (await pool.query(`SELECT v FROM meta WHERE k = 'salt'`)).rows[0].v;
}

const hash = s => crypto.createHmac('sha256', salt).update(s).digest('hex');
const playerId = email => hash('player:' + email).slice(0, 12);

async function topList() {
  const { rows } = await pool.query('SELECT email, name, best, country FROM players WHERE best > 0 ORDER BY best DESC, updated ASC LIMIT 10');
  return rows.map(r => ({ id: playerId(r.email), name: r.name, score: r.best, country: r.country || null }));
}
async function visitorCount() {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM visitors')).rows[0].n;
}

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
setInterval(() => { const cut = Date.now() - 60000; for (const [k, t] of lastSubmit) if (t < cut) lastSubmit.delete(k); }, 60000).unref();

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
      pool.query(`SELECT email, name, best, country FROM players WHERE best > 0
                  ORDER BY best DESC, updated ASC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS n FROM players WHERE best > 0'),
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

  if (pathname === '/api/score' && req.method === 'POST') {
    const ip = clientIp(req), now = Date.now();
    if (now - (lastSubmit.get(ip) || 0) < 2000) return json(res, 429, { error: 'Slow down' });
    lastSubmit.set(ip, now);

    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    const email = String(body.email || '').trim().toLowerCase();
    const score = Number(body.score);
    const duration = Number(body.duration); // seconds of play
    if (!NAME_RE.test(name)) return json(res, 400, { error: 'Username must be 2–16 letters, numbers, space, _ . -' });
    if (email.length > 254 || !EMAIL_RE.test(email)) return json(res, 400, { error: 'Invalid email' });
    if (!Number.isInteger(score) || score < 0 || !(duration > 0) || duration > 7200) return json(res, 400, { error: 'Invalid score' });
    // sanity cap: distance points top out near 100/s, yarn combos add a few hundred/s at most
    if (score > 60 + duration * 700) return json(res, 400, { error: 'Score rejected' });

    // player upsert (keeps best score atomically) + visitor + player<->visitor link, all in one transaction
    const db = await pool.connect();
    let prev, row;
    try {
      await db.query('BEGIN');
      prev = await db.query('SELECT best FROM players WHERE email = $1', [email]);
      ({ rows: [row] } = await db.query(`
        INSERT INTO players (email, name, best, plays, country) VALUES ($1, $2, $3, 1, $4)
        ON CONFLICT (email) DO UPDATE SET name = excluded.name, best = GREATEST(players.best, excluded.best),
          plays = players.plays + 1, updated = now(), country = COALESCE(excluded.country, players.country)
        RETURNING best`, [email, name, score, clientCountry(req)]));
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
    const rank = (await pool.query('SELECT COUNT(*)::int + 1 AS r FROM players WHERE best > $1', [row.best])).rows[0].r;
    return json(res, 200, {
      you: playerId(email), best: row.best, rank,
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
