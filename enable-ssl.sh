#!/usr/bin/env bash
# Issue a Let's Encrypt cert for the Cataline game and switch nginx to HTTPS (80 -> 443).
# Usage: ./enable-ssl.sh game.example.com [you@example.com]
set -euo pipefail

DOMAIN="${1:?usage: $0 <domain> [email]}"
EMAIL="${2:-}"
BREW=/opt/homebrew
LE="$HOME/.letsencrypt"           # user-owned certbot dirs, so no sudo is needed
WEBROOT="$BREW/var/www/acme"
CONF="$BREW/etc/nginx/servers/cataline.conf"

mkdir -p "$LE"/{config,work,logs} "$WEBROOT"
CB=(certbot --config-dir "$LE/config" --work-dir "$LE/work" --logs-dir "$LE/logs")

if [[ -n "$EMAIL" ]]; then ACCT=(-m "$EMAIL"); else ACCT=(--register-unsafely-without-email); fi

"${CB[@]}" certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --agree-tos --non-interactive "${ACCT[@]}" \
  --deploy-hook "$BREW/bin/nginx -s reload"

CERT="$LE/config/live/$DOMAIN"
cat > "$CONF" <<EOF
# Cataline game — HTTPS reverse proxy to node on 127.0.0.1:3030
server {
    listen 80 default_server;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header CF-IPCountry \$cf_country;
    }
}
EOF

"$BREW/bin/nginx" -t
"$BREW/bin/nginx" -s reload

# Auto-renew twice a day via launchd
PLIST="$HOME/Library/LaunchAgents/com.cataline.certbot-renew.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cataline.certbot-renew</string>
  <key>ProgramArguments</key><array>
    <string>$BREW/bin/certbot</string><string>renew</string><string>--quiet</string>
    <string>--config-dir</string><string>$LE/config</string>
    <string>--work-dir</string><string>$LE/work</string>
    <string>--logs-dir</string><string>$LE/logs</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>17</integer></dict>
  </array>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.cataline.certbot-renew" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Done: https://$DOMAIN  (http redirects to https, auto-renew scheduled)"
