"""Create two confirmed test users in a separate test family.

Credentials are generated and saved to .test-users.json (git-ignored,
never deployed), used only by the local test page. Nothing secret is printed.
"""
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

s = S.load()
ref = S.project_ref(s)
OUT = os.path.join(S.ROOT, ".test-users.json")

st, keys = S.request("GET", f"https://api.supabase.com/v1/projects/{ref}/api-keys?reveal=true",
                     token=s["SUPABASE_ACCESS_TOKEN"])
print("api-keys:", st)
service = next(k["api_key"] for k in keys if k.get("name") == "service_role")

if os.path.exists(OUT):
    users = json.load(open(OUT, encoding="utf-8"))
else:
    users = [
        {"email": "test-gas@familyapp.test", "name": "GaS (prova)"},
        {"email": "test-chips@familyapp.test", "name": "Chips (prova)"},
    ]
    for u in users:
        u["password"] = secrets.token_urlsafe(18)

adm = {"apikey": service}
for u in users:
    st, out = S.request("POST", s["SUPABASE_URL"] + "/auth/v1/admin/users", token=service,
                        headers=adm, body={"email": u["email"], "password": u["password"],
                                           "email_confirm": True})
    print("create", u["email"], st, "" if st < 300 else str(out.get("msg") or out.get("error_code") or "")[:120])

json.dump(users, open(OUT, "w", encoding="utf-8"), indent=1)

sql = """
insert into public.families (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Famiglia di prova')
on conflict (id) do nothing;
""" + "".join(
    f"insert into public.members (email, family_id, display_name) values ('{u['email']}', "
    f"'00000000-0000-0000-0000-0000000000f1', '{u['name']}') on conflict (email) do nothing;\n"
    for u in users)
st, out = S.request("POST", f"https://api.supabase.com/v1/projects/{ref}/database/query",
                    token=s["SUPABASE_ACCESS_TOKEN"], body={"query": sql})
print("family+members:", st, S.redact(out, s)[:300])
