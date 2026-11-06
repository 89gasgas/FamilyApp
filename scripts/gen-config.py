"""Write app/config.js with the public Supabase URL and anon key (never printed).

Optional argument: the app version shown in the settings (deploy passes the publish time).

The anon key is designed to be public in the browser; data is protected by
row-level security. config.js is git-ignored and generated at deploy time.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
cfg = {"url": s["SUPABASE_URL"].rstrip("/"), "anonKey": s["SUPABASE_ANON_KEY"]}
with open(os.path.join(S.ROOT, "app", "config.js"), "w", encoding="utf-8") as f:
    f.write("window.FA_CONFIG = " + json.dumps(cfg) + ";\n")
    f.write("window.FA_VERSION = " + json.dumps(sys.argv[1] if len(sys.argv) > 1 else "sviluppo") + ";\n")
print("config.js ok")
