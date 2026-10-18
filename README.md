# THRUSTERS — Neon Gravity Roadster

A synthwave one-button runner: fly a white Roadster with rocket thrusters, flip gravity, dodge spikes and grab energy cells. Press **Space**, click or tap to flip.

Live at [truepilot.io](https://truepilot.io).

## Stack

- `public/index.html` — the game's rendering, sound and UI (canvas, no build step)
- `public/sim.js` — the deterministic gameplay core, shared by the browser and the server
- `server.js` — dependency-light Node HTTP server: static files (gzip) plus a leaderboard / visitor API
- PostgreSQL via [`pg`](https://www.npmjs.com/package/pg); tables are created on startup

## Running locally

Requires Node 20.6+ (for `--env-file`) and PostgreSQL.

```sh
npm install
createdb thrusters
cat > .env <<'EOF'
DATABASE_URL=postgres://localhost/thrusters
PORT=3030
HOST=127.0.0.1
EOF
npm start
```

Then open http://127.0.0.1:3030.

| Variable       | Default     | Notes                          |
| -------------- | ----------- | ------------------------------ |
| `DATABASE_URL` | —           | PostgreSQL connection string   |
| `PORT`         | `3030`      |                                |
| `HOST`         | `127.0.0.1` | Keep it on localhost behind nginx |

## API

| Method | Path               | Description |
| ------ | ------------------ | ----------- |
| GET    | `/api/leaderboard` | Top 10 scores and total visitor count |
| GET    | `/api/players`     | Paged ranking, `?limit=` (≤100) and `?offset=` |
| GET    | `/api/countries`   | Visitors by country (top 10, others, unknown) |
| POST   | `/api/visit`       | Record a visit |
| POST   | `/api/run`         | Start a game: returns a single-use run `{ id, seed }` |
| POST   | `/api/score`       | Finish it: `{ run, name, email, key, inputs, steps, v }`; returns the verified score, best, rank and top 10 |
| GET    | `/healthz`         | Liveness check |

IPs are stored only as salted HMAC hashes; player emails are never returned by the API.

## Anti-cheat

The client never reports a score. Each game is a server-issued run with a secret level seed; the browser records only the
simulation steps at which the button was pressed, and the server replays those inputs through the same `sim.js` and
computes the score itself. `sim.js` is bit-for-bit deterministic across JS engines (seeded PRNG, fixed 240 Hz step,
no `Math.sin`), which is checked against both V8 and JavaScriptCore.

A submission is rejected (and logged with a `verdict` in the `runs` table) when:

- the run is unknown, expired (3 h) or already used — each run counts once
- the replay doesn't end in a crash at exactly the reported step (`replay`)
- it took less real time than game time, i.e. it was computed rather than played (`too-fast`)
- the run came from an automated browser (`navigator.webdriver`) (`automated`)
- the client is an old version (asks to reload)

The page also ignores synthetic (`isTrusted: false`) input events, and run creation is rate-limited per IP. A random key
kept in the browser proves ownership of a player, so nobody else can rename it by reusing the email.

To hide a cheater from the leaderboard (reversible):

```sql
UPDATE players SET banned = true WHERE email = '…';
SELECT email, verdict, count(*) FROM runs GROUP BY 1, 2 ORDER BY 1;   -- who keeps failing checks
```

When changing gameplay in `sim.js`, bump `VERSION` there and the `?v=` on its `<script>` tag.

## Deployment

Production runs on macOS (Homebrew) behind Cloudflare → nginx → node on `127.0.0.1:3030`. Visitor countries come from Cloudflare's `CF-IPCountry` header, which nginx forwards as `$cf_country`.

To issue a Let's Encrypt certificate and switch nginx to HTTPS:

```sh
./enable-ssl.sh your.domain [you@example.com]
```

The script:

1. Gets a cert with `certbot --webroot`, keeping certbot's dirs in `~/.letsencrypt` so no sudo is needed
2. Writes `/opt/homebrew/etc/nginx/servers/cataline.conf` (HTTP → HTTPS redirect plus the reverse proxy) and reloads nginx
3. Installs the launchd agent `com.cataline.certbot-renew`, which runs `certbot renew` at 03:17 and 15:17 and reloads nginx after a renewal

To check that renewal will work:

```sh
certbot renew --dry-run --config-dir ~/.letsencrypt/config \
  --work-dir ~/.letsencrypt/work --logs-dir ~/.letsencrypt/logs
```
