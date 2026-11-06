"""Daily backup + keep-alive (run by GitHub Actions, .github/workflows/backup.yml).

Calls backup_export through the Supabase API (this API call also keeps the free project
from pausing) and writes backups/backup.json. Reads SUPABASE_URL, SUPABASE_ANON_KEY and
BACKUP_KEY from the environment; locally falls back to Segreti.txt. Never prints keys.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "BACKUP_KEY")

env = {k: os.environ.get(k, "") for k in NAMES}
if not all(env.values()):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _secrets as S
    s = S.load()
    env = {k: env[k] or s.get(k, "") for k in NAMES}
missing = [k for k in NAMES if not env[k]]
if missing:
    sys.exit("missing: " + ", ".join(missing))

req = urllib.request.Request(
    env["SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/backup_export",
    data=json.dumps({"p_key": env["BACKUP_KEY"]}).encode(),
    method="POST",
    headers={"apikey": env["SUPABASE_ANON_KEY"], "Authorization": "Bearer " + env["SUPABASE_ANON_KEY"],
             "Content-Type": "application/json", "User-Agent": "FamilyApp-backup/1.0"},
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        status, data = r.status, json.loads(r.read())
except urllib.error.HTTPError as e:
    sys.exit(f"backup failed: HTTP {e.code}")

os.makedirs(os.path.join(ROOT, "backups"), exist_ok=True)
with open(os.path.join(ROOT, "backups", "backup.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
    f.write("\n")
print("backup:", status, "|", ", ".join(f"{k} {len(v)}" for k, v in sorted(data.items())))
