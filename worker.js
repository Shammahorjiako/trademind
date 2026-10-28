// TradeMind Worker: accounts (email code, Google, Apple), Paystack payments, shared price batch.
// Deploy: Cloudflare dashboard > Workers > your worker > Edit code > paste this whole file.
// Bindings:   KV namespace named USERS
// Secrets:    AUTH_KEY, PRO_SIGN_KEY, PAYSTACK_SECRET, TD_KEY, RESEND_KEY (or BREVO_KEY)
// Variables:  APP_URL, MAIL_FROM  (Resend: "TradeMind <login@yourdomain.com>")  or MAIL_FROM_EMAIL (Brevo)
//             GOOGLE_CLIENT_ID, APPLE_CLIENT_ID (only if you switch those buttons on)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const te = (s) => new TextEncoder().encode(s);
const b64 = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function hmac(key, d) { const k = await crypto.subtle.importKey('raw', te(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, te(d)))); }

// ---------- ACCOUNTS ----------
async function pbk(pw, salt) { const k = await crypto.subtle.importKey('raw', te(pw), 'PBKDF2', false, ['deriveBits']); return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256))); }
async function issue(env, email, name) { const body = b64(te(JSON.stringify({ email, exp: Date.now() + 30 * 864e5 }))); return { token: body + '.' + await hmac(env.AUTH_KEY, body), user: { email, name: name || '' } }; }
async function who(env, tok) { const [b, s] = (tok || '').split('.'); if (!b || s !== await hmac(env.AUTH_KEY, b)) return null; const p = JSON.parse(new TextDecoder().decode(unb64(b))); return p.exp > Date.now() ? p : null; }
const okEmail = (e) => /^\S+@\S+\.\S+$/.test(e || '') && e.length < 120;
const getJ = async (env, k) => JSON.parse((await env.USERS.get(k)) || 'null');
const code6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
const chash = (env, email, code) => hmac(env.AUTH_KEY, 'c:' + email + ':' + code);

async function mail(env, to, code, why) {
  const subject = why === 'reset' ? 'Your TradeMind password reset code' : 'Your TradeMind verification code';
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">TradeMind</h2><p>${why === 'reset' ? 'Use this code to reset your password:' : 'Use this code to finish creating your account:'}</p><p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:16px 0">${code}</p><p style="color:#666">It expires in 10 minutes. If you did not ask for this, you can ignore this email.</p></div>`;
  const r = env.BREVO_KEY
    ? await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: { email: env.MAIL_FROM_EMAIL, name: 'TradeMind' }, to: [{ email: to }], subject, htmlContent: html }) })
    : await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }) });
  return r.ok;
}
// kind 'p' = new account waiting for its code, 'r' = password reset. Max 5 emails per hour, 60 s apart.
async function sendCode(env, kind, email, data) {
  const key = kind + ':' + email, old = await getJ(env, key);
  if (old && Date.now() - old.sent < 6e4) return 'wait';
  const sk = 's:' + email, n = +((await env.USERS.get(sk)) || 0);
  if (n >= 5) return 'limit';
  const code = code6();
  if (!await mail(env, email, code, kind === 'r' ? 'reset' : 'signup')) return 'mail';
  await env.USERS.put(sk, String(n + 1), { expirationTtl: 3600 });
  const base = data || (old ? { salt: old.salt, hash: old.hash } : {});
  await env.USERS.put(key, JSON.stringify({ ...base, ch: await chash(env, email, code), sent: Date.now(), tries: 0 }), { expirationTtl: 900 });
  return 'ok';
}
async function check(env, kind, email, code) {
  const k = kind + ':' + email, r = await getJ(env, k);
  if (!r) return null;
  if (r.tries >= 5) { await env.USERS.delete(k); return null; }
  if (r.ch !== await chash(env, email, String(code || '').trim())) { r.tries++; await env.USERS.put(k, JSON.stringify(r), { expirationTtl: 900 }); return null; }
  await env.USERS.delete(k);
  return r;
}
const sendErr = (s) => s === 'wait' ? J({ error: 'Please wait a minute before asking for another code.' }, 429) : s === 'limit' ? J({ error: 'Too many codes requested. Try again in an hour.' }, 429) : s === 'mail' ? J({ error: 'We could not send the email. Check the address and try again.' }, 424) : null;
async function social(env, email, name) { const k = 'u:' + email; if (!await env.USERS.get(k)) await env.USERS.put(k, JSON.stringify({ created: Date.now(), social: true })); return J(await issue(env, email, name)); }

async function auth(req, env, url) {
  const p = url.pathname;
  if (p === '/auth/me') { const u = await who(env, (req.headers.get('Authorization') || '').slice(7)); return u ? J({ ok: true, email: u.email }) : J({ ok: false }, 401); }
  const b = await req.json().catch(() => ({})), email = String(b.email || '').trim().toLowerCase();
  if (p === '/auth/signup') {
    if (!okEmail(email) || String(b.password || '').length < 8) return J({ error: 'Enter a valid email and a password of 8 or more characters.' }, 400);
    if (await env.USERS.get('u:' + email)) return J({ error: 'That email already has an account. Try signing in.' }, 409);
    const salt = crypto.getRandomValues(new Uint8Array(16)), s = await sendCode(env, 'p', email, { salt: b64(salt), hash: await pbk(b.password, salt) });
    return sendErr(s) || J({ pending: true });
  }
  if (p === '/auth/resend') {
    if (!await env.USERS.get('p:' + email)) return J({ error: 'Your sign-up expired. Please start again.' }, 400);
    return sendErr(await sendCode(env, 'p', email, null)) || J({ pending: true });
  }
  if (p === '/auth/verify') {
    const r = await check(env, 'p', email, b.code);
    if (!r) return J({ error: 'That code is wrong or has expired.' }, 400);
    await env.USERS.put('u:' + email, JSON.stringify({ salt: r.salt, hash: r.hash, created: Date.now(), verified: true }));
    return J(await issue(env, email));
  }
  if (p === '/auth/forgot') {
    if (!okEmail(email)) return J({ error: 'Enter a valid email.' }, 400);
    if (await env.USERS.get('u:' + email)) { const e = sendErr(await sendCode(env, 'r', email, {})); if (e) return e; }
    return J({ ok: true });
  }
  if (p === '/auth/reset') {
    if (String(b.password || '').length < 8) return J({ error: 'Use a password of 8 or more characters.' }, 400);
    const r = await check(env, 'r', email, b.code), u = await getJ(env, 'u:' + email);
    if (!r || !u) return J({ error: 'That code is wrong or has expired.' }, 400);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.USERS.put('u:' + email, JSON.stringify({ ...u, salt: b64(salt), hash: await pbk(b.password, salt) }));
    await env.USERS.delete('f:' + email);
    return J(await issue(env, email));
  }
  if (p === '/auth/login') {
    const fk = 'f:' + email, fails = +((await env.USERS.get(fk)) || 0);
    if (fails >= 5) return J({ error: 'Too many tries. Please wait 15 minutes.' }, 429);
    const u = await getJ(env, 'u:' + email);
    if (!u || !u.hash || u.hash !== await pbk(String(b.password || ''), unb64(u.salt))) { await env.USERS.put(fk, String(fails + 1), { expirationTtl: 900 }); return J({ error: 'Wrong email or password.' }, 401); }
    return J(await issue(env, email));
  }
  if (p === '/auth/google') {
    const t = await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(b.access_token || ''))).json();
    if (t.aud !== env.GOOGLE_CLIENT_ID || t.email_verified !== 'true') return J({ error: 'Google sign-in failed.' }, 401);
    return social(env, t.email.toLowerCase(), t.name);
  }
  if (p === '/auth/apple') {
    try {
      const [h, c, s] = String(b.id_token || '').split('.'), hd = JSON.parse(new TextDecoder().decode(unb64(h))), pl = JSON.parse(new TextDecoder().decode(unb64(c)));
      const jwk = (await (await fetch('https://appleid.apple.com/auth/keys')).json()).keys.find((k) => k.kid === hd.kid);
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(s), te(h + '.' + c)) || pl.iss !== 'https://appleid.apple.com' || pl.aud !== env.APPLE_CLIENT_ID || pl.exp * 1000 < Date.now() || !pl.email) throw 0;
      return social(env, pl.email.toLowerCase(), b.name);
    } catch (e) { return J({ error: 'Apple sign-in failed.' }, 401); }
  }
  return J({ error: 'Not found' }, 404);
}

// ---------- PAYSTACK ----------
const PLANS = { m: { p: 3500, mo: 1 }, q: { p: 9000, mo: 3 }, y: { p: 30000, mo: 12 } };  // Naira. Prices live HERE.
const ps = async (env, path, opt = {}) => (await fetch('https://api.paystack.co' + path, { ...opt, headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET, 'Content-Type': 'application/json' } })).json();
async function pay(req, env, url) {
  if (url.pathname === '/pay/init' && req.method === 'POST') {
    const { email, plan } = await req.json().catch(() => ({})), P = PLANS[plan];
    if (!P || !okEmail(email)) return J({ error: 'bad request' }, 400);
    const r = await ps(env, '/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: P.p * 100, currency: 'NGN', callback_url: env.APP_URL, metadata: { plan } }) });
    return r.status ? J({ url: r.data.authorization_url, reference: r.data.reference }) : J({ error: r.message || 'paystack error' }, 502);
  }
  if (url.pathname === '/pay/verify') {
    const r = await ps(env, '/transaction/verify/' + encodeURIComponent(url.searchParams.get('reference') || '')), d = r.data, P = d && d.metadata && PLANS[d.metadata.plan];
    if (!r.status || !d || d.status !== 'success' || !P || d.amount !== P.p * 100 || d.currency !== 'NGN') return J({ error: 'not paid' }, 402);
    const t = new Date(Date.parse(d.paid_at) || Date.now()); t.setUTCMonth(t.getUTCMonth() + P.mo);
    const body = btoa(JSON.stringify({ tier: 'pro', plan: d.metadata.plan, until: t.getTime(), ref: d.reference })).replace(/=+$/, '');
    return J({ tier: 'pro', plan: d.metadata.plan, until: t.getTime(), token: body + '.' + await hmac(env.PRO_SIGN_KEY, body) });
  }
  if (url.pathname === '/pay/check') {
    const [body, sig] = (url.searchParams.get('token') || '').split('.');
    if (!body || !sig || sig !== await hmac(env.PRO_SIGN_KEY, body)) return J({ ok: false });
    try { return J({ ok: JSON.parse(atob(body)).until > Date.now() }); } catch (e) { return J({ ok: false }); }
  }
  return J({ error: 'Not found' }, 404);
}

// ---------- SHARED PRICE BATCH (7 USD pairs, cached 15 min for everyone) ----------
async function batch(url, env) {
  const cache = caches.default, key = new Request(url.origin + '/batch?v=1');
  let r = await cache.match(key);
  if (r) return r;
  const q = `symbol=${encodeURIComponent('EUR/USD,GBP/USD,USD/JPY,USD/CHF,AUD/USD,USD/CAD,NZD/USD')}&interval=1h&outputsize=120&timezone=UTC&apikey=${env.TD_KEY}`;
  r = new Response(await (await fetch('https://api.twelvedata.com/time_series?' + q)).text(), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } });
  await cache.put(key, r.clone());
  return r;
}

// ---------- YOUR EXISTING PRICE CODE ----------
// Paste your old Worker here: rename its "export default { async fetch(...) {...} }" to "const oldWorker = { async fetch(...) {...} }".
const oldWorker = { async fetch() { return new Response('Not found', { status: 404, headers: CORS }); } };

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (p.startsWith('/auth/')) return await auth(req, env, u);
      if (p.startsWith('/pay/')) return await pay(req, env, u);
      if (p === '/batch') return await batch(u, env);
    } catch (e) { return J({ error: 'Something went wrong on our side. Please try again.' }, 500); }
    return oldWorker.fetch(req, env, ctx);
  },
};
