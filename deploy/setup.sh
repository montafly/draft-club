#!/usr/bin/env bash
# Установка Draft Club на чистый Ubuntu (запускать от root).
# Использование (в веб-консоли сервера):
#   curl -fsSL https://raw.githubusercontent.com/montafly/draft-club/master/deploy/setup.sh | bash
set -e
export DEBIAN_FRONTEND=noninteractive

echo "== apt + git + curl =="
apt-get update -y
apt-get install -y curl git

echo "== Node.js 20 LTS =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== клонируем репозиторий =="
rm -rf /opt/draft-club
git clone --depth 1 https://github.com/montafly/draft-club.git /opt/draft-club
cd /opt/draft-club/server
npm install --no-audit --no-fund

echo "== systemd-сервис =="
cat >/etc/systemd/system/draftclub.service <<'EOF'
[Unit]
Description=Draft Club server
After=network.target

[Service]
WorkingDirectory=/opt/draft-club/server
ExecStart=/usr/bin/node server.js
Environment=PORT=4000
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable draftclub
systemctl restart draftclub
sleep 1
systemctl --no-pager status draftclub | head -5 || true

# на случай включённого ufw
ufw allow 4000/tcp 2>/dev/null || true
ufw allow OpenSSH 2>/dev/null || true

IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "=================================================="
echo " Draft Club поднят. Открой:  http://$IP:4000"
echo "=================================================="
