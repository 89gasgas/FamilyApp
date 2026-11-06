// FamilyApp edge function "push": sends the Web Push notifications of one job.
// Called by the database (pg_net) with {job}; everything else comes from push_take, so the
// function holds no secrets. Encryption: RFC 8291 (aes128gcm); auth: VAPID (RFC 8292).
// {selftest: {p256dh, auth, text, aud}} returns an encrypted body and a VAPID JWT with a
// throwaway key, used only to check the cryptography from scripts/test-push-crypto.py.

const SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const te = new TextEncoder();

const b64u = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const cat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) { out.set(x, i); i += x.length; }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

async function encrypt(text: string, p256dh: string, authSecret: string) {
  const ua = b64u.dec(p256dh), auth = b64u.dec(authSecret);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key,
    cat(te.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return cat(head, asPub, ct);
}

async function vapidJwt(jwk: JsonWebKey, aud: string, sub: string) {
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: unknown) => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = part({ typ: "JWT", alg: "ES256" }) + "." +
    part({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return unsigned + "." + b64u.enc(sig);
}

async function rpc(name: string, args: unknown) {
  const r = await fetch(`${SB}/rest/v1/rpc/${name}`, {
    method: "POST", body: JSON.stringify(args),
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

type Msg = { endpoint: string; p256dh: string; auth: string; payload: { tag?: string } };

Deno.serve(async (req) => {
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  let body: { job?: string; selftest?: { p256dh: string; auth: string; text: string; aud: string } };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  if (body.selftest) {
    const t = body.selftest;
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return json({
      body: b64u.enc(await encrypt(t.text, t.p256dh, t.auth)),
      jwt: await vapidJwt(jwk, t.aud, "mailto:test@example.com"), pub: b64u.enc(pub),
    });
  }

  if (!body.job || !/^[0-9a-f-]{36}$/.test(body.job)) return json({ error: "bad request" }, 400);
  const job = await rpc("push_take", { p_job: body.job });
  if (!job) return json({ sent: 0 });
  const gone: string[] = [];
  const results = await Promise.all((job.messages as Msg[]).map(async (m) => {
    try {
      const aud = new URL(m.endpoint).origin;
      const r = await fetch(m.endpoint, {
        method: "POST", body: await encrypt(JSON.stringify(m.payload), m.p256dh, m.auth),
        headers: {
          Authorization: `vapid t=${await vapidJwt(job.jwk, aud, job.sub)}, k=${job.pub}`,
          "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
          TTL: "86400", Urgency: "normal",
          ...(m.payload.tag ? { Topic: m.payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
        },
      });
      if (r.status === 404 || r.status === 410) gone.push(m.endpoint);
      if (!r.ok) console.log("push", r.status, aud, (await r.text()).slice(0, 200));
      return r.status;
    } catch (e) {
      console.log("push error", String(e));
      return 0;
    }
  }));
  await rpc("push_done", { p_job: body.job, p_gone: gone });
  return json({ sent: results.filter((s) => s >= 200 && s < 300).length, results });
});
