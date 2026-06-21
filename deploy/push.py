# Деплой на VPS: git pull, заливка server/.env через SFTP, перезапуск сервиса.
# Секреты не печатаются: .env переносится файлом, не через stdout.
import sys, os, paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows-консоль (cp1251) иначе падает на '●'/кириллице

HOST = "147.45.158.66"
USER = "root"
# Пути переносимы между машинами: ключ в ~/.ssh, .env — относительно репо.
KEY = os.path.expanduser(r"~\.ssh\draftclub_vps")
LOCAL_ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server", ".env")
REMOTE_ENV = "/opt/draft-club/server/.env"

def run(ssh, cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, key_filename=KEY, timeout=20)

# 1. свежий код
c, o, e = run(ssh, "cd /opt/draft-club && git pull --ff-only 2>&1")
print("[git pull]", o.strip() or e.strip())

# 2. .env через SFTP (без печати содержимого)
sftp = ssh.open_sftp()
sftp.put(LOCAL_ENV, REMOTE_ENV)
sftp.chmod(REMOTE_ENV, 0o600)
st = sftp.stat(REMOTE_ENV)
sftp.close()
print(f"[.env] залит, размер {st.st_size} байт, права 600")

# 3. зависимости + рестарт
c, o, e = run(ssh, "cd /opt/draft-club/server && npm install --no-audit --no-fund 2>&1 | tail -3")
print("[npm]", o.strip())
c, o, e = run(ssh, "systemctl restart draftclub && sleep 2 && systemctl is-active draftclub")
print("[service]", (o + e).strip())

# 4. проверки
c, o, e = run(ssh, "curl -sS http://localhost:4000/config.json")
print("[config.json]", o.strip()[:120], "...")
c, o, e = run(ssh, "systemctl --no-pager status draftclub | sed -n '1,8p'")
print("[status]\n" + o.strip())

ssh.close()
