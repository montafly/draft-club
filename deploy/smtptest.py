# Прямой тест SMTP — показывает точную причину отказа.
# Gmail:  python deploy/smtptest.py gmail "APP_PASSWORD" montafly4@gmail.com
# Brevo:  python deploy/smtptest.py brevo "xsmtpsib-..."   (login/sender зашиты ниже)
import sys, smtplib
from email.message import EmailMessage

PROVIDER = sys.argv[1] if len(sys.argv) > 1 else ""
PASS = sys.argv[2] if len(sys.argv) > 2 else ""

if PROVIDER == "gmail":
    HOST, PORT = "smtp.gmail.com", 587
    SENDER = sys.argv[3] if len(sys.argv) > 3 else "montafly4@gmail.com"
    LOGIN = SENDER                     # в Gmail login = адрес ящика
elif PROVIDER == "brevo":
    HOST, PORT = "smtp-relay.brevo.com", 587
    LOGIN = "adc74c001@smtp-brevo.com"
    SENDER = "montafly4@gmail.com"
else:
    print('Запуск: python deploy/smtptest.py gmail "APP_PASSWORD" montafly4@gmail.com')
    raise SystemExit

if not PASS:
    print("нет пароля/ключа во втором аргументе"); raise SystemExit

TO = "montafly4+dc1@gmail.com"         # придёт в ящик montafly4@gmail.com

msg = EmailMessage()
msg["From"] = f"Draft Club <{SENDER}>"
msg["To"] = TO
msg["Subject"] = "Draft Club SMTP test"
msg.set_content("Esли это письмо пришло - SMTP работает.")

try:
    s = smtplib.SMTP(HOST, PORT, timeout=30)
    s.starttls()
    s.ehlo()
    s.login(LOGIN, PASS)
    print(f"[AUTH OK] {PROVIDER}: логин принят ({LOGIN})")
    s.send_message(msg)
    print(f"[SEND OK] письмо принято -> проверь montafly4@gmail.com (и спам)")
    s.quit()
except smtplib.SMTPAuthenticationError as e:
    print("[AUTH FAIL] неверный login/пароль:", e)
except smtplib.SMTPSenderRefused as e:
    print("[SENDER REFUSED]:", e)
except smtplib.SMTPException as e:
    print("[SMTP ERROR]", type(e).__name__, e)
except Exception as e:
    print("[ERROR]", type(e).__name__, e)
