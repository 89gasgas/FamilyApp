"""SP-01 test: a registered account outside the family sees no data.

Creates (once) a confirmed outsider user that is NOT in members, logs in
as that user and checks that every read returns nothing and writes fail.
"""
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
ref = S.project_ref(s)
url, anon = s["SUPABASE_URL"].rstrip("/"), s["SUPABASE_ANON_KEY"]
users_file = os.path.join(S.ROOT, ".test-users.json")
users = json.load(open(users_file, encoding="utf-8"))
out = next((u for u in users if u.get("outsider")), None)
if not out:
    st, keys = S.request("GET", f"https://api.supabase.com/v1/projects/{ref}/api-keys?reveal=true",
                         token=s["SUPABASE_ACCESS_TOKEN"])
    service = next(k["api_key"] for k in keys if k.get("name") == "service_role")
    out = {"email": "test-outsider@familyapp.test", "name": "Estraneo", "outsider": True,
           "password": secrets.token_urlsafe(18)}
    st, _ = S.request("POST", url + "/auth/v1/admin/users", token=service, headers={"apikey": service},
                      body={"email": out["email"], "password": out["password"], "email_confirm": True})
    print("outsider created:", st)
    users.append(out)
    json.dump(users, open(users_file, "w", encoding="utf-8"), indent=1)

st, tok = S.request("POST", url + "/auth/v1/token?grant_type=password", headers={"apikey": anon},
                    body={"email": out["email"], "password": out["password"]})
assert st == 200, f"login failed {st}"
jwt = tok["access_token"]
h = {"apikey": anon}
ok = True
for table in ("shopping_items", "members", "families"):
    st, rows = S.request("GET", f"{url}/rest/v1/{table}?select=*", token=jwt, headers=h)
    passed = st == 200 and rows == []
    ok &= passed
    print(f"read {table}: {st}, rows={len(rows) if isinstance(rows, list) else '?'} ->", "OK" if passed else "FAIL")
st, _ = S.request("POST", f"{url}/rest/v1/rpc/add_item", token=jwt, headers=h,
                  body={"p_id": "00000000-0000-0000-0000-0000000000aa", "p_name": "intruso", "p_position": 1})
passed = st >= 400
ok &= passed
print(f"write add_item: {st} ->", "OK (rejected)" if passed else "FAIL")
print("SP-01 outsider:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
