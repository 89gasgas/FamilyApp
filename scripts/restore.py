"""Restore one family's data from a backup (backups/backup.json or an older version of it).

Usage:
  python scripts/restore.py --family prova|reale|<uuid> [--file F | --commit SHA|AAAA-MM-GG] [--apply]

Without --apply it only compares backup and database (nothing is changed).
With --apply, in a single transaction:
  - the family and its members are re-created if missing (members are never deleted);
  - the family's shopping items, to-dos, expense categories and expenses are replaced by the backup's
    (tables the backup has not saved yet, like to-dos in early backups, are left untouched).
Before changing anything, the family's current data is saved to
backups/prima-del-ripristino-<ora>.json (not committed). Never prints keys.
"""
import argparse
import datetime
import json
import os
import secrets
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

sys.stdout.reconfigure(encoding="utf-8")

FAMILIES = {"prova": "00000000-0000-0000-0000-0000000000f1",
            "reale": "496e6cf0-7604-4405-8efb-62ec3ed42aa4"}
DATA_TABLES = ("shopping_items", "tasks", "expense_categories", "expenses")  # replaced wholesale, in FK order

ap = argparse.ArgumentParser()
ap.add_argument("--family", required=True)
src = ap.add_mutually_exclusive_group()
src.add_argument("--file", default=os.path.join("backups", "backup.json"))
src.add_argument("--commit", help="git commit or date AAAA-MM-GG of the backup to use")
ap.add_argument("--apply", action="store_true")
a = ap.parse_args()
fam = FAMILIES.get(a.family, a.family)


def git(*args):
    return subprocess.run(["git", "-C", S.ROOT, *args], check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout


# ---- load the backup
if a.commit:
    ref = a.commit
    if len(ref) == 10 and ref[4] == "-":   # a date: last backup committed that day or before
        ref = git("log", "-1", "--format=%H", f"--before={ref} 23:59:59", "--", "backups/backup.json").strip()
        if not ref:
            sys.exit("nessun backup trovato fino a quella data")
    label = "commit " + git("log", "-1", "--format=%h del %ad", "--date=short", ref).strip()
    data = json.loads(git("show", f"{ref}:backups/backup.json"))
else:
    label = a.file
    with open(os.path.join(S.ROOT, a.file), encoding="utf-8") as f:
        data = json.load(f)

s = S.load()
REF = S.project_ref(s)


def sql(query):
    status, out = S.request("POST", f"https://api.supabase.com/v1/projects/{REF}/database/query",
                            token=s["SUPABASE_ACCESS_TOKEN"], body={"query": query})
    if not 200 <= status < 300:
        sys.exit(f"errore database {status}: " + S.redact(out, s)[:800])
    return out


def lit(obj):
    """JSON as a dollar-quoted SQL literal."""
    tag = "j" + secrets.token_hex(6)
    return f"${tag}${json.dumps(obj, ensure_ascii=False)}${tag}$::json"


mine = {t: [r for r in data.get(t, []) if r.get("family_id") == fam] for t in data}
family_row = next((r for r in data.get("families", []) if r["id"] == fam), None)
if not family_row:
    sys.exit(f"la famiglia {fam} non è nel backup ({label})")

now = sql("select " + ", ".join(
    f"(select count(*) from public.{t} where {'id' if t == 'families' else 'family_id'} = '{fam}') as {t}"
    for t in ("families", "members") + DATA_TABLES))[0]

print(f"Backup: {label}  |  famiglia: {family_row['name']}")
print(f"{'':16}{'nel database':>14}{'nel backup':>12}")
for t in ("members",) + DATA_TABLES:
    have = "non salvate" if t not in data else len(mine[t])
    print(f"{t:16}{now[t]:>14}{have:>12}")
for t in ("shopping_items",):
    rows = mine[t]
    print(f"  di cui spesa da comprare nel backup: {sum(1 for r in rows if not r.get('bought'))}")

if not a.apply:
    print("\nProva soltanto: nulla è stato cambiato. Aggiungi --apply per ripristinare.")
    sys.exit(0)

# ---- safety copy of the current data
snap = sql("select json_build_object("
           f"'families', (select coalesce(json_agg(f), '[]') from public.families f where id = '{fam}'), "
           f"'members', (select coalesce(json_agg(m), '[]') from public.members m where family_id = '{fam}'), "
           + ", ".join(f"'{t}', (select coalesce(json_agg(x), '[]') from public.{t} x where family_id = '{fam}')"
                       for t in DATA_TABLES) + ") as snap")[0]["snap"]
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
snap_path = os.path.join(S.ROOT, "backups", f"prima-del-ripristino-{stamp}.json")
with open(snap_path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(snap, f, ensure_ascii=False, indent=1, sort_keys=True)
print("\nCopia dei dati attuali:", os.path.relpath(snap_path, S.ROOT))

# ---- columns we can write (generated ones, like name_key, are computed by the database)
cols = {}
for r in sql("select table_name, column_name from information_schema.columns "
             "where table_schema = 'public' and is_generated = 'NEVER' "
             "and table_name in ('families','members','shopping_items','tasks','expense_categories','expenses')"):
    cols.setdefault(r["table_name"], []).append(r["column_name"])


def insert(table, rows, conflict):
    use = [c for c in cols[table] if any(c in r for r in rows)]
    cl = ", ".join(use)
    return (f"insert into public.{table} ({cl}) select {cl} "
            f"from json_populate_recordset(null::public.{table}, {lit(rows)}) {conflict};")


stmts = ["begin;",
         insert("families", [family_row], "on conflict (id) do nothing")]
if mine.get("members"):
    stmts.append(insert("members", mine["members"], "on conflict do nothing"))
saved = [t for t in DATA_TABLES if t in data]
if "expense_categories" in saved and "expenses" not in saved:
    saved.remove("expense_categories")   # never drop categories that current expenses point to
for t in reversed(saved):
    stmts.append(f"delete from public.{t} where family_id = '{fam}';")
for t in saved:
    if mine[t]:
        stmts.append(insert(t, mine[t], ""))
stmts.append("commit;")
sql("\n".join(stmts))

after = sql("select " + ", ".join(
    f"(select count(*) from public.{t} where family_id = '{fam}') as {t}" for t in ("members",) + DATA_TABLES))[0]
print("Ripristino fatto. Ora nel database:", ", ".join(f"{t} {after[t]}" for t in after))
