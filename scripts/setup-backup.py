"""One-time setup of the daily backup. Never prints keys.

1. Creates BACKUP_KEY in Segreti.txt if missing (random, 32 bytes).
2. Stores its SHA-256 in the database (private.config), never the key itself.
3. Sets the GitHub Actions secrets SUPABASE_URL, SUPABASE_ANON_KEY, BACKUP_KEY with gh.
"""
import hashlib
import os
import secrets
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
if not s.get("BACKUP_KEY"):
    with open(S.SECRETS_FILE, "rb") as f:
        ends_nl = f.read().endswith(b"\n")
    with open(S.SECRETS_FILE, "a", encoding="utf-8") as f:
        f.write(("" if ends_nl else "\n") + "BACKUP_KEY=" + secrets.token_urlsafe(32) + "\n")
    s = S.load()
    print("BACKUP_KEY: created in Segreti.txt")
else:
    print("BACKUP_KEY: already in Segreti.txt")

digest = hashlib.sha256(s["BACKUP_KEY"].encode()).hexdigest()
sql = ("insert into private.config (key, value) values ('backup_key_sha256', '%s') "
       "on conflict (key) do update set value = excluded.value; select 'ok' as result;" % digest)
st, out = S.request("POST", f"https://api.supabase.com/v1/projects/{S.project_ref(s)}/database/query",
                    token=s["SUPABASE_ACCESS_TOKEN"], body={"query": sql})
print("database hash:", st)
if st >= 300:
    sys.exit(S.redact(out, s)[:500])

env = dict(os.environ, GH_TOKEN=s["GITHUB_TOKEN"], GH_PROMPT_DISABLED="1")
repo = s["GITHUB_USER"] + "/FamilyApp"
for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "BACKUP_KEY"):
    r = subprocess.run(["gh", "secret", "set", name, "--repo", repo], input=s[name], env=env,
                       capture_output=True, text=True)
    print(f"github secret {name}:", "ok" if r.returncode == 0 else "FAILED " + S.redact(r.stderr, s)[:300])
