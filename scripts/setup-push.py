"""One-time setup for notifications: VAPID keys and the push function URL in private.config.

The key pair is made with openssl; the private key goes only into the database (private
schema, never exported by the backup) and is never printed. Existing keys are kept, so
phones stay subscribed: pass --rotate to force new ones.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
ref = S.project_ref(s)


def sql(q):
    status, out = S.request("POST", f"https://api.supabase.com/v1/projects/{ref}/database/query",
                            token=s["SUPABASE_ACCESS_TOKEN"], body={"query": q})
    if not 200 <= status < 300:
        sys.exit(f"database error {status}")
    return out


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


have = sql("select count(*) n from private.config where key = 'vapid_jwk'")[0]["n"]
if have and "--rotate" not in sys.argv:
    print("VAPID keys: already present, kept")
else:
    with tempfile.TemporaryDirectory() as d:
        pem = os.path.join(d, "k.pem")
        subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", pem], check=True)
        text = subprocess.run(["openssl", "ec", "-in", pem, "-text", "-noout"], check=True,
                              capture_output=True, text=True).stdout
    hexes = re.findall(r"(priv|pub):\s*\n((?:\s+[0-9a-f:]+\n)+)", text)
    raw = {k: bytes.fromhex(re.sub(r"[\s:]", "", v)) for k, v in hexes}
    d_, pub = raw["priv"][-32:].rjust(32, b"\0"), raw["pub"]
    assert len(pub) == 65 and pub[0] == 4
    jwk = {"kty": "EC", "crv": "P-256", "x": b64u(pub[1:33]), "y": b64u(pub[33:]), "d": b64u(d_)}
    tag = "$k$"
    sql("insert into private.config (key, value) values "
        f"('vapid_jwk', {tag}{json.dumps(jwk)}{tag}), ('vapid_public', '{b64u(pub)}') "
        "on conflict (key) do update set value = excluded.value")
    print("VAPID keys: created")

sql("insert into private.config (key, value) values "
    f"('push_url', 'https://{ref}.supabase.co/functions/v1/push'), "
    "('push_subject', 'mailto:89gasgas@gmail.com') on conflict (key) do update set value = excluded.value")
print("push_url and subject: ok")
