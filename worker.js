// TradeMind Worker: accounts (email code, Google, Apple), Paystack payments, shared price batch.
// Deploy: Cloudflare dashboard > Workers > your worker > Edit code > paste this whole file.
// Bindings:   KV namespace named USERS
// Secrets:    AUTH_KEY, PRO_SIGN_KEY, PAYSTACK_SECRET, TD_KEY, RESEND_KEY (or BREVO_KEY), TG_TOKEN, TG_SECRET, ADMIN_KEY (optional)
// Cron:       Triggers > Cron > 5 * * * *   (hourly signal check, sends Telegram alerts)
// Telegram:   TG_TOKEN (secret), TG_SECRET (secret, any random text), TG_BOT (bot username without @). Cron Trigger: */15 * * * *
// Variables:  APP_URL, MAIL_FROM  (Resend: "TradeMind <login@yourdomain.com>")  or MAIL_FROM_EMAIL (Brevo)
//             TG_BOT_USER (your Telegram bot username without @), GOOGLE_CLIENT_ID, APPLE_CLIENT_ID (only if you switch those buttons on)

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

// ---------- SIGNAL ENGINE (copied from the app so alerts match the app) ----------
const I={
 sma(a,n){return a.map((_,i)=>i<n-1?NaN:a.slice(i-n+1,i+1).reduce((x,y)=>x+y)/n)},
 ema(a,n,raw){const k=2/(n+1);let p;return a.map((x,i)=>{p=i?x*k+p*(1-k):x;return raw||i>=n-1?p:NaN})},
 rsi(c,n=14){const o=Array(c.length).fill(NaN);let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],u=Math.max(d,0),w=Math.max(-d,0);if(i<=n){g+=u/n;l+=w/n}else{g=(g*(n-1)+u)/n;l=(l*(n-1)+w)/n}if(i>=n)o[i]=l?100-100/(1+g/l):100}return o},
 macd(c){const a=I.ema(c,12,1),b=I.ema(c,26,1),m=a.map((x,i)=>x-b[i]),s=I.ema(m,9,1);return{m:m.map((x,i)=>i<33?NaN:x),s:s.map((x,i)=>i<33?NaN:x),h:m.map((x,i)=>i<33?NaN:x-s[i])}},
 bb(c,n=20){const m=I.sma(c,n);const sd=c.map((_,i)=>{if(i<n-1)return NaN;const q=c.slice(i-n+1,i+1);return Math.sqrt(q.reduce((s,x)=>s+(x-m[i])**2,0)/n)});return{m,u:m.map((x,i)=>x+2*sd[i]),l:m.map((x,i)=>x-2*sd[i])}},
 atr(cs,n=14){const o=Array(cs.length).fill(NaN);let a=0;for(let i=1;i<cs.length;i++){const t=Math.max(cs[i].h-cs[i].l,Math.abs(cs[i].h-cs[i-1].c),Math.abs(cs[i].l-cs[i-1].c));if(i<=n){a+=t/n}else a=(a*(n-1)+t)/n;if(i>=n)o[i]=a}return o},
 all(cs){const c=cs.map(x=>x.c);return{c,e20:I.ema(c,20),e50:I.ema(c,50),e200:I.ema(c,200),rsi:I.rsi(c),macd:I.macd(c),bb:I.bb(c),atr:I.atr(cs),va:I.sma(cs.map(x=>x.v),20)}},
 piv(cs,from,k=4){const H=[],L=[];for(let i=from+k;i<cs.length-k;i++){let hi=1,lo=1;for(let j=i-k;j<=i+k;j++){if(cs[j].h>cs[i].h)hi=0;if(cs[j].l<cs[i].l)lo=0}if(hi)H.push({i,p:cs[i].h});if(lo)L.push({i,p:cs[i].l})}return{H,L}},
 fib(cs){const q=cs.slice(-100),hi=Math.max(...q.map(x=>x.h)),lo=Math.min(...q.map(x=>x.l)),up=q.findIndex(x=>x.l===lo)<q.findIndex(x=>x.h===hi);return[.236,.382,.5,.618,.786].map(r=>({r,p:up?hi-r*(hi-lo):lo+r*(hi-lo)}))},
 pat(cs,i){const c=cs[i],p=cs[i-1],b=Math.abs(c.c-c.o),rg=c.h-c.l||1e-9,up=c.h-Math.max(c.o,c.c),dn=Math.min(c.o,c.c)-c.l,o=[];
  if(b/rg<.1)o.push(['Doji',0]);if(b>0&&dn>2*b&&up<b)o.push(['Hammer',1]);if(b>0&&up>2*b&&dn<b)o.push(['Shooting star',-1]);
  if(p.c<p.o&&c.c>c.o&&c.c>=p.o&&c.o<=p.c)o.push(['Bullish engulfing',1]);if(p.c>p.o&&c.c<c.o&&c.c<=p.o&&c.o>=p.c)o.push(['Bearish engulfing',-1]);return o}
};
/* ============ Strategy engine ============ */
const hiN=(cs,i,n)=>Math.max(...cs.slice(i-n,i).map(c=>c.h)),loN=(cs,i,n)=>Math.min(...cs.slice(i-n,i).map(c=>c.l));
const S=[
 {k:'Trend',f:(x,cs,i)=>{const a=x.e20[i],b=x.e50[i],c=x.e200[i];return a>b&&b>c?[1,'EMA20 > EMA50 > EMA200 (bullish stack)']:a<b&&b<c?[-1,'EMA20 < EMA50 < EMA200 (bearish stack)']:[0,'EMAs not aligned']}},
 {k:'Momentum',f:(x,cs,i)=>{const r=x.c[i]/x.c[i-10]-1,t=x.atr[i]/x.c[i];return r>t?[1,`10-bar ROC ${(r*100).toFixed(2)}% > 1 ATR`]:r<-t?[-1,`10-bar ROC ${(r*100).toFixed(2)}% < -1 ATR`]:[0,'Momentum inside ±1 ATR']}},
 {k:'RSI',f:(x,cs,i)=>{const r=x.rsi[i];return r<35?[1,`RSI ${r.toFixed(1)} oversold`]:r>65?[-1,`RSI ${r.toFixed(1)} overbought`]:[0,`RSI ${r.toFixed(1)} neutral`]}},
 {k:'MACD',f:(x,cs,i)=>{const h=x.macd.h[i],p=x.macd.h[i-1];return h>0&&h>p?[1,'Histogram positive & rising']:h<0&&h<p?[-1,'Histogram negative & falling']:[0,'Histogram fading / flat']}},
 {k:'Support/Resistance',f:(x,cs,i)=>{const lo=loN(cs,i,40),hi=hiN(cs,i,40),c=x.c[i],a=x.atr[i];return c-lo<.6*a?[1,'Price at 40-bar support']:hi-c<.6*a?[-1,'Price at 40-bar resistance']:[0,'Between support and resistance']}},
 {k:'Volume',f:(x,cs,i)=>{const c=cs[i],r=c.v/x.va[i];return r>1.3&&c.c>c.o?[1,`Volume ${r.toFixed(1)}× avg on up candle`]:r>1.3&&c.c<c.o?[-1,`Volume ${r.toFixed(1)}× avg on down candle`]:[0,`Volume ${r.toFixed(1)}× avg (no surge)`]}},
 {k:'Breakout',f:(x,cs,i)=>x.c[i]>hiN(cs,i,20)?[1,'Close above 20-bar high']:x.c[i]<loN(cs,i,20)?[-1,'Close below 20-bar low']:[0,'Inside 20-bar range']},
 {k:'Candle Pattern',f:(x,cs,i)=>{const p=I.pat(cs,i),s=p.reduce((a,b)=>a+b[1],0);return[Math.sign(s),p.length?p.map(z=>z[0]).join(', '):'No pattern']}}
];
const W={strong:{Trend:1.5,Momentum:1.3,RSI:.5,MACD:1.2,'Support/Resistance':.6,Volume:1,Breakout:1.2,'Candle Pattern':.7},weak:{Trend:1.2,Momentum:1,RSI:.8,MACD:1,'Support/Resistance':.8,Volume:1,Breakout:1,'Candle Pattern':.7},side:{Trend:.5,Momentum:.5,RSI:1.5,MACD:.6,'Support/Resistance':1.5,Volume:.8,Breakout:.6,'Candle Pattern':1},highVol:{Trend:1,Momentum:1,RSI:.7,MACD:.9,'Support/Resistance':.8,Volume:1,Breakout:1.2,'Candle Pattern':.6},lowVol:{Trend:.9,Momentum:.7,RSI:1.2,MACD:.8,'Support/Resistance':1.2,Volume:.8,Breakout:.8,'Candle Pattern':1}};
const NOTE={strong:'Trend-following rules weighted up.',weak:'Balanced weights, mild trend bias.',side:'Mean-reversion (RSI, S/R) weighted up; trend rules weighted down.',highVol:'Breakout weighted up; wider stops advisable.',lowVol:'Range rules weighted up; breakouts less reliable.'};
function regime(x,i){let s=0;for(let j=i-100;j<i;j++)s+=x.atr[j]/x.c[j];const ratio=(x.atr[i]/x.c[i])/(s/100),sl=(x.e50[i]-x.e50[i-10])/x.atr[i],up=x.e20[i]>x.e50[i]&&x.e50[i]>x.e200[i],dn=x.e20[i]<x.e50[i]&&x.e50[i]<x.e200[i];let key,label;
 if(ratio>1.5){key='highVol';label='High volatility'}else if(ratio<.65){key='lowVol';label='Low volatility'}else if(up&&sl>1){key='strong';label='Strong uptrend'}else if(dn&&sl<-1){key='strong';label='Strong downtrend'}else if(up||sl>.4){key='weak';label='Weak uptrend'}else if(dn||sl<-.4){key='weak';label='Weak downtrend'}else{key='side';label='Sideways'}
 return{key,label,ratio,slope:sl,note:NOTE[key]}}
function analyze(x,cs,i){const rg=regime(x,i),w=W[rg.key],v=S.map(s=>{const[sg,why]=s.f(x,cs,i);return{k:s.k,sg,why,w:w[s.k]}}),tw=v.reduce((a,b)=>a+b.w,0);v.forEach(o=>o.pts=o.w*o.sg/tw*100);
 const net=v.reduce((a,b)=>a+b.pts,0),sig=net>=30?1:net<=-30?-1:0;return{v,net,score:Math.round(Math.abs(net)),sig,rg,agree:v.filter(o=>o.sg===sig).length}}

// ---------- SERVER SIGNALS: hourly check, Telegram alerts, MT5 feed ----------
const CRYPTO = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map((b) => b + '/USDT');
const FX = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD'];
const UNI = [...CRYPTO, ...FX];
const dflt = () => ({ chat: null, on: true, syms: UNI.slice(), min: 60 });
const mt5 = (s) => s.replace('/', '').replace('USDT', 'USD');   // BTC/USDT -> BTCUSD, EUR/USD -> EURUSD
const pf = (v) => v.toFixed(v >= 100 ? 2 : v >= 10 ? 3 : v >= 1 ? 5 : 7);
async function kl(sym) {
  const r = await fetch('https://data-api.binance.vision/api/v3/klines?symbol=' + sym.replace('/', '') + '&interval=1h&limit=300');
  if (!r.ok) throw 0;
  return (await r.json()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
// 7 USD pairs, kept in KV. Used by the app's /batch and by the hourly job. maxAge in seconds.
async function fxData(env, maxAge) {
  const c = await getJ(env, 'fx:batch');
  if (c && Date.now() - c.t < maxAge * 1000) return c.d;
  const j = await (await fetch('https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(FX.join(',')) + '&interval=1h&outputsize=300&timezone=UTC&apikey=' + env.TD_KEY)).json(), d = {};
  FX.forEach((s) => { const v = j[s] && j[s].values; if (v && v.length > 210) d[s] = v.slice().reverse().map((z) => ({ t: Date.parse(z.datetime.replace(' ', 'T') + 'Z'), o: +z.open, h: +z.high, l: +z.low, c: +z.close, v: +z.volume || 0 })); });
  if (Object.keys(d).length) { await env.USERS.put('fx:batch', JSON.stringify({ t: Date.now(), d })); return d; }
  return c ? c.d : {};
}
async function batch(url, env) {
  const d = await fxData(env, 1800), o = {};
  Object.keys(d).forEach((s) => { o[s] = { values: d[s].slice().reverse().map((z) => ({ datetime: new Date(z.t).toISOString().slice(0, 19).replace('T', ' '), close: String(z.c) })) }; });
  return new Response(JSON.stringify(o), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
}
const tg = (env, chat, text) => fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }).catch(() => 0);
const msg = (s) => `${s.d > 0 ? '🟢 BUY' : '🔴 SELL'} ${s.s} (1h)\nScore ${s.score}/100\nEntry ~${pf(s.en)}\nStop ${pf(s.sl)}\nTargets ${pf(s.tp1)} / ${pf(s.tp)} / ${pf(s.tp3)}\nWhy: ${s.why}\n\nNot financial advice. Check the live price before you trade. You are responsible for your own trades.`;
async function runSignals(env) {
  const list = ((await getJ(env, 'sig:list')) || []).filter((x) => Date.now() - x.ts < 864e5), have = new Set(list.map((x) => x.id)), fresh = [], fx = await fxData(env, 3000).catch(() => ({}));
  for (const sym of UNI) {
    try {
      const cs = CRYPTO.includes(sym) ? await kl(sym) : (fx[sym] || []).slice();
      while (cs.length && cs[cs.length - 1].t + 36e5 > Date.now()) cs.pop();   // drop the candle still forming
      if (cs.length < 250) continue;
      const x = I.all(cs), i = cs.length - 1, r = analyze(x, cs, i), id = sym + '-1h-' + cs[i].t;
      if (!r.sig || r.sig === analyze(x, cs, i - 1).sig || have.has(id)) continue;   // only NEW signals, not the same one every hour
      const en = cs[i].c, rd = 1.5 * x.atr[i], d = r.sig;
      const why = [...r.v].filter((o) => o.sg === d).sort((p, q) => Math.abs(q.pts) - Math.abs(p.pts)).slice(0, 3).map((o) => o.k).join(', ');
      const s = { id, s: sym, d, en, sl: en - d * rd, tp1: en + d * 1.5 * rd, tp: en + d * 2.5 * rd, tp3: en + d * 4 * rd, score: r.score, why, t: cs[i].t, ts: Date.now() };
      list.push(s); fresh.push(s);
    } catch (e) {}
  }
  await env.USERS.put('sig:list', JSON.stringify(list));
  if (fresh.length) for (const em of ((await getJ(env, 'subs')) || [])) { const u = await getJ(env, 'sub:' + em); if (u && u.chat && u.on) for (const s of fresh) if (u.syms.includes(s.s) && s.score >= u.min) await tg(env, u.chat, msg(s)); }
  return fresh.length;
}
async function tgHook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) return J({ ok: false }, 403);
  const m = ((await req.json().catch(() => ({}))).message) || {}, t = String(m.text || '').trim(), chat = m.chat && m.chat.id;
  if (!chat) return J({ ok: true });
  if (t.startsWith('/start')) {
    const code = t.split(/\s+/)[1] || '', em = code && await env.USERS.get('tl:' + code);
    if (!em) { await tg(env, chat, 'To connect, open TradeMind > Alerts > Connect Telegram and tap the link it gives you.'); return J({ ok: true }); }
    await env.USERS.delete('tl:' + code);
    const u = (await getJ(env, 'sub:' + em)) || dflt(); u.chat = chat; u.on = true;
    await env.USERS.put('sub:' + em, JSON.stringify(u)); await env.USERS.put('chat:' + chat, em);
    const idx = (await getJ(env, 'subs')) || []; if (!idx.includes(em)) { idx.push(em); await env.USERS.put('subs', JSON.stringify(idx)); }
    await tg(env, chat, 'Connected. TradeMind signals will arrive here. Send /stop to pause and /resume to restart. Signals are not financial advice.');
  } else if (t === '/stop' || t === '/resume') {
    const em = await env.USERS.get('chat:' + chat), u = em && await getJ(env, 'sub:' + em);
    if (u) { u.on = t === '/resume'; await env.USERS.put('sub:' + em, JSON.stringify(u)); await tg(env, chat, u.on ? 'Alerts are on.' : 'Alerts are paused.'); }
  }
  return J({ ok: true });
}
const me = async (req, env) => { const u = await who(env, (req.headers.get('Authorization') || '').slice(7)); return u && u.email; };
async function sig(req, env, url) {
  const em = await me(req, env); if (!em) return J({ error: 'Please sign in.' }, 401);
  const k = 'sub:' + em;
  if (url.pathname === '/sig/prefs') {
    const u = (await getJ(env, k)) || dflt();
    if (req.method === 'POST') { const b = await req.json().catch(() => ({})); u.syms = (b.syms || []).filter((s) => UNI.includes(s)).slice(0, 14); u.min = Math.min(95, Math.max(30, Math.round(+b.min || 60))); u.on = !!b.on; await env.USERS.put(k, JSON.stringify(u)); }
    return J({ linked: !!u.chat, on: u.on, syms: u.syms, min: u.min, uni: UNI });
  }
  if (url.pathname === '/tg/link') { const code = b64(crypto.getRandomValues(new Uint8Array(9))); await env.USERS.put('tl:' + code, em, { expirationTtl: 900 }); return J({ link: 'https://t.me/' + env.TG_BOT_USER + '?start=' + code }); }
  if (url.pathname === '/tg/status') { const u = await getJ(env, k); return J({ linked: !!(u && u.chat) }); }
  if (url.pathname === '/tg/unlink') {
    const u = await getJ(env, k);
    if (u && u.chat) { await env.USERS.delete('chat:' + u.chat); u.chat = null; await env.USERS.put(k, JSON.stringify(u)); }
    await env.USERS.put('subs', JSON.stringify(((await getJ(env, 'subs')) || []).filter((e) => e !== em)));
    return J({ ok: true });
  }
  return J({ error: 'Not found' }, 404);
}
async function ea(req, env, url) {
  if (url.pathname === '/ea/signals') {
    const em = await env.USERS.get('ea:' + (url.searchParams.get('key') || '')); if (!em) return new Response('ERR|bad key', { status: 401, headers: CORS });
    const u = (await getJ(env, 'sub:' + em)) || dflt(), now = Date.now();
    const lines = ((await getJ(env, 'sig:list')) || []).filter((s) => now - s.ts < 108e5 && u.syms.includes(s.s) && s.score >= u.min).sort((p, q) => p.ts - q.ts).map((s) => [s.id, mt5(s.s), s.d > 0 ? 'BUY' : 'SELL', pf(s.en), pf(s.sl), pf(s.tp), s.score, s.ts].join('|'));
    return new Response('OK\n' + lines.join('\n'), { headers: { ...CORS, 'Content-Type': 'text/plain' } });
  }
  const em = await me(req, env); if (!em) return J({ error: 'Please sign in.' }, 401);
  let key = await env.USERS.get('eak:' + em);
  if (!key || url.searchParams.get('new') === '1') { if (key) await env.USERS.delete('ea:' + key); key = 'ea_' + b64(crypto.getRandomValues(new Uint8Array(18))); await env.USERS.put('ea:' + key, em); await env.USERS.put('eak:' + em, key); }
  return J({ key });
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
      if (p === '/tg/webhook') return await tgHook(req, env);
      if (p.startsWith('/sig/') || (p.startsWith('/tg/') && p !== '/tg/webhook')) return await sig(req, env, u);
      if (p.startsWith('/ea/')) return await ea(req, env, u);
      if (p === '/run' && env.ADMIN_KEY && u.searchParams.get('key') === env.ADMIN_KEY) return J({ new: await runSignals(env) });
    } catch (e) { return J({ error: 'Something went wrong on our side. Please try again.' }, 500); }
    return oldWorker.fetch(req, env, ctx);
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(runSignals(env, new Date(ev.scheduledTime))); },
};
