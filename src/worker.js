/**
 * 🍇 PODOLANG by BJ LEE - 실시간 통역 + Twilio 전화 통역 API
 * Cloudflare Workers · api.podolang.kr
 * © 2026 BJ LEE. All Rights Reserved.
 *
 * 배포: wrangler deploy
 * 시크릿: OPENAI_API_KEY, DEEPL_API_KEY, ELEVENLABS_API_KEY,
 *         TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 * 변수:   TWILIO_PHONE_NUMBER
 */

const VOICE_DEFAULT = '21m00Tcm4TlvDq8ikWAM';

// 앱이 올라가는 주소만 허용 (다른 사이트가 이 API를 못 쓰게)
const ALLOWED = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
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
          ok: true,
          app: 'podolang',
          keys: {
            openai: !!env.OPENAI_API_KEY,
            deepl: !!env.DEEPL_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_PHONE_NUMBER)
          }
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
        const { text, voiceId } = await request.json();
        const buf = await speak(env, text, voiceId);
        return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', ...H } });
      }

      // 4. 올인원 통역 (앱이 쓰는 경로)
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

        let audioBase64 = null;
        try { audioBase64 = toBase64(await speak(env, tr.translated, voiceId)); } catch (e) {}

        if (env.PODOLANG_KV) {
          await env.PODOLANG_KV.put(`log:${Date.now()}`,
            JSON.stringify({ original, translated: tr.translated, sourceLang, targetLang, engine: tr.engine }),
            { expirationTtl: 60 * 60 * 24 * 30 });
        }

        return json({
          original,
          translated: tr.translated,
          audioBase64,
          engine: tr.engine,
          pipeline: `Whisper(${sourceLang}) → ${tr.engine}(${sourceLang}→${targetLang}) → ElevenLabs`
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

      // 6. TwiML - 통역 시작 (Twilio가 호출하므로 CORS 무관)
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

      // 7. TwiML - 인식 → 번역 → 재생 → 반대 방향
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

      return new Response('🍇 PodoLang API by BJ LEE', { headers: H });

    } catch (e) {
      return json({ error: e.message || '처리 중 오류가 발생했습니다.' }, 500, H);
    }
  }
};

/* ---------------- 파이프라인 ---------------- */

async function transcribe(env, audio, sourceLang) {
  if (!audio) throw new Error('음성 파일이 없습니다.');
  const form = new FormData();
  form.append('file', audio, 'audio.webm');
  form.append('model', 'whisper-1');
  const s = (sourceLang || '').toUpperCase();
  if (s && s !== 'AUTO') form.append('language', s.toLowerCase());

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: form
  });
  const d = await res.json();
  if (d.error) throw new Error('음성 인식 실패: ' + d.error.message);
  return d.text;
}

// DeepL이 지원하지 않는 언어(태국어·베트남어 등)는 자동으로 GPT로 넘어감
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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  const d = await res.json();
  if (d.error) throw new Error('번역 실패: ' + d.error.message);
  return { translated: d.choices[0].message.content.trim(), engine: 'GPT' };
}

async function speak(env, text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || VOICE_DEFAULT}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!res.ok) throw new Error('음성 생성 실패');
  return await res.arrayBuffer();
}

/* ---------------- 유틸 ---------------- */

// 큰 오디오도 스택 오버플로 없이 변환
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const LMAP = { KO:'ko-KR', TH:'th-TH', EN:'en-US', JA:'ja-JP', ZH:'zh-CN', VI:'vi-VN', ES:'es-ES', ID:'id-ID' };
const sttLang = l => LMAP[l] || 'en-US';
const sayLang = l => LMAP[l] || 'en-US';
const sayVoice = l => ({ KO:'Polly.Seoyeon', TH:'Polly.Ayutthaya', JA:'Polly.Mizuki', ZH:'Polly.Zhiyu', ES:'Polly.Lupe' })[l] || 'Polly.Joanna';

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
function xml(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/xml' } });
}
function json(obj, status = 200, H = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...H } });
}
