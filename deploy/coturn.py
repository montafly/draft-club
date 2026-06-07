# Ставит coturn (TURN/STUN) на VPS для WebRTC-видеосвязи драфта.
# Режим эфемерных кредов (use-auth-secret): Node-сервер будет минтить временные логин/пароль из секрета.
# Секрет генерится один раз и пишется: в /etc/turnserver.conf на VPS + в локальный server/.env (TURN_SECRET) для /api/ice.
import sys, os, secrets, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

HOST = "147.45.158.66"
KEY = r"C:\Users\Montafly\.ssh\draftclub_vps"
DOMAIN = "draftclub.147.45.158.66.sslip.io"
ENV = r"C:\Users\Montafly\Desktop\Draft Club\server\.env"

# секрет: переиспользуем из .env если уже есть, иначе генерим
sec = None
if os.path.exists(ENV):
    for line in open(ENV, encoding="utf-8"):
        m = re.match(r"\s*TURN_SECRET\s*=\s*(\S+)", line)
        if m:
            sec = m.group(1).strip()
if not sec:
    sec = secrets.token_hex(32)

CONF = f"""listening-port=3478
fingerprint
use-auth-secret
static-auth-secret={sec}
realm={DOMAIN}
external-ip={HOST}
min-port=49152
max-port=65535
no-cli
no-tlsv1
no-tlsv1_1
log-file=/var/log/turnserver.log
simple-log
"""

STEPS = [
    ("apt install coturn", "DEBIAN_FRONTEND=noninteractive apt-get install -y coturn 2>&1 | tail -2"),
    ("enable coturn default", "sed -i 's/^#\\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; grep TURNSERVER_ENABLED /etc/default/coturn"),
    ("write turnserver.conf", f"cat > /etc/turnserver.conf <<'EOF'\n{CONF}EOF\necho conf-written"),
    ("firewall 3478 + relay", "ufw allow 3478/tcp; ufw allow 3478/udp; ufw allow 49152:65535/udp; echo fw-done"),
    ("enable+restart", "systemctl enable coturn 2>&1 | tail -1; systemctl restart coturn; sleep 1; systemctl is-active coturn"),
    ("listen check (udp 3478)", "ss -lun | grep ':3478' || echo 'нет UDP 3478'"),
    ("listen check (tcp 3478)", "ss -ltn | grep ':3478' || echo 'нет TCP 3478'"),
]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username="root", key_filename=KEY, timeout=25)
for name, cmd in STEPS:
    _, out, err = ssh.exec_command(cmd)
    o = out.read().decode("utf-8", "replace").strip()
    e = err.read().decode("utf-8", "replace").strip()
    print(f"[{name}] {o or e}")
ssh.close()

# записать секрет/URL в локальный .env (для /api/ice), если ещё нет
env_txt = open(ENV, encoding="utf-8").read() if os.path.exists(ENV) else ""
add = ""
if "TURN_SECRET=" not in env_txt:
    add += f"\nTURN_SECRET={sec}"
if "TURN_URL=" not in env_txt:
    add += f"\nTURN_URL=turn:{DOMAIN}:3478"
if "TURN_REALM=" not in env_txt:
    add += f"\nTURN_REALM={DOMAIN}"
if add:
    with open(ENV, "a", encoding="utf-8") as f:
        f.write(add + "\n")
    print("[.env] добавлены TURN_SECRET/TURN_URL/TURN_REALM (локально; задеплоится push.py)")
else:
    print("[.env] TURN_* уже присутствуют")
print("[secret] первые/последние символы:", sec[:4] + "…" + sec[-4:])
