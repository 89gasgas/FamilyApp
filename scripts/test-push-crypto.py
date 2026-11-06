"""Check the push function's cryptography independently, with openssl and the standard library.

Plays the phone: makes a key pair, asks the function (selftest mode) to encrypt a text for it,
decrypts it following RFC 8291 and checks the VAPID JWT signature (RFC 8292).
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _secrets as S

SPKI = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
unb64u = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hkdf(salt, ikm, info, n):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]


def ssl(*a, inp=None):
    return subprocess.run(["openssl", *a], input=inp, capture_output=True, check=True).stdout


def pem_pub(raw, path):
    with open(path, "wb") as f:
        f.write(b"-----BEGIN PUBLIC KEY-----\n" + base64.encodebytes(SPKI + raw) + b"-----END PUBLIC KEY-----\n")


def der_int(b):
    b = b.lstrip(b"\0")
    if b[0] & 0x80:
        b = b"\0" + b
    return b"\x02" + bytes([len(b)]) + b


ok = True
with tempfile.TemporaryDirectory() as d:
    ua_pem = os.path.join(d, "ua.pem")
    ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ua_pem)
    ua_pub = ssl("ec", "-in", ua_pem, "-pubout", "-outform", "DER")[-65:]
    auth = secrets.token_bytes(16)
    text = "Prova àèìòù 🛒 " + secrets.token_hex(4)

    s = S.load()
    url = s["SUPABASE_URL"].rstrip("/") + "/functions/v1/push"
    req = urllib.request.Request(url, method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"selftest": {"p256dh": b64u(ua_pub), "auth": b64u(auth),
                                                               "text": text, "aud": "https://fcm.googleapis.com"}}).encode())
    res = json.loads(urllib.request.urlopen(req, timeout=60).read())

    body = unb64u(res["body"])
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_pub, ct = body[21:21 + idlen], body[21 + idlen:]
    pem_pub(as_pub, os.path.join(d, "as.pem"))
    shared = ssl("pkeyutl", "-derive", "-inkey", ua_pem, "-peerkey", os.path.join(d, "as.pem"))
    ikm = hkdf(auth, shared, b"WebPush: info\0" + ua_pub + as_pub, 32)
    cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\0", 12)
    plain = ssl("enc", "-d", "-aes-128-ctr", "-K", cek.hex(), "-iv", (nonce + b"\0\0\0\x02").hex(), inp=ct[:-16])
    got = plain[:-1].decode("utf-8", "replace") if plain.endswith(b"\x02") else None
    print("header: rs", rs, "keyid", idlen, "bytes")
    print("decryption:", "OK" if got == text else f"FAILED ({got!r})")
    ok &= got == text

    h, p, sig = res["jwt"].split(".")
    claims = json.loads(unb64u(p))
    sig = unb64u(sig)
    der = der_int(sig[:32]) + der_int(sig[32:])
    with open(os.path.join(d, "sig"), "wb") as f:
        f.write(b"\x30" + bytes([len(der)]) + der)
    pem_pub(unb64u(res["pub"]), os.path.join(d, "v.pem"))
    v = subprocess.run(["openssl", "dgst", "-sha256", "-verify", os.path.join(d, "v.pem"), "-signature",
                        os.path.join(d, "sig")], input=f"{h}.{p}".encode(), capture_output=True)
    good = v.returncode == 0 and json.loads(unb64u(h))["alg"] == "ES256" and claims["aud"] == "https://fcm.googleapis.com"
    print("VAPID signature:", "OK" if good else "FAILED", "| claims", sorted(claims))
    ok &= good
sys.exit(0 if ok else 1)
