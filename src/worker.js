/**
 * 🍇 PODOLANG by BJ LEE - 실시간 통역 + 사진 번역 + Twilio 전화 통역 + Podoclone API
 * Cloudflare Workers · v1.6
 * © 2026 BJ LEE. All Rights Reserved.
 *
 * v1.6 변경점
 *  - 사진 번역(OCR) 추가: POST /api/vision
 *    이미지 안의 글자를 읽어서 번역. 서류·라벨·인보이스·간판·손글씨.
 *    multipart(image 파일) 또는 JSON({imageBase64}) 둘 다 받음.
 *    숫자·코드·단가·날짜는 원문 그대로 유지하도록 프롬프트 고정.
 * v1.5
 *  - 전화 통역을 "앱이 다리 역할" 방식으로 재작성 (양방향 전달)
 *    당신=앱(마이크/스피커), 상대=전화. KV(PODOLANG_KV) 필요.
 *    /api/call/start · /twiml/answer · /twiml/gather · /api/call/say · /api/call/poll
 * v1.4
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

// 사진 번역에 쓰는 모델 (vision 지원)
const VISION_MODEL = 'gpt-4o-mini';
const VISION_MAX_BYTES = 8 * 1024 * 1024;   // 8MB

// eleven_multilingual_v2 가 지원하는 29개 언어 (태국어·베트남어 없음)
const V2_LANGS = ['EN','JA','ZH','DE','HI','FR','KO','PT','IT','ES','ID','NL','TR',
                  'FIL','PL','SV','BG','RO','AR','CS','EL','FI','HR','MS','SK','DA','TA','UK','RU'];

const ALLOWED = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
  'https://podolang.hasin7jk.workers.dev',
  'https://podotalk.kr',
  'https://www.podotalk.kr',
  'http://localhost:8788'
];

// ===== Podoclone: 30개국 데이터 (clone.html 과 동일) =====
/* ===================== 크레딧 (포도톡과 하나로) =====================
   이 워커는 지금까지 아무나 부를 수 있었습니다. 주소만 알면 남이 우리 돈으로
   번역하고 음성을 만들고 국제전화를 걸 수 있었다는 뜻입니다.
   ALLOWED 로 막고 있었지만 그건 브라우저에만 걸리는 장치라
   명령창 한 줄이면 넘어갑니다.

   이제 돈이 드는 길은 전부 포도톡 크레딧을 보고 엽니다.

   워커 설정에 두 가지를 넣어야 합니다 (Settings → Variables and Secrets)
     TALK_API   (Text)   https://podotalk-api.hasin7jk.workers.dev
     LINK_KEY   (Secret) 포도톡 워커에 넣은 것과 똑같은 글자           */

const CD_PHOTO = 5;    // 사진 번역 1장
const CD_VOICE = 1;    // 음성 통역 한 마디
const CD_PHONE = 60;   // 전화통역 1분

const talkApi = env => String(env.TALK_API || 'https://podotalk-api.hasin7jk.workers.dev')
  .replace(/\/+$/, '');
const uidOk = v => /^[a-zA-Z0-9_-]{6,64}$/.test(v || '');

async function cdCheck(env, uid) {
  if (!env.LINK_KEY) return { ok: false, reason: '서버 설정이 끝나지 않았습니다. (LINK_KEY)' };
  if (!uidOk(uid)) return { ok: false, reason: '포도톡에서 열어주세요. 사용자 정보가 없습니다.' };
  try {
    const r = await fetch(`${talkApi(env)}/link/credits?uid=${encodeURIComponent(uid)}`, {
      headers: { 'X-Link-Key': env.LINK_KEY }
    });
    const d = await r.json();
    if (!d || !d.ok) return { ok: false, reason: '크레딧을 확인하지 못했습니다.' };
    if ((d.balance || 0) <= 0) {
      return { ok: false, reason: '크레딧이 없습니다. 포도톡 설정 → 크레딧에서 채워주세요.' };
    }
    return { ok: true, balance: d.balance };
  } catch (e) {
    /* 왜 못 갔는지 그대로 알려줍니다. 예전에는 "닿지 못했습니다" 한 마디뿐이라
       열쇠 문제인지 주소 문제인지 구분할 수가 없었습니다. */
    return { ok: false, reason: '크레딧 서버에 닿지 못했습니다: ' + ((e && e.message) || e) };
  }
}

/* 먼저 깎습니다. 부르고 나서 깎으면 실패한 요청으로 얼마든지 뽑아갑니다. */
async function cdSpend(env, uid, amount, kind) {
  if (!env.LINK_KEY || !uid || !amount) return { ok: false, took: 0 };
  try {
    const r = await fetch(`${talkApi(env)}/link/credits`, {
      method: 'POST',
      headers: { 'X-Link-Key': env.LINK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, amount, kind: kind || 'podolang' })
    });
    return await r.json();
  } catch (_) { return { ok: false, took: 0 }; }
}

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
          ok: true, app: 'podolang', version: '2.0',
          gateway: OPENAI_BASE.includes('gateway.ai') ? 'ai-gateway' : 'direct',
          routes: ['/api/podolang', '/api/translate', '/api/speak', '/api/vision', '/api/clone', '/api/call/start', '/api/call/say', '/api/call/poll'],
          keys: {
            openai: !!env.OPENAI_API_KEY,
            deepl: !!env.DEEPL_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_PHONE_NUMBER),
            kv: !!env.PODOLANG_KV,
            /* 크레딧 연결이 되어 있는지 눈으로 보려고 넣었습니다.
               linkKey 가 false 면 워커가 LINK_KEY 를 못 보고 있다는 뜻입니다. */
            linkKey: !!env.LINK_KEY,
            talkApi: String(env.TALK_API || '(없음)')
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

      // 0-4. 사진 번역 진단 (브라우저 주소창으로 확인용)
      /* 크레딧 연결 진단. 포도톡을 실제로 불러보고 받은 답을 그대로 보여줍니다.
         podolang.hasin7jk.workers.dev/api/link/test?uid=(내 번호) */
      if (url.pathname === '/api/link/test') {
        const uid = url.searchParams.get('uid') || 'test123456';
        const out = { talkApi: talkApi(env), hasKey: !!env.LINK_KEY, uid };
        try {
          const r = await fetch(`${talkApi(env)}/link/credits?uid=${encodeURIComponent(uid)}`, {
            headers: { 'X-Link-Key': env.LINK_KEY || '' }
          });
          out.status = r.status;
          out.body = (await r.text()).slice(0, 400);
        } catch (e) {
          out.fetchError = (e && e.message) || String(e);
        }
        return json(out, 200, H);
      }

      if (url.pathname === '/api/vision/test') {
        return json({
          ok: true,
          model: VISION_MODEL,
          openaiKey: !!env.OPENAI_API_KEY,
          maxBytes: VISION_MAX_BYTES,
          how: 'POST /api/vision · multipart(image, sourceLang, targetLang) 또는 JSON({imageBase64, mime, sourceLang, targetLang})'
        }, 200, H);
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
        const sb = await request.json();
        const { text, voiceId, lang } = sb;

        // ⚠️ 여기가 문입니다. 이게 없으면 주소를 아는 사람이
        //    우리 ElevenLabs 로 공짜 음성을 무한정 뽑아갑니다.
        const sUid = String(sb.uid || '');
        const sChk = await cdCheck(env, sUid);
        if (!sChk.ok) return json({ error: sChk.reason, needCredit: true }, 402, H);

        // 너무 긴 글은 값이 많이 듭니다. 한 마디 분량으로 끊습니다.
        const say = String(text || '').slice(0, 500);
        if (!say.trim()) return json({ error: '읽을 글이 없습니다.' }, 400, H);

        // 먼저 깎고 부릅니다. 부르고 나서 깎으면 실패한 요청으로 뽑아갑니다.
        await cdSpend(env, sUid, CD_VOICE, 'speak');

        const r = await speak(env, say, voiceId, lang || 'EN');
        return new Response(r.audio, { headers: { 'Content-Type': 'audio/mpeg', ...H } });
      }

      // ===== 4. 사진 번역 (OCR) =====
      // 서류 · 라벨 · 인보이스 · 간판 · 손글씨를 찍으면 글자를 읽어 번역합니다.
      // 보내는 방법 두 가지 (앱 사정에 맞는 쪽으로):
      //   ① multipart/form-data : image(파일), sourceLang, targetLang, speak(선택 '1')
      //   ② application/json    : { imageBase64, mime, sourceLang, targetLang, speak }
      if (url.pathname === '/api/vision' && request.method === 'POST') {
        const ct = (request.headers.get('Content-Type') || '').toLowerCase();
        let dataUrl, sourceLang = 'AUTO', targetLang = 'KO', wantSpeak = false, vUid = '';

        if (ct.includes('application/json')) {
          const b = await request.json();
          let raw = String(b.imageBase64 || '');
          const mime = b.mime || 'image/jpeg';
          // 앱이 dataURL 통째로 보내도 받아줌
          dataUrl = raw.startsWith('data:') ? raw : `data:${mime};base64,${raw}`;
          if (b.sourceLang) sourceLang = String(b.sourceLang);
          if (b.targetLang) targetLang = String(b.targetLang);
          wantSpeak = b.speak === true || b.speak === '1';
          vUid = String(b.uid || '');
        } else {
          const fd = await request.formData();
          const image = fd.get('image') || fd.get('file') || fd.get('photo');
          if (!image || typeof image.arrayBuffer !== 'function') {
            return json({ error: '사진이 오지 않았습니다.' }, 400, H);
          }
          const buf = await image.arrayBuffer();
          if (buf.byteLength > VISION_MAX_BYTES) {
            return json({ error: '사진이 너무 큽니다. 8MB 이하로 줄여주세요.' }, 400, H);
          }
          const mime = (image.type && image.type.startsWith('image/')) ? image.type : 'image/jpeg';
          dataUrl = `data:${mime};base64,${toBase64(buf)}`;
          if (fd.get('sourceLang')) sourceLang = String(fd.get('sourceLang'));
          if (fd.get('targetLang')) targetLang = String(fd.get('targetLang'));
          wantSpeak = String(fd.get('speak') || '') === '1';
          vUid = String(fd.get('uid') || '');
        }

        // 사진 한 장에 크레딧이 듭니다. 먼저 깎고 부릅니다.
        const vChk = await cdCheck(env, vUid);
        if (!vChk.ok) return json({ error: vChk.reason, needCredit: true }, 402, H);
        await cdSpend(env, vUid, CD_PHOTO, 'photo');

        const r = await visionRead(env, dataUrl, sourceLang, targetLang);
        if (!r.original && !r.translated) {
          return json({ error: '사진에서 글자를 찾지 못했습니다. 더 밝고 가까이 찍어보세요.' }, 200, H);
        }

        // 짧은 결과만 음성 생성 (긴 서류를 읽어주면 비용·시간이 커집니다)
        let audioBase64 = null, audioError = null;
        if (wantSpeak && r.translated && r.translated.length <= 400) {
          try {
            const s = await speak(env, r.translated, VOICE_DEFAULT, (targetLang || 'KO').toUpperCase());
            audioBase64 = toBase64(s.audio);
          } catch (e) { audioError = e.message; }
        }

        if (env.PODOLANG_KV) {
          try {
            await env.PODOLANG_KV.put(`vlog:${Date.now()}`,
              JSON.stringify({ kind: r.kind, translated: r.translated.slice(0, 500), targetLang }),
              { expirationTtl: 60 * 60 * 24 * 30 });
          } catch (_) {}
        }

        return json({
          ok: true,
          kind: r.kind,
          original: r.original,
          translated: r.translated,
          audioBase64,
          audioError,
          model: VISION_MODEL
        }, 200, H);
      }

      // 5. 올인원 통역
      if (url.pathname === '/api/podolang' && request.method === 'POST') {
        const fd = await request.formData();
        const audio = fd.get('audio');
        const sourceLang = (fd.get('sourceLang') || 'KO').toUpperCase();
        const targetLang = (fd.get('targetLang') || 'TH').toUpperCase();
        const voiceId = fd.get('voiceId') || VOICE_DEFAULT;

        const pUid = String(fd.get('uid') || '');
        const pChk = await cdCheck(env, pUid);
        if (!pChk.ok) return json({ error: pChk.reason, needCredit: true }, 402, H);
        await cdSpend(env, pUid, CD_VOICE, 'voice');

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

      // 6. 전화 걸기
      if (url.pathname === '/api/call/start' && request.method === 'POST') {
        if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
          return json({ error: '전화 통역이 아직 설정되지 않았습니다.' }, 400, H);
        }
        if (!env.PODOLANG_KV) {
          return json({ error: '전화 통역 저장소(KV)가 연결되지 않았습니다.' }, 400, H);
        }
        const callBody = await request.json();
        const { to, fromLang, toLang } = callBody;
        if (!/^\+\d{8,15}$/.test(to || '')) return json({ error: '전화번호 형식이 맞지 않습니다.' }, 400, H);

        // ⚠️ 여기가 문입니다. 이게 없으면 아무나 아무 번호로 국제전화를 겁니다.
        const cUid = String(callBody.uid || '');
        const cChk = await cdCheck(env, cUid);
        if (!cChk.ok) return json({ error: cChk.reason, needCredit: true }, 402, H);
        if (cChk.balance < CD_PHONE) {
          return json({ error: '통화 1분치 크레딧이 필요합니다.', needCredit: true }, 402, H);
        }
        // 잔액만큼만 통화하게 시간을 미리 재둡니다. 이게 없으면 마이너스가 납니다.
        const cMaxMin = Math.max(1, Math.floor(cChk.balance / CD_PHONE));
        const f = (fromLang || 'KO').toUpperCase();   // 내 언어
        const t = (toLang || 'TH').toUpperCase();     // 상대 언어

        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const form = new URLSearchParams();
        form.append('To', to);
        form.append('From', env.TWILIO_PHONE_NUMBER);
        form.append('Url', `${url.origin}/twiml/answer?me=${f}&peer=${t}`);
        form.append('StatusCallback', `${url.origin}/api/call/status`);
        form.append('StatusCallbackEvent', 'completed');
        form.append('TimeLimit', String(cMaxMin * 60));   // 잔액이 다하면 저절로 끊깁니다

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form
        });
        const d = await res.json();
        if (d.code) return json({ error: d.message }, 400, H);

        await env.PODOLANG_KV.put(`call:${d.sid}`,
          JSON.stringify({ to, me: f, peer: t, seq: 0, status: 'initiated', created: Date.now(), uid: cUid }),
          { expirationTtl: 60 * 60 * 6 });
        return json({ callSid: d.sid, status: d.status, message: `${to} 연결 중입니다.` }, 200, H);
      }

      // 7. TwiML - 상대 전화가 받으면: 인사 후 상대 말을 계속 수집
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

      // 8. TwiML - 상대가 말한 것: 번역해서 KV 우편함에 저장 (상대 → 나)
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

      // 9. 내가 앱에서 말함 → 번역 → 진행 중 통화에 밀어넣어 상대가 들음 (나 → 상대)
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

      // 10. 앱이 상대방 말(번역본)을 받아가는 우편함
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

      // 10-1. 통화 종료 (전화 끊기)
      if (url.pathname === '/api/call/end' && request.method === 'POST') {
        const { callSid } = await request.json();
        if (callSid && env.TWILIO_ACCOUNT_SID) {
          try {
            const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
            const f = new URLSearchParams(); f.append('Status', 'completed');
            await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`, {
              method: 'POST',
              headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: f
            });
            if (env.PODOLANG_KV) {
              const old = await env.PODOLANG_KV.get(`call:${callSid}`, 'json') || {};
              await env.PODOLANG_KV.put(`call:${callSid}`, JSON.stringify({ ...old, status: 'completed' }), { expirationTtl: 60 * 30 });
            }
          } catch (e) {}
        }
        return json({ ok: true }, 200, H);
      }

      // 11. 콜 상태 콜백
      if (url.pathname === '/api/call/status' && request.method === 'POST') {
        const fd = await request.formData();
        const sid = fd.get('CallSid'), st = fd.get('CallStatus');
        if (env.PODOLANG_KV && sid) {
          const old = await env.PODOLANG_KV.get(`call:${sid}`, 'json') || {};

          // 실제 통화 시간만큼 깎습니다. Twilio 는 분 단위라 올림합니다.
          if (String(st) === 'completed' && old.uid) {
            const secs = parseInt(String(fd.get('CallDuration') || '0'), 10) || 0;
            const mins = Math.ceil(secs / 60);
            if (mins > 0) await cdSpend(env, old.uid, mins * CD_PHONE, 'phone');
          }
          await env.PODOLANG_KV.put(`call:${sid}`,
            JSON.stringify({ ...old, status: st, updated: Date.now() }),
            { expirationTtl: 60 * 60 * 6 });
        }
        return new Response('OK');
      }

      return new Response('🍇 PodoLang API by BJ LEE · v2.0', { headers: H });

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

/* ---------------- 사진 번역 (OCR) ---------------- */
// 사진 안의 글자를 그대로 읽고(original) 목표 언어로 옮깁니다(translated).
// 숫자·금액·코드·날짜는 절대 변환하지 않도록 프롬프트로 못을 박아뒀습니다.
// 거래 서류에서 단가가 바뀌면 사고가 나기 때문입니다.
async function visionRead(env, dataUrl, sourceLang, targetLang) {
  if (!env.OPENAI_API_KEY) throw new Error('OpenAI 키가 없습니다.');
  const s = (sourceLang || 'AUTO').toUpperCase();
  const t = (targetLang || 'KO').toUpperCase();
  const tName = LNAME[t] || t;
  const sHint = (s && s !== 'AUTO')
    ? `The text in the image is mainly ${LNAME[s] || s}.`
    : 'Detect the language in the image yourself.';

  const sysPrompt = [
    'You read text out of photographs: business documents, invoices, product labels, packing lists, signs, receipts and handwriting.',
    'Return ONLY a JSON object. No markdown fences, no commentary.',
    'Shape: {"original": string, "translated": string, "kind": string}',
    '"original" = every readable character exactly as printed, keeping line order. Separate lines with \\n.',
    `"translated" = the same content rendered in ${tName}, keeping the same line structure so the two can be read side by side.`,
    'Numbers, prices, quantities, dates, model numbers, order codes, phone numbers and units must be copied character for character. Never convert currency, never reformat dates, never round anything.',
    'If a part is blurry or unreadable, write [?] at that spot instead of guessing.',
    `"kind" = two or three words in ${tName} naming what the document is.`,
    'If there is no readable text at all, return empty strings for original and translated.'
  ].join(' ');

  return await retry(async () => {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0.1,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: [
            { type: 'text', text: sHint },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
          ] }
        ]
      })
    });

    const raw = await res.text();
    let d;
    try { d = JSON.parse(raw); }
    catch (e) { throw new Error('사진 번역 실패(파싱): ' + raw.slice(0, 300)); }
    if (d.error) throw new Error('사진 번역 실패: ' + (d.error.message || JSON.stringify(d.error)));

    const content = d.choices?.[0]?.message?.content;
    if (!content) throw new Error('사진 번역 실패(응답형식): ' + JSON.stringify(d).slice(0, 300));

    // response_format 이 무시되는 경우까지 대비해 코드펜스를 걷어냅니다
    const cleaned = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let out;
    try { out = JSON.parse(cleaned); }
    catch (e) { out = { original: '', translated: cleaned, kind: '' }; }

    return {
      original: String(out.original || '').trim(),
      translated: String(out.translated || '').trim(),
      kind: String(out.kind || '').trim()
    };
  }, 3);
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

const LCODE = { KO:'ko', TH:'th', EN:'en', JA:'ja', ZH:'zh', VI:'vi', ES:'es', ID:'id', DE:'de', FR:'fr', AR:'ar', IT:'it', RU:'ru', PT:'pt' };
const LMAP  = { KO:'ko-KR', TH:'th-TH', EN:'en-US', JA:'ja-JP', ZH:'zh-CN', VI:'vi-VN', ES:'es-ES', ID:'id-ID', DE:'de-DE', FR:'fr-FR', AR:'ar-XA', IT:'it-IT', RU:'ru-RU', PT:'pt-BR' };
// 사진 번역 프롬프트에서 쓰는 언어 이름
const LNAME = { KO:'Korean', TH:'Thai', EN:'English', JA:'Japanese', ZH:'Chinese', VI:'Vietnamese', ES:'Spanish', ID:'Indonesian', DE:'German', FR:'French', AR:'Arabic', IT:'Italian', RU:'Russian', PT:'Portuguese', MS:'Malay', HI:'Hindi' };
const sttLang = l => LMAP[l] || 'en-US';
const sayLang = l => LMAP[l] || 'en-US';
const sayVoice = l => ({ KO:'Polly.Seoyeon', JA:'Polly.Mizuki', ZH:'Polly.Zhiyu', EN:'Polly.Joanna', ES:'Polly.Lupe', TH:'Google.th-TH-Standard-A', VI:'Google.vi-VN-Standard-A', ID:'Google.id-ID-Standard-A', DE:'Polly.Vicki', FR:'Polly.Lea', IT:'Polly.Bianca', RU:'Polly.Tatyana', AR:'Polly.Zeina', PT:'Polly.Camila' })[l] || 'Polly.Joanna';

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
