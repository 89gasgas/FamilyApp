"""Deploy app/ to Vercel production (project familyapp-gas). Prints only URLs and status."""
import base64
import os
import subprocess
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

PROJECT = "familyapp-gas"
s = S.load()
MONTHS = "gen feb mar apr mag giu lug ago set ott nov dic".split()
now = datetime.now()  # the PC is in Italy
version = f"{now.day} {MONTHS[now.month - 1]} {now.year}, {now:%H:%M}"
subprocess.run([sys.executable, os.path.join(S.ROOT, "scripts", "gen-config.py"), version], check=True)

app = os.path.join(S.ROOT, "app")
files = []
for d, _, names in os.walk(app):
    for n in names:
        p = os.path.join(d, n)
        rel = os.path.relpath(p, app).replace(os.sep, "/")
        files.append({"file": rel, "data": base64.b64encode(open(p, "rb").read()).decode(),
                      "encoding": "base64"})

body = {"name": PROJECT, "files": files, "target": "production",
        "projectSettings": {"framework": None, "buildCommand": None, "outputDirectory": None}}
st, out = S.request("POST", "https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1",
                    token=s["VERCEL_TOKEN"], body=body)
print("create:", st)
if st >= 300:
    print(S.redact(out, s)[:800])
    sys.exit(1)
dep = out["id"]
for _ in range(40):
    st, d = S.request("GET", f"https://api.vercel.com/v13/deployments/{dep}", token=s["VERCEL_TOKEN"])
    if d.get("readyState") in ("READY", "ERROR", "CANCELED"):
        break
    time.sleep(3)
print("state:", d.get("readyState"))
print("aliases:", ", ".join("https://" + a for a in d.get("alias", [])))
