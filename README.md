# THRUSTERS — Neon Gravity Roadster

A synthwave one-button runner: fly a white Roadster with rocket thrusters, flip gravity, dodge spikes and grab energy cells. Press **Space**, click or tap to flip.

Live at [truepilot.io](https://truepilot.io).

## Stack

- `public/index.html` — the whole game (canvas, no build step)
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
| POST   | `/api/score`       | Submit `{ name, email, score, duration }`; returns best, rank and top 10 |
| GET    | `/healthz`         | Liveness check |

Score submissions are rate-limited per IP (one per 2 s) and sanity-checked against play duration. IPs are stored only as salted HMAC hashes; player emails are never returned by the API.

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
