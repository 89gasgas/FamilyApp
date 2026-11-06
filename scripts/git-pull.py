"""Pull github.com/<GITHUB_USER>/FamilyApp main into the local main (rebase), e.g. the daily backup commits.

Run before git-push.py. The token is passed only for this command (never stored or printed).
"""
import base64
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
basic = base64.b64encode(f"x-access-token:{s['GITHUB_TOKEN']}".encode()).decode()
env = dict(os.environ, GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
           GIT_CONFIG_VALUE_0="AUTHORIZATION: basic " + basic, GIT_TERMINAL_PROMPT="0")
url = f"https://github.com/{s['GITHUB_USER']}/FamilyApp.git"
r = subprocess.run(["git", "pull", "--rebase", url, "main"], cwd=S.ROOT, env=env, capture_output=True, text=True)
print(S.redact(r.stdout + r.stderr, s))
sys.exit(r.returncode)
