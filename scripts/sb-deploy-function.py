"""Deploy an edge function from supabase/functions/<name>/index.ts (Supabase Management API).

Usage: python scripts/sb-deploy-function.py push
The function is public (verify_jwt false): it holds no secrets and only acts on job ids
that exist in the database for a few minutes.
"""
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

name = sys.argv[1]
if not name.isidentifier():
    sys.exit("bad name")
with open(os.path.join(S.ROOT, "supabase", "functions", name, "index.ts"), "rb") as f:
    code = f.read()

s = S.load()
ref = S.project_ref(s)
b = "----fa" + secrets.token_hex(8)
meta = json.dumps({"entrypoint_path": "index.ts", "name": name, "verify_jwt": False}).encode()
body = (f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n").encode() + meta + \
       (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"index.ts\"\r\n"
        "Content-Type: application/typescript\r\n\r\n").encode() + code + f"\r\n--{b}--\r\n".encode()
status, out = S.request("POST", f"https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug={name}",
                        token=s["SUPABASE_ACCESS_TOKEN"], body=body,
                        headers={"Content-Type": f"multipart/form-data; boundary={b}"})
print("status:", status)
print(S.redact(out, s)[:1500])
sys.exit(0 if 200 <= status < 300 else 1)
