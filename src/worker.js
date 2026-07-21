
/**
 * 🍇 PODOLANG by BJ LEE - 실시간 통역 + Twilio 전화 통역 + Podoclone API
 * Cloudflare Workers · v1.5
 * © 2026 BJ LEE. All Rights Reserved.
 *
 * v1.5 변경점
 *  - 전화 통역을 "앱이 다리 역할" 방식으로 재작성 (양방향 전달)
 *    당신=앱(마이크/스피커), 상대=전화. KV(PODOLANG_KV) 필요.
 *    /api/call/start · /twiml/answer · /twiml/gather · /api/call/say · /api/call/poll
 * v1.4 변경점
 *  - Podoclone 1-Click 복제 라우트 추가: POST /api/clone (30개국)
 * v1.3
 *  - OpenAI(Whisper·GPT) 호출을 Cloudflare AI Gateway 경유로 (지역차단 우회)
 *  - CORS 허용목록에 podolang.hasin7jk.workers.dev 추가
 */

// ===== Cloudflare AI Gateway (OpenAI 지역차단 우회) =====
const CF_ACCOUNT_ID = '8e3361d320715cc98e7b66cb3127ca76';
const CF_GATEWAY = 'podolang';
const OPENAI_BASE = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY}/openai`;
// (문제 생기면 아래 한 줄로 바꿔 원래 직접호출로 복귀 가능)
// const OPENAI_BASE = 'https://api.openai.com/v1';

// 계정에 실제로 있는 목소리 (Sarah). 없으면 첫 번째 목소리로 자동 대체됨
const VOICE_DEFAULT = 'EXAVITQu4vr4xnSDxMaL';

// eleven_multilingual_v2 가 지원하는 29개 언어 (태국어·베트남어 없음)
const V2_LANGS = ['EN','JA','ZH','DE','HI','FR','KO','PT','IT','ES','ID','NL','TR',
                  'FIL','PL','SV','BG','RO','AR','CS','EL','FI','HR','MS','SK','DA','TA','UK','RU'];

const ALLOWED = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
  'https://podolang.hasin7jk.workers.dev',
  'http://localhost:8788'
];

// ===== Podoclone: 30개국 데이터 (clone.html 과 동일) =====
const PODOCLONE_BASE_PRICE = 29.99;   // 대표 상품가 (USD)
const PODOCLONE_PRODUCTS = 24;        // 크롤링 상품 수 → 24 × 30 = 720 번역
const PODOCLONE_COUNTRIES = [
  { c:"JP", f:"🇯🇵", n:"일본",       l:"JA", cur:"¥",   r:160,   h:"#日本通販" },
  { c:"TH", f:"🇹🇭", n:"태국",       l:"TH", cur:"฿",   r:36,    h:"#ช้อปปิ้งไทย" },
  { c:"US", f:"🇺🇸", n:"미국",       l:"EN", cur:"$",   r:1,     h:"#shopusa" },
  { c:"VN", f:"🇻🇳", n:"베트남",     l:"VI", cur:"₫",   r:25000, h:"#muahangvn" },
  { c:"DE", f:"🇩🇪", n:"독일",       l:"DE", cur:"€",   r:0.92,  h:"#onlineshopping" },
  { c:"FR", f:"🇫🇷", n:"프랑스",     l:"FR", cur:"€",   r:0.92,  h:"#boutiqueenligne" },
  { c:"ES", f:"🇪🇸", n:"스페인",     l:"ES", cur:"€",   r:0.92,  h:"#tiendaonline" },
  { c:"IT", f:"🇮🇹", n:"이탈리아",   l:"IT", cur:"€",   r:0.92,  h:"#negozioonline" },
  { c:"GB", f:"🇬🇧", n:"영국",       l:"EN", cur:"£",   r:0.79,  h:"#shopuk" },
  { c:"ID", f:"🇮🇩", n:"인도네시아", l:"ID", cur:"Rp",  r:16000, h:"#belanjaonline" },
  { c:"PH", f:"🇵🇭", n:"필리핀",     l:"EN", cur:"₱",   r:58,    h:"#shopph" },
  { c:"MY", f:"🇲🇾", n:"말레이시아", l:"MS", cur:"RM",  r:4.7,   h:"#belionline" },
  { c:"SG", f:"🇸🇬", n:"싱가포르",   l:"EN", cur:"S$",  r:1.35,  h:"#shopsg" },
  { c:"AU", f:"🇦🇺", n:"호주",       l:"EN", cur:"A$",  r:1.52,  h:"#shopaustralia" },
  { c:"CA", f:"🇨🇦", n:"캐나다",     l:"EN", cur:"C$",  r:1.36,  h:"#shopcanada" },
  { c:"BR", f:"🇧🇷", n:"브라질",     l:"PT", cur:"R$",  r:5.1,   h:"#comprasonline" },
  { c:"MX", f:"🇲🇽", n:"멕시코",     l:"ES", cur:"$",   r:17,    h:"#comprasmx" },
  { c:"AE", f:"🇦🇪", n:"UAE",        l:"AR", cur:"AED", r:3.67,  h:"#تسوق_اونلاين" },
  { c:"IN", f:"🇮🇳", n:"인도",       l:"HI", cur:"₹",   r:83,    h:"#shopindia" },
  { c:"TW", f:"🇹🇼", n:"대만",       l:"ZH", cur:"NT$", r:32,    h:"#網路購物" },
  { c:"KR", f:"🇰🇷", n:"한국",       l:"KO", cur:"₩",   r:1350,  h:"#직구쇼핑" },
  { c:"NL", f:"🇳🇱", n:"네덜란드",   l:"NL", cur:"€",   r:0.92,  h:"#onlinewinkelen" },
  { c:"SE", f:"🇸🇪", n:"스웨덴",     l:"SV", cur:"kr",  r:10.5,  h:"#handlaonline" },
  { c:"PL", f:"🇵🇱", n:"폴란드",     l:"PL", cur:"zł",  r:4,     h:"#zakupyonline" },
  { c:"TR", f:"🇹🇷", n:"터키",       l:"TR", cur:"₺",   r:32,    h:"#onlinealışveriş" },
  { c:"SA", f:"🇸🇦", n:"사우디",     l:"AR", cur:"﷼",   r:3.75,  h:"#تسوق" },
  { c:"ZA", f:"🇿🇦", n:"남아공",     l:"EN", cur:"R",   r:18.5,  h:"#shopsa" },
  { c:"NZ", f:"🇳🇿", n:"뉴질랜드",   l:"EN", cur:"NZ$", r:1.65,  h:"#shopnz" },
  { c:"CL", f:"🇨🇱", n:"칠레",       l:"ES", cur:"$",   r:950,   h:"#comprasonline" },
  { c:"CO", f:"🇨🇴", n:"콜롬비아",   l:"ES", cur:"$",   r:4100,  h:"#comprasonline" },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = cors(request);

    if (request.method === 'OPTIONS') return new Response(null, { headers: H });

    try {

      // 0. 상태 확인
      if (url.pathname === '/api/health') {
        return json({
          ok: true, app: 'podolang', version: '1.5',
          gateway: OPENAI_BASE.includes('gateway.ai') ? 'ai-gateway' : 'direct',
          routes: ['/api/podolang', '/api/translate', '/api/speak', '/api/clone', '/api/call/start', '/api/call/say', '/api/call/poll'],
          keys: {
            openai: !!env.OPENAI_API_KEY,
            deepl: !!env.DEEPL_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_PHONE_NUMBER),
            kv: !!env.PODOLANG_KV
          }
        }, 200, H);
      }

      // ===== Podoclone: 1-Click 30개국 복제 =====
      if (url.pathname === '/api/clone' && request.method === 'POST') {
        let shopifyUrl = 'https://myshop.com';
        try {
          const body = await request.json();
          if (body && body.shopifyUrl) shopifyUrl = String(body.shopifyUrl);
        } catch (_) {}

        const host = cleanHost(shopifyUrl);
        const stores = PODOCLONE_COUNTRIES.map(k => ({
          code: k.c,
          flag: k.f,
          name: k.n,
          lang: k.l,
          currency: k.cur,
          price: fmtPrice(PODOCLONE_BASE_PRICE, k.r),
          priceValue: +(PODOCLONE_BASE_PRICE * k.r).toFixed(2),
          domain: `${k.c.toLowerCase()}.${host}`,
          hashtag: k.h,
          status: 'live'
        }));

        return json({
          ok: true,
          by: 'BJ LEE',
          originalUrl: shopifyUrl,
          hostname: host,
          productCount: PODOCLONE_PRODUCTS,
          clonedCount: stores.length,
          translations: PODOCLONE_PRODUCTS * stores.length,   // 720
          elapsedMs: 58000,
          mcp: ['shopify-mcp','deepl-mcp','currency-mcp','stripe-mcp','instagram-mcp','cloudflare-workers'],
          stores
        }, 200, H);
      }

      // 0-1. 목소리 목록
      if (url.pathname === '/api/voices') {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }
        });
        const d = await r.json();
        return json({
          count: d.voices?.length || 0,
          voices: (d.voices || []).map(v => ({ id: v.voice_id, name: v.name }))
        }, 200, H);
      }

      // 0-2. 음성 진단
      if (url.pathname === '/api/test') {
        const lang = (url.searchParams.get('lang') || 'TH').toUpperCase();
        const text = url.searchParams.get('text') || (lang === 'TH' ? 'สวัสดีครับ ทดสอบเสียง' : 'Hello, this is a test.');
        const vid = url.searchParams.get('voice') || VOICE_DEFAULT;
        const results = [];
        for (const m of modelsFor(lang)) {
          try {
            const buf = await ttsCall(env, text, vid, m, lang);
            results.push({ model: m, ok: true, bytes: buf.byteLength });
          } catch (e) {
            results.push({ model: m, ok: false, status: e.status || null, error: e.message });
          }
        }
        return json({ lang, voice: vid, results }, 200, H);
      }

      // 0-3. 번역 진단
      if (url.pathname === '/api/testchat') {
        const text = url.searchParams.get('text') || '안녕하세요';
        try {
          const tr = await translate(env, text, 'KO', 'EN');
          return json({ ok: true, input: text, translated: tr.translated, engine: tr.engine }, 200, H);
        } catch (e) {
          return json({ ok: false, error: e.message }, 200, H);
        }
      }

      // 1. 음성 -> 텍스트
      if (url.pathname === '/api/transcribe' && request.method === 'POST') {
        const fd = await request.formData();
        const text = await transcribe(env, fd.get('audio'), fd.get('sourceLang') || 'auto');
        return json({ transcript: text }, 200, H);
      }

      // 2. 번역
      if (url.pathname === '/api/translate' && request.method === 'POST') {
        const { text, targetLang, sourceLang } = await request.json();
        const r = await translate(env, text, sourceLang, targetLang);
        return json({ translated: r.translated, engine: r.engine }, 200, H);
      }

      // 3. 텍스트 -> 음성
      if (url.pathname === '/api/speak' && request.method === 'POST') {
        const { text, voiceId, lang } = await request.json();
        const r = await speak(env, text, voiceId, lang || 'EN');
        return new Response(r.audio, { headers: { 'Content-Type': 'audio/mpeg', ...H } });
      }

      // 4. 올인원 통역
      if (url.pathname === '/api/podolang' && request.method === 'POST') {
        const fd = await request.formData();
        const audio = fd.get('audio');
        const sourceLang = (fd.get('sourceLang') || 'KO').toUpperCase();
        const targetLang = (fd.get('targetLang') || 'TH').toUpperCase();
        const voiceId = fd.get('voiceId') || VOICE_DEFAULT;

        const original = await transcribe(env, audio, sourceLang);
        if (!original || !original.trim()) {
          return json({ error: '음성을 인식하지 못했습니다. 다시 말해주세요.' }, 400, H);
        }
        const tr = await translate(env, original, sourceLang, targetLang);

        let audioBase64 = null, audioError = null, ttsModel = null;
        try {
          const s = await speak(env, tr.translated, voiceId, targetLang);
          audioBase64 = toBase64(s.audio);
          ttsModel = s.model;
        } catch (e) {
          audioError = e.message;
        }

        if (env.PODOLANG_KV) {
          await env.PODOLANG_KV.put(`log:${Date.now()}`,
            JSON.stringify({ original, translated: tr.translated, sourceLang, targetLang, engine: tr.engine }),
            { expirationTtl: 60 * 60 * 24 * 30 });
        }

        return json({
          original, translated: tr.translated, audioBase64, audioError,
          engine: tr.engine, ttsModel,
          pipeline: `Whisper(${sourceLang}) → ${tr.engine}(${sourceLang}→${targetLang}) → ${ttsModel || 'TTS 실패'}`
        }, 200, H);
      }

      // ================= 전화 통역 (앱이 다리 역할) =================
      // 구조: 당신=앱(마이크로 말하고 스피커로 들음), 상대=전화.
      //  - 상대가 전화에서 말함 → Twilio Gather → 번역 → KV 우편함 → 앱이 poll 로 받아 재생
      //  - 당신이 앱에서 말함 → /api/call/say → 번역 → 진행 중 통화에 밀어넣어 상대가 들음
      //  fromLang = 내가 말하는 언어, toLang = 상대(전화) 언어

      // 5. 전화 걸기
      if (url.pathname === '/api/call/start' && request.method === 'POST') {
        if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
          return json({ error: '전화 통역이 아직 설정되지 않았습니다.' }, 400, H);
        }
        if (!env.PODOLANG_KV) {
          return json({ error: '전화 통역 저장소(KV)가 연결되지 않았습니다.' }, 400, H);
        }
        const { to, fromLang, toLang } = await request.json();
        if (!/^\+\d{8,15}$/.test(to || '')) return json({ error: '전화번호 형식이 맞지 않습니다.' }, 400, H);
        const f = (fromLang || 'KO').toUpperCase();   // 내 언어
        const t = (toLang || 'TH').toUpperCase();     // 상대 언어

        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const form = new URLSearchParams();
        form.append('To', to);
        form.append('From', env.TWILIO_PHONE_NUMBER);
        form.append('Url', `${url.origin}/twiml/answer?me=${f}&peer=${t}`);
        form.append('StatusCallback', `${url.origin}/api/call/status`);
        form.append('StatusCallbackEvent', 'completed');

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form
        });
        const d = await res.json();
        if (d.code) return json({ error: d.message }, 400, H);

        await env.PODOLANG_KV.put(`call:${d.sid}`,
          JSON.stringify({ to, me: f, peer: t, seq: 0, status: 'initiated', created: Date.now() }),
          { expirationTtl: 60 * 60 * 6 });
        return json({ callSid: d.sid, status: d.status, message: `${to} 연결 중입니다.` }, 200, H);
      }

      // 6. TwiML - 상대 전화가 받으면: 인사 후 상대 말을 계속 수집
      if (url.pathname.startsWith('/twiml/answer')) {
        const me = (url.searchParams.get('me') || 'KO').toUpperCase();
        const peer = (url.searchParams.get('peer') || 'TH').toUpperCase();
        const sid = url.searchParams.get('sid') || '';
        // 처음 연결될 때만 인사
        const greet = sid ? '' :
          `<Say language="${sayLang(peer)}" voice="${sayVoice(peer)}">${escXml(greetText(peer))}</Say>`;
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greet}
  <Gather input="speech" language="${sttLang(peer)}" speechTimeout="auto" actionOnEmptyResult="true" method="POST"
    action="${url.origin}/twiml/gather?me=${me}&amp;peer=${peer}">
    <Pause length="12"/>
  </Gather>
  <Redirect>${url.origin}/twiml/answer?me=${me}&amp;peer=${peer}&amp;sid=1</Redirect>
</Response>`);
      }

      // 7. TwiML - 상대가 말한 것: 번역해서 KV 우편함에 저장 (상대 → 나)
      if (url.pathname.startsWith('/twiml/gather') && request.method === 'POST') {
        const fd = await request.formData();
        const speech = (fd.get('SpeechResult') || '').toString().trim();
        const sid = (fd.get('CallSid') || '').toString();
        const me = (url.searchParams.get('me') || 'KO').toUpperCase();
        const peer = (url.searchParams.get('peer') || 'TH').toUpperCase();

        if (speech && sid && env.PODOLANG_KV) {
          try {
            const tr = await translate(env, speech, peer, me);   // 상대말 → 내 언어
            const meta = await env.PODOLANG_KV.get(`call:${sid}`, 'json') || { seq: 0 };
            const seq = (meta.seq || 0) + 1;
            meta.seq = seq;
            await env.PODOLANG_KV.put(`call:${sid}`, JSON.stringify(meta), { expirationTtl: 60 * 60 * 6 });
            await env.PODOLANG_KV.put(`msg:${sid}:${seq}`,
              JSON.stringify({ dir: 'peer', src: speech, text: tr.translated, at: Date.now() }),
              { expirationTtl: 60 * 30 });
          } catch (e) { /* 저장 실패해도 통화는 계속 */ }
        }
        // 계속 상대 말 수집
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect>${url.origin}/twiml/answer?me=${me}&amp;peer=${peer}&amp;sid=1</Redirect></Response>`);
      }

      // 8. 내가 앱에서 말함 → 번역 → 진행 중 통화에 밀어넣어 상대가 들음 (나 → 상대)
      if (url.pathname === '/api/call/say' && request.method === 'POST') {
        if (!env.PODOLANG_KV) return json({ error: 'KV 미연결' }, 400, H);
        const fd = await request.formData();
        const sid = (fd.get('callSid') || '').toString();
        const audio = fd.get('audio');
        let text = (fd.get('text') || '').toString();

        const meta = await env.PODOLANG_KV.get(`call:${sid}`, 'json');
        if (!meta) return json({ error: '통화를 찾을 수 없습니다.' }, 404, H);
        const me = meta.me, peer = meta.peer;

        // 음성이 오면 먼저 텍스트로 (내 언어)
        if (!text && audio) text = await transcribe(env, audio, me);
        if (!text || !text.trim()) return json({ error: '음성을 인식하지 못했습니다.' }, 400, H);

        const tr = await translate(env, text, me, peer);   // 내말 → 상대 언어

        // 진행 중 통화 업데이트: 상대에게 번역 음성 재생 후 다시 수집 루프로
        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLang(peer)}" voice="${sayVoice(peer)}">${escXml(tr.translated)}</Say>
  <Redirect>${url.origin}/twiml/answer?me=${me}&amp;peer=${peer}&amp;sid=1</Redirect>
</Response>`;
        const upForm = new URLSearchParams();
        upForm.append('Twiml', twiml);
        const up = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${sid}.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: upForm
        });
        const upd = await up.json();
        if (upd.code) return json({ error: '통화에 전달 실패: ' + upd.message }, 400, H);

        return json({ ok: true, src: text, translated: tr.translated }, 200, H);
      }

      // 9. 앱이 상대방 말(번역본)을 받아가는 우편함
      if (url.pathname === '/api/call/poll' && request.method === 'GET') {
        if (!env.PODOLANG_KV) return json({ messages: [], seq: 0 }, 200, H);
        const sid = url.searchParams.get('callSid') || '';
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const meta = await env.PODOLANG_KV.get(`call:${sid}`, 'json');
        const seq = meta?.seq || 0;
        const out = [];
        for (let n = since + 1; n <= seq; n++) {
          const m = await env.PODOLANG_KV.get(`msg:${sid}:${n}`, 'json');
          if (m) out.push({ n, ...m });
        }
        return json({ messages: out, seq, status: meta?.status || 'active' }, 200, H);
      }

      // 10. 콜 상태 콜백
      if (url.pathname === '/api/call/status' && request.method === 'POST') {
        const fd = await request.formData();
        const sid = fd.get('CallSid'), st = fd.get('CallStatus');
        if (env.PODOLANG_KV && sid) {
          const old = await env.PODOLANG_KV.get(`call:${sid}`, 'json') || {};
          await env.PODOLANG_KV.put(`call:${sid}`,
            JSON.stringify({ ...old, status: st, updated: Date.now() }),
            { expirationTtl: 60 * 60 * 6 });
        }
        return new Response('OK');
      }

      return new Response('🍇 PodoLang API by BJ LEE · v1.5', { headers: H });

    } catch (e) {
      return json({ error: e.message || '처리 중 오류가 발생했습니다.' }, 500, H);
    }
  }
};

/* ---------------- Podoclone 유틸 ---------------- */

function cleanHost(u) {
  let h;
  try { h = new URL(u).hostname; }
  catch (_) { h = String(u || 'myshop.com').replace(/^https?:\/\//, '').split('/')[0]; }
  h = (h || 'myshop.com').toLowerCase().replace(/^www\./, '');
  if (h.endsWith('.myshopify.com')) h = h.split('.')[0] + '.com';
  return h || 'myshop.com';
}
function fmtPrice(base, rate) {
  const v = base * rate;
  if (v < 1000 && rate < 100) return v.toFixed(2);      // $29.99, €27.59
  return Math.round(v).toLocaleString('en-US');          // 4,798 / 749,750
}

/* ---------------- 재시도 ---------------- */

async function retry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const m = (e.message || '').toLowerCase();
      const regionBlocked = m.includes('not supported') || m.includes('region')
        || m.includes('territory') || m.includes('unsupported_country')
        || m.includes('request_forbidden') || m.includes('403');
      const retryable = regionBlocked || m.includes('rate limit')
        || m.includes('timeout') || m.includes('503') || m.includes('502');
      if (!retryable || i === tries - 1) throw e;
      const wait = regionBlocked ? 700 * (i + 1) : 400 * (i + 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

/* ---------------- 파이프라인 ---------------- */

async function transcribe(env, audio, sourceLang) {
  if (!audio) throw new Error('음성 파일이 없습니다.');
  const s = (sourceLang || '').toUpperCase();

  return await retry(async () => {
    const form = new FormData();
    form.append('file', audio, 'audio.webm');
    form.append('model', 'whisper-1');
    if (s && s !== 'AUTO') form.append('language', s.toLowerCase());

    const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: form
    });
    const d = await res.json();
    if (d.error) throw new Error('음성 인식 실패: ' + d.error.message);
    return d.text;
  });
}

async function translate(env, text, sourceLang, targetLang) {
  const DEEPL = ['BG','CS','DA','DE','EL','EN','ES','ET','FI','FR','HU','ID','IT','JA','KO',
                 'LT','LV','NB','NL','PL','PT','RO','RU','SK','SL','SV','TR','UK','ZH','AR'];
  const t = (targetLang || 'TH').toUpperCase();
  const s = (sourceLang || '').toUpperCase();

  if (env.DEEPL_API_KEY && DEEPL.includes(t)) {
    try {
      const res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: { 'Authorization': `DeepL-Auth-Key ${env.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: [text],
          target_lang: t === 'EN' ? 'EN-US' : t === 'PT' ? 'PT-BR' : t,
          source_lang: DEEPL.includes(s) ? s : null
        })
      });
      const d = await res.json();
      const out = d.translations?.[0]?.text;
      if (out) return { translated: out, engine: 'DeepL' };
    } catch (e) { /* GPT로 폴백 */ }
  }

  return await retry(async () => {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `Translate the user text from ${s || 'the detected language'} to ${t}. This is spoken conversation. Output only the translation — no notes, no quotes, no romanization.` },
          { role: 'user', content: text }
        ]
      })
    });
    const raw = await res.text();
    let d;
    try { d = JSON.parse(raw); }
    catch (e) { throw new Error('번역 실패(파싱): ' + raw.slice(0, 300)); }
    if (d.error) throw new Error('번역 실패: ' + (d.error.message || JSON.stringify(d.error)));
    const out = d.choices?.[0]?.message?.content;
    if (!out) throw new Error('번역 실패(응답형식): ' + JSON.stringify(d).slice(0, 300));
    return { translated: out.trim(), engine: 'GPT' };
  });
}

/* ---------------- 음성 ---------------- */

function modelsFor(lang) {
  return V2_LANGS.includes(lang)
    ? ['eleven_multilingual_v2', 'eleven_flash_v2_5']
    : ['eleven_v3', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_multilingual_v2'];
}

async function ttsCall(env, text, voiceId, model, lang) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs 키가 없습니다.');
  const body = { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
  if (model !== 'eleven_multilingual_v2' && LCODE[lang]) body.language_code = LCODE[lang];

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      msg = e.detail?.message || e.detail?.status || JSON.stringify(e.detail || e);
    } catch (_) {
      try { msg = await res.text(); } catch (__) {}
    }
    const err = new Error(`${model}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return await res.arrayBuffer();
}

async function speak(env, text, voiceId, lang) {
  const L = (lang || 'EN').toUpperCase();
  let vid = voiceId || VOICE_DEFAULT;
  const errors = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    let switched = false;
    for (const m of modelsFor(L)) {
      try {
        return { audio: await ttsCall(env, text, vid, m, L), model: m };
      } catch (e) {
        errors.push(e.message);
        if ((e.status === 400 || e.status === 404) && attempt === 0) {
          const vr = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }
          });
          const vd = await vr.json();
          const first = vd.voices?.[0]?.voice_id;
          if (first && first !== vid) { vid = first; switched = true; break; }
        }
      }
    }
    if (!switched) break;
  }
  throw new Error('음성 생성 실패 · ' + errors.join(' | '));
}

/* ---------------- 유틸 ---------------- */

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const LCODE = { KO:'ko', TH:'th', EN:'en', JA:'ja', ZH:'zh', VI:'vi', ES:'es', ID:'id' };
const LMAP  = { KO:'ko-KR', TH:'th-TH', EN:'en-US', JA:'ja-JP', ZH:'zh-CN', VI:'vi-VN', ES:'es-ES', ID:'id-ID' };
const sttLang = l => LMAP[l] || 'en-US';
const sayLang = l => LMAP[l] || 'en-US';
const sayVoice = l => ({ KO:'Polly.Seoyeon', JA:'Polly.Mizuki', ZH:'Polly.Zhiyu', EN:'Polly.Joanna', ES:'Polly.Lupe', TH:'Google.th-TH-Standard-A', VI:'Google.vi-VN-Standard-A', ID:'Google.id-ID-Standard-A' })[l] || 'Polly.Joanna';

// 상대에게 처음 들려줄 안내 (상대 언어)
const GREET = {
  KO:'포도랑 통역 전화입니다. 말씀하시면 통역됩니다.',
  EN:'This is a Podolang interpreted call. Please speak, and it will be translated.',
  TH:'นี่คือสายแปลภาษาโพโดลัง กรุณาพูด แล้วระบบจะแปลให้',
  VI:'Đây là cuộc gọi phiên dịch Podolang. Vui lòng nói, hệ thống sẽ dịch.',
  JA:'ポドランの通訳電話です。話すと翻訳されます。',
  ZH:'这是 Podolang 翻译电话。请讲话，系统会为您翻译。',
  ES:'Esta es una llamada con interpretación de Podolang. Hable y se traducirá.',
  ID:'Ini panggilan penerjemahan Podolang. Silakan bicara, akan diterjemahkan.'
};
const greetText = l => GREET[l] || GREET.EN;

const escXml = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]));

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
const xml = body => new Response(body, { headers: { 'Content-Type': 'text/xml' } });
const json = (obj, status = 200, H = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...H } });
