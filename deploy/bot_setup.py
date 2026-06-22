# Bring-up бота-уведомлятора на VPS: корневой .env (SFTP), systemd dc-bot, cron collect auto.
# Идемпотентно — можно гонять повторно. Секреты не печатаются (.env переносится файлом).
import os, sys, base64, paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "147.45.158.66"
USER = "root"
KEY = os.path.expanduser(r"~\.ssh\draftclub_vps")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_ENV = os.path.join(ROOT, ".env")               # корневой .env: SUPABASE_URL/SUPABASE_KEY/BOT_TOKEN
REMOTE_DIR = "/opt/draft-club"
REMOTE_ENV = f"{REMOTE_DIR}/.env"

UNIT = """[Unit]
Description=Draft Club notify bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/draft-club
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 bot/run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
"""

# collect.py auto каждые 2 мин: пишет lineup и статусы активных матчей. SEASON_IDS=1995 (ЧМ-2026).
CRON = "*/2 * * * * cd /opt/draft-club && SEASON_IDS=1995 /usr/bin/python3 collect.py auto >> /var/log/dc-collect.log 2>&1"


def run(ssh, c):
    _, o, e = ssh.exec_command(c)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    return o.channel.recv_exit_status(), out, err


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, key_filename=KEY, timeout=20)

# 1) корневой .env через SFTP (600)
sftp = ssh.open_sftp()
sftp.put(LOCAL_ENV, REMOTE_ENV)
sftp.chmod(REMOTE_ENV, 0o600)
st = sftp.stat(REMOTE_ENV)
sftp.close()
print(f"[.env] залит -> {REMOTE_ENV}, {st.st_size} байт, права 600")

# 2) systemd unit (через base64, без проблем с кавычками)
b64 = base64.b64encode(UNIT.encode()).decode()
run(ssh, f"echo {b64} | base64 -d > /etc/systemd/system/dc-bot.service")
run(ssh, "systemctl daemon-reload")
run(ssh, "systemctl enable dc-bot 2>&1")
c, o, e = run(ssh, "systemctl restart dc-bot 2>&1; sleep 1; systemctl is-active dc-bot")
print("[systemd] enable + restart:", (o + e).strip() or "ok")

# 3) cron (идемпотентно: убираем прежнюю строку collect.py auto, добавляем свежую)
c, o, e = run(ssh, f"( crontab -l 2>/dev/null | grep -v 'collect.py auto' ; echo '{CRON}' ) | crontab - && crontab -l | grep 'collect.py auto'")
print("[cron]", o.strip() or e.strip())

# 4) проверки
c, o, e = run(ssh, "sleep 2; echo active=$(systemctl is-active dc-bot); echo '--- journal ---'; journalctl -u dc-bot -n 8 --no-pager 2>&1 | tail -8")
print("[dc-bot]\n" + (o + e).strip())

ssh.close()
