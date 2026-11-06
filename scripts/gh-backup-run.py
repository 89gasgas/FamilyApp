"""Start the backup workflow on GitHub now and wait for its result. Never prints keys.

Usage: python scripts/gh-backup-run.py           (start a run and wait)
       python scripts/gh-backup-run.py --status  (only show the latest runs)
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
env = dict(os.environ, GH_TOKEN=s["GITHUB_TOKEN"], GH_PROMPT_DISABLED="1")
repo = s["GITHUB_USER"] + "/FamilyApp"


def gh(*args):
    r = subprocess.run(["gh", *args, "--repo", repo], env=env, capture_output=True, text=True)
    return r.returncode, S.redact(r.stdout + r.stderr, s)


def runs():
    return gh("run", "list", "--workflow", "backup.yml", "--limit", "3",
              "--json", "databaseId,status,conclusion,event,createdAt",
              "--template", '{{range .}}{{.databaseId}} {{.event}} {{.status}} {{.conclusion}} {{.createdAt}}\n{{end}}')[1]


if "--status" not in sys.argv:
    code, out = gh("workflow", "run", "backup.yml")
    print("start:", "ok" if code == 0 else out)
    if code:
        sys.exit(1)
    time.sleep(8)
    for _ in range(36):
        latest = runs().splitlines()[:1]
        if latest and " completed " in latest[0] + " ":
            break
        time.sleep(5)
print(runs())
