"""Run a SQL file from supabase/ on the FamilyApp Supabase project.

Usage: python scripts/sb-sql.py supabase/<file>.sql
Prints status and the query result (secrets redacted).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

path = sys.argv[1]
full = os.path.abspath(os.path.join(S.ROOT, path))
if not full.startswith(os.path.join(S.ROOT, "supabase") + os.sep) or not full.endswith(".sql"):
    sys.exit("Only .sql files inside supabase/ are allowed")

s = S.load()
ref = S.project_ref(s)
with open(full, encoding="utf-8") as f:
    sql = f.read()
status, out = S.request(
    "POST",
    f"https://api.supabase.com/v1/projects/{ref}/database/query",
    token=s["SUPABASE_ACCESS_TOKEN"],
    body={"query": sql},
)
print("status:", status)
print(S.redact(out, s)[:4000])
sys.exit(0 if 200 <= status < 300 else 1)
