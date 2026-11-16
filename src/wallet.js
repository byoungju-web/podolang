/**
 * 🍇 포도랑 지갑 · 구글 로그인 · 구글 플레이 결제 · 1:1/다중 동시통역 방  (v9.1 · 2026-11-16)
 * © 2026 BJ LEE. All Rights Reserved.
 *
 * coverfo · 포도톡과 따로 도는 포도랑 자체 회원·크레딧입니다.
 *   · 저장: Cloudflare D1 (바인딩 이름 DB) — schema.sql 을 D1 콘솔에서 한 번 실행합니다.
 *   · 로그인: 구글 (Google Identity Services). 워커 Secret GOOGLE_CLIENT_ID 필요.
 *   · 결제: 구글 플레이 인앱 결제 (포도랑 앱 = TWA 안에서만). 웹(크롬)에서는 충전하지 않고 앱 안내만 합니다.
 *     앱 화면이 Digital Goods API 로 결제 → 구매 토큰을 /api/pl/play 로 보냄 → 이 워커가 Google Play Developer API 로
 *     진짜 결제인지 확인 → 크레딧 넣기 → 소비(consume) 처리. 같은 토큰은 한 번만 (pl_orders 의 order_id = 'GP' + 토큰 해시).
 *     Secret PLAY_SA_JSON = 구글 서비스 계정 JSON 키 통째 · 변수 PLAY_PACKAGE (없으면 kr.podolang.app)
 *   · 로그인 키: 'pl.' 로 시작하는 글자 (이 기기에만 저장). 기존 기능의 uid 자리에 그대로 들어갑니다.
 *     uid 가 'pl.' 로 시작하면 포도톡이 아니라 이 지갑에서 확인·차감합니다.
 *   · 크레딧은 0.1 단위까지 쓰므로 D1 에는 10배(tenths, 정수)로 저장합니다. 1 크레딧 = 99원.
 *
 * 경로 (모두 POST · JSON · 로그인 키는 본문의 tk)
 *   /api/pl/config                       → { google, play, pkg, products, welcome }
 *   /api/pl/login     { credential }      → 구글 로그인 → { tk, me }
 *   /api/pl/me        { tk }              → { me, orders }
 *   /api/pl/logout    { tk }
 *   /api/pl/delete    { tk }              → 계정 삭제 (남은 크레딧도 사라짐)
 *   /api/pl/play      { tk, sku, token }  → 구글 플레이 구매 확인 → 크레딧 넣기 → 소비 { me, already }
 *   /api/pl/room      { tk, op, ... }     → 동시통역 방 (rooms · create · join · lang · msgs · send · leave · delete · block · unblock_all · report)
 *   /api/link/wallet  (헤더 X-Link-Key)    → 서버끼리 (전화통역 podolang-realtime) { op:'balance'|'spend', t, amount, kind }
 */

const WELCOME_DEFAULT = 3;          // 처음 가입 선물 (크레딧) — 워커 변수 PL_WELCOME 으로 바꿈
const PLAY_PKG_DEFAULT = 'kr.podolang.app';
const PRODUCTS = [                  // 충전 상품 (1 크레딧 = 99원) — Play Console 인앱 상품 ID 와 같아야 합니다 (c100 · c300 · c1000)
  { id: 'c100', credits: 100, amount: 9900, name: '포도랑 100 크레딧' },
  { id: 'c300', credits: 300, amount: 29700, name: '포도랑 300 크레딧' },
  { id: 'c1000', credits: 1000, amount: 99000, name: '포도랑 1000 크레딧' },
];
const ROOM_STEP = 1;                // 방 번역 1개 = 0.1 크레딧
const MAX_TEXT = 500;
const KEEP_DAYS = 30;
const LIMIT = { one: 2, multi: 10 };
const LANGS = {
  KO: 'Korean', TH: 'Thai', EN: 'English', JA: 'Japanese', ZH: 'Chinese (Simplified)', VI: 'Vietnamese', ES: 'Spanish',
  ID: 'Indonesian', DE: 'German', FR: 'French', AR: 'Arabic', IT: 'Italian', RU: 'Russian', PT: 'Portuguese (Brazil)',
  HI: 'Hindi', NL: 'Dutch',
};
const langOk = (l) => Object.prototype.hasOwnProperty.call(LANGS, String(l || ''));

export const isPl = (v) => /^pl\.[A-Za-z0-9_-]{30,80}$/.test(String(v || ''));

/* ───────────── 공통 ───────────── */
function httpErr(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }
const now = () => Date.now();
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
function b64u(bytes) { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function rand(n) { const r = new Uint8Array(n); crypto.getRandomValues(r); return r; }
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function safeEq(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(rand(6), (x) => A[x % A.length]).join(''); }
const cr = (tenths) => Math.round(Number(tenths) || 0) / 10;   // 화면에 보여줄 크레딧

function db(env) { if (!env.DB) throw httpErr(503, '포도랑 지갑 설정이 아직 끝나지 않았습니다 (D1).'); return env.DB; }
async function one(env, sql, ...args) { return await db(env).prepare(sql).bind(...args).first(); }
async function all(env, sql, ...args) { const r = await db(env).prepare(sql).bind(...args).all(); return r.results || []; }
async function run(env, sql, ...args) { return await db(env).prepare(sql).bind(...args).run(); }

/* 로그인 키 → 회원 */
async function userOf(env, tk, need = true) {
  if (!isPl(tk)) { if (need) throw httpErr(401, '로그인이 필요합니다', { login: true }); return null; }
  const s = await one(env, 'SELECT user_id FROM pl_sessions WHERE token_hash = ?', await sha(tk));
  const u = s ? await one(env, 'SELECT * FROM pl_users WHERE id = ?', s.user_id) : null;
  if (!u) { if (need) throw httpErr(401, '다시 로그인해 주세요', { login: true }); return null; }
  return u;
}
const meView = (u) => ({ id: u.id, email: u.email, name: u.name, credits: cr(u.tenths), tenths: u.tenths });

/* ───────────── 지갑 ───────────── */
/** 남은 양 (크레딧) */
export async function plBalance(env, tk) {
  const u = await userOf(env, tk, false);
  if (!u) return { ok: false, reason: '포도랑에 다시 로그인해 주세요.' };
  return { ok: true, balance: cr(u.tenths), uid: u.id };
}
/** 깎기. partial=true 면 모자랄 때 남은 만큼만 깎는다 (전화통역 통화 끝 정산). 돌려줌 { ok, took(크레딧) } */
export async function plSpend(env, tk, amount, kind, partial) {
  const u = await userOf(env, tk, false);
  if (!u) return { ok: false, took: 0 };
  return await spendUser(env, u.id, Math.round(Number(amount) * 10), kind, partial);
}
async function spendUser(env, uid, tenths, kind, partial) {
  if (!(tenths > 0)) return { ok: true, took: 0 };
  let r = await run(env, 'UPDATE pl_users SET tenths = tenths - ?, last_at = ? WHERE id = ? AND tenths >= ?', tenths, now(), uid, tenths);
  let took = tenths;
  if (!(r.meta && r.meta.changes)) {
    if (!partial) return { ok: false, took: 0 };
    const u = await one(env, 'SELECT tenths FROM pl_users WHERE id = ?', uid);
    took = Math.max(0, Math.min(tenths, (u && u.tenths) || 0));
    if (!took) return { ok: false, took: 0 };
    r = await run(env, 'UPDATE pl_users SET tenths = tenths - ?, last_at = ? WHERE id = ? AND tenths >= ?', took, now(), uid, took);
    if (!(r.meta && r.meta.changes)) return { ok: false, took: 0 };
  }
  await run(env, 'INSERT INTO pl_ledger (user_id, delta, kind, memo, created_at) VALUES (?, ?, ?, ?, ?)', uid, -took, String(kind || 'use').slice(0, 20), '', now()).catch(() => {});
  return { ok: took === tenths, took: took / 10 };
}
async function addUser(env, uid, tenths, kind, memo) {
  await db(env).batch([
    db(env).prepare('UPDATE pl_users SET tenths = tenths + ?, last_at = ? WHERE id = ?').bind(tenths, now(), uid),
    db(env).prepare('INSERT INTO pl_ledger (user_id, delta, kind, memo, created_at) VALUES (?, ?, ?, ?, ?)').bind(uid, tenths, kind, String(memo || '').slice(0, 100), now()),
  ]);
}

/* ───────────── 구글 로그인 ───────────── */
async function login(env, b) {
  if (!env.GOOGLE_CLIENT_ID) throw httpErr(503, '구글 로그인 설정이 아직 끝나지 않았습니다 (GOOGLE_CLIENT_ID).');
  const cred = String(b.credential || '');
  if (cred.length < 100 || cred.length > 5000) throw httpErr(400, '구글 로그인 정보가 없습니다');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
  const g = await r.json().catch(() => ({}));
  if (!r.ok || !g.sub) throw httpErr(401, '구글 로그인을 확인하지 못했습니다');
  if (g.aud !== env.GOOGLE_CLIENT_ID) throw httpErr(401, '이 사이트용 구글 로그인이 아닙니다');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(g.iss)) throw httpErr(401, '구글 로그인이 아닙니다');
  if (Number(g.exp || 0) * 1000 < now()) throw httpErr(401, '로그인 시간이 지났습니다. 다시 눌러 주세요');
  let u = await one(env, 'SELECT * FROM pl_users WHERE google_sub = ?', g.sub);
  if (!u) {
    const id = 'u_' + b64u(rand(12));
    const welcome = Math.max(0, Math.round((env.PL_WELCOME != null ? Number(env.PL_WELCOME) : WELCOME_DEFAULT) * 10)) || 0;
    await run(env, 'INSERT INTO pl_users (id, google_sub, email, name, tenths, created_at, last_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      id, g.sub, clean(g.email, 200), clean(g.name || '', 60), now(), now());
    if (welcome) await addUser(env, id, welcome, 'welcome', '가입 선물');
    u = await one(env, 'SELECT * FROM pl_users WHERE id = ?', id);
  } else {
    await run(env, 'UPDATE pl_users SET email = ?, name = ?, last_at = ? WHERE id = ?', clean(g.email, 200), clean(g.name || u.name || '', 60), now(), u.id);
  }
  const tk = 'pl.' + b64u(rand(32));
  await run(env, 'INSERT INTO pl_sessions (token_hash, user_id, created_at, last_at) VALUES (?, ?, ?, ?)', await sha(tk), u.id, now(), now());
  return { ok: true, tk, me: meView(u) };
}

/* ───────────── 구글 플레이 결제 ───────────── */
function pemBody(pem) { return String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); }
function b64ToBytes(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
const b64uStr = (str) => b64u(new TextEncoder().encode(str));
let playTok = null;   // { token, exp } — 워커가 살아 있는 동안 재사용
/** 서비스 계정으로 Google Play Developer API 접근 키 받기 (JWT RS256) */
async function playAccess(env) {
  if (playTok && playTok.exp > now() + 60000) return playTok.token;
  let sa = null;
  try { sa = JSON.parse(env.PLAY_SA_JSON || ''); } catch (e) {}
  if (!sa || !sa.client_email || !sa.private_key) throw httpErr(503, '구글 결제 확인 설정이 아직 끝나지 않았습니다 (PLAY_SA_JSON).');
  const iat = Math.floor(now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64uStr(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', b64ToBytes(pemBody(sa.private_key)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + b64u(sig),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw httpErr(502, '구글 결제 확인 키를 받지 못했습니다' + (d.error ? ' (' + clean(d.error, 60) + ')' : ''));
  playTok = { token: d.access_token, exp: now() + (Number(d.expires_in) || 3600) * 1000 };
  return playTok.token;
}
async function play(env, b) {
  const u = await userOf(env, b.tk);
  const p = PRODUCTS.find((x) => x.id === b.sku);
  if (!p) throw httpErr(400, '충전 상품을 찾지 못했습니다');
  const token = String(b.token || '');
  if (token.length < 20 || token.length > 1000 || /[^A-Za-z0-9._\-]/.test(token)) throw httpErr(400, '구매 정보가 없습니다');
  const orderId = 'GP' + (await sha(token)).slice(0, 40);
  const pkg = env.PLAY_PACKAGE || PLAY_PKG_DEFAULT;
  const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(pkg) + '/purchases/products/' + encodeURIComponent(p.id) + '/tokens/' + encodeURIComponent(token);
  const done = await one(env, 'SELECT user_id, status FROM pl_orders WHERE order_id = ?', orderId);
  if (done && done.status === 'paid') {
    if (done.user_id !== u.id) throw httpErr(409, '이미 다른 계정에 들어간 구매입니다');
    /* 크레딧은 이미 넣었음 — 소비가 안 됐을 수 있으니 한 번 더 소비만 */
    try { const at0 = await playAccess(env); await fetch(base + ':consume', { method: 'POST', headers: { Authorization: 'Bearer ' + at0 } }); } catch (e) {}
    return { ok: true, already: true, me: meView(await one(env, 'SELECT * FROM pl_users WHERE id = ?', u.id)) };
  }
  const at = await playAccess(env);
  const r = await fetch(base, { headers: { Authorization: 'Bearer ' + at } });
  const g = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status === 404 || r.status === 400 ? 400 : 502, '구글에서 구매를 확인하지 못했습니다' + (g.error && g.error.message ? ' (' + clean(g.error.message, 120) + ')' : ''));
  if (g.productId && g.productId !== p.id) throw httpErr(400, '구매한 상품이 맞지 않습니다');
  if (g.purchaseState === 2) throw httpErr(402, '결제가 아직 끝나지 않았습니다 (대기 중). 결제가 끝나면 마이를 다시 열어 주세요');
  if (g.purchaseState !== 0) throw httpErr(402, '취소된 결제입니다');
  /* 주문 기록(같은 토큰은 order_id 가 같아 두 번 들어가지 않음) + 크레딧 + 기록 을 한 번에 */
  try {
    await db(env).batch([
      db(env).prepare('INSERT INTO pl_orders (order_id, user_id, product, amount, tenths, status, payment_key, method, created_at, paid_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(orderId, u.id, p.id, p.amount, p.credits * 10, 'paid', clean(g.orderId, 64), 'Google Play', now(), now(), JSON.stringify({ orderId: g.orderId, regionCode: g.regionCode, purchaseTimeMillis: g.purchaseTimeMillis }).slice(0, 500)),
      db(env).prepare('UPDATE pl_users SET tenths = tenths + ?, last_at = ? WHERE id = ?').bind(p.credits * 10, now(), u.id),
      db(env).prepare('INSERT INTO pl_ledger (user_id, delta, kind, memo, created_at) VALUES (?, ?, ?, ?, ?)').bind(u.id, p.credits * 10, 'charge', 'play ' + clean(g.orderId, 60), now()),
    ]);
  } catch (e) {
    const again = await one(env, 'SELECT user_id FROM pl_orders WHERE order_id = ?', orderId);
    if (!again) throw httpErr(500, '크레딧을 넣지 못했습니다. 잠시 뒤 마이를 다시 열어 주세요');
    if (again.user_id !== u.id) throw httpErr(409, '이미 다른 계정에 들어간 구매입니다');
  }
  /* 소비 처리 — 같은 상품을 다시 살 수 있게. 실패해도 크레딧은 이미 들어갔고, 다음에 다시 보내면 already 로 끝난 뒤 다시 소비한다 */
  if (g.consumptionState !== 1) await fetch(base + ':consume', { method: 'POST', headers: { Authorization: 'Bearer ' + at } }).catch(() => {});
  return { ok: true, me: meView(await one(env, 'SELECT * FROM pl_users WHERE id = ?', u.id)) };
}

/* ───────────── 동시통역 방 ───────────── */
async function member(env, uid, room) {
  const m = await one(env, 'SELECT * FROM pl_members WHERE room_id = ? AND user_id = ?', String(room || ''), uid);
  if (!m) throw httpErr(403, '이 방에 들어가 있지 않아요');
  return m;
}
const nickOf = (u, n) => clean(n, 20) || clean(u.name, 20) || String(u.email || '').split('@')[0].slice(0, 20) || 'me';

async function roomOp(env, ctx, b) {
  const u = await userOf(env, b.tk);
  const op = String(b.op || '');
  if (Math.random() < 0.02) cleanup(env).catch(() => {});
  if (op === 'rooms') {
    const kind = b.kind === 'multi' ? 'multi' : 'one';
    const rs = await all(env, `SELECT r.* FROM pl_rooms r JOIN pl_members m ON m.room_id = r.id WHERE m.user_id = ? AND r.kind = ? ORDER BY r.last_at DESC LIMIT 50`, u.id, kind);
    const out = [];
    for (const r of rs) {
      const ms = await all(env, 'SELECT nick, lang FROM pl_members WHERE room_id = ?', r.id);
      out.push({ id: r.id, code: r.code, kind: r.kind, name: r.name, mine: r.owner === u.id, members: ms.length, langs: [...new Set(ms.map((m) => m.lang))], last_body: r.last_body || '', last_nick: r.last_nick || '' });
    }
    return { ok: true, rooms: out };
  }
  if (op === 'create') {
    const kind = b.kind === 'multi' ? 'multi' : 'one';
    const lang = langOk(b.lang) ? b.lang : 'KO';
    const name = clean(b.name, 30) || (kind === 'multi' ? 'Group room' : '1:1 room');
    let room = null;
    for (let i = 0; i < 4 && !room; i++) {
      const id = 'r_' + b64u(rand(12)), code = newCode();
      try { await run(env, 'INSERT INTO pl_rooms (id, code, kind, name, owner, last_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, code, kind, name, u.id, now(), now()); room = { id, code, kind, name }; } catch (e) {}
    }
    if (!room) throw httpErr(500, '방을 만들지 못했어요');
    await run(env, 'INSERT INTO pl_members (room_id, user_id, nick, lang, joined_at) VALUES (?, ?, ?, ?, ?)', room.id, u.id, nickOf(u, b.nick), lang, now());
    return { ok: true, room };
  }
  if (op === 'join') {
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length !== 6) throw httpErr(400, '초대 코드 6자리를 넣어 주세요');
    const room = await one(env, 'SELECT * FROM pl_rooms WHERE code = ?', code);
    if (!room) throw httpErr(404, '그 코드의 통역방이 없어요');
    const lang = langOk(b.lang) ? b.lang : 'KO';
    const ms = await all(env, 'SELECT user_id FROM pl_members WHERE room_id = ?', room.id);
    if (!ms.some((m) => m.user_id === u.id)) {
      const cap = LIMIT[room.kind] || 2;
      if (ms.length >= cap) throw httpErr(409, room.kind === 'one' ? '1:1 통역방은 2명까지예요' : '이 방은 꽉 찼어요 (' + cap + '명)');
      await run(env, 'INSERT INTO pl_members (room_id, user_id, nick, lang, joined_at) VALUES (?, ?, ?, ?, ?)', room.id, u.id, nickOf(u, b.nick), lang, now());
    }
    return { ok: true, room: { id: room.id, code: room.code, kind: room.kind, name: room.name } };
  }
  if (op === 'lang') {
    await member(env, u.id, b.room);
    if (!langOk(b.lang)) throw httpErr(400, '언어를 골라 주세요');
    await run(env, 'UPDATE pl_members SET lang = ? WHERE room_id = ? AND user_id = ?', b.lang, b.room, u.id);
    return { ok: true };
  }
  if (op === 'msgs') {
    const me = await member(env, u.id, b.room);
    const after = Math.max(0, parseInt(b.after, 10) || 0);
    const room = await one(env, 'SELECT id, code, kind, name, owner FROM pl_rooms WHERE id = ?', b.room);
    const ms = await all(env, 'SELECT user_id, nick, lang FROM pl_members WHERE room_id = ?', b.room);
    const rows = await all(env, 'SELECT id, user_id, nick, lang, body, tr, created_at FROM pl_msgs WHERE room_id = ? AND id > ? AND created_at > ? ORDER BY id ASC LIMIT 100', b.room, after, now() - KEEP_DAYS * 864e5);
    const bl = new Set((await all(env, 'SELECT blocked FROM pl_blocks WHERE user_id = ?', u.id)).map((x) => x.blocked));
    return {
      ok: true,
      room: room ? { id: room.id, code: room.code, kind: room.kind, name: room.name, mine: room.owner === u.id } : null,
      me: { lang: me.lang, nick: me.nick },
      members: ms.map((m) => ({ nick: m.nick, lang: m.lang, me: m.user_id === u.id })),
      blocked: bl.size,
      credits: cr(u.tenths),
      msgs: rows.map((m) => {
        if (bl.has(m.user_id) && m.user_id !== u.id) return { id: m.id, hidden: true };
        let tr = {}; try { tr = JSON.parse(m.tr || '{}'); } catch (e) {}
        return { id: m.id, mine: m.user_id === u.id, nick: m.nick, lang: m.lang, at: m.created_at, orig: m.body,
          text: m.lang === me.lang ? m.body : (tr[me.lang] || m.body), translated: m.lang !== me.lang && !!tr[me.lang] };
      }),
    };
  }
  if (op === 'send') {
    const me = await member(env, u.id, b.room);
    const text = String(b.text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) throw httpErr(400, '보낼 말을 적어 주세요');
    const ms = await all(env, 'SELECT lang FROM pl_members WHERE room_id = ?', b.room);
    const targets = [...new Set(ms.map((m) => m.lang).filter((l) => l !== me.lang && langOk(l)))];
    let tr = {};
    if (targets.length) {
      const need = targets.length * ROOM_STEP;
      const paid = await spendUser(env, u.id, need, 'room', false);
      if (!paid.ok) throw httpErr(402, '크레딧이 부족합니다 (이번 한 마디 ' + (need / 10) + ' 크레딧)', { needCredit: true });
      try { tr = await roomTranslate(env, ctx, text, me.lang, targets); }
      catch (e) { await addUser(env, u.id, need, 'refund', '번역 실패'); throw httpErr(500, '번역하지 못했어요 · 크레딧은 돌려드렸어요'); }
    }
    const r = await run(env, 'INSERT INTO pl_msgs (room_id, user_id, nick, lang, body, tr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b.room, u.id, me.nick, me.lang, text, JSON.stringify(tr), now());
    await run(env, 'UPDATE pl_rooms SET last_body = ?, last_nick = ?, last_at = ? WHERE id = ?', text.slice(0, 80), me.nick, now(), b.room).catch(() => {});
    return { ok: true, id: r.meta && r.meta.last_row_id, cost: targets.length * ROOM_STEP / 10 };
  }
  if (op === 'leave' || op === 'delete') {
    await member(env, u.id, b.room);
    const room = await one(env, 'SELECT owner FROM pl_rooms WHERE id = ?', b.room);
    if (op === 'delete') {
      if (!room || room.owner !== u.id) throw httpErr(403, '방을 만든 사람만 지울 수 있어요');
      await wipeRoom(env, b.room);
      return { ok: true };
    }
    await run(env, 'DELETE FROM pl_members WHERE room_id = ? AND user_id = ?', b.room, u.id);
    const left = await one(env, 'SELECT COUNT(*) AS n FROM pl_members WHERE room_id = ?', b.room);
    if (!left || !left.n) await wipeRoom(env, b.room);
    return { ok: true };
  }
  if (op === 'block' || op === 'report') {
    const m = await one(env, 'SELECT id, room_id, user_id, nick, body FROM pl_msgs WHERE id = ?', parseInt(b.msg, 10) || 0);
    if (!m) throw httpErr(404, '없어진 메시지예요');
    await member(env, u.id, m.room_id);
    if (op === 'block') {
      if (m.user_id === u.id) throw httpErr(400, '나는 차단할 수 없어요');
      await run(env, 'INSERT OR IGNORE INTO pl_blocks (user_id, blocked, nick, created_at) VALUES (?, ?, ?, ?)', u.id, m.user_id, m.nick, now());
      return { ok: true };
    }
    await run(env, 'INSERT INTO pl_reports (room_id, msg_id, reporter, target, body, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      m.room_id, m.id, u.id, m.user_id, String(m.body || '').slice(0, 1000), clean(b.reason, 180), now());
    return { ok: true };
  }
  if (op === 'unblock_all') { await run(env, 'DELETE FROM pl_blocks WHERE user_id = ?', u.id); return { ok: true }; }
  throw httpErr(400, '알 수 없는 요청입니다');
}
async function wipeRoom(env, room) {
  await db(env).batch([
    db(env).prepare('DELETE FROM pl_msgs WHERE room_id = ?').bind(room),
    db(env).prepare('DELETE FROM pl_members WHERE room_id = ?').bind(room),
    db(env).prepare('DELETE FROM pl_rooms WHERE id = ?').bind(room),
  ]);
}
async function cleanup(env) {
  const t = now() - KEEP_DAYS * 864e5;
  await run(env, 'DELETE FROM pl_msgs WHERE created_at < ?', t);
  const old = await all(env, 'SELECT id FROM pl_rooms WHERE last_at < ? LIMIT 50', t);
  for (const r of old) await wipeRoom(env, r.id);
}
async function roomTranslate(env, ctx, text, from, targets) {
  const sys = 'You are a professional interpreter for live chat. Translate the user message from ' + (LANGS[from] || from) +
    ' into each requested language. Keep the meaning, tone and politeness; keep names, numbers, prices and emojis. Do not add explanations. ' +
    'Return ONLY a JSON object whose keys are exactly these codes: ' + targets.map((t) => t + ' (' + LANGS[t] + ')').join(', ') + '.';
  const r = await fetch(ctx.OPENAI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('번역 오류 ' + r.status);
  const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const m = String(out).match(/\{[\s\S]*\}/);
  let o = null; try { o = m ? JSON.parse(m[0]) : null; } catch (e) {}
  if (!o) throw new Error('번역 결과를 읽지 못했어요');
  const res = {};
  for (const t of targets) if (typeof o[t] === 'string' && o[t].trim()) res[t] = o[t].trim().slice(0, 2000);
  if (!Object.keys(res).length) throw new Error('번역 결과가 비었어요');
  return res;
}

/* ───────────── 길 나누기 ─────────────
   이 워커가 처리할 경로면 Response 를, 아니면 null 을 돌려준다 */
export async function plRoute(request, env, url, H, ctx) {
  const p = url.pathname;
  if (!(p.startsWith('/api/pl/') || p === '/api/link/wallet')) return null;
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...H } });
  if (request.method !== 'POST') return J({ error: 'POST 로 불러 주세요' }, 405);
  let b = {};
  try { b = await request.json(); } catch (e) { return J({ error: '잘못된 요청입니다' }, 400); }
  try {
    if (p === '/api/link/wallet') {
      const lk = request.headers.get('X-Link-Key') || '';
      if (!env.LINK_KEY || !safeEq(lk, env.LINK_KEY)) return J({ ok: false, error: '권한이 없어요' }, 401);
      if (b.op === 'balance') return J(await plBalance(env, b.t));
      if (b.op === 'spend') return J(await plSpend(env, b.t, Number(b.amount) || 0, String(b.kind || 'phone'), true));
      return J({ ok: false, error: '알 수 없는 요청' }, 400);
    }
    if (p === '/api/pl/config') {
      return J({ ok: true, google: env.GOOGLE_CLIENT_ID || '', play: !!env.PLAY_SA_JSON, pkg: env.PLAY_PACKAGE || PLAY_PKG_DEFAULT, wallet: !!env.DB,
        products: PRODUCTS.map((x) => ({ id: x.id, credits: x.credits, amount: x.amount, name: x.name })),
        welcome: env.PL_WELCOME != null ? Number(env.PL_WELCOME) : WELCOME_DEFAULT });
    }
    if (p === '/api/pl/login') return J(await login(env, b));
    if (p === '/api/pl/me') {
      const u = await userOf(env, b.tk);
      const orders = await all(env, "SELECT order_id, amount, tenths, method, paid_at FROM pl_orders WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 20", u.id);
      return J({ ok: true, me: meView(u), orders: orders.map((o) => ({ id: o.order_id, amount: o.amount, credits: cr(o.tenths), method: o.method, at: o.paid_at })) });
    }
    if (p === '/api/pl/logout') { if (isPl(b.tk)) await run(env, 'DELETE FROM pl_sessions WHERE token_hash = ?', await sha(b.tk)); return J({ ok: true }); }
    if (p === '/api/pl/delete') {
      const u = await userOf(env, b.tk);
      const rooms = await all(env, 'SELECT id FROM pl_rooms WHERE owner = ?', u.id);
      for (const r of rooms) await wipeRoom(env, r.id);
      await db(env).batch([
        db(env).prepare('DELETE FROM pl_members WHERE user_id = ?').bind(u.id),
        db(env).prepare('DELETE FROM pl_blocks WHERE user_id = ?').bind(u.id),
        db(env).prepare('DELETE FROM pl_sessions WHERE user_id = ?').bind(u.id),
        db(env).prepare('DELETE FROM pl_users WHERE id = ?').bind(u.id),
      ]);
      return J({ ok: true });
    }
    if (p === '/api/pl/play') return J(await play(env, b));
    if (p === '/api/pl/room') return J(await roomOp(env, ctx, b));
    return J({ error: '없는 경로입니다' }, 404);
  } catch (e) {
    const s = e && e.status ? e.status : 500;
    return J(Object.assign({ error: (e && e.message) || '오류가 났습니다' }, (e && e.extra) || {}), s);
  }
}
