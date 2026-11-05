"""Shared helpers for FamilyApp service scripts.

Reads keys from Segreti.txt and never prints them.
"""
import json
import os
import re
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_FILE = os.path.join(ROOT, "Segreti.txt")
UA = "FamilyApp-scripts/1.0"


def load():
    values = {}
    with open(SECRETS_FILE, encoding="utf-8-sig") as f:
        for line in f:
            m = re.match(r"\s*([A-Z0-9_]+)\s*[=:]\s*(.*?)\s*$", line)
            if m:
                values[m.group(1)] = m.group(2).strip('"').strip("'")
    return values


def project_ref(s):
    m = re.match(r"https://([a-z0-9]+)\.supabase\.co", s["SUPABASE_URL"])
    return m.group(1)


def request(method, url, token=None, body=None, headers=None):
    """HTTP call; returns (status, parsed_json_or_text). Never echoes headers."""
    h = {"User-Agent": UA, "Accept": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        else:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    text = raw.decode("utf-8", "replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def redact(obj, s):
    """Remove any secret value from text before printing."""
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1)
    for k, v in s.items():
        if v and len(v) > 6 and k != "GITHUB_USER" and k != "SUPABASE_URL":
            text = text.replace(v, "<" + k + ">")
    return text
