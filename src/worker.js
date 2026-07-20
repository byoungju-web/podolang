/**
 * 🍇 PODOLANG by BJ LEE - 실시간 통역 + Twilio 전화 통역 API
 * Cloudflare Workers · v1.3
 * © 2026 BJ LEE. All Rights Reserved.
 *
 * v1.3 변경점 (지역차단 우회)
 *  - OpenAI(Whisper·GPT) 호출을 Cloudflare AI Gateway 경유로 변경
 *    → "Country, region, or territory not supported" 우회
 *  - CORS 허용목록에 podolang.hasin7jk.workers.dev 추가
 *  - /api/health 에 gateway 표시
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = cors(request);

    if (request.method === 'OPTIONS') return new Response(null, { headers: H });

    try {

      // 0. 상태 확인
      if (url.pathname === '/api/health') {
        return json({
          ok: true, app: 'podolang', version: '1.3',
          gateway: OPENAI_BASE.includes('gateway.ai') ? 'ai-gateway' : 'direct',
          keys: {
            openai: !!env.OPENAI_API_KEY,
            deepl: !!env.DEEPL_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_PHONE_NUMBER)
          }
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

      // 0-2. 음성 진단 — 브라우저에서 /api/test?lang=TH 열면 모델별 결과가 보입니다
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

      // 0-3. 번역 파이프라인 진단 — /api/testchat?text=안녕 열면 GPT 경유 확인
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

      // 5. 전화 걸기
      if (url.pathname === '/api/call/start' && request.method === 'POST') {
        if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
          return json({ error: '전화 통역이 아직 설정되지 않았습니다.' }, 400, H);
        }
        const { to, fromLang, toLang, userId } = await request.json();
        if (!/^\+\d{8,15}$/.test(to || '')) return json({ error: '전화번호 형식이 맞지 않습니다.' }, 400, H);

        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const form = new URLSearchParams();
        form.append('To', to);
        form.append('From', env.TWILIO_PHONE_NUMBER);
        form.append('Url', `${url.origin}/twiml/translate?fromLang=${fromLang}&toLang=${toLang}&userId=${userId || ''}`);
        form.append('StatusCallback', `${url.origin}/api/call/status`);
        form.append('StatusCallbackEvent', 'completed');

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form
        });
        const d = await res.json();
        if (d.code) return json({ error: d.message }, 400, H);

        if (env.PODOLANG_KV) {
          await env.PODOLANG_KV.put(`call:${d.sid}`,
            JSON.stringify({ to, fromLang, toLang, status: 'initiated', created: Date.now() }),
            { expirationTtl: 60 * 60 * 24 * 7 });
        }
        return json({ callSid: d.sid, status: d.status, message: `${to} 연결 중입니다.` }, 200, H);
      }

      // 6. TwiML - 통역 시작
      if (url.pathname.startsWith('/twiml/translate')) {
        const f = (url.searchParams.get('fromLang') || 'KO').toUpperCase();
        const t = (url.searchParams.get('toLang') || 'TH').toUpperCase();
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLang(f)}" voice="${sayVoice(f)}">포도랑 통역을 시작합니다. 말씀하세요.</Say>
  <Gather input="speech" language="${sttLang(f)}" speechTimeout="auto" method="POST"
    action="${url.origin}/twiml/process?fromLang=${f}&amp;toLang=${t}">
    <Pause length="10"/>
  </Gather>
  <Redirect>${url.origin}/twiml/translate?fromLang=${t}&amp;toLang=${f}</Redirect>
</Response>`);
      }

      // 7. TwiML - 인식 → 번역 → 재생
      if (url.pathname.startsWith('/twiml/process') && request.method === 'POST') {
        const fd = await request.formData();
        const speech = (fd.get('SpeechResult') || '').toString();
        const f = (url.searchParams.get('fromLang') || 'KO').toUpperCase();
        const t = (url.searchParams.get('toLang') || 'TH').toUpperCase();

        if (!speech.trim()) {
          return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect>${url.origin}/twiml/translate?fromLang=${f}&amp;toLang=${t}</Redirect></Response>`);
        }
        const tr = await translate(env, speech, f, t);
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLang(t)}" voice="${sayVoice(t)}">${escXml(tr.translated)}</Say>
  <Gather input="speech" language="${sttLang(t)}" speechTimeout="auto" method="POST"
    action="${url.origin}/twiml/process?fromLang=${t}&amp;toLang=${f}">
    <Pause length="10"/>
  </Gather>
  <Redirect>${url.origin}/twiml/translate?fromLang=${t}&amp;toLang=${f}</Redirect>
</Response>`);
      }

      // 8. 콜 상태 콜백
      if (url.pathname === '/api/call/status' && request.method === 'POST') {
        const fd = await request.formData();
        const sid = fd.get('CallSid'), st = fd.get('CallStatus');
        if (env.PODOLANG_KV && sid) {
          const old = await env.PODOLANG_KV.get(`call:${sid}`, 'json') || {};
          await env.PODOLANG_KV.put(`call:${sid}`,
            JSON.stringify({ ...old, status: st, updated: Date.now() }),
            { expirationTtl: 60 * 60 * 24 * 7 });
        }
        return new Response('OK');
      }

      return new Response('🍇 PodoLang API by BJ LEE · v1.3', { headers: H });

    } catch (e) {
      return json({ error: e.message || '처리 중 오류가 발생했습니다.' }, 500, H);
    }
  }
};

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

    // ★ AI Gateway 경유로 OpenAI Whisper 호출 (지역차단 우회)
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
    // ★ AI Gateway 경유로 OpenAI GPT 호출 (지역차단 우회)
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

// 태국어·베트남어는 multilingual_v2 에 없으므로 v3 부터 시도합니다.
function modelsFor(lang) {
  return V2_LANGS.includes(lang)
    ? ['eleven_multilingual_v2', 'eleven_flash_v2_5']
    : ['eleven_v3', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_multilingual_v2'];
}

async function ttsCall(env, text, voiceId, model, lang) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs 키가 없습니다.');
  const body = { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
  // multilingual_v2 는 language_code 를 받지 않습니다
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
        // 목소리가 없으면 계정의 첫 목소리로 바꿔서 한 번 더
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
