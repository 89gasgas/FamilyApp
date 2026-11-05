"""Configure Supabase Auth: site URL, allowed redirects, and Google login
(enabled only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are in Segreti.txt)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

SITE = "https://familyapp-gas.vercel.app"
s = S.load()
ref = S.project_ref(s)
body = {"site_url": SITE, "uri_allow_list": f"{SITE}/**,http://localhost:5173/**"}
if s.get("GOOGLE_CLIENT_ID") and s.get("GOOGLE_CLIENT_SECRET"):
    body.update({"external_google_enabled": True, "external_google_client_id": s["GOOGLE_CLIENT_ID"],
                 "external_google_secret": s["GOOGLE_CLIENT_SECRET"]})
st, out = S.request("PATCH", f"https://api.supabase.com/v1/projects/{ref}/config/auth",
                    token=s["SUPABASE_ACCESS_TOKEN"], body=body)
print("auth config:", st, "| google:", "enabled" if "external_google_enabled" in body else "waiting for keys")
if st >= 300:
    print(S.redact(out, s)[:500])
print("Google redirect URI to register:", f"https://{ref}.supabase.co/auth/v1/callback")
