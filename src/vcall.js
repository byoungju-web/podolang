/**
 * 🍇 포도랑 v9.9 — 영상·음성 통화 번역 (/api/vc · /api/vc/live)
 *
 *  · 초대한 사람(로그인 회원)이 통화방을 만들고 링크(https://podolang.kr/?vc=ABC123)를 메신저로 보냅니다.
 *  · 받은 사람은 로그인 없이 링크로 참여합니다.
 *  · 영상·소리는 두 폰이 직접 주고받습니다(WebRTC). 서버는 연결 정보(SDP)만 잠깐 건네 줍니다.
 *    직접 연결이 안 되는 망이면 Cloudflare TURN 이 중계합니다 (Secret TURN_KEY_ID · TURN_KEY_TOKEN 이 있을 때).
 *  · 번역: 각자 자기 목소리 조각을 /api/vc/live 로 보내면 받아쓰고 상대 언어로 옮겨 돌려줍니다.
 *    요금은 라이브 청취와 같은 '말한 시간 1분 0.5 크레딧'(12초마다 0.1)이고, 양쪽 모두 초대한 사람이 냅니다.
 *  · 목소리·영상·대화 글은 저장하지 않습니다. 표(pl_calls)의 연결 정보는 2일 뒤 지웁니다.
 *
 *  D1 표: schema.sql 의 pl_calls (한 번 실행 필요)
 */
import { isPl, plUserId, plBalanceId, plSpendId } from './wallet.js';

const UNIT_SEC = 12;          // 이 초마다
const UNIT_CR = 0.1;          //   이만큼 (= 1분 0.5 크레딧)
const MAX_BYTES = 900000;     // 한 조각 최대 크기
const KEEP_MS = 2 * 86400000; // 표에 남겨 두는 기간
const MAX_TALK_MS = 3 * 3600000;   // 한 통화 최대 3시간
const SEEN_MS = 75000;        // 이 시간 동안 소식이 없으면 나간 것으로 봄

const now = () => Date.now();
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const langOk = (l) => /^[A-Z]{2,3}$/.test(String(l || ''));
function rand(n) { const r = new Uint8Array(n); crypto.getRandomValues(r); return r; }
function b64u(bytes) { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(rand(6), (x) => A[x % A.length]).join(''); }
function err(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }

function db(env) { if (!env.DB) throw err(503, '포도랑 설정이 아직 끝나지 않았습니다 (D1).'); return env.DB; }
async function one(env, sql, ...a) { return await db(env).prepare(sql).bind(...a).first(); }
async function run(env, sql, ...a) { return await db(env).prepare(sql).bind(...a).run(); }

/* 표가 없을 때(아직 schema 를 실행 안 했을 때) 알아보기 쉬운 말로 */
function tableMissing(e) { return /no such table/i.test(String((e && e.message) || '')); }

/* ── 연결 도우미(STUN·TURN) 주소 ── */
async function iceServers(env) {
  const base = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return base;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 4 * 3600 }),
    });
    if (!r.ok) return base;
    const d = await r.json();
    const list = Array.isArray(d.iceServers) ? d.iceServers : (d.iceServers ? [d.iceServers] : []);
    // 브라우저는 53번 포트를 막아서 기다리기만 하므로 뺍니다 (Cloudflare 안내)
    const out = list.map((s) => Object.assign({}, s, { urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return out.length ? out : base;
  } catch (e) { return base; }
}

/* v10.1 coverfo 'AI에게 물어보기'에서 열면 tk 자리에 coverfo 표(cf.…, 12시간)가 옵니다.
   그때 초대한 사람 = 'cf:' + 표 이고, 요금은 coverfo 지갑(worker.js 의 cdCheck · cdSpend)에서 나갑니다.
   통화가 끝나면 표를 지웁니다 (host = 'cf:end'). */
let CX = {};
async function hostKey(env, tk) {
  if (!tk) return null;
  if (isPl(tk)) return await plUserId(env, tk);
  if (CX.isCf && CX.isCf(tk)) return 'cf:' + tk;
  return null;
}
const isCfHost = (h) => String(h || '').startsWith('cf:');

/* ── 누가 부르는지: 초대한 사람(tk) 또는 참여한 사람(gk) ── */
async function who(env, call, b) {
  if (b.tk) {
    const id = await hostKey(env, b.tk);
    if (id && id === call.host) return 'host';
  }
  if (b.gk && call.guest_key && (await sha(b.gk)) === call.guest_key) return 'guest';
  throw err(403, '이 통화에 들어갈 수 없습니다.');
}
async function callOf(env, code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (c.length !== 6) throw err(400, '통화 코드가 올바르지 않습니다.');
  const call = await one(env, 'SELECT * FROM pl_calls WHERE code = ?', c);
  if (!call) throw err(404, '없는 통화이거나 이미 끝난 통화입니다.');
  return call;
}
const peerView = (call, role) => role === 'host'
  ? (call.guest_lang ? { lang: call.guest_lang, nick: call.guest_nick || '' } : null)
  : { lang: call.host_lang, nick: call.host_nick || '' };
const ended = (call) => call.state === 'end' || (call.talk_at && now() - call.talk_at > MAX_TALK_MS);

async function vcOp(env, b) {
  const op = String(b.op || '');

  /* 초대한 사람: 통화방 만들기 */
  if (op === 'create') {
    const host = await hostKey(env, b.tk);
    if (!host) throw err(401, '마이에서 구글로 로그인해 주세요.', { login: true });
    if (isCfHost(host)) {   // v10.1 coverfo 지갑
      const chk = await CX.cdCheck(env, b.tk);
      if (!chk || !chk.ok) throw err(402, (chk && chk.reason) || '크레딧이 없습니다.', { needCredit: true });
    } else if ((await plBalanceId(env, host)) <= 0) throw err(402, '크레딧이 없습니다. 마이 → 크레딧 충전에서 채워주세요.', { needCredit: true });
    const lang = String(b.lang || '').toUpperCase();
    if (!langOk(lang)) throw err(400, '내 언어를 골라 주세요.');
    // 오래된 통화 정리 · 내가 열어 둔 통화는 끝냄
    await run(env, 'DELETE FROM pl_calls WHERE created_at < ?', now() - KEEP_MS).catch(() => {});
    await run(env, "UPDATE pl_calls SET state = 'end', ended_at = ?, offer = NULL, answer = NULL WHERE host = ? AND state != 'end'", now(), host);
    let code = '';
    for (let i = 0; i < 5 && !code; i++) { const c = newCode(); if (!(await one(env, 'SELECT code FROM pl_calls WHERE code = ?', c))) code = c; }
    if (!code) throw err(500, '잠시 뒤 다시 해 주세요.');
    await run(env, `INSERT INTO pl_calls (id, code, host, video, host_lang, host_nick, state, host_seen, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'wait', ?, ?)`,
      b64u(rand(12)), code, host, b.video ? 1 : 0, lang, clean(b.nick, 20), now(), now());
    return { ok: true, code, video: !!b.video, ice: await iceServers(env) };
  }

  /* 받은 사람: 링크를 열었을 때 보여 줄 정보 (로그인 필요 없음) */
  if (op === 'info') {
    await run(env, 'DELETE FROM pl_calls WHERE created_at < ?', now() - KEEP_MS).catch(() => {});   // 2일 지난 통화 정리
    const call = await callOf(env, b.code);
    return { ok: true, video: call.video === 1, host: { nick: call.host_nick || '', lang: call.host_lang },
             state: ended(call) ? 'end' : call.state, busy: !!call.guest_key };
  }

  /* 받은 사람: 참여 (같은 폰이 다시 들어오면 gk 로 이어서) */
  if (op === 'join') {
    const call = await callOf(env, b.code);
    if (ended(call)) throw err(410, '이미 끝난 통화입니다.');
    const lang = String(b.lang || '').toUpperCase();
    if (!langOk(lang)) throw err(400, '내 언어를 골라 주세요.');
    let gk = String(b.gk || '');
    const mine = gk && call.guest_key && (await sha(gk)) === call.guest_key;
    if (call.guest_key && !mine) {
      if (call.guest_seen && now() - call.guest_seen < SEEN_MS) throw err(409, '이미 다른 사람이 참여한 통화입니다.');
    }
    if (!mine) gk = b64u(rand(24));
    // 새로 들어오면 연결을 처음부터 다시 맞춥니다 (offer 를 다시 받음)
    await run(env, `UPDATE pl_calls SET guest_lang = ?, guest_nick = ?, guest_key = ?, guest_seen = ?, state = 'join',
                    offer = NULL, answer = NULL WHERE id = ?`,
      lang, clean(b.nick, 20), await sha(gk), now(), call.id);
    return { ok: true, gk, video: call.video === 1, ver: call.ver, peer: { nick: call.host_nick || '', lang: call.host_lang }, ice: await iceServers(env) };
  }

  const call = await callOf(env, b.code);
  const role = await who(env, call, b);
  const seenCol = role === 'host' ? 'host_seen' : 'guest_seen';

  /* 둘 다: 상태 묻기 (2~4초마다) */
  if (op === 'poll') {
    await run(env, `UPDATE pl_calls SET ${seenCol} = ? WHERE id = ?`, now(), call.id).catch(() => {});
    const out = { ok: true, state: ended(call) ? 'end' : call.state, ver: call.ver, peer: peerView(call, role) };
    if (role === 'guest' && call.offer) out.offer = call.offer;
    if (role === 'host' && call.answer && call.answer_ver === call.ver) out.answer = call.answer;
    if (role === 'host') { out.spent = Math.round(call.spent) / 10; out.secs = Math.round(call.secs); }
    if (role === 'host' && call.state === 'join' && !call.offer) out.needOffer = true;   // 상대가 (다시) 들어왔으니 연결 제안을 새로
    const other = role === 'host' ? call.guest_seen : call.host_seen;
    out.peerAway = !!(other && now() - other > SEEN_MS);
    return out;
  }

  /* 초대한 사람: 연결 제안 보내기 (다시 연결할 때도) */
  if (op === 'offer') {
    if (role !== 'host') throw err(403, '권한이 없습니다.');
    if (ended(call)) throw err(410, '이미 끝난 통화입니다.');
    const sdp = String(b.sdp || '');
    if (!sdp || sdp.length > 60000) throw err(400, '연결 정보가 올바르지 않습니다.');
    const ver = (call.ver || 0) + 1;
    await run(env, "UPDATE pl_calls SET ver = ?, offer = ?, answer = NULL, host_seen = ? WHERE id = ?", ver, sdp, now(), call.id);
    return { ok: true, ver };
  }

  /* 받은 사람: 연결 응답 보내기 */
  if (op === 'answer') {
    if (role !== 'guest') throw err(403, '권한이 없습니다.');
    if (ended(call)) throw err(410, '이미 끝난 통화입니다.');
    const sdp = String(b.sdp || '');
    if (!sdp || sdp.length > 60000) throw err(400, '연결 정보가 올바르지 않습니다.');
    if (Number(b.ver) !== call.ver) return { ok: false, stale: true };
    await run(env, "UPDATE pl_calls SET answer = ?, answer_ver = ?, state = 'talk', talk_at = COALESCE(talk_at, ?), guest_seen = ? WHERE id = ?",
      sdp, call.ver, now(), now(), call.id);
    return { ok: true };
  }

  /* 둘 다: 끊기 */
  if (op === 'end') {
    await run(env, "UPDATE pl_calls SET state = 'end', ended_at = COALESCE(ended_at, ?), offer = NULL, answer = NULL WHERE id = ?", now(), call.id);
    if (isCfHost(call.host) && role === 'host') await run(env, "UPDATE pl_calls SET host = 'cf:end' WHERE id = ?", call.id).catch(() => {});   // v10.1 coverfo 표는 끝나면 지움
    return { ok: true, spent: Math.round(call.spent) / 10, secs: Math.round(call.secs) };
  }

  throw err(400, '알 수 없는 요청입니다.');
}

/* 말 한 조각 받아쓰기 + 상대 언어로 번역 — 요금은 초대한 사람 지갑에서 */
async function vcLive(env, request, ctx) {
  const fd = await request.formData();
  const b = { code: fd.get('code'), tk: String(fd.get('tk') || ''), gk: String(fd.get('gk') || '') };
  const audio = fd.get('audio');
  if (!audio || !audio.size) throw err(400, '소리가 없습니다.');
  if (audio.size > MAX_BYTES) throw err(413, '소리 조각이 너무 큽니다.');
  const call = await callOf(env, b.code);
  const role = await who(env, call, b);
  if (ended(call)) throw err(410, '통화가 끝났습니다.');
  if (call.state !== 'talk') throw err(409, '아직 연결되지 않았습니다.');
  const other = role === 'host' ? call.guest_seen : call.host_seen;
  if (role === 'guest' && other && now() - other > SEEN_MS) throw err(409, '초대한 사람이 나갔습니다.');
  const src = role === 'host' ? call.host_lang : call.guest_lang;
  const dst = role === 'host' ? call.guest_lang : call.host_lang;

  const spend = async () => {
    const sp = isCfHost(call.host)
      ? await CX.cdSpend(env, call.host.slice(3), UNIT_CR, 'vcall')   // v10.1 coverfo 지갑
      : await plSpendId(env, call.host, UNIT_CR, 'vcall');
    if (!sp || sp.ok === false) return false;
    await run(env, 'UPDATE pl_calls SET bank = bank + ?, spent = spent + ? WHERE id = ?', UNIT_SEC, Math.round(UNIT_CR * 10), call.id);
    return true;
  };
  // 미리 낸 초가 없으면 먼저 12초어치를 뺍니다 — 먼저 깎고 부릅니다
  let charged = 0;
  if ((Number(call.bank) || 0) < 1) {
    if (!(await spend())) throw err(402, '초대한 사람의 크레딧이 떨어져 번역이 멈췄어요. 통화는 계속됩니다.', { needCredit: true, stop: true });
    charged += UNIT_CR;
  }
  const tr = await ctx.transcribeLive(env, audio, src);
  const dur = Math.max(0, Math.min(Number(tr.duration) || 0, 30));
  await run(env, 'UPDATE pl_calls SET bank = bank - ?, secs = secs + ? WHERE id = ?', dur, dur, call.id);
  let stop = false;
  for (let i = 0; i < 4; i++) {   // 쓴 만큼 이어서 뺍니다 (한 조각 최대 30초 = 3번)
    const r = await one(env, 'SELECT bank FROM pl_calls WHERE id = ?', call.id);
    if (!r || (Number(r.bank) || 0) >= 0) break;
    if (!(await spend())) { stop = true; await run(env, 'UPDATE pl_calls SET bank = 0 WHERE id = ?', call.id); break; }
    charged += UNIT_CR;
  }
  const text = tr.text;
  let translated = '';
  if (text) { try { translated = (await ctx.translate(env, text, src, dst)).translated; } catch (e) { translated = ''; } }
  return { ok: true, text, translated, sec: Math.round(dur * 10) / 10, charged: Math.round(charged * 10) / 10, stop };
}

export async function vcRoute(request, env, url, H, ctx) {
  const p = url.pathname;
  if (p !== '/api/vc' && p !== '/api/vc/live') return null;
  CX = ctx || {};
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...H } });
  if (request.method !== 'POST') return J({ error: 'POST 로 불러 주세요' }, 405);
  try {
    if (p === '/api/vc/live') return J(await vcLive(env, request, ctx));
    let b = {};
    try { b = await request.json(); } catch (e) { return J({ error: '잘못된 요청입니다' }, 400); }
    return J(await vcOp(env, b));
  } catch (e) {
    if (tableMissing(e)) return J({ error: '통화 설정이 아직 끝나지 않았습니다 (D1 pl_calls).' }, 503);
    const s = e && e.status ? e.status : 500;
    return J(Object.assign({ error: (e && e.message) || '오류가 났습니다' }, (e && e.extra) || {}), s);
  }
}
