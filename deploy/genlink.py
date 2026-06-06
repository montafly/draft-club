# Генерит magic-link для входа/подтверждения через админ-API Supabase (без отправки письма).
# Находит «живую» регу (не dctest*), отдаёт action_link с redirect_to на VPS.
import json, urllib.request, os

ENV = r"C:\Users\Montafly\Desktop\Draft Club\server\.env"
REDIRECT = "https://draftclub.147.45.158.66.sslip.io/"

env = {}
for line in open(ENV, encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
URL, SVC = env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]

def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method,
        headers={"apikey": SVC, "authorization": "Bearer " + SVC, "content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def mask(e):
    n, d = e.split("@"); return (n[:2] + "***@" + d)

users = api("/auth/v1/admin/users").get("users", [])
real = [u for u in users if not u["email"].startswith("dctest")]
real.sort(key=lambda u: u.get("created_at", ""), reverse=True)
if not real:
    print("живых рег не найдено (только dctest*)"); raise SystemExit
u = real[0]
print(f"юзер: {mask(u['email'])} | подтверждён: {bool(u.get('email_confirmed_at'))} | создан: {u.get('created_at','')[:19]}")

res = api("/auth/v1/admin/generate_link", "POST",
          {"type": "magiclink", "email": u["email"], "redirect_to": REDIRECT})
link = res.get("action_link", "")
print("\n=== ССЫЛКА ВХОДА (одноразовая, открой в браузере) ===")
print(link)
print("\nredirect_to в ссылке:", "OK 147.45.158.66:4000" if "147.45.158.66" in link else "НЕ наш адрес — " + link)
