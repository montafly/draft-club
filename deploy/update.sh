#!/usr/bin/env bash
# Обновить Draft Club на сервере до свежего master и перезапустить.
#   curl -fsSL https://raw.githubusercontent.com/montafly/draft-club/master/deploy/update.sh | bash
set -e
cd /opt/draft-club
git pull --ff-only
cd server
npm install --no-audit --no-fund
systemctl restart draftclub
echo "Draft Club обновлён и перезапущен."
