# Ставит Caddy на VPS, вешает https (Let's Encrypt) на sslip.io-домен, прокси на :4000.
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

HOST = "147.45.158.66"
KEY = r"C:\Users\Montafly\.ssh\draftclub_vps"
DOMAIN = "draftclub.147.45.158.66.sslip.io"

CADDYFILE = f"{DOMAIN} {{\n    reverse_proxy localhost:4000\n}}\n"

STEPS = [
    ("firewall 80/443", "ufw allow 80/tcp; ufw allow 443/tcp; echo done"),
    ("apt deps", "DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg 2>&1 | tail -2"),
    ("caddy gpg key", "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && echo key-ok"),
    ("caddy repo", "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list && echo repo-ok"),
    ("apt update", "DEBIAN_FRONTEND=noninteractive apt-get update 2>&1 | tail -2"),
    ("install caddy", "DEBIAN_FRONTEND=noninteractive apt-get install -y caddy 2>&1 | tail -3"),
    ("caddy version", "caddy version"),
    ("write Caddyfile", f"cat > /etc/caddy/Caddyfile <<'EOF'\n{CADDYFILE}EOF\ncat /etc/caddy/Caddyfile"),
    ("restart caddy", "systemctl restart caddy && sleep 8 && systemctl is-active caddy"),
]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username="root", key_filename=KEY, timeout=25)

def run(cmd, t=180):
    i, o, e = ssh.exec_command(cmd, timeout=t)
    out = o.read().decode("utf-8", "replace").strip()
    err = e.read().decode("utf-8", "replace").strip()
    return out, err

for name, cmd in STEPS:
    out, err = run(cmd)
    print(f"[{name}] {out or err}")

# проверка https (Caddy получил сертификат?)
import time
time.sleep(4)
out, err = run(f"curl -sS --max-time 15 https://{DOMAIN}/config.json", t=30)
print(f"[https config.json] {out or err}")
out, err = run("journalctl -u caddy --no-pager -n 6 2>&1 | tail -6", t=30)
print(f"[caddy log]\n{out}")

ssh.close()
